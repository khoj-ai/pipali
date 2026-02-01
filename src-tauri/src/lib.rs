mod commands;
mod wake_lock;

use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// Check for app updates and prompt user to install
#[cfg(desktop)]
async fn check_for_updates(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    use tauri_plugin_updater::UpdaterExt;

    if cfg!(debug_assertions) {
        log::info!("[Updater] Skipping update check in debug build");
        return Ok(());
    }

    let Some(updater) = app.updater_builder().build().ok() else {
        return Ok(());
    };

    let update = updater.check().await?;

    if let Some(update) = update {
        let version = update.version.clone();
        let body = update.body.clone().unwrap_or_default();

        let should_update = app
            .dialog()
            .message(format!(
                "Update to {} is available!\n\nRelease notes:\n{}",
                version, body
            ))
            .title("New Version Available")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Update".to_string(),
                "Later".to_string(),
            ))
            .blocking_show();

        if should_update {
            log::info!("[Updater] Downloading and installing update...");
            update.download_and_install(|_, _| {}, || {}).await?;
            log::info!("[Updater] Update installed, restarting...");
            app.restart();
        }
    } else {
        log::info!("[Updater] No updates available");
    }

    Ok(())
}

/// Show the app in the dock and Cmd+Tab switcher (macOS)
#[cfg(target_os = "macos")]
fn show_in_dock(app: &AppHandle) {
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
}

/// Hide the app from the dock and Cmd+Tab switcher (macOS)
#[cfg(target_os = "macos")]
fn hide_from_dock(app: &AppHandle) {
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

#[cfg(not(target_os = "macos"))]
fn show_in_dock(_app: &AppHandle) {}

#[cfg(not(target_os = "macos"))]
fn hide_from_dock(_app: &AppHandle) {}

#[cfg(target_os = "windows")]
fn normalize_windows_path(path: std::path::PathBuf) -> std::path::PathBuf {
    let path_str = path.to_string_lossy();
    let stripped = path_str.strip_prefix(r"\\?\").unwrap_or(&path_str);
    std::path::PathBuf::from(stripped)
}

#[cfg(not(target_os = "windows"))]
fn normalize_windows_path(path: std::path::PathBuf) -> std::path::PathBuf {
    path
}

/// Show the main window and emit an event to focus the chat input
fn show_window(app: &AppHandle) {
    show_in_dock(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        // Emit event so frontend can focus the chat input
        let _ = app.emit("window-shown", ());
    }
}

/// Toggle window visibility - show if hidden, hide to tray if visible
fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            hide_from_dock(app);
        } else {
            show_window(app);
        }
    }
}

/// Sidecar state management
pub struct SidecarState {
    pub child: Mutex<Option<CommandChild>>,
    pub host: String,
    pub port: u16,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            host: std::env::var("PIPALI_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
            port: std::env::var("PIPALI_PORT").unwrap_or_else(|_| "6464".to_string()).parse().unwrap_or(6464),
        }
    }
}

/// Get the app data directory for storing the database
fn get_app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))
}

#[cfg(target_os = "windows")]
fn get_home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE").map(std::path::PathBuf::from)
}

#[cfg(not(target_os = "windows"))]
fn get_home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

fn get_legacy_data_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return get_home_dir().map(|home| {
            home.join("Library").join("Application Support").join("pipali")
        });
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return Some(std::path::PathBuf::from(appdata).join("pipali"));
        }
        return get_home_dir().map(|home| home.join("AppData").join("Roaming").join("pipali"));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(xdg_data_home) = std::env::var_os("XDG_DATA_HOME") {
            return Some(std::path::PathBuf::from(xdg_data_home).join("pipali"));
        }
        return get_home_dir().map(|home| home.join(".local").join("share").join("pipali"));
    }
}

fn has_existing_data_dir(dir: &std::path::Path) -> bool {
    dir.join("db").exists() || dir.join("pipali.db").exists()
}

/// Get the path to the bundled server source directory
fn get_server_resource_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|p| p.join("resources").join("server"))
        .map_err(|e| format!("Failed to get resource dir: {}", e))
}

