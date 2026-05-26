use serde::{Deserialize, Serialize};

/// One declared per-repo input. New workspaces are required to supply a value
/// for each declared field before they can be created; the value then becomes
/// an environment variable visible to the agent, terminal, and setup/archive
/// scripts for that workspace.
///
/// The `type` discriminator drives the input the UI renders (and the
/// validation it applies before the value is serialized to a string).
/// Everything ultimately crosses the env boundary as a string — the type is
/// purely a UX/validation aid.
///
/// `required` defaults to `true` (via `default_required` below) so existing
/// schemas keep their "value mandatory at create time" behavior. Marking a
/// field `required: false` lets the user submit the workspace-create modal
/// without filling that field in — the env var is still set, but to an empty
/// string for string/number, so downstream scripts can `[ -z "$X" ]` check.
///
/// Shape intentionally mirrors `PluginSettingField` (Lua plugin manifests) so
/// the frontend can render both with the same `PluginSettingInput` component.
/// `select` is not supported in v1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RepositoryInputField {
    Boolean {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<bool>,
        /// Booleans always carry a value (`true` / `false`), so this flag is
        /// effectively informational for the boolean variant — the coercer
        /// ignores it. Kept for schema symmetry across variants.
        #[serde(default = "default_required")]
        required: bool,
    },
    String {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
        #[serde(default = "default_required")]
        required: bool,
    },
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
        #[serde(default = "default_required")]
        required: bool,
    },
}

/// serde's `#[serde(default)]` on a `bool` would default to `false`. We want
/// the opposite — existing schemas (and any third-party producer that omits
/// the field) should be treated as required. A free function gives us that.
fn default_required() -> bool {
    true
}

impl RepositoryInputField {
    pub fn key(&self) -> &str {
        match self {
            Self::Boolean { key, .. } | Self::String { key, .. } | Self::Number { key, .. } => key,
        }
    }

    /// Whether the user must supply a non-blank value when creating a
    /// workspace. Booleans always have a value so this returns `true` for
    /// them regardless of the schema flag — the flag is meaningless for
    /// booleans (see comment on the variant).
    pub fn is_required(&self) -> bool {
        match self {
            Self::Boolean { .. } => true,
            Self::String { required, .. } | Self::Number { required, .. } => *required,
        }
    }
}

/// `key` must look like a POSIX-ish environment variable name. We're slightly
/// stricter than POSIX (no leading digit) so the names round-trip through
/// shells without surprise. Returns `Err` with a human-readable reason.
pub fn validate_input_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("Input name cannot be empty.".to_string());
    }
    let mut chars = key.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(format!(
            "Input name {key:?} must start with a letter or underscore."
        ));
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!(
                "Input name {key:?} can only contain letters, digits, and underscores."
            ));
        }
    }
    Ok(())
}

/// Validate that the schema is well-formed: every key passes
/// `validate_input_key` and no two fields share the same key.
pub fn validate_schema(schema: &[RepositoryInputField]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for field in schema {
        let key = field.key();
        validate_input_key(key)?;
        if !seen.insert(key.to_string()) {
            return Err(format!("Duplicate input name {key:?}."));
        }
    }
    Ok(())
}

