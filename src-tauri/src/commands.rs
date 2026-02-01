use std::time::Duration;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{show_window, start_sidecar, stop_sidecar, SidecarState};

#[derive(Serialize)]
pub struct SidecarConfig {
    pub host: String,
    pub port: u16,
}

/// Get the sidecar port (exposed to frontend)
#[tauri::command]
pub fn get_sidecar_port(state: State<'_, SidecarState>) -> u16 {
    state.port
}

/// Get the sidecar host (exposed to frontend)
#[tauri::command]
pub fn get_sidecar_host(state: State<'_, SidecarState>) -> String {
    state.host.clone()
}

/// Get the sidecar config (host and port) - exposed to frontend
#[tauri::command]
pub fn get_sidecar_config(state: State<'_, SidecarState>) -> SidecarConfig {
    SidecarConfig {
        host: state.host.clone(),
        port: state.port,
    }
}

/// Restart the sidecar (exposed to frontend)
#[tauri::command]
pub async fn restart_sidecar(app: AppHandle) -> Result<(), String> {
    stop_sidecar(&app)?;
    // Small delay to ensure clean shutdown
    std::thread::sleep(Duration::from_millis(500));
    start_sidecar(&app)
}

/// Show the app window and add it to the dock (exposed to frontend)
#[tauri::command]
pub fn focus_window(app: AppHandle) {
    show_window(&app);
}

/// Open a file with the system default application.
/// Only allows files under $HOME or /tmp/pipali/.
#[tauri::command]
pub async fn open_file(path: String) -> Result<(), String> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("Cannot resolve path: {e}"))?;
    let canonical_str = canonical.to_string_lossy();

    let home = std::env::var("HOME").unwrap_or_default();
    let allowed = (!home.is_empty() && canonical_str.starts_with(&home))
        || canonical_str.starts_with("/private/tmp/pipali/")
        || canonical_str.starts_with("/tmp/pipali/");

    if !allowed {
        return Err(format!("Path not allowed: {canonical_str}"));
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &canonical_str])
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }

    Ok(())
}
