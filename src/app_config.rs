use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// App-level configuration stored outside the database.
///
/// This lives at a fixed platform path (`dirs::config_dir()/claudette/config.toml`)
/// and is read before the database is opened — solving the chicken-and-egg problem
/// of storing the data directory override in the database it configures.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct AppConfig {
    /// Override the default data directory (where `claudette.db` is stored).
    pub data_dir: Option<String>,
}

/// Fixed path where the app-level config file lives.
pub fn app_config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("claudette").join("config.toml"))
}

/// Read and parse the app config file. Returns `Default` on any error.
pub fn load_app_config() -> AppConfig {
    let Some(config_path) = app_config_path() else {
        return AppConfig::default();
    };
    let Ok(contents) = std::fs::read_to_string(&config_path) else {
        return AppConfig::default();
    };
    toml::from_str(&contents).unwrap_or_default()
}

/// Expand a leading `~` to the user's home directory.
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/")
        && let Some(home) = dirs::home_dir()
    {
        return home.join(rest);
    } else if path == "~"
        && let Some(home) = dirs::home_dir()
    {
        return home;
    }
    PathBuf::from(path)
}

/// Resolve the data directory using: env var > config file > platform default.
pub fn resolve_data_dir() -> PathBuf {
    // 1. Environment variable (highest priority).
    if let Ok(val) = std::env::var("CLAUDETTE_DATA_DIR") {
        let val = val.trim();
        if !val.is_empty() {
            return expand_tilde(val);
        }
    }

    // 2. Config file.
    let config = load_app_config();
    if let Some(ref dir) = config.data_dir {
        let dir = dir.trim();
        if !dir.is_empty() {
            return expand_tilde(dir);
        }
    }

    // 3. Platform default.
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("claudette")
}

/// Resolve the full database path: `<data_dir>/claudette.db`.
pub fn resolve_db_path() -> PathBuf {
    resolve_data_dir().join("claudette.db")
}

/// Save a data directory override to the config file.
///
/// Pass `None` to clear the override and revert to the platform default.
pub fn save_data_dir_config(data_dir: Option<&str>) -> Result<(), String> {
    let config_path = app_config_path().ok_or("Could not determine config directory")?;

    let config = AppConfig {
        data_dir: data_dir.map(|s| s.to_string()),
    };

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {e}"))?;
    }

    let content =
        toml::to_string_pretty(&config).map_err(|e| format!("Failed to serialize config: {e}"))?;
    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write config file: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_expand_tilde_with_subpath() {
        let result = expand_tilde("~/foo/bar");
        if let Some(home) = dirs::home_dir() {
            assert_eq!(result, home.join("foo/bar"));
        }
    }

    #[test]
    fn test_expand_tilde_bare() {
        let result = expand_tilde("~");
        if let Some(home) = dirs::home_dir() {
            assert_eq!(result, home);
        }
    }

    #[test]
    fn test_expand_tilde_absolute_passthrough() {
        let result = expand_tilde("/tmp/claudette");
        assert_eq!(result, PathBuf::from("/tmp/claudette"));
    }

    #[test]
    fn test_resolve_data_dir_env_override() {
        // Temporarily set the env var and verify it takes priority.
        let key = "CLAUDETTE_DATA_DIR";
        let prev = std::env::var(key).ok();
        // SAFETY: test runs serially; no other thread reads this env var concurrently.
        unsafe { std::env::set_var(key, "/tmp/claudette-test-env") };

        let result = resolve_data_dir();
        assert_eq!(result, PathBuf::from("/tmp/claudette-test-env"));

        // Restore previous value.
        unsafe {
            match prev {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }

    #[test]
    fn test_resolve_data_dir_default_has_claudette_suffix() {
        let key = "CLAUDETTE_DATA_DIR";
        let prev = std::env::var(key).ok();
        // SAFETY: test runs serially; no other thread reads this env var concurrently.
        unsafe { std::env::remove_var(key) };

        let result = resolve_data_dir();
        // The default should end with "claudette" (the directory name).
        assert!(
            result
                .file_name()
                .is_some_and(|n| n.to_string_lossy() == "claudette"),
            "Expected default data dir to end with 'claudette', got: {result:?}"
        );

        if let Some(v) = prev {
            // SAFETY: restoring previous env state.
            unsafe { std::env::set_var(key, v) };
        }
    }

    #[test]
    fn test_resolve_db_path_ends_with_db_file() {
        let key = "CLAUDETTE_DATA_DIR";
        let prev = std::env::var(key).ok();
        // SAFETY: test runs serially; no other thread reads this env var concurrently.
        unsafe { std::env::set_var(key, "/tmp/claudette-test-db") };

        let result = resolve_db_path();
        assert_eq!(result, PathBuf::from("/tmp/claudette-test-db/claudette.db"));

        unsafe {
            match prev {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }

    #[test]
    fn test_save_and_load_config() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");

        let config = AppConfig {
            data_dir: Some("/custom/path".to_string()),
        };

        let content = toml::to_string_pretty(&config).unwrap();
        std::fs::write(&config_path, &content).unwrap();

        let loaded: AppConfig =
            toml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(loaded.data_dir.as_deref(), Some("/custom/path"));
    }

    #[test]
    fn test_load_config_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        std::fs::write(&config_path, "").unwrap();

        let loaded: AppConfig =
            toml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert!(loaded.data_dir.is_none());
    }

    #[test]
    fn test_load_config_no_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.toml");
        std::fs::write(&config_path, "# just a comment\n").unwrap();

        let loaded: AppConfig =
            toml::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert!(loaded.data_dir.is_none());
    }
}
