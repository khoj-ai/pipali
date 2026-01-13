mod commands;

use std::sync::Mutex;
use std::time::Instant;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// Sidecar state management
pub struct SidecarState {
    pub child: Mutex<Option<CommandChild>>,
    pub port: u16,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            port: 6464,
        }
    }
}

/// Get the app data directory for storing the database
fn get_app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))
}

/// Start the sidecar process
pub fn start_sidecar(app: &AppHandle) -> Result<(), String> {
    let state: State<SidecarState> = app.state();
    let port = state.port;

    // Check if already running
    if state.child.lock().unwrap().is_some() {
        log::info!("[Sidecar] Already running");
        return Ok(());
    }

    // Get and create the app data directory for the database
    let data_dir = get_app_data_dir(app)?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    log::info!("[Sidecar] Starting on port {}...", port);
    log::info!("[Sidecar] Data directory: {:?}", data_dir);

    // Use NODE_USE_SYSTEM_CA=1 to ensure Bun uses the OS certificate store for SSL verification.
    // This handles corporate proxies, custom CAs, and system-trusted certificates properly.
    // See: https://bun.com/blog/bun-v1.2.23
    let sidecar_command = app
        .shell()
        .sidecar("pipali-server")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args([
            "--port",
            &port.to_string(),
            "--host",
            "127.0.0.1",
        ])
        .env("NODE_USE_SYSTEM_CA", "1")
        .current_dir(data_dir);

    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    // Store the child process
    *state.child.lock().unwrap() = Some(child);

    // Spawn a task to handle stdout/stderr
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!("[Sidecar] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    log::warn!("[Sidecar] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(err) => {
                    log::error!("[Sidecar] Error: {}", err);
                }
                CommandEvent::Terminated(payload) => {
                    log::info!(
                        "[Sidecar] Terminated with code: {:?}, signal: {:?}",
                        payload.code,
                        payload.signal
                    );
                    // Clear the child state
                    if let Some(state) = app_handle.try_state::<SidecarState>() {
                        *state.child.lock().unwrap() = None;
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    log::info!("[Sidecar] Process spawned, waiting for server to be ready...");
    Ok(())
}

/// Wait for the sidecar to be ready by polling the health endpoint
pub fn wait_for_sidecar_ready(port: u16) -> Result<(), String> {
    let health_url = format!("http://127.0.0.1:{}/api/health", port);
    let max_attempts = 50; // 10 seconds total (50 * 200ms)

    // Create a ureq agent with a short timeout for health checks
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(500))
        .timeout(Duration::from_secs(2))
        .build();

    for attempt in 1..=max_attempts {
        // Use native Rust HTTP client (no console windows on Windows)
        match agent.get(&health_url).call() {
            Ok(response) => {
                if response.status() == 200 {
                    log::info!("[Sidecar] Server ready after {} attempts", attempt);
                    return Ok(());
                }
            }
            Err(_) => {}
        }

        if attempt < max_attempts {
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    Err("Sidecar failed to become ready within timeout".to_string())
}

/// Stop the sidecar process gracefully
pub fn stop_sidecar(app: &AppHandle) -> Result<(), String> {
    let state: State<SidecarState> = app.state();
    let mut child_guard = state.child.lock().unwrap();

    if let Some(child) = child_guard.take() {
        log::info!("[Sidecar] Stopping...");

        let pid = child.pid();

        #[cfg(unix)]
        {
            if let Err(e) = send_sigterm(pid) {
                log::warn!("[Sidecar] Failed to send SIGTERM (pid={}): {}", pid, e);
            }

            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if !is_process_alive(pid) {
                    log::info!("[Sidecar] Stopped gracefully (pid={})", pid);
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(100));
            }

            log::warn!("[Sidecar] Graceful stop timed out, forcing kill (pid={})", pid);
        }

        child
            .kill()
            .map_err(|e| format!("Failed to kill sidecar: {}", e))?;
        log::info!("[Sidecar] Stopped");
    }

    Ok(())
}

#[cfg(unix)]
fn send_sigterm(pid: u32) -> Result<(), String> {
    let status = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|e| e.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("kill exited with status {}", status))
    }
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // When a second instance is launched, focus the existing window
            log::info!("[App] Second instance detected, focusing existing window");
            if let Some(window) = app.get_webview_window("main") {
                // Unminimize if minimized, then show and focus
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(SidecarState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let state: State<SidecarState> = app.state();
            let port = state.port;

            // Start sidecar during setup
            if let Err(e) = start_sidecar(&handle) {
                log::error!("Failed to start sidecar: {}", e);
                return Err(e.into());
            }

            // Wait for sidecar to be ready before showing the window
            if let Err(e) = wait_for_sidecar_ready(port) {
                log::error!("Sidecar not ready: {}", e);
                // Don't fail - the UI will show connection error
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_sidecar_port,
            commands::restart_sidecar
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { .. },
                    ..
                } => {
                    // Window close button clicked - stop sidecar before window closes
                    log::info!("[App] Window '{}' close requested, stopping sidecar...", label);
                    if let Err(e) = stop_sidecar(app_handle) {
                        log::error!("Error stopping sidecar on window close: {}", e);
                    }
                }
                tauri::RunEvent::ExitRequested { .. } => {
                    // Graceful shutdown on app exit (Cmd+Q, etc.)
                    log::info!("[App] Exit requested, stopping sidecar...");
                    if let Err(e) = stop_sidecar(app_handle) {
                        log::error!("Error stopping sidecar on exit: {}", e);
                    }
                }
                tauri::RunEvent::Exit => {
                    // Final cleanup when app is exiting (best-effort).
                    log::info!("[App] Exiting, stopping sidecar...");
                    if let Err(e) = stop_sidecar(app_handle) {
                        log::error!("Error stopping sidecar on exit: {}", e);
                    }
                }
                _ => {}
            }
        });
}
