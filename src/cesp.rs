use std::collections::{HashMap, VecDeque};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rand::seq::SliceRandom;

use crate::model::cesp::{CespManifest, CespSound, InstalledPack, InstalledPackMeta, RegistryPack};

const MANIFEST_FILE: &str = "openpeon.json";
const META_FILE: &str = "_meta.json";
const MAX_ALIAS_DEPTH: usize = 5;
const NO_REPEAT_WINDOW: usize = 3;

fn validate_pack_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.starts_with('.')
    {
        return Err(format!("Invalid pack name: {name:?}"));
    }
    Ok(())
}

pub fn packs_dir() -> PathBuf {
    let base = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claudette")
        .join("packs");
    let _ = std::fs::create_dir_all(&base);
    base
}

pub fn load_manifest(pack_dir: &Path) -> Result<CespManifest, String> {
    let path = pack_dir.join(MANIFEST_FILE);
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

pub fn resolve_category<'a>(manifest: &'a CespManifest, category: &str) -> Option<&'a [CespSound]> {
    if let Some(cat) = manifest.categories.get(category)
        && !cat.sounds.is_empty()
    {
        return Some(&cat.sounds);
    }
    let mut target = category.to_string();
    for _ in 0..MAX_ALIAS_DEPTH {
        match manifest.category_aliases.get(&target) {
            Some(alias_target) => {
                if let Some(cat) = manifest.categories.get(alias_target)
                    && !cat.sounds.is_empty()
                {
                    return Some(&cat.sounds);
                }
                target = alias_target.clone();
            }
            None => return None,
        }
    }
    None
}

pub fn list_installed() -> Result<Vec<InstalledPack>, String> {
    let dir = packs_dir();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Cannot read packs dir: {e}"))?;
    let mut packs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) if !n.starts_with('_') => n.to_string(),
            _ => continue,
        };
        let manifest = match load_manifest(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let meta = load_meta(&path);
        let sound_count: u32 = manifest
            .categories
            .values()
            .map(|c| c.sounds.len() as u32)
            .sum();
        let categories: Vec<String> = manifest.categories.keys().cloned().collect();
        let display_name = manifest
            .display_name
            .clone()
            .unwrap_or_else(|| manifest.name.clone());
        packs.push(InstalledPack {
            name,
            display_name,
            version: manifest.version.clone(),
            categories,
            sound_count,
            installed_ref: meta.map(|m| m.source_ref),
            update_available: false,
        });
    }
    packs.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    Ok(packs)
}

fn load_meta(pack_dir: &Path) -> Option<InstalledPackMeta> {
    let data = std::fs::read_to_string(pack_dir.join(META_FILE)).ok()?;
    serde_json::from_str(&data).ok()
}

pub fn install_pack(
    registry_entry: &RegistryPack,
    tarball_bytes: &[u8],
) -> Result<InstalledPack, String> {
    validate_pack_name(&registry_entry.name)?;

    let base = packs_dir();
    let pack_dir = base.join(&registry_entry.name);
    let staging_dir = base.join(format!("_staging_{}", registry_entry.name));

    if staging_dir.exists() {
        let _ = std::fs::remove_dir_all(&staging_dir);
    }
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Failed to create staging dir: {e}"))?;

    let cleanup_staging = || {
        let _ = std::fs::remove_dir_all(&staging_dir);
    };

    if let Err(e) = extract_tarball(tarball_bytes, &staging_dir, &registry_entry.source_path) {
        cleanup_staging();
        return Err(e);
    }

    let manifest = match load_manifest(&staging_dir) {
        Ok(m) => m,
        Err(e) => {
            cleanup_staging();
            return Err(format!("Pack missing valid {MANIFEST_FILE}: {e}"));
        }
    };

    let meta = InstalledPackMeta {
        source_repo: registry_entry.source_repo.clone(),
        source_ref: registry_entry.source_ref.clone(),
        installed_at: chrono_now_iso(),
    };
    let meta_json = serde_json::to_string_pretty(&meta)
        .map_err(|e| format!("Failed to serialize meta: {e}"))?;
    if let Err(e) = std::fs::write(staging_dir.join(META_FILE), meta_json) {
        cleanup_staging();
        return Err(format!("Failed to write {META_FILE}: {e}"));
    }

    if pack_dir.exists() {
        std::fs::remove_dir_all(&pack_dir)
            .map_err(|e| format!("Failed to remove existing pack: {e}"))?;
    }
    std::fs::rename(&staging_dir, &pack_dir).map_err(|e| {
        cleanup_staging();
        format!("Failed to finalize pack install: {e}")
    })?;

    let sound_count: u32 = manifest
        .categories
        .values()
        .map(|c| c.sounds.len() as u32)
        .sum();
    let categories: Vec<String> = manifest.categories.keys().cloned().collect();
    let display_name = manifest
        .display_name
        .clone()
        .unwrap_or_else(|| manifest.name.clone());

    Ok(InstalledPack {
        name: registry_entry.name.clone(),
        display_name,
        version: manifest.version,
        categories,
        sound_count,
        installed_ref: Some(registry_entry.source_ref.clone()),
        update_available: false,
    })
}

