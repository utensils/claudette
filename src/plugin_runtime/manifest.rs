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
    /// Language grammar plugins ship TextMate grammars + language
    /// metadata to power syntax highlighting in chat code blocks, the
    /// diff viewer, and the file editor. Purely declarative — no
    /// `init.lua` is required and no Lua VM is spawned for this kind.
    LanguageGrammar,
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
    /// scripts read them via `host.config("<key>")`.
    #[serde(default)]
    pub settings: Vec<PluginSettingField>,
    /// Language metadata contributed by a `language-grammar` plugin.
    /// Mirrors VS Code's `contributes.languages` shape so users can
    /// copy directly from existing extensions.
    #[serde(default)]
    pub languages: Vec<LanguageContribution>,
    /// TextMate grammars contributed by a `language-grammar` plugin.
    /// Each entry binds a grammar file to a previously-declared
    /// language id. Mirrors VS Code's `contributes.grammars` shape.
    #[serde(default)]
    pub grammars: Vec<GrammarContribution>,
}

/// A language contributed by a `language-grammar` plugin. Parallels
/// VS Code's `contributes.languages` entry — `id`, `extensions`,
/// `filenames`, and `aliases` carry the same semantics, letting users
/// lift entries directly from a `package.json` shipped in a `.vsix`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LanguageContribution {
    /// Stable identifier (e.g. `"nix"`, `"toml"`). Used to bind a
    /// grammar (via `GrammarContribution::language`) and to register
    /// the language with Monaco / Shiki on the frontend.
    pub id: String,
    /// File extensions including the leading dot (e.g. `".nix"`).
    #[serde(default)]
    pub extensions: Vec<String>,
    /// Exact filenames that should be associated with this language
    /// regardless of extension (e.g. `"Dockerfile"`, `"Makefile"`).
    #[serde(default)]
    pub filenames: Vec<String>,
    /// Display aliases — the first entry is typically used as the
    /// human-readable name in UI surfaces.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Optional regex matched against the first line of a file when
    /// neither extension nor filename rules apply (e.g. a shebang
    /// detector). Pattern semantics follow JavaScript regex on the
    /// frontend — keep them simple and well-anchored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_line_pattern: Option<String>,
}

/// A TextMate grammar contributed by a `language-grammar` plugin.
/// `path` is resolved relative to the plugin's directory, with
/// path-traversal protection enforced by [`crate::grammar_provider`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GrammarContribution {
    /// The id of a [`LanguageContribution`] declared in the same
    /// manifest. Frontend registers this grammar against the matching
    /// language id.
    pub language: String,
    /// Top-level scope name used by the grammar (e.g. `"source.nix"`).
    /// Required because injection grammars and theme rules key off
    /// scope names rather than language ids.
    pub scope_name: String,
    /// Plugin-relative path to the `.tmLanguage.json` file
    /// (e.g. `"grammars/nix.tmLanguage.json"`). Must resolve inside
    /// the plugin directory; the loader rejects paths that escape via
    /// `..` or symlinks pointing elsewhere.
    pub path: String,
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
    /// Numeric input. Stored as JSON number; UI renders an `<input
    /// type="number">` honoring the optional `min` / `max` / `step`.
    /// `unit` is a free-text suffix (e.g. `"seconds"`) shown next to
    /// the field — does not affect parsing.
    Number {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
}

