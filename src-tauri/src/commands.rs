use std::time::Duration;
use tauri::{AppHandle, State};

use crate::{start_sidecar, stop_sidecar, SidecarState};

/// Get the sidecar port (exposed to frontend)
#[tauri::command]
pub fn get_sidecar_port(state: State<'_, SidecarState>) -> u16 {
    state.port
}

/// Restart the sidecar (exposed to frontend)
#[tauri::command]
pub async fn restart_sidecar(app: AppHandle) -> Result<(), String> {
    stop_sidecar(&app)?;
    // Small delay to ensure clean shutdown
    std::thread::sleep(Duration::from_millis(500));
    start_sidecar(&app)
}