pub fn delete_pack(name: &str) -> Result<(), String> {
    validate_pack_name(name)?;
    let base = packs_dir();
    let pack_dir = base.join(name);
    let canonical_base = base.canonicalize().unwrap_or_else(|_| base.clone());
    let canonical_pack = pack_dir.canonicalize().unwrap_or_else(|_| pack_dir.clone());
    if !canonical_pack.starts_with(&canonical_base) {
        return Err(format!("Invalid pack path for '{name}'"));
    }
    if !pack_dir.exists() {
        return Err(format!("Pack '{name}' is not installed"));
    }
    std::fs::remove_dir_all(&pack_dir).map_err(|e| format!("Failed to delete pack: {e}"))
}

fn extract_tarball(data: &[u8], target_dir: &Path, source_path: &str) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(Cursor::new(data));
    let mut archive = tar::Archive::new(decoder);

    for entry in archive.entries().map_err(|e| format!("Bad tarball: {e}"))? {
        let mut entry = entry.map_err(|e| format!("Bad tarball entry: {e}"))?;
        let raw_path = entry
            .path()
            .map_err(|e| format!("Bad path in tarball: {e}"))?
            .into_owned();

        let components: Vec<_> = raw_path.components().collect();
        if components.len() <= 1 {
            continue;
        }
        // Strip top-level directory (GitHub tarball wrapping)
        let inner: PathBuf = components[1..].iter().collect();
        let inner_str = inner.to_string_lossy();

        // Only extract files under the source_path subdirectory
        let relative = if source_path.is_empty() || source_path == "." {
            inner.clone()
        } else if let Ok(rel) = inner.strip_prefix(source_path) {
            rel.to_path_buf()
        } else {
            continue;
        };

        if relative.as_os_str().is_empty() {
            continue;
        }

        let dest = target_dir.join(&relative);

        // Path traversal guard
        let canonical_target = target_dir
            .canonicalize()
            .unwrap_or_else(|_| target_dir.to_path_buf());
        let dest_parent = dest.parent().unwrap_or(target_dir);
        let _ = std::fs::create_dir_all(dest_parent);
        let canonical_dest = dest
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .unwrap_or_else(|| dest_parent.to_path_buf());
        if !canonical_dest.starts_with(&canonical_target) {
            return Err(format!("Path traversal detected: {}", inner_str));
        }

        if entry.header().entry_type().is_dir() {
            let _ = std::fs::create_dir_all(&dest);
        } else if entry.header().entry_type().is_file() {
            let mut out = std::fs::File::create(&dest)
                .map_err(|e| format!("Failed to create {}: {e}", dest.display()))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| format!("Failed to write {}: {e}", dest.display()))?;
        }
    }

    Ok(())
}

fn chrono_now_iso() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let days = secs / 86400;
    let day_secs = secs % 86400;
    let hours = day_secs / 3600;
    let mins = (day_secs % 3600) / 60;
    let s = day_secs % 60;
    // Approximate date from epoch days (good enough for a timestamp)
    let (year, month, day) = epoch_days_to_date(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{mins:02}:{s:02}Z")
}