impl PluginSettingField {
    pub fn key(&self) -> &str {
        match self {
            Self::Boolean { key, .. }
            | Self::Text { key, .. }
            | Self::Select { key, .. }
            | Self::Number { key, .. } => key,
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
            Self::Number { default, .. } => default
                .and_then(serde_json::Number::from_f64)
                .map(serde_json::Value::Number)
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
            languages: vec![],
            grammars: vec![],
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
    fn manifest_parses_language_grammar_kind() {
        let json = r#"{
            "name": "lang-nix",
            "display_name": "Nix",
            "version": "1.0.0",
            "description": "Nix language",
            "kind": "language-grammar",
            "operations": [],
            "languages": [
                { "id": "nix", "extensions": [".nix"], "aliases": ["Nix"] }
            ],
            "grammars": [
                { "language": "nix", "scope_name": "source.nix", "path": "grammars/nix.tmLanguage.json" }
            ]
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.kind, PluginKind::LanguageGrammar);
        assert_eq!(manifest.languages.len(), 1);
        assert_eq!(manifest.languages[0].id, "nix");
        assert_eq!(manifest.languages[0].extensions, vec![".nix".to_string()]);
        assert_eq!(manifest.grammars.len(), 1);
        assert_eq!(manifest.grammars[0].language, "nix");
        assert_eq!(manifest.grammars[0].scope_name, "source.nix");
        assert_eq!(manifest.grammars[0].path, "grammars/nix.tmLanguage.json");
    }

    #[test]
    fn language_contribution_optional_fields_default_to_empty() {
        let json = r#"{ "id": "nix" }"#;
        let lang: LanguageContribution = serde_json::from_str(json).unwrap();
        assert_eq!(lang.id, "nix");
        assert!(lang.extensions.is_empty());
        assert!(lang.filenames.is_empty());
        assert!(lang.aliases.is_empty());
        assert!(lang.first_line_pattern.is_none());
    }

    #[test]
    fn language_contribution_first_line_pattern_roundtrips() {
        let value = LanguageContribution {
            id: "shell".into(),
            extensions: vec![],
            filenames: vec![],
            aliases: vec![],
            first_line_pattern: Some("^#!.*\\bsh\\b".into()),
        };
        let json = serde_json::to_string(&value).unwrap();
        assert!(
            json.contains("first_line_pattern"),
            "expected first_line_pattern in: {json}"
        );
        let back: LanguageContribution = serde_json::from_str(&json).unwrap();
        assert_eq!(back, value);
    }

    #[test]
    fn manifest_languages_and_grammars_default_to_empty() {
        let json = r#"{
            "name": "legacy",
            "display_name": "Legacy",
            "version": "1.0.0",
            "description": "no contributions",
            "operations": []
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert!(manifest.languages.is_empty());
        assert!(manifest.grammars.is_empty());
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

    #[test]
    fn manifest_parses_number_setting() {
        // Numeric settings carry default + bounds. All bounds are
        // optional so a manifest can declare just `default` if it
        // doesn't care about clamping.
        let json = r#"{
            "name": "env-direnv",
            "display_name": "direnv",
            "version": "1.0.0",
            "description": "direnv env provider",
            "kind": "env-provider",
            "operations": ["detect", "export"],
            "settings": [
                {
                    "type": "number",
                    "key": "timeout_seconds",
                    "label": "Timeout (seconds)",
                    "description": "Max time to wait for direnv export",
                    "default": 120,
                    "min": 5,
                    "max": 600,
                    "step": 5,
                    "unit": "seconds"
                }
            ]
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.settings.len(), 1);
        match &manifest.settings[0] {
            PluginSettingField::Number {
                key,
                label,
                description,
                default,
                min,
                max,
                step,
                unit,
            } => {
                assert_eq!(key, "timeout_seconds");
                assert_eq!(label, "Timeout (seconds)");
                assert_eq!(
                    description.as_deref(),
                    Some("Max time to wait for direnv export")
                );
                assert_eq!(*default, Some(120.0));
                assert_eq!(*min, Some(5.0));
                assert_eq!(*max, Some(600.0));
                assert_eq!(*step, Some(5.0));
                assert_eq!(unit.as_deref(), Some("seconds"));
            }
            other => panic!("expected number, got {other:?}"),
        }
    }

    #[test]
    fn number_setting_default_value_helper() {
        let with_default = PluginSettingField::Number {
            key: "k".into(),
            label: "l".into(),
            description: None,
            default: Some(120.0),
            min: None,
            max: None,
            step: None,
            unit: None,
        };
        match with_default.default_value() {
            serde_json::Value::Number(n) => assert_eq!(n.as_f64(), Some(120.0)),
            other => panic!("expected number value, got {other:?}"),
        }
        assert_eq!(with_default.key(), "k");

        let no_default = PluginSettingField::Number {
            key: "k".into(),
            label: "l".into(),
            description: None,
            default: None,
            min: None,
            max: None,
            step: None,
            unit: None,
        };
        assert_eq!(no_default.default_value(), serde_json::Value::Null);
    }

    #[test]
    fn number_setting_minimal_manifest() {
        // Only required fields are key + label + the type tag; min/max/
        // step/unit/default/description are all optional.
        let json = r#"{
            "type": "number",
            "key": "x",
            "label": "X"
        }"#;
        let field: PluginSettingField = serde_json::from_str(json).unwrap();
        match field {
            PluginSettingField::Number {
                default,
                min,
                max,
                step,
                unit,
                description,
                ..
            } => {
                assert_eq!(default, None);
                assert_eq!(min, None);
                assert_eq!(max, None);
                assert_eq!(step, None);
                assert_eq!(unit, None);
                assert_eq!(description, None);
            }
            other => panic!("expected number, got {other:?}"),
        }
    }

    #[test]
    fn number_setting_roundtrips() {
        let field = PluginSettingField::Number {
            key: "timeout_seconds".into(),
            label: "Timeout".into(),
            description: None,
            default: Some(120.0),
            min: Some(5.0),
            max: Some(600.0),
            step: Some(5.0),
            unit: Some("seconds".into()),
        };
        let json = serde_json::to_string(&field).unwrap();
        assert!(json.contains(r#""type":"number""#), "got {json}");
        let back: PluginSettingField = serde_json::from_str(&json).unwrap();
        assert_eq!(back, field);
    }
}
