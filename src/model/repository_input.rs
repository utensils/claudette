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
    },
}

impl RepositoryInputField {
    pub fn key(&self) -> &str {
        match self {
            Self::Boolean { key, .. } | Self::String { key, .. } | Self::Number { key, .. } => key,
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
/// Number: must parse as `f64`; min/max checked when set; canonical form
/// is the original string trimmed (we don't reformat e.g. "1.0" → "1").
/// String: any value accepted; whitespace preserved.
pub fn coerce_value(field: &RepositoryInputField, raw: &str) -> Result<String, String> {
    match field {
        RepositoryInputField::Boolean { key, .. } => match raw {
            "true" | "false" => Ok(raw.to_string()),
            other => Err(format!(
                "Input {key:?} must be a boolean (\"true\" or \"false\"), got {other:?}."
            )),
        },
        RepositoryInputField::Number { key, min, max, .. } => {
            let trimmed = raw.trim();
            let parsed: f64 = trimmed
                .parse()
                .map_err(|_| format!("Input {key:?} must be a number, got {raw:?}."))?;
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
        RepositoryInputField::String { .. } => Ok(raw.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            RepositoryInputField::String {
                key: "DUP".into(),
                label: "A".into(),
                description: None,
                default: None,
                placeholder: None,
            },
            RepositoryInputField::Boolean {
                key: "DUP".into(),
                label: "B".into(),
                description: None,
                default: None,
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
        };
        assert_eq!(coerce_value(&field, "true").unwrap(), "true");
        assert_eq!(coerce_value(&field, "false").unwrap(), "false");
        assert!(coerce_value(&field, "True").is_err());
        assert!(coerce_value(&field, "yes").is_err());
    }

    #[test]
    fn coerce_number_with_bounds() {
        let field = RepositoryInputField::Number {
            key: "N".into(),
            label: "N".into(),
            description: None,
            default: None,
            min: Some(0.0),
            max: Some(10.0),
            step: None,
            unit: None,
        };
        assert_eq!(coerce_value(&field, "5").unwrap(), "5");
        assert_eq!(coerce_value(&field, "  3.5  ").unwrap(), "3.5");
        assert!(coerce_value(&field, "abc").is_err());
        assert!(coerce_value(&field, "-1").is_err());
        assert!(coerce_value(&field, "11").is_err());
    }

    #[test]
    fn coerce_string_accepts_anything() {
        let field = RepositoryInputField::String {
            key: "S".into(),
            label: "S".into(),
            description: None,
            default: None,
            placeholder: None,
        };
        assert_eq!(coerce_value(&field, "PROJ-123").unwrap(), "PROJ-123");
        assert_eq!(coerce_value(&field, "").unwrap(), "");
        assert_eq!(coerce_value(&field, "  spaces  ").unwrap(), "  spaces  ");
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
            },
            RepositoryInputField::Boolean {
                key: "DEBUG".into(),
                label: "Debug".into(),
                description: None,
                default: Some(false),
            },
        ];
        let json = serde_json::to_string(&schema).unwrap();
        let parsed: Vec<RepositoryInputField> = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, schema);
    }
}
