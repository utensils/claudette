use std::path::{Path, PathBuf};

use super::image::image_data_url_from_file;
use crate::commands::apps::AppEntry;

pub(super) fn jetbrains_toolbox_script_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    home.map(|home| {
        home.join(".local")
            .join("share")
            .join("JetBrains")
            .join("Toolbox")
            .join("scripts")
    })
    .into_iter()
    .collect()
}

fn desktop_file_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/usr/share/applications"),
        PathBuf::from("/usr/local/share/applications"),
        PathBuf::from("/var/lib/flatpak/exports/share/applications"),
    ];

    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/share/applications"));
        dirs.push(home.join(".local/share/flatpak/exports/share/applications"));
    }

    dirs
}

fn parse_desktop_value(contents: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    contents
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn normalized_match_text(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn desktop_file_matches(
    entry: &AppEntry,
    detected_path: &Path,
    file_stem: &str,
    contents: &str,
) -> bool {
    let exec = parse_desktop_value(contents, "Exec").unwrap_or_default();
    let name = parse_desktop_value(contents, "Name").unwrap_or_default();
    let detected_name = detected_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();

    let mut needles = vec![entry.id.as_str(), entry.name.as_str(), detected_name];
    needles.extend(entry.bin_names.iter().map(String::as_str));

    let desktop_key = normalized_match_text(file_stem);
    let name_key = normalized_match_text(&name);
    let exec_key = normalized_match_text(&exec);

    needles.iter().any(|needle| {
        let key = normalized_match_text(needle);
        !key.is_empty()
            && (desktop_key.contains(&key) || name_key.contains(&key) || exec_key.contains(&key))
    })
}

fn find_linux_desktop_icon_name(entry: &AppEntry, detected_path: &Path) -> Option<String> {
    for dir in desktop_file_dirs() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry_path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
            if !entry_path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("desktop"))
            {
                continue;
            }
            let Ok(contents) = std::fs::read_to_string(&entry_path) else {
                continue;
            };
            let file_stem = entry_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if desktop_file_matches(entry, detected_path, file_stem, &contents) {
                if let Some(icon) = parse_desktop_value(&contents, "Icon") {
                    return Some(icon);
                }
            }
        }
    }
    None
}

fn linux_icon_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/usr/share/pixmaps"),
        PathBuf::from("/usr/share/icons"),
        PathBuf::from("/usr/local/share/icons"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".local/share/icons"));
        roots.push(home.join(".icons"));
    }
    roots
}

fn icon_candidate_score(path: &Path) -> u8 {
    let text = path.to_string_lossy();
    if text.contains("/64x64/") {
        0
    } else if text.contains("/128x128/") {
        1
    } else if text.contains("/256x256/") {
        2
    } else if text.contains("/scalable/") {
        3
    } else if text.ends_with(".png") {
        4
    } else {
        5
    }
}

pub(super) fn find_icon_file_recursive(
    root: &Path,
    icon_name: &str,
    max_depth: usize,
) -> Option<PathBuf> {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut best: Option<PathBuf> = None;
    let mut visited = 0usize;

    while let Some((dir, depth)) = stack.pop() {
        visited += 1;
        if visited > 12_000 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
            if path.is_dir() {
                if depth < max_depth {
                    stack.push((path, depth + 1));
                }
                continue;
            }

            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if stem != icon_name {
                continue;
            }
            if image_data_url_from_file(&path).is_none() {
                continue;
            }

            let replace = best
                .as_ref()
                .is_none_or(|current| icon_candidate_score(&path) < icon_candidate_score(current));
            if replace {
                best = Some(path);
            }
        }
    }

    best
}

fn linux_icon_file_from_name(icon_name: &str) -> Option<PathBuf> {
    let icon_path = PathBuf::from(icon_name);
    if icon_path.is_absolute() && icon_path.exists() {
        return Some(icon_path);
    }

    let direct_names =
        ["png", "svg", "jpg", "jpeg", "webp"].map(|ext| format!("{icon_name}.{ext}"));
    for root in linux_icon_roots() {
        for direct_name in &direct_names {
            let direct = root.join(direct_name);
            if direct.exists() {
                return Some(direct);
            }
        }
        if let Some(path) = find_icon_file_recursive(&root, icon_name, 6) {
            return Some(path);
        }
    }

    None
}

pub(super) fn app_icon_data_url(entry: &AppEntry, detected_path: &Path) -> Option<String> {
    find_linux_desktop_icon_name(entry, detected_path)
        .and_then(|name| linux_icon_file_from_name(&name))
        .and_then(|path| image_data_url_from_file(&path))
}
