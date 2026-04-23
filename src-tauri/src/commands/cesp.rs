use tauri::State;

use claudette::cesp;
use claudette::db::Database;
use claudette::model::cesp::{InstalledPack, RegistryIndex, RegistryPack};

use crate::state::AppState;

const REGISTRY_URL: &str = "https://peonping.github.io/registry/index.json";

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[tauri::command]
pub async fn cesp_fetch_registry() -> Result<Vec<RegistryPack>, String> {
    let resp = http_client()
        .get(REGISTRY_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch registry: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Registry returned HTTP {status}"));
    }
    let index: RegistryIndex = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse registry: {e}"))?;
    Ok(index.packs)
}

#[tauri::command]
pub async fn cesp_list_installed() -> Result<Vec<InstalledPack>, String> {
    cesp::list_installed()
}

#[tauri::command]
pub async fn cesp_install_pack(
    name: String,
    source_repo: String,
    source_ref: String,
    source_path: String,
) -> Result<InstalledPack, String> {
    let tarball_url =
        format!("https://github.com/{source_repo}/archive/refs/tags/{source_ref}.tar.gz");
    let resp = http_client()
        .get(&tarball_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download pack: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Failed to download pack: HTTP {status}"));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read pack data: {e}"))?;

    let entry = RegistryPack {
        name,
        display_name: String::new(),
        description: None,
        language: None,
        source_repo,
        source_ref,
        source_path,
        categories: Vec::new(),
        sound_count: 0,
        total_size_bytes: 0,
    };

    cesp::install_pack(&entry, &bytes)
}

#[tauri::command]
pub async fn cesp_update_pack(
    name: String,
    source_repo: String,
    source_ref: String,
    source_path: String,
) -> Result<InstalledPack, String> {
    cesp_install_pack(name, source_repo, source_ref, source_path).await
}

#[tauri::command]
pub async fn cesp_delete_pack(name: String) -> Result<(), String> {
    cesp::delete_pack(&name)
}

#[tauri::command]
pub async fn cesp_preview_sound(
    pack_name: String,
    category: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let volume: f64 = db
        .get_app_setting("cesp_volume")
        .ok()
        .flatten()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1.0);

    cesp::validate_pack_name(&pack_name)?;
    let pack_dir = cesp::packs_dir().join(&pack_name);
    let manifest = cesp::load_manifest(&pack_dir)?;
    let sounds = cesp::resolve_category(&manifest, &category)
        .ok_or_else(|| format!("No sounds for category '{category}'"))?;

    let mut playback = state
        .cesp_playback
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    let preview_category = format!("preview:{category}");
    let sound = playback
        .pick_sound(&preview_category, sounds, std::time::Duration::ZERO)
        .ok_or("No sound available")?;

    if let Some(file_path) = cesp::resolve_sound_file(&pack_dir, sound) {
        cesp::play_audio_file(&file_path, volume);
    }
    Ok(())
}

#[tauri::command]
pub async fn cesp_play_for_event(
    event_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    let db_get = |key: &str| -> Option<String> { db.get_app_setting(key).ok().flatten() };

    let sound_source = db_get("sound_source").unwrap_or_else(|| "system".to_string());
    if sound_source != "openpeon" {
        return Ok(());
    }

    let muted = db_get("cesp_muted").unwrap_or_else(|| "false".to_string());
    if muted == "true" {
        return Ok(());
    }

    let pack_name = match db_get("cesp_active_pack") {
        Some(name) if !name.is_empty() => name,
        _ => return Ok(()),
    };

    let volume: f64 = db_get("cesp_volume")
        .and_then(|v| v.parse().ok())
        .unwrap_or(1.0);

    if cesp::validate_pack_name(&pack_name).is_err() {
        return Ok(());
    }
    let pack_dir = cesp::packs_dir().join(&pack_name);
    let manifest = match cesp::load_manifest(&pack_dir) {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };

    let category = cesp::notification_event_to_cesp_category(&event_name);
    let sounds = match cesp::resolve_category(&manifest, category) {
        Some(s) => s,
        None => return Ok(()),
    };

    let mut playback = state
        .cesp_playback
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    if let Some(sound) =
        playback.pick_sound(category, sounds, std::time::Duration::from_millis(500))
    {
        if let Some(file_path) = cesp::resolve_sound_file(&pack_dir, sound) {
            cesp::play_audio_file(&file_path, volume);
        }
    }

    Ok(())
}
