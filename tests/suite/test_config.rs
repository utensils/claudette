use claudette::config::*;

/// load_config with a nonexistent directory returns Ok(None).
#[test]
fn test_config_load_nonexistent_path() {
    let result = load_config(std::path::Path::new("/tmp/nonexistent_path_99999"));
    assert!(result.is_ok());
    assert!(result.unwrap().is_none());
}

/// load_config with a directory that exists but has no .claudette.json.
#[test]
fn test_config_load_no_config_file() {
    let dir = tempfile::tempdir().unwrap();
    let result = load_config(dir.path());
    assert!(result.is_ok());
    assert!(result.unwrap().is_none());
}

/// load_config with a valid .claudette.json file.
#[test]
fn test_config_load_valid_config() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join(".claudette.json");
    std::fs::write(
        &config_path,
        r#"{"scripts":{"setup":"./setup.sh"},"instructions":"Be brief"}"#,
    )
    .unwrap();

    let result = load_config(dir.path());
    assert!(result.is_ok());
    let config = result.unwrap().unwrap();
    assert_eq!(config.instructions, Some("Be brief".to_string()));
    assert!(config.scripts.is_some());
    assert_eq!(
        config.scripts.unwrap().setup,
        Some("./setup.sh".to_string())
    );
}

/// load_config with a minimal empty JSON object.
#[test]
fn test_config_load_empty_object() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".claudette.json"), "{}").unwrap();
    let result = load_config(dir.path());
    assert!(result.is_ok());
    let config = result.unwrap().unwrap();
    assert!(config.scripts.is_none());
    assert!(config.instructions.is_none());
}

/// load_config with malformed JSON should return Err.
#[test]
fn test_config_load_malformed_json() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".claudette.json"), "not json at all").unwrap();
    let result = load_config(dir.path());
    assert!(result.is_err());
}

/// load_config with truncated JSON.
#[test]
fn test_config_load_truncated_json() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".claudette.json"), r#"{"scripts":{"set"#).unwrap();
    let result = load_config(dir.path());
    assert!(result.is_err());
}

/// load_config with empty file (0 bytes).
#[test]
fn test_config_load_empty_file() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".claudette.json"), "").unwrap();
    let result = load_config(dir.path());
    // Empty file is not valid JSON -- should error
    assert!(result.is_err());
}

/// load_config with JSON that has extra unknown fields (forward compatibility).
#[test]
fn test_config_load_extra_fields() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(".claudette.json"),
        r#"{"instructions":"hello","unknown_field":"value","future_key":42}"#,
    )
    .unwrap();
    let result = load_config(dir.path());
    // Should succeed, ignoring unknown fields
    assert!(result.is_ok());
    let config = result.unwrap().unwrap();
    assert_eq!(config.instructions, Some("hello".to_string()));
}

/// load_config with JSON array instead of object.
#[test]
fn test_config_load_json_array() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".claudette.json"), "[1,2,3]").unwrap();
    let result = load_config(dir.path());
    assert!(result.is_err());
}

/// load_config with null JSON.
#[test]
fn test_config_load_json_null() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".claudette.json"), "null").unwrap();
    let result = load_config(dir.path());
    // "null" is valid JSON but not an object -- likely error
    assert!(result.is_err());
}

/// ClaudetteConfig default should have all Nones.
#[test]
fn test_config_default() {
    let config = ClaudetteConfig::default();
    assert!(config.scripts.is_none());
    assert!(config.instructions.is_none());
}

/// Scripts default should have None setup.
#[test]
fn test_config_scripts_default() {
    let scripts = Scripts::default();
    assert!(scripts.setup.is_none());
}

/// load_config with very large instructions value.
#[test]
fn test_config_load_large_instructions() {
    let dir = tempfile::tempdir().unwrap();
    let big = "x".repeat(100_000);
    std::fs::write(
        dir.path().join(".claudette.json"),
        format!(r#"{{"instructions":"{big}"}}"#),
    )
    .unwrap();
    let result = load_config(dir.path());
    assert!(result.is_ok());
    let config = result.unwrap().unwrap();
    assert_eq!(config.instructions.unwrap().len(), 100_000);
}

/// load_config with unicode instructions.
#[test]
fn test_config_load_unicode_instructions() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(".claudette.json"),
        r#"{"instructions":"日本語の指示 🎌"}"#,
    )
    .unwrap();
    let result = load_config(dir.path());
    assert!(result.is_ok());
    let config = result.unwrap().unwrap();
    assert!(config.instructions.unwrap().contains('🎌'));
}
