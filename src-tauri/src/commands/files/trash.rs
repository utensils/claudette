use std::path::{Path, PathBuf};

pub(super) async fn trash_path(path: PathBuf) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || trash_path_blocking(&path))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

pub(super) async fn restore_path(
    target: PathBuf,
    undo_token: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || restore_path_blocking(&target, undo_token.as_deref()))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(target_os = "macos")]
fn trash_path_blocking(path: &Path) -> Result<Option<String>, String> {
    trash_path_macos(path).map(Some)
}

#[cfg(not(target_os = "macos"))]
fn trash_path_blocking(path: &Path) -> Result<Option<String>, String> {
    let absolute_for_token = path.to_path_buf();
    trash::delete(path).map_err(|e| format!("move to trash: {e}"))?;
    Ok(find_trash_item_token_for_original(&absolute_for_token))
}

#[cfg(target_os = "macos")]
fn restore_path_blocking(target: &Path, undo_token: Option<&str>) -> Result<(), String> {
    let token = undo_token.ok_or_else(|| "missing trash undo token".to_string())?;
    restore_path_macos(token, target)
}

#[cfg(any(
    target_os = "windows",
    all(
        unix,
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    )
))]
fn restore_path_blocking(target: &Path, undo_token: Option<&str>) -> Result<(), String> {
    let items = trash::os_limited::list().map_err(|e| format!("list trash: {e}"))?;
    let item = select_trash_item(items, target, undo_token)
        .ok_or_else(|| "trash item not found".to_string())?;
    trash::os_limited::restore_all(vec![item]).map_err(|e| format!("restore: {e}"))
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "windows",
    all(unix, not(target_os = "ios"), not(target_os = "android"))
)))]
fn restore_path_blocking(_target: &Path, _undo_token: Option<&str>) -> Result<(), String> {
    Err("trash restore is not supported on this platform".to_string())
}

#[cfg(target_os = "macos")]
fn trash_path_macos(path: &Path) -> Result<String, String> {
    let trash_dir = home_trash_dir()?;
    std::fs::create_dir_all(&trash_dir).map_err(|e| format!("create trash dir: {e}"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "path has no file name".to_string())?;
    let mut target = trash_dir.join(file_name);
    if target.exists() {
        let stem = path.file_stem().unwrap_or(file_name).to_string_lossy();
        let ext = path.extension().map(|ext| ext.to_string_lossy());
        for idx in 1..10_000 {
            let candidate_name = match &ext {
                Some(ext) if !ext.is_empty() => format!("{stem} {idx}.{ext}"),
                _ => format!("{stem} {idx}"),
            };
            let candidate = trash_dir.join(candidate_name);
            if !candidate.exists() {
                target = candidate;
                break;
            }
        }
    }
    if target.exists() {
        return Err("could not choose a unique trash name".to_string());
    }
    move_to_trash_path_macos(path, &target)?;
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
fn move_to_trash_path_macos(path: &Path, target: &Path) -> Result<(), String> {
    match std::fs::rename(path, target) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_to_trash_path_macos(path, target)?;
            let remove_result = if path.is_dir() {
                std::fs::remove_dir_all(path).map_err(|e| format!("remove trashed dir: {e}"))
            } else {
                std::fs::remove_file(path).map_err(|e| format!("remove trashed file: {e}"))
            };
            if let Err(err) = remove_result {
                cleanup_trash_copy_macos(target);
                return Err(err);
            }
            Ok(())
        }
        Err(err) => Err(format!("move to trash: {err}")),
    }
}

#[cfg(target_os = "macos")]
fn copy_to_trash_path_macos(path: &Path, target: &Path) -> Result<(), String> {
    let result = if path.is_dir() {
        copy_dir_all_macos(path, target)
    } else {
        std::fs::copy(path, target)
            .map(|_| ())
            .map_err(|e| format!("copy to trash: {e}"))
    };
    if result.is_err() {
        let _ = if target.is_dir() {
            std::fs::remove_dir_all(target)
        } else {
            std::fs::remove_file(target)
        };
    }
    result
}