fn epoch_days_to_date(days: u64) -> (u64, u64, u64) {
    // Algorithm from Howard Hinnant's civil_from_days
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

pub fn notification_event_to_cesp_category(event: &str) -> &str {
    match event {
        "ask" => "input.required",
        "plan" => "task.acknowledge",
        "finished" => "task.complete",
        "error" => "task.error",
        "session_start" => "session.start",
        _ => "input.required",
    }
}

pub struct SoundPlaybackState {
    recent: HashMap<String, VecDeque<usize>>,
    last_played: HashMap<String, Instant>,
}

impl SoundPlaybackState {
    pub fn new() -> Self {
        Self {
            recent: HashMap::new(),
            last_played: HashMap::new(),
        }
    }

    pub fn pick_sound<'a>(
        &mut self,
        category: &str,
        sounds: &'a [CespSound],
        debounce: Duration,
    ) -> Option<&'a CespSound> {
        if sounds.is_empty() {
            return None;
        }

        if let Some(last) = self.last_played.get(category)
            && last.elapsed() < debounce
        {
            return None;
        }

        let recent = self.recent.entry(category.to_string()).or_default();

        let mut candidates: Vec<usize> =
            (0..sounds.len()).filter(|i| !recent.contains(i)).collect();

        if candidates.is_empty() {
            recent.clear();
            candidates = (0..sounds.len()).collect();
        }

        let mut rng = rand::thread_rng();
        let &idx = candidates.choose(&mut rng)?;

        while recent.len() >= NO_REPEAT_WINDOW {
            recent.pop_front();
        }
        recent.push_back(idx);
        self.last_played
            .insert(category.to_string(), Instant::now());

        Some(&sounds[idx])
    }
}

impl Default for SoundPlaybackState {
    fn default() -> Self {
        Self::new()
    }
}

pub fn resolve_sound_file(pack_dir: &Path, sound: &CespSound) -> PathBuf {
    let file = &sound.file;
    if file.contains('/') {
        pack_dir.join(file)
    } else {
        pack_dir.join("sounds").join(file)
    }
}

