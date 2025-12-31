mod commands;

use std::sync::Mutex;
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

    let sidecar_command = app
        .shell()
        .sidecar("panini-server")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args([
            "--port",
            &port.to_string(),
            "--host",
            "127.0.0.1",
        ])
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

    for attempt in 1..=max_attempts {
        // Use a simple blocking HTTP request
        match std::process::Command::new("curl")
            .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", &health_url])
            .output()
        {
            Ok(output) => {
                let status = String::from_utf8_lossy(&output.stdout);
                if status.trim() == "200" {
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
        child
            .kill()
            .map_err(|e| format!("Failed to kill sidecar: {}", e))?;
        log::info!("[Sidecar] Stopped");
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
                tauri::RunEvent::ExitRequested { .. } => {
                    // Graceful shutdown on app exit (Cmd+Q, etc.)
                    log::info!("[App] Exit requested, stopping sidecar...");
                    if let Err(e) = stop_sidecar(app_handle) {
                        log::error!("Error stopping sidecar on exit: {}", e);
                    }
                }
                tauri::RunEvent::Exit => {
                    // Final cleanup when app is exiting
                    log::info!("[App] Exiting...");
                }
                _ => {}
            }
        });
}