#[cfg(target_os = "macos")]
fn cleanup_trash_copy_macos(target: &Path) {
    let Ok(metadata) = std::fs::symlink_metadata(target) else {
        return;
    };
    let _ = if metadata.is_dir() {
        std::fs::remove_dir_all(target)
    } else {
        std::fs::remove_file(target)
    };
}

#[cfg(target_os = "macos")]
fn copy_dir_all_macos(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir(target).map_err(|e| format!("copy trash dir: {e}"))?;
    for entry in std::fs::read_dir(source).map_err(|e| format!("read dir: {e}"))? {
        let entry = entry.map_err(|e| format!("read dir entry: {e}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("read file type: {e}"))?;
        if file_type.is_dir() {
            copy_dir_all_macos(&source_path, &target_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&source_path, &target_path)
                .map_err(|e| format!("copy trash file: {e}"))?;
        } else if file_type.is_symlink() {
            let link_target =
                std::fs::read_link(&source_path).map_err(|e| format!("read symlink: {e}"))?;
            std::os::unix::fs::symlink(link_target, &target_path)
                .map_err(|e| format!("copy trash symlink: {e}"))?;
        } else {
            return Err(format!(
                "unsupported file type at {}",
                source_path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn restore_path_macos(undo_token: &str, target: &Path) -> Result<(), String> {
    let trash_dir = home_trash_dir()?;
    let trash_path = PathBuf::from(undo_token);
    // The undo token is a path supplied by the frontend, so canonicalize it and
    // verify Trash containment before restoring anything from it.
    let trash_canonical =
        std::fs::canonicalize(&trash_path).map_err(|e| format!("trash item not found: {e}"))?;
    let trash_dir_canonical =
        std::fs::canonicalize(&trash_dir).map_err(|e| format!("canonicalize trash dir: {e}"))?;
    if !trash_canonical.starts_with(&trash_dir_canonical) {
        return Err("trash undo token is outside the Trash".to_string());
    }
    std::fs::rename(&trash_canonical, target).map_err(|e| format!("restore from trash: {e}"))
}

#[cfg(target_os = "macos")]
fn home_trash_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".Trash"))
}

#[cfg(not(target_os = "macos"))]
fn find_trash_item_token_for_original(original_path: &Path) -> Option<String> {
    #[cfg(any(
        target_os = "windows",
        all(unix, not(target_os = "ios"), not(target_os = "android"))
    ))]
    {
        let original = original_path
            .canonicalize()
            .unwrap_or_else(|_| original_path.to_path_buf());
        let mut items: Vec<_> = trash::os_limited::list()
            .ok()?
            .into_iter()
            .filter(|item| item.original_path() == original)
            .collect();
        // Some platforms expose coarse deletion timestamps, so two rapid
        // deletes of the same original path can be ambiguous. Prefer the
        // newest item as the best available restore token.
        items.sort_by_key(|item| item.time_deleted);
        return items
            .pop()
            .map(|item| item.id.to_string_lossy().into_owned());
    }

    #[cfg(not(any(
        target_os = "windows",
        all(unix, not(target_os = "ios"), not(target_os = "android"))
    )))]
    {
        let _ = original_path;
        None
    }
}

#[cfg(any(
    target_os = "windows",
    all(
        unix,
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    )
))]
fn select_trash_item(
    items: Vec<trash::TrashItem>,
    original_path: &Path,
    undo_token: Option<&str>,
) -> Option<trash::TrashItem> {
    let mut matches: Vec<_> = items
        .into_iter()
        .filter(|item| {
            let token_matches = undo_token
                .map(|token| item.id.to_string_lossy() == token)
                .unwrap_or(false);
            token_matches || item.original_path() == original_path
        })
        .collect();
    matches.sort_by_key(|item| item.time_deleted);
    matches.pop()
}
