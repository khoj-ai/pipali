use std::time::Duration;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::{show_window, start_sidecar, stop_sidecar, SidecarState};

// Versioned so we can rotate the hash space if the derivation ever changes.
const FINGERPRINT_SALT: &str = "pipali-device-fingerprint-v1";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedFileInfo {
    pub file_path: String,
    pub file_name: String,
    pub size_bytes: u64,
}

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

/// The server's settings token, which the settings page presents to change what the sandbox allows
#[tauri::command]
pub fn get_settings_token(state: State<'_, SidecarState>) -> Option<String> {
    state.settings_token.lock().unwrap().clone()
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

/// Reject machine IDs that don't uniquely identify a device: empty, the systemd
/// first-boot placeholder "uninitialized", or all-zero (forbidden by the machine-id
/// spec and shared across un-reset VM/disk clones).
fn is_degenerate_machine_id(machine_id: &str) -> bool {
    let id = machine_id.trim();
    if id.is_empty() || id.eq_ignore_ascii_case("uninitialized") {
        return true;
    }
    // All-zero once GUID separators are stripped (Linux 32×'0' or the zero GUID).
    id.chars().all(|c| c == '0' || c == '-')
}

/// Return a stable, salted hash of the OS machine identifier.
/// Sent to the platform as an anti-abuse signal.
/// Returns `None` if the machine ID cannot be read or isn't device-unique.
#[tauri::command]
pub fn get_device_fingerprint() -> Option<String> {
    let machine_id = machine_uid::get().ok()?;
    if is_degenerate_machine_id(&machine_id) {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(FINGERPRINT_SALT.as_bytes());
    hasher.update(b":");
    hasher.update(machine_id.as_bytes());
    Some(hex::encode(hasher.finalize()))
}

/// Read metadata for dropped files
#[tauri::command]
pub async fn get_dropped_file_metadata(paths: Vec<String>) -> Result<Vec<AttachedFileInfo>, String> {
    let mut results = Vec::new();
    for source_path_str in paths {
        let source = std::path::PathBuf::from(&source_path_str);
        if !source.exists() || !source.is_file() {
            continue;
        }

        let file_name = source
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        let metadata = std::fs::metadata(&source)
            .map_err(|e| format!("Failed to read metadata for {}: {}", source_path_str, e))?;

        results.push(AttachedFileInfo {
            file_path: source_path_str,
            file_name,
            size_bytes: metadata.len(),
        });
    }

    Ok(results)
}
