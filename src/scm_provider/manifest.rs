use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub required_clis: Vec<String>,
    #[serde(default)]
    pub remote_patterns: Vec<String>,
    pub operations: Vec<String>,
    #[serde(default)]
    pub config_schema: HashMap<String, ConfigField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigField {
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: serde_json::Value,
    #[serde(default)]
    pub options: Vec<String>,
}

/// Parse a plugin manifest from a `plugin.json` file.
pub fn parse_manifest(path: &Path) -> Result<PluginManifest, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_valid_manifest() {
        let json = r#"{
            "name": "github",
            "display_name": "GitHub",
            "version": "1.0.0",
            "description": "GitHub PR and CI status via gh CLI",
            "required_clis": ["gh"],
            "remote_patterns": ["github.com"],
            "operations": ["list_pull_requests", "ci_status"],
            "config_schema": {
                "enterprise_hostname": {
                    "type": "string",
                    "description": "GitHub Enterprise hostname",
                    "required": false
                }
            }
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.name, "github");
        assert_eq!(manifest.display_name, "GitHub");
        assert_eq!(manifest.required_clis, vec!["gh"]);
        assert_eq!(manifest.remote_patterns, vec!["github.com"]);
        assert_eq!(manifest.operations.len(), 2);
        assert!(manifest.config_schema.contains_key("enterprise_hostname"));
    }

    #[test]
    fn test_parse_minimal_manifest() {
        let json = r#"{
            "name": "test",
            "display_name": "Test",
            "version": "0.1.0",
            "description": "A test plugin",
            "operations": ["list_pull_requests"]
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.name, "test");
        assert!(manifest.required_clis.is_empty());
        assert!(manifest.remote_patterns.is_empty());
        assert!(manifest.config_schema.is_empty());
    }

    #[test]
    fn test_parse_invalid_json() {
        let json = "not json at all";
        let result: Result<PluginManifest, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_missing_required_field() {
        let json = r#"{
            "name": "test",
            "display_name": "Test",
            "version": "0.1.0"
        }"#;
        let result: Result<PluginManifest, _> = serde_json::from_str(json);
        assert!(result.is_err()); // missing description and operations
    }
}