pub fn play_audio_file(path: &Path, volume: f64) {
    if !volume.is_finite() || !path.exists() {
        return;
    }
    let volume = volume.clamp(0.0, 1.0);
    if volume <= 0.0 {
        return;
    }

    #[cfg(target_os = "macos")]
    {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let result = if ext == "ogg" || ext == "oga" {
            std::process::Command::new("ffplay")
                .args(["-nodisp", "-autoexit", "-volume"])
                .arg(format!("{}", (volume * 100.0) as u32))
                .arg(path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
        } else {
            std::process::Command::new("afplay")
                .arg("-v")
                .arg(format!("{volume}"))
                .arg(path)
                .spawn()
        };
        if let Ok(child) = result {
            spawn_and_reap(child);
        }
    }

    #[cfg(target_os = "linux")]
    {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let result = if ext == "mp3" {
            std::process::Command::new("ffplay")
                .args(["-nodisp", "-autoexit", "-volume"])
                .arg(format!("{}", (volume * 100.0) as u32))
                .arg(path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
        } else {
            let pa_volume = (volume * 65536.0) as u32;
            std::process::Command::new("paplay")
                .arg("--volume")
                .arg(pa_volume.to_string())
                .arg(path)
                .spawn()
                .or_else(|_| {
                    std::process::Command::new("ffplay")
                        .args(["-nodisp", "-autoexit", "-volume"])
                        .arg(format!("{}", (volume * 100.0) as u32))
                        .arg(path)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn()
                })
        };
        if let Ok(child) = result {
            spawn_and_reap(child);
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (path, volume);
    }
}

fn spawn_and_reap(mut child: std::process::Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

pub fn play_cesp_sound_for_event_with_state(
    event: &str,
    playback: &mut SoundPlaybackState,
    db_get: &dyn Fn(&str) -> Option<String>,
) {
    let sound_source = db_get("sound_source").unwrap_or_else(|| "system".to_string());
    if sound_source != "openpeon" {
        return;
    }

    let muted = db_get("cesp_muted").unwrap_or_else(|| "false".to_string());
    if muted == "true" {
        return;
    }

    let pack_name = match db_get("cesp_active_pack") {
        Some(name) if !name.is_empty() => name,
        _ => return,
    };

    let volume: f64 = db_get("cesp_volume")
        .and_then(|v| v.parse().ok())
        .unwrap_or(1.0);

    let pack_dir = packs_dir().join(&pack_name);
    let manifest = match load_manifest(&pack_dir) {
        Ok(m) => m,
        Err(_) => return,
    };

    let category = notification_event_to_cesp_category(event);
    let sounds = match resolve_category(&manifest, category) {
        Some(s) => s,
        None => return,
    };

    if let Some(sound) = playback.pick_sound(category, sounds, Duration::from_millis(500)) {
        let file_path = resolve_sound_file(&pack_dir, sound);
        play_audio_file(&file_path, volume);
    }
}

pub fn play_cesp_sound_for_event(event: &str, db_get: &dyn Fn(&str) -> Option<String>) {
    let mut playback = SoundPlaybackState::new();
    play_cesp_sound_for_event_with_state(event, &mut playback, db_get);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::cesp::{CespCategorySounds, CespSound};

    fn make_manifest() -> CespManifest {
        let mut categories = HashMap::new();
        categories.insert(
            "task.complete".to_string(),
            CespCategorySounds {
                sounds: vec![
                    CespSound {
                        file: "sounds/done1.wav".to_string(),
                        label: Some("Done 1".to_string()),
                    },
                    CespSound {
                        file: "sounds/done2.wav".to_string(),
                        label: Some("Done 2".to_string()),
                    },
                    CespSound {
                        file: "sounds/done3.wav".to_string(),
                        label: Some("Done 3".to_string()),
                    },
                    CespSound {
                        file: "sounds/done4.wav".to_string(),
                        label: Some("Done 4".to_string()),
                    },
                ],
            },
        );
        categories.insert(
            "input.required".to_string(),
            CespCategorySounds {
                sounds: vec![CespSound {
                    file: "sounds/what.wav".to_string(),
                    label: None,
                }],
            },
        );
        let mut aliases = HashMap::new();
        aliases.insert("complete".to_string(), "task.complete".to_string());
        aliases.insert("greeting".to_string(), "session.start".to_string());

        CespManifest {
            cesp_version: "1.0".to_string(),
            name: "test-pack".to_string(),
            display_name: Some("Test Pack".to_string()),
            version: "1.0.0".to_string(),
            categories,
            category_aliases: aliases,
        }
    }

    #[test]
    fn resolve_direct_category() {
        let m = make_manifest();
        let sounds = resolve_category(&m, "task.complete").unwrap();
        assert_eq!(sounds.len(), 4);
    }

    #[test]
    fn resolve_via_alias() {
        let m = make_manifest();
        let sounds = resolve_category(&m, "complete").unwrap();
        assert_eq!(sounds.len(), 4);
    }

    #[test]
    fn resolve_missing_category_returns_none() {
        let m = make_manifest();
        assert!(resolve_category(&m, "session.end").is_none());
    }

    #[test]
    fn resolve_alias_to_missing_category_returns_none() {
        let m = make_manifest();
        assert!(resolve_category(&m, "greeting").is_none());
    }

    #[test]
    fn pick_sound_no_repeat() {
        let sounds: Vec<CespSound> = (0..4)
            .map(|i| CespSound {
                file: format!("s{i}.wav"),
                label: None,
            })
            .collect();
        let mut state = SoundPlaybackState::new();
        let debounce = Duration::from_millis(0);

        let mut seen = std::collections::HashSet::new();
        for _ in 0..20 {
            let s = state.pick_sound("cat", &sounds, debounce).unwrap();
            seen.insert(s.file.clone());
        }
        assert_eq!(seen.len(), 4);
    }

    #[test]
    fn pick_sound_single_sound_always_works() {
        let sounds = vec![CespSound {
            file: "only.wav".to_string(),
            label: None,
        }];
        let mut state = SoundPlaybackState::new();
        let debounce = Duration::from_millis(0);

        for _ in 0..5 {
            let s = state.pick_sound("cat", &sounds, debounce).unwrap();
            assert_eq!(s.file, "only.wav");
        }
    }

    #[test]
    fn pick_sound_debounce() {
        let sounds = vec![CespSound {
            file: "a.wav".to_string(),
            label: None,
        }];
        let mut state = SoundPlaybackState::new();

        let first = state.pick_sound("cat", &sounds, Duration::from_secs(10));
        assert!(first.is_some());

        let second = state.pick_sound("cat", &sounds, Duration::from_secs(10));
        assert!(second.is_none());
    }

    #[test]
    fn pick_sound_empty_sounds() {
        let mut state = SoundPlaybackState::new();
        assert!(
            state
                .pick_sound("cat", &[], Duration::from_millis(0))
                .is_none()
        );
    }

    #[test]
    fn event_to_category_mapping() {
        assert_eq!(notification_event_to_cesp_category("ask"), "input.required");
        assert_eq!(
            notification_event_to_cesp_category("plan"),
            "task.acknowledge"
        );
        assert_eq!(
            notification_event_to_cesp_category("finished"),
            "task.complete"
        );
        assert_eq!(notification_event_to_cesp_category("error"), "task.error");
        assert_eq!(
            notification_event_to_cesp_category("session_start"),
            "session.start"
        );
    }

    #[test]
    fn resolve_sound_file_with_slash() {
        let sound = CespSound {
            file: "sounds/hello.wav".to_string(),
            label: None,
        };
        let result = resolve_sound_file(Path::new("/packs/peon"), &sound);
        assert_eq!(result, PathBuf::from("/packs/peon/sounds/hello.wav"));
    }

    #[test]
    fn resolve_sound_file_without_slash() {
        let sound = CespSound {
            file: "hello.wav".to_string(),
            label: None,
        };
        let result = resolve_sound_file(Path::new("/packs/peon"), &sound);
        assert_eq!(result, PathBuf::from("/packs/peon/sounds/hello.wav"));
    }

    #[test]
    fn extract_tarball_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("extracted");
        std::fs::create_dir_all(&target).unwrap();

        // Build a minimal tarball with a top-level wrapper dir
        let mut builder = tar::Builder::new(Vec::new());
        let data = b"test content";
        let mut header = tar::Header::new_gnu();
        header.set_path("repo-v1.0.0/mypack/openpeon.json").unwrap();
        header.set_size(data.len() as u64);
        header.set_cksum();
        builder.append(&header, &data[..]).unwrap();

        let data2 = b"wav bytes";
        let mut header2 = tar::Header::new_gnu();
        header2
            .set_path("repo-v1.0.0/mypack/sounds/hello.wav")
            .unwrap();
        header2.set_size(data2.len() as u64);
        header2.set_cksum();
        builder.append(&header2, &data2[..]).unwrap();

        let raw = builder.into_inner().unwrap();

        // Compress
        use flate2::write::GzEncoder;
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&raw).unwrap();
        let gz = encoder.finish().unwrap();

        extract_tarball(&gz, &target, "mypack").unwrap();

        assert!(target.join("openpeon.json").exists());
        assert!(target.join("sounds/hello.wav").exists());
        assert_eq!(
            std::fs::read_to_string(target.join("openpeon.json")).unwrap(),
            "test content"
        );
    }

    #[test]
    fn epoch_days_to_date_known_values() {
        assert_eq!(epoch_days_to_date(0), (1970, 1, 1));
        assert_eq!(epoch_days_to_date(18627), (2020, 12, 31));
    }

    #[test]
    fn validate_pack_name_rejects_traversal() {
        assert!(validate_pack_name("../escape").is_err());
        assert!(validate_pack_name("foo/bar").is_err());
        assert!(validate_pack_name("foo\\bar").is_err());
        assert!(validate_pack_name(".hidden").is_err());
        assert!(validate_pack_name("").is_err());
    }

    #[test]
    fn validate_pack_name_accepts_valid() {
        assert!(validate_pack_name("peon-classic").is_ok());
        assert!(validate_pack_name("glados_v2").is_ok());
    }
}
