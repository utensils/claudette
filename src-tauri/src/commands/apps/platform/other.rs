use std::path::{Path, PathBuf};

use crate::commands::apps::AppEntry;

pub(super) fn jetbrains_toolbox_script_dirs(_home: Option<&Path>) -> Vec<PathBuf> {
    Vec::new()
}

pub(super) fn app_icon_data_url(_entry: &AppEntry, _detected_path: &Path) -> Option<String> {
    None
}
