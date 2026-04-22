use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CespSound {
    pub file: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CespCategorySounds {
    pub sounds: Vec<CespSound>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CespManifest {
    pub cesp_version: String,
    pub name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub version: String,
    #[serde(default)]
    pub categories: HashMap<String, CespCategorySounds>,
    #[serde(default)]
    pub category_aliases: HashMap<String, String>,
}

/// Top-level registry index envelope (`index.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryIndex {
    #[serde(default)]
    pub version: u32,
    pub packs: Vec<RegistryPack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryPack {
    pub name: String,
    pub display_name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    pub source_repo: String,
    pub source_ref: String,
    pub source_path: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub sound_count: u32,
    #[serde(default)]
    pub total_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledPackMeta {
    pub source_repo: String,
    pub source_ref: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledPack {
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub categories: Vec<String>,
    pub sound_count: u32,
    #[serde(default)]
    pub installed_ref: Option<String>,
    pub update_available: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_manifest_minimal() {
        let json = r#"{
            "cesp_version": "1.0",
            "name": "test",
            "version": "1.0.0",
            "categories": {}
        }"#;
        let m: CespManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.name, "test");
        assert_eq!(m.cesp_version, "1.0");
        assert!(m.display_name.is_none());
        assert!(m.category_aliases.is_empty());
    }

    #[test]
    fn parse_manifest_full() {
        let json = r#"{
            "cesp_version": "1.0",
            "name": "peon",
            "display_name": "Warcraft Peon",
            "version": "1.0.0",
            "categories": {
                "session.start": {
                    "sounds": [
                        { "file": "sounds/Hello.wav", "label": "Something need doing?" },
                        { "file": "sounds/ReadyToWork.wav", "label": "Ready to work!" }
                    ]
                },
                "task.complete": {
                    "sounds": [
                        { "file": "sounds/JobsDone.wav", "label": "Job's done!" }
                    ]
                }
            },
            "category_aliases": {
                "greeting": "session.start",
                "complete": "task.complete"
            }
        }"#;
        let m: CespManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.display_name.as_deref(), Some("Warcraft Peon"));
        assert_eq!(m.categories.len(), 2);
        assert_eq!(m.categories["session.start"].sounds.len(), 2);
        assert_eq!(m.category_aliases["greeting"], "session.start");
    }

    #[test]
    fn parse_registry_pack() {
        let json = r#"{
            "name": "glados",
            "display_name": "GLaDOS",
            "source_repo": "PeonPing/og-packs",
            "source_ref": "v1.1.0",
            "source_path": "glados",
            "categories": ["session.start", "task.complete", "task.error", "input.required"],
            "sound_count": 28,
            "total_size_bytes": 1843200
        }"#;
        let p: RegistryPack = serde_json::from_str(json).unwrap();
        assert_eq!(p.name, "glados");
        assert_eq!(p.sound_count, 28);
        assert_eq!(p.categories.len(), 4);
    }
}
