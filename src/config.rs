use std::path::Path;

use serde::Deserialize;

const CONFIG_FILE_NAME: &str = ".claudette.json";

/// Top-level structure of a `.claudette.json` file.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ClaudetteConfig {
    #[serde(default)]
    pub scripts: Option<Scripts>,
    /// Custom instructions appended to the agent's system prompt.
    #[serde(default)]
    pub instructions: Option<String>,
}

/// Script definitions within `.claudette.json`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Scripts {
    #[serde(default)]
    pub setup: Option<String>,
}

/// Load and parse `.claudette.json` from the given directory.
///
/// Returns `Ok(None)` if the file doesn't exist (not an error).
/// Returns `Err` with a user-visible message if the file exists but is malformed.
pub fn load_config(repo_path: &Path) -> Result<Option<ClaudetteConfig>, String> {
    let config_path = repo_path.join(CONFIG_FILE_NAME);

    let contents = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to read {CONFIG_FILE_NAME}: {e}")),
    };

    let config: ClaudetteConfig = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse {CONFIG_FILE_NAME}: {e}"))?;

    Ok(Some(config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_valid_config_with_setup() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(CONFIG_FILE_NAME),
            r#"{"scripts": {"setup": "mise trust && mise install"}}"#,
        )
        .unwrap();

        let config = load_config(dir.path()).unwrap().unwrap();
        assert_eq!(
            config.scripts.unwrap().setup.unwrap(),
            "mise trust && mise install"
        );
    }

    #[test]
    fn test_valid_config_without_scripts_key() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{}"#).unwrap();

        let config = load_config(dir.path()).unwrap().unwrap();
        assert!(config.scripts.is_none());
    }

    #[test]
    fn test_valid_config_scripts_without_setup() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{"scripts": {}}"#).unwrap();

        let config = load_config(dir.path()).unwrap().unwrap();
        assert!(config.scripts.unwrap().setup.is_none());
    }

    #[test]
    fn test_unknown_keys_ignored() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(CONFIG_FILE_NAME),
            r#"{"scripts": {"setup": "echo hi", "deploy": "echo deploy"}, "version": 2, "extra": true}"#,
        )
        .unwrap();

        let config = load_config(dir.path()).unwrap().unwrap();
        assert_eq!(config.scripts.unwrap().setup.unwrap(), "echo hi");
    }

    #[test]
    fn test_valid_config_with_instructions() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(CONFIG_FILE_NAME),
            r#"{"instructions": "Always use TypeScript"}"#,
        )
        .unwrap();

        let config = load_config(dir.path()).unwrap().unwrap();
        assert_eq!(config.instructions.unwrap(), "Always use TypeScript");
        assert!(config.scripts.is_none());
    }

    #[test]
    fn test_valid_config_with_instructions_and_scripts() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(CONFIG_FILE_NAME),
            r#"{"instructions": "Use Rust", "scripts": {"setup": "cargo build"}}"#,
        )
        .unwrap();

        let config = load_config(dir.path()).unwrap().unwrap();
        assert_eq!(config.instructions.unwrap(), "Use Rust");
        assert_eq!(config.scripts.unwrap().setup.unwrap(), "cargo build");
    }

    #[test]
    fn test_malformed_json() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(CONFIG_FILE_NAME), "not valid json {{{").unwrap();

        let err = load_config(dir.path()).unwrap_err();
        assert!(err.contains("Failed to parse .claudette.json"));
    }

    #[test]
    fn test_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let result = load_config(dir.path()).unwrap();
        assert!(result.is_none());
    }
}
