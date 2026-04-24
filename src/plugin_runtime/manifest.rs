use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Plugin kind — drives which dispatcher consumes the plugin.
///
/// Defaults to [`PluginKind::Scm`] for backwards compatibility with
/// manifests written before this field existed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum PluginKind {
    #[default]
    Scm,
    EnvProvider,
}

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
    #[serde(default)]
    pub kind: PluginKind,
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

    #[test]
    fn test_manifest_defaults_to_scm_kind() {
        // Existing manifests in the wild don't have a `kind` field — parsing
        // must succeed and default to Scm for backwards compatibility.
        let json = r#"{
            "name": "legacy",
            "display_name": "Legacy",
            "version": "1.0.0",
            "description": "No kind field",
            "operations": ["list_pull_requests"]
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.kind, PluginKind::Scm);
    }

    #[test]
    fn test_manifest_parses_env_provider_kind() {
        let json = r#"{
            "name": "env-direnv",
            "display_name": "direnv",
            "version": "1.0.0",
            "description": "direnv env provider",
            "kind": "env-provider",
            "operations": ["detect", "export"]
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.kind, PluginKind::EnvProvider);
    }

    #[test]
    fn test_manifest_rejects_unknown_kind() {
        let json = r#"{
            "name": "weird",
            "display_name": "Weird",
            "version": "1.0.0",
            "description": "Unknown kind",
            "kind": "frobnicator",
            "operations": []
        }"#;
        let result: Result<PluginManifest, _> = serde_json::from_str(json);
        assert!(result.is_err(), "unknown kind should fail to parse");
    }

    #[test]
    fn test_manifest_roundtrips_env_provider_kind() {
        let manifest = PluginManifest {
            name: "env-mise".into(),
            display_name: "mise".into(),
            version: "1.0.0".into(),
            description: "mise env provider".into(),
            required_clis: vec!["mise".into()],
            remote_patterns: vec![],
            operations: vec!["detect".into(), "export".into()],
            config_schema: HashMap::new(),
            kind: PluginKind::EnvProvider,
        };
        let json = serde_json::to_string(&manifest).unwrap();
        assert!(
            json.contains(r#""kind":"env-provider""#),
            "serialized kind should be kebab-case: {json}"
        );
        let round: PluginManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(round.kind, PluginKind::EnvProvider);
    }
}