/// Start the sidecar process
///
/// This starts the Pipali server using the bundled Bun runtime.
/// The server source code is bundled in the resources directory,
/// and we use the bundled Bun binary to run it.
pub fn start_sidecar(app: &AppHandle) -> Result<(), String> {
    let state: State<SidecarState> = app.state();
    let host = state.host.clone();
    let port = state.port;

    // Check if already running
    if state.child.lock().unwrap().is_some() {
        log::info!("[Sidecar] Already running");
        return Ok(());
    }

    // Get and create the app data directory for the database
    let app_data_dir = normalize_windows_path(get_app_data_dir(app)?);
    let legacy_data_dir = get_legacy_data_dir();
    let data_dir = legacy_data_dir
        .as_ref()
        .filter(|dir| has_existing_data_dir(dir))
        .cloned()
        .unwrap_or(app_data_dir);
    let data_dir = normalize_windows_path(data_dir);

    if legacy_data_dir.as_ref().is_some_and(|dir| dir == &data_dir) {
        log::info!("[Sidecar] Using legacy data directory: {:?}", data_dir);
    }

    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    // Get the bundled server directory
    let server_dir = normalize_windows_path(get_server_resource_dir(app)?);
    log::info!("[Sidecar] Server directory: {:?}", server_dir);

    // Verify the server entry point exists
    // The server is bundled into a single JS file at dist/index.js
    let entry_point = server_dir.join("dist").join("index.js");
    if !entry_point.exists() {
        return Err(format!(
            "Server entry point not found: {:?}. The app bundle may be corrupted.",
            entry_point
        ));
    }

    log::info!("[Sidecar] Starting on {}:{}...", host, port);
    log::info!("[Sidecar] Data directory: {:?}", data_dir);

    // Use NODE_USE_SYSTEM_CA=1 to ensure Bun uses the OS certificate store for SSL verification.
    // This handles corporate proxies, custom CAs, and system-trusted certificates properly.
    // See: https://bun.com/blog/bun-v1.2.23
    //
    // Also pass PIPALI_PLATFORM_URL if set (used for connecting to remote platform instances)
    let platform_url = std::env::var("PIPALI_PLATFORM_URL").ok();

    // Build args for the server
    // The bundled Bun will run: bun run dist/index.js --port ... --host ...
    let mut args = vec![
        "run".to_string(),
        entry_point.to_string_lossy().to_string(),
        "--port".to_string(),
        port.to_string(),
        "--host".to_string(),
        host.clone(),
    ];
    if let Some(ref url) = platform_url {
        log::info!("[Sidecar] Using platform URL: {}", url);
        args.push("--platform-url".to_string());
        args.push(url.clone());
    }

    // Get the directory containing the bundled binaries (sidecars)
    // Tauri places sidecars next to the main executable
    let binaries_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default();
    let binaries_dir = normalize_windows_path(binaries_dir);

    // Use the bundled Bun runtime to start the server
    // The "bun" sidecar is registered in tauri.conf.json
    let sidecar_command = app
        .shell()
        .sidecar("bun")
        .map_err(|e| format!("Failed to create Bun sidecar command: {}", e))?
        .args(&args)
        .env("NODE_USE_SYSTEM_CA", "1")
        .env("NODE_ENV", "production")
        .env("PIPALI_DATA_DIR", data_dir.to_string_lossy().to_string())
        // Set PIPALI_BUNDLED_RUNTIMES_DIR so the server knows where to find bundled uv/uvx
        .env("PIPALI_BUNDLED_RUNTIMES_DIR", binaries_dir.to_string_lossy().to_string())
        // Provide the server resources root for migrations/assets
        .env("PIPALI_SERVER_RESOURCE_DIR", server_dir.to_string_lossy().to_string())
        .current_dir(data_dir);

    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|e| format!("Failed to spawn Bun sidecar: {}", e))?;

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
                    #[cfg(target_os = "windows")]
                    if payload.code == Some(-1073741795) {
                        log::error!(
                            "[Sidecar] Bun crashed with illegal instruction. This usually indicates an unsupported CPU instruction set."
                        );
                    }
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
pub fn wait_for_sidecar_ready(host: &str, port: u16) -> Result<(), String> {
    let health_url = format!("http://{}:{}/api/health", host, port);
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        log::info!("[App] Global shortcut triggered");
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // When a second instance is launched, focus the existing window
            log::info!("[App] Second instance detected, focusing existing window");
            // Check if the second instance was launched with a deep link URL
            // The deep-link feature of single-instance plugin passes URLs in argv
            for arg in argv.iter().skip(1) {
                if arg.starts_with("pipali://") {
                    log::info!("[App] Deep link from second instance: {}", arg);
                    let _ = app.emit("deep-link", arg.clone());
                }
            }
            show_window(app);
        }))
        .manage(SidecarState::default())
        .manage(wake_lock::WakeLockState::default())
        .setup(|app| {
            // Initialize updater plugin
            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

                // Check for updates on startup (non-blocking)
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = check_for_updates(&handle).await {
                        log::warn!("[Updater] Failed to check for updates: {}", e);
                    }
                });
            }

            let handle = app.handle().clone();
            let state: State<SidecarState> = app.state();
            let host = state.host.clone();
            let port = state.port;

            // Show app in dock immediately
            show_in_dock(&handle);

            // Splash window is defined in tauri.conf.json and shown automatically
            log::info!("[App] Splash window should be visible");

            // Start sidecar during setup
            if let Err(e) = start_sidecar(&handle) {
                log::error!("Failed to start sidecar: {}", e);
                return Err(e.into());
            }

            // Spawn async task to wait for sidecar and transition windows
            // This allows the event loop to start so windows can render
            let app_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                // Wait for sidecar to be ready
                if let Err(e) = wait_for_sidecar_ready(&host, port) {
                    log::error!("Sidecar not ready: {}", e);
                    // Don't fail - the UI will show connection error
                }

                // Emit sidecar-ready event so frontend can start fetching data
                log::info!("[App] Emitting sidecar-ready event");
                let _ = app_handle.emit("sidecar-ready", ());

                // Signal splash screen to start transformation animation
                log::info!("[App] Server ready, triggering splash animation");
                if let Some(splash) = app_handle.get_webview_window("splashscreen") {
                    // Call start() directly via JavaScript eval - more reliable than events
                    let _ = splash.eval("start()");
                }

                // Wait for animation to complete (~2 seconds for the transformation)
                std::thread::sleep(Duration::from_millis(2000));

                // Close splash and show main window
                if let Some(splash) = app_handle.get_webview_window("splashscreen") {
                    let _ = splash.close();
                    log::info!("[App] Splash window closed");
                }
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    let _ = main_window.show();
                    let _ = main_window.set_focus();
                    log::info!("[App] Main window shown");
                }
            });

            // Setup system tray menu
            let show_item = MenuItemBuilder::with_id("show", "Show Pipali").build(app)?;
            let keep_awake_item = CheckMenuItemBuilder::with_id("keep_awake", "Keep Device Awake")
                .checked(false)
                .build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&keep_awake_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // Get the tray icon created from tauri.conf.json and set its menu
            if let Some(tray) = app.tray_by_id("main-tray") {
                tray.set_menu(Some(tray_menu))?;

                // Handle tray icon click - toggle window visibility
                let app_handle = app.handle().clone();
                tray.on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                                hide_from_dock(&app_handle);
                            } else {
                                show_window(&app_handle);
                            }
                        }
                    }
                });

                // Handle tray menu item clicks
                let app_handle = app.handle().clone();
                tray.on_menu_event(move |_tray, event| {
                    match event.id().as_ref() {
                        "show" => {
                            show_window(&app_handle);
                        }
                        "keep_awake" => {
                            let state: State<wake_lock::WakeLockState> = app_handle.state();
                            let is_checked = state.user_toggle();
                            log::info!("[WakeLock] User toggled keep awake: {}", is_checked);
                        }
                        "quit" => {
                            log::info!("[App] Quit requested from tray menu");
                            app_handle.exit(0);
                        }
                        _ => {}
                    }
                });
            }

            // Register global shortcut: Alt+Space
            let shortcut: Shortcut = "Alt+Space".parse().unwrap();
            app.global_shortcut().register(shortcut)?;
            log::info!("[App] Global shortcut Alt+Space registered");

            // Handle deep links when app is already running (macOS)
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        log::info!("[App] Deep link received: {}", url);
                        let _ = app_handle.emit("deep-link", url.to_string());
                        show_window(&app_handle);
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_sidecar_port,
            commands::get_sidecar_host,
            commands::get_sidecar_config,
            commands::restart_sidecar,
            commands::focus_window,
            commands::open_file,
            wake_lock::acquire_wake_lock,
            wake_lock::release_wake_lock
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { api, .. },
                    ..
                } => {
                    // Only hide main window to tray, let splashscreen close normally
                    if label == "main" {
                        api.prevent_close();
                        if let Some(window) = app_handle.get_webview_window(&label) {
                            let _ = window.hide();
                        }
                        hide_from_dock(app_handle);
                        log::info!("[App] Window '{}' hidden to tray", label);
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
                    // Release wake lock on exit
                    if let Some(state) = app_handle.try_state::<wake_lock::WakeLockState>() {
                        state.release_all();
                    }
                }
                _ => {}
            }
        });
}