/// Coerce a supplied value (already serialized as a string from the
/// frontend) against its declared type. Returns the canonicalized string
/// to persist, or an error explaining why it was rejected.
///
/// Boolean: accepts `"true"`/`"false"` (lowercase), canonicalizes to those.
/// Number: must parse as a finite `f64` when supplied; min/max checked when
/// set. A blank input is rejected when the field is `required`, accepted as
/// `""` when not (downstream scripts get an empty env var to test with).
/// String: required ⇒ non-blank; not required ⇒ any value (including blank).
pub fn coerce_value(field: &RepositoryInputField, raw: &str) -> Result<String, String> {
    match field {
        RepositoryInputField::Boolean { key, .. } => match raw {
            "true" | "false" => Ok(raw.to_string()),
            other => Err(format!(
                "Input {key:?} must be a boolean (\"true\" or \"false\"), got {other:?}."
            )),
        },
        RepositoryInputField::Number {
            key,
            min,
            max,
            required,
            ..
        } => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                // Non-required numeric inputs pass through as an empty string
                // — the workspace's env var is set to `""` so scripts can
                // detect "user didn't supply" uniformly via `[ -z "$X" ]`.
                if !required {
                    return Ok(String::new());
                }
                return Err(format!("Input {key:?} is required."));
            }
            let parsed: f64 = trimmed
                .parse()
                .map_err(|_| format!("Input {key:?} must be a number, got {raw:?}."))?;
            // `f64::from_str` happily accepts "NaN" / "inf" / "-inf", and the
            // `<` / `>` comparisons against NaN are always false — without
            // this check, a CLI/IPC caller could persist `NaN` and the scripts
            // downstream would see literal "NaN". Frontend already rejects.
            if !parsed.is_finite() {
                return Err(format!(
                    "Input {key:?} must be a finite number, got {raw:?}."
                ));
            }
            if let Some(lo) = min
                && parsed < *lo
            {
                return Err(format!("Input {key:?} must be ≥ {lo}, got {parsed}."));
            }
            if let Some(hi) = max
                && parsed > *hi
            {
                return Err(format!("Input {key:?} must be ≤ {hi}, got {parsed}."));
            }
            Ok(trimmed.to_string())
        }
        RepositoryInputField::String { key, required, .. } => {
            // Required strings must carry a non-blank value (matches the
            // frontend's modal contract). Non-required strings pass through
            // verbatim — including whitespace-only, in case the user
            // deliberately wants leading/trailing space.
            if *required && raw.trim().is_empty() {
                return Err(format!("Input {key:?} is required."));
            }
            Ok(raw.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Convenience constructors so the tests below don't drown in
    /// `..Default::default()`-style boilerplate per variant.
    fn string_field(key: &str) -> RepositoryInputField {
        RepositoryInputField::String {
            key: key.into(),
            label: key.into(),
            description: None,
            default: None,
            placeholder: None,
            required: true,
        }
    }

    fn number_field(key: &str, min: Option<f64>, max: Option<f64>) -> RepositoryInputField {
        RepositoryInputField::Number {
            key: key.into(),
            label: key.into(),
            description: None,
            default: None,
            min,
            max,
            step: None,
            unit: None,
            required: true,
        }
    }

    #[test]
    fn validate_key_accepts_typical_env_names() {
        validate_input_key("TICKET_ID").unwrap();
        validate_input_key("_internal").unwrap();
        validate_input_key("a1").unwrap();
    }

    #[test]
    fn validate_key_rejects_leading_digit_and_bad_chars() {
        assert!(validate_input_key("").is_err());
        assert!(validate_input_key("1FOO").is_err());
        assert!(validate_input_key("FOO-BAR").is_err());
        assert!(validate_input_key("FOO BAR").is_err());
    }

    #[test]
    fn schema_rejects_duplicate_keys() {
        let schema = vec![
            string_field("DUP"),
            RepositoryInputField::Boolean {
                key: "DUP".into(),
                label: "B".into(),
                description: None,
                default: None,
                required: true,
            },
        ];
        let err = validate_schema(&schema).unwrap_err();
        assert!(err.contains("Duplicate"));
    }

    #[test]
    fn coerce_boolean() {
        let field = RepositoryInputField::Boolean {
            key: "FLAG".into(),
            label: "Flag".into(),
            description: None,
            default: None,
            required: true,
        };
        assert_eq!(coerce_value(&field, "true").unwrap(), "true");
        assert_eq!(coerce_value(&field, "false").unwrap(), "false");
        assert!(coerce_value(&field, "True").is_err());
        assert!(coerce_value(&field, "yes").is_err());
    }

    #[test]
    fn coerce_number_with_bounds() {
        let field = number_field("N", Some(0.0), Some(10.0));
        assert_eq!(coerce_value(&field, "5").unwrap(), "5");
        assert_eq!(coerce_value(&field, "  3.5  ").unwrap(), "3.5");
        assert!(coerce_value(&field, "abc").is_err());
        assert!(coerce_value(&field, "-1").is_err());
        assert!(coerce_value(&field, "11").is_err());
    }

    #[test]
    fn coerce_string_rejects_blank_and_whitespace() {
        let field = string_field("S");
        assert_eq!(coerce_value(&field, "PROJ-123").unwrap(), "PROJ-123");
        // Whitespace-padded values are preserved verbatim — the user may
        // have meant the leading/trailing spaces. Only purely blank input
        // is rejected.
        assert_eq!(coerce_value(&field, "  spaces  ").unwrap(), "  spaces  ");
        assert!(coerce_value(&field, "").is_err());
        assert!(coerce_value(&field, "   ").is_err());
        assert!(coerce_value(&field, "\t\n").is_err());
    }

    #[test]
    fn coerce_number_rejects_non_finite() {
        let field = number_field("N", None, None);
        // `f64::from_str` parses these — the explicit `is_finite` check is
        // what makes the backend match the frontend's rejection.
        assert!(coerce_value(&field, "NaN").is_err());
        assert!(coerce_value(&field, "inf").is_err());
        assert!(coerce_value(&field, "-inf").is_err());
        assert!(coerce_value(&field, "Infinity").is_err());
    }

    #[test]
    fn coerce_optional_string_accepts_blank() {
        let field = RepositoryInputField::String {
            key: "NOTES".into(),
            label: "Notes".into(),
            description: None,
            default: None,
            placeholder: None,
            required: false,
        };
        assert_eq!(coerce_value(&field, "").unwrap(), "");
        assert_eq!(coerce_value(&field, "   ").unwrap(), "   ");
        assert_eq!(coerce_value(&field, "anything").unwrap(), "anything");
    }

    #[test]
    fn coerce_optional_number_blank_yields_empty() {
        let field = RepositoryInputField::Number {
            key: "BUDGET".into(),
            label: "Budget".into(),
            description: None,
            default: None,
            min: None,
            max: None,
            step: None,
            unit: None,
            required: false,
        };
        // Blank → "" so downstream scripts can `[ -z "$BUDGET" ]`.
        assert_eq!(coerce_value(&field, "").unwrap(), "");
        assert_eq!(coerce_value(&field, "  ").unwrap(), "");
        // Non-blank still goes through full numeric + finite validation.
        assert_eq!(coerce_value(&field, "42").unwrap(), "42");
        assert!(coerce_value(&field, "NaN").is_err());
        assert!(coerce_value(&field, "abc").is_err());
    }

    #[test]
    fn legacy_schema_without_required_defaults_to_true() {
        // Older persisted schemas don't have the `required` field. Make
        // sure they deserialize as required so behavior doesn't silently
        // shift for users upgrading.
        let legacy_json = r#"[
            {"type":"string","key":"TICKET_ID","label":"Ticket"},
            {"type":"number","key":"BUDGET","label":"Budget"},
            {"type":"boolean","key":"DEBUG","label":"Debug"}
        ]"#;
        let parsed: Vec<RepositoryInputField> = serde_json::from_str(legacy_json).unwrap();
        assert!(parsed.iter().all(|f| f.is_required()));
        // And blank coercion against a legacy string still rejects.
        assert!(coerce_value(&parsed[0], "").is_err());
    }

    #[test]
    fn serde_roundtrip_all_variants() {
        let schema = vec![
            RepositoryInputField::String {
                key: "TICKET_ID".into(),
                label: "Ticket".into(),
                description: Some("JIRA key".into()),
                default: None,
                placeholder: Some("PROJ-123".into()),
                required: true,
            },
            RepositoryInputField::Number {
                key: "RETRIES".into(),
                label: "Retries".into(),
                description: None,
                default: Some(3.0),
                min: Some(0.0),
                max: Some(10.0),
                step: Some(1.0),
                unit: None,
                required: false,
            },
            RepositoryInputField::Boolean {
                key: "DEBUG".into(),
                label: "Debug".into(),
                description: None,
                default: Some(false),
                required: true,
            },
        ];
        let json = serde_json::to_string(&schema).unwrap();
        let parsed: Vec<RepositoryInputField> = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, schema);
    }
}
