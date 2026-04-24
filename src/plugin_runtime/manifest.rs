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
    /// User-facing settings the Plugins UI renders a form for. Values
    /// are persisted in `app_settings` as `plugin:{name}:setting:{key}`
    /// and piped into `HostContext.config` at invocation time so plugin
    /// scripts read them via `host.config("auto_allow")`.
    #[serde(default)]
    pub settings: Vec<PluginSettingField>,
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

/// User-facing plugin setting — rendered as a typed input in the
/// Plugins settings section. The Lua plugin reads its own values via
/// `host.config("<key>")`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PluginSettingField {
    Boolean {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default)]
        default: bool,
    },
    Text {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
    },
    Select {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<String>,
        options: Vec<SelectOption>,
    },
}

impl PluginSettingField {
    pub fn key(&self) -> &str {
        match self {
            Self::Boolean { key, .. } | Self::Text { key, .. } | Self::Select { key, .. } => key,
        }
    }

    /// Default value rendered as a serde_json::Value so it can feed
    /// `HostContext.config` with the same type shape plugins will read.
    pub fn default_value(&self) -> serde_json::Value {
        match self {
            Self::Boolean { default, .. } => serde_json::Value::Bool(*default),
            Self::Text { default, .. } => default
                .clone()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
            Self::Select { default, .. } => default
                .clone()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SelectOption {
    pub value: String,
    pub label: String,
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
            settings: vec![],
        };
        let json = serde_json::to_string(&manifest).unwrap();
        assert!(
            json.contains(r#""kind":"env-provider""#),
            "serialized kind should be kebab-case: {json}"
        );
        let round: PluginManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(round.kind, PluginKind::EnvProvider);
    }

    #[test]
    fn manifest_defaults_to_empty_settings() {
        let json = r#"{
            "name": "legacy",
            "display_name": "Legacy",
            "version": "1.0.0",
            "description": "No settings",
            "operations": []
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert!(manifest.settings.is_empty());
    }

    #[test]
    fn manifest_parses_boolean_setting() {
        let json = r#"{
            "name": "env-direnv",
            "display_name": "direnv",
            "version": "1.0.0",
            "description": "direnv env provider",
            "kind": "env-provider",
            "operations": ["detect", "export"],
            "settings": [
                {
                    "type": "boolean",
                    "key": "auto_allow",
                    "label": "Always allow .envrc",
                    "description": "Run direnv allow automatically",
                    "default": false
                }
            ]
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.settings.len(), 1);
        match &manifest.settings[0] {
            PluginSettingField::Boolean {
                key,
                label,
                description,
                default,
            } => {
                assert_eq!(key, "auto_allow");
                assert_eq!(label, "Always allow .envrc");
                assert_eq!(
                    description.as_deref(),
                    Some("Run direnv allow automatically")
                );
                assert!(!*default);
            }
            other => panic!("expected boolean, got {other:?}"),
        }
    }

    #[test]
    fn manifest_parses_multiple_setting_types() {
        let json = r#"{
            "name": "demo", "display_name": "Demo", "version": "1.0.0",
            "description": "d", "operations": [],
            "settings": [
                { "type": "boolean", "key": "a", "label": "A", "default": true },
                { "type": "text", "key": "b", "label": "B", "placeholder": "x" },
                { "type": "select", "key": "c", "label": "C",
                  "options": [
                      { "value": "v1", "label": "V1" },
                      { "value": "v2", "label": "V2" }
                  ] }
            ]
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.settings.len(), 3);
        assert!(matches!(
            manifest.settings[0],
            PluginSettingField::Boolean { .. }
        ));
        assert!(matches!(
            manifest.settings[1],
            PluginSettingField::Text { .. }
        ));
        match &manifest.settings[2] {
            PluginSettingField::Select { options, .. } => assert_eq!(options.len(), 2),
            other => panic!("expected select, got {other:?}"),
        }
    }

    #[test]
    fn manifest_rejects_unknown_setting_type() {
        let json = r#"{
            "name": "bad", "display_name": "B", "version": "1.0.0",
            "description": "b", "operations": [],
            "settings": [ { "type": "weirdo", "key": "x", "label": "X" } ]
        }"#;
        let result: Result<PluginManifest, _> = serde_json::from_str(json);
        assert!(result.is_err(), "unknown setting type should fail to parse");
    }

    #[test]
    fn setting_field_default_value_helper() {
        let b = PluginSettingField::Boolean {
            key: "k".into(),
            label: "l".into(),
            description: None,
            default: true,
        };
        assert_eq!(b.default_value(), serde_json::Value::Bool(true));
        assert_eq!(b.key(), "k");

        let t_with = PluginSettingField::Text {
            key: "k".into(),
            label: "l".into(),
            description: None,
            default: Some("hi".into()),
            placeholder: None,
        };
        assert_eq!(
            t_with.default_value(),
            serde_json::Value::String("hi".into())
        );

        let t_no_default = PluginSettingField::Text {
            key: "k".into(),
            label: "l".into(),
            description: None,
            default: None,
            placeholder: None,
        };
        assert_eq!(t_no_default.default_value(), serde_json::Value::Null);
    }

    #[test]
    fn setting_field_roundtrips() {
        let field = PluginSettingField::Boolean {
            key: "auto_allow".into(),
            label: "Auto allow".into(),
            description: Some("Auto-run".into()),
            default: false,
        };
        let json = serde_json::to_string(&field).unwrap();
        assert!(json.contains(r#""type":"boolean""#), "got {json}");
        let back: PluginSettingField = serde_json::from_str(&json).unwrap();
        assert_eq!(back, field);
    }
}
