//! Persistence for user-toggled `claude` CLI flags.
//!
//! Builds on the existing `app_settings` key/value table — no schema
//! migration needed. Keys follow:
//!
//! - `claude_flag:{name}:enabled`        — global enable/disable
//! - `claude_flag:{name}:value`          — global value (for value-taking flags)
//! - `repo:{repo_id}:claude_flag:{name}:override` — sentinel: repo overrides global
//! - `repo:{repo_id}:claude_flag:{name}:enabled`  — repo enable/disable
//! - `repo:{repo_id}:claude_flag:{name}:value`    — repo value

use std::collections::HashMap;

use crate::claude_help::ClaudeFlagDef;
use crate::db::Database;

#[derive(Debug, Clone)]
pub struct FlagValue {
    pub enabled: bool,
    pub value: Option<String>,
}

const GLOBAL_PREFIX: &str = "claude_flag:";

fn repo_prefix(repo_id: &str) -> String {
    format!("repo:{repo_id}:claude_flag:")
}

fn global_enabled_key(name: &str) -> String {
    format!("{GLOBAL_PREFIX}{name}:enabled")
}

fn global_value_key(name: &str) -> String {
    format!("{GLOBAL_PREFIX}{name}:value")
}

fn repo_enabled_key(repo_id: &str, name: &str) -> String {
    format!("{}{}:enabled", repo_prefix(repo_id), name)
}

fn repo_value_key(repo_id: &str, name: &str) -> String {
    format!("{}{}:value", repo_prefix(repo_id), name)
}

fn repo_override_key(repo_id: &str, name: &str) -> String {
    format!("{}{}:override", repo_prefix(repo_id), name)
}

/// Strip a known suffix off a setting key. Returns `Some(flag_name)` only
/// if `key` ends with the suffix; otherwise `None`.
fn strip_suffix<'a>(key: &'a str, prefix: &str, suffix: &str) -> Option<&'a str> {
    let rest = key.strip_prefix(prefix)?;
    rest.strip_suffix(suffix)
}

/// Read every persisted global flag value. Pairs `:enabled` and `:value`
/// keys keyed by flag name.
pub fn load_global(db: &Database) -> Result<HashMap<String, FlagValue>, rusqlite::Error> {
    let rows = db.list_app_settings_with_prefix(GLOBAL_PREFIX)?;
    let mut map: HashMap<String, FlagValue> = HashMap::new();
    let mut has_valid_enabled: HashMap<String, bool> = HashMap::new();
    for (key, val) in rows {
        if let Some(name) = strip_suffix(&key, GLOBAL_PREFIX, ":enabled") {
            // Only accept canonical "true"/"false" — malformed strings
            // (e.g. legacy "yes"/"no") drop the flag entirely so the
            // resolver doesn't surface a half-written entry.
            if val == "true" || val == "false" {
                let entry = map.entry(name.to_string()).or_insert(FlagValue {
                    enabled: false,
                    value: None,
                });
                entry.enabled = val == "true";
                has_valid_enabled.insert(name.to_string(), true);
            }
        } else if let Some(name) = strip_suffix(&key, GLOBAL_PREFIX, ":value") {
            let entry = map.entry(name.to_string()).or_insert(FlagValue {
                enabled: false,
                value: None,
            });
            entry.value = Some(val);
        }
    }
    map.retain(|name, _| has_valid_enabled.get(name).copied().unwrap_or(false));
    Ok(map)
}

/// Read every persisted per-repo override. Only flags with the
/// `:override = "true"` sentinel are returned.
pub fn load_repo_overrides(
    db: &Database,
    repo_id: &str,
) -> Result<HashMap<String, FlagValue>, rusqlite::Error> {
    let prefix = repo_prefix(repo_id);
    let rows = db.list_app_settings_with_prefix(&prefix)?;
    let mut overrides: HashMap<String, FlagValue> = HashMap::new();
    let mut has_sentinel: HashMap<String, bool> = HashMap::new();
    for (key, val) in rows {
        if let Some(name) = strip_suffix(&key, &prefix, ":override") {
            if val == "true" {
                has_sentinel.insert(name.to_string(), true);
            }
        } else if let Some(name) = strip_suffix(&key, &prefix, ":enabled") {
            let entry = overrides.entry(name.to_string()).or_insert(FlagValue {
                enabled: false,
                value: None,
            });
            entry.enabled = val == "true";
        } else if let Some(name) = strip_suffix(&key, &prefix, ":value") {
            let entry = overrides.entry(name.to_string()).or_insert(FlagValue {
                enabled: false,
                value: None,
            });
            entry.value = Some(val);
        }
    }
    overrides.retain(|name, _| has_sentinel.get(name).copied().unwrap_or(false));
    Ok(overrides)
}

/// Walk `defs` and produce the flat `(name, optional_value)` list ready to
/// feed into `AgentSettings.extra_claude_flags`. Repo overrides win over
/// global values; disabled flags are skipped; flags not present in `defs`
/// are skipped (silent ignore — see plan failure-modes).
pub fn resolve_for_repo(
    db: &Database,
    defs: &[ClaudeFlagDef],
    repo_id: Option<&str>,
) -> Result<Vec<(String, Option<String>)>, rusqlite::Error> {
    let global = load_global(db)?;
    let repo = match repo_id {
        Some(id) => load_repo_overrides(db, id)?,
        None => HashMap::new(),
    };

    let mut out = Vec::new();
    for def in defs {
        let chosen = repo.get(&def.name).or_else(|| global.get(&def.name));
        let Some(fv) = chosen else { continue };
        if !fv.enabled {
            continue;
        }
        let value = if def.takes_value {
            fv.value.clone()
        } else {
            None
        };
        out.push((def.name.clone(), value));
    }
    Ok(out)
}

pub fn set_global_flag(
    db: &Database,
    name: &str,
    enabled: bool,
    value: Option<&str>,
) -> Result<(), rusqlite::Error> {
    db.set_app_setting(
        &global_enabled_key(name),
        if enabled { "true" } else { "false" },
    )?;
    match value {
        Some(v) if !v.is_empty() => {
            db.set_app_setting(&global_value_key(name), v)?;
        }
        _ => {
            db.delete_app_setting(&global_value_key(name))?;
        }
    }
    Ok(())
}

pub fn set_repo_override(
    db: &Database,
    repo_id: &str,
    name: &str,
    enabled: bool,
    value: Option<&str>,
) -> Result<(), rusqlite::Error> {
    db.set_app_setting(&repo_override_key(repo_id, name), "true")?;
    db.set_app_setting(
        &repo_enabled_key(repo_id, name),
        if enabled { "true" } else { "false" },
    )?;
    match value {
        Some(v) if !v.is_empty() => {
            db.set_app_setting(&repo_value_key(repo_id, name), v)?;
        }
        _ => {
            db.delete_app_setting(&repo_value_key(repo_id, name))?;
        }
    }
    Ok(())
}

pub fn clear_repo_override(
    db: &Database,
    repo_id: &str,
    name: &str,
) -> Result<(), rusqlite::Error> {
    db.delete_app_setting(&repo_override_key(repo_id, name))?;
    db.delete_app_setting(&repo_enabled_key(repo_id, name))?;
    db.delete_app_setting(&repo_value_key(repo_id, name))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn def(name: &str, takes_value: bool) -> ClaudeFlagDef {
        ClaudeFlagDef {
            name: name.to_string(),
            short: None,
            takes_value,
            value_placeholder: None,
            enum_choices: None,
            description: String::new(),
            is_dangerous: false,
        }
    }

    fn open_db() -> (Database, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let db = Database::open(&db_path).unwrap();
        (db, dir)
    }

    #[test]
    fn resolve_uses_global_when_no_overrides() {
        let (db, _td) = open_db();
        set_global_flag(&db, "--debug", true, None).unwrap();
        set_global_flag(&db, "--add-dir", true, Some("/foo")).unwrap();
        let defs = vec![def("--debug", false), def("--add-dir", true)];
        let resolved = resolve_for_repo(&db, &defs, Some("r1")).unwrap();
        assert!(resolved.contains(&("--debug".to_string(), None)));
        assert!(resolved.contains(&("--add-dir".to_string(), Some("/foo".to_string()))));
    }

    #[test]
    fn resolve_repo_override_wins() {
        let (db, _td) = open_db();
        set_global_flag(&db, "--add-dir", true, Some("/global")).unwrap();
        set_repo_override(&db, "r1", "--add-dir", true, Some("/repo")).unwrap();
        let defs = vec![def("--add-dir", true)];
        let resolved = resolve_for_repo(&db, &defs, Some("r1")).unwrap();
        assert_eq!(
            resolved,
            vec![("--add-dir".to_string(), Some("/repo".to_string()))]
        );
    }

    #[test]
    fn resolve_disabled_flags_excluded() {
        let (db, _td) = open_db();
        set_global_flag(&db, "--debug", false, None).unwrap();
        let defs = vec![def("--debug", false)];
        let resolved = resolve_for_repo(&db, &defs, Some("r1")).unwrap();
        assert!(resolved.is_empty());
    }

    #[test]
    fn resolve_repo_override_can_disable_globally_enabled_flag() {
        let (db, _td) = open_db();
        set_global_flag(&db, "--debug", true, None).unwrap();
        set_repo_override(&db, "r1", "--debug", false, None).unwrap();
        let defs = vec![def("--debug", false)];
        let resolved = resolve_for_repo(&db, &defs, Some("r1")).unwrap();
        assert!(resolved.is_empty(), "repo override must be able to disable");
    }

    #[test]
    fn resolve_repo_override_only_applies_when_sentinel_set() {
        // Setting :enabled / :value without :override should not bypass
        // the global value — load_repo_overrides should ignore those.
        let (db, _td) = open_db();
        set_global_flag(&db, "--debug", true, None).unwrap();
        // Write repo enabled=false directly without going through
        // set_repo_override — i.e. no :override sentinel.
        db.set_app_setting(&repo_enabled_key("r1", "--debug"), "false")
            .unwrap();
        let defs = vec![def("--debug", false)];
        let resolved = resolve_for_repo(&db, &defs, Some("r1")).unwrap();
        // Global wins because there's no :override sentinel.
        assert_eq!(resolved, vec![("--debug".to_string(), None)]);
    }

    #[test]
    fn clear_repo_override_restores_global() {
        let (db, _td) = open_db();
        set_global_flag(&db, "--debug", true, None).unwrap();
        set_repo_override(&db, "r1", "--debug", false, None).unwrap();
        clear_repo_override(&db, "r1", "--debug").unwrap();
        let defs = vec![def("--debug", false)];
        let resolved = resolve_for_repo(&db, &defs, Some("r1")).unwrap();
        assert_eq!(resolved, vec![("--debug".to_string(), None)]);
    }

    #[test]
    fn resolve_skips_flags_not_in_defs() {
        let (db, _td) = open_db();
        set_global_flag(&db, "--gone-flag", true, None).unwrap();
        let defs: Vec<ClaudeFlagDef> = vec![]; // upstream removed the flag
        let resolved = resolve_for_repo(&db, &defs, None).unwrap();
        assert!(resolved.is_empty());
    }

    #[test]
    fn resolve_no_repo_id_uses_global() {
        let (db, _td) = open_db();
        set_global_flag(&db, "--debug", true, None).unwrap();
        let defs = vec![def("--debug", false)];
        let resolved = resolve_for_repo(&db, &defs, None).unwrap();
        assert_eq!(resolved, vec![("--debug".to_string(), None)]);
    }

    #[test]
    fn boolean_flag_drops_value_even_if_persisted() {
        // A flag stored with takes_value=true at one point, then upstream
        // changed it to a boolean — value should be dropped.
        let (db, _td) = open_db();
        set_global_flag(&db, "--debug", true, Some("ignored")).unwrap();
        let defs = vec![def("--debug", false)];
        let resolved = resolve_for_repo(&db, &defs, None).unwrap();
        assert_eq!(resolved, vec![("--debug".to_string(), None)]);
    }

    #[test]
    fn set_global_flag_with_none_value_does_not_persist_value_key() {
        let (db, _td) = open_db();
        set_global_flag(&db, "--add-dir", true, None).unwrap();
        let loaded = load_global(&db).unwrap();
        let entry = loaded.get("--add-dir").expect("flag should exist");
        assert!(entry.enabled);
        assert!(
            entry.value.is_none(),
            "value should be None, got {:?}",
            entry.value
        );
    }

    #[test]
    fn set_global_flag_with_empty_string_treated_as_none() {
        let (db, _td) = open_db();
        set_global_flag(&db, "--add-dir", true, Some("")).unwrap();
        let loaded = load_global(&db).unwrap();
        let entry = loaded.get("--add-dir").expect("flag should exist");
        assert!(entry.enabled);
        assert!(
            entry.value.is_none(),
            "empty string should be treated as None, got {:?}",
            entry.value
        );
    }

    #[test]
    fn set_global_flag_with_real_value_persists() {
        let (db, _td) = open_db();
        set_global_flag(&db, "--add-dir", true, Some("/foo")).unwrap();
        let loaded = load_global(&db).unwrap();
        let entry = loaded.get("--add-dir").expect("flag should exist");
        assert_eq!(entry.value.as_deref(), Some("/foo"));
    }

    #[test]
    fn set_global_flag_clearing_value_deletes_value_key() {
        let (db, _td) = open_db();
        set_global_flag(&db, "--add-dir", true, Some("/foo")).unwrap();
        set_global_flag(&db, "--add-dir", true, None).unwrap();
        let loaded = load_global(&db).unwrap();
        let entry = loaded.get("--add-dir").expect("flag should exist");
        assert!(
            entry.value.is_none(),
            "stale value should be cleared, got {:?}",
            entry.value
        );
    }

    #[test]
    fn set_repo_override_with_empty_string_treated_as_none() {
        let (db, _td) = open_db();
        set_repo_override(&db, "r1", "--add-dir", true, Some("")).unwrap();
        let loaded = load_repo_overrides(&db, "r1").unwrap();
        let entry = loaded.get("--add-dir").expect("override should exist");
        assert!(
            entry.value.is_none(),
            "empty string should be treated as None"
        );
    }

    #[test]
    fn set_repo_override_clearing_value_deletes_value_key() {
        let (db, _td) = open_db();
        set_repo_override(&db, "r1", "--add-dir", true, Some("/foo")).unwrap();
        set_repo_override(&db, "r1", "--add-dir", true, None).unwrap();
        let loaded = load_repo_overrides(&db, "r1").unwrap();
        let entry = loaded.get("--add-dir").expect("override should exist");
        assert!(entry.value.is_none(), "stale value should be cleared");
    }

    #[test]
    fn load_global_skips_malformed_enabled_value() {
        let (db, _td) = open_db();
        // Manually write a bad :enabled value (not "true" or "false").
        // The loader must skip the entry rather than crash.
        db.set_app_setting("claude_flag:--add-dir:enabled", "yes")
            .unwrap();
        db.set_app_setting("claude_flag:--add-dir:value", "/tmp")
            .unwrap();

        let loaded = load_global(&db).unwrap();
        assert!(
            !loaded.contains_key("--add-dir"),
            "malformed :enabled string should drop the flag, got {:?}",
            loaded.get("--add-dir"),
        );
    }

    #[test]
    fn load_repo_overrides_skips_entries_without_sentinel() {
        let (db, _td) = open_db();
        // :enabled and :value present but no :override sentinel — must
        // be filtered out of the repo overrides map.
        db.set_app_setting("repo:r1:claude_flag:--add-dir:enabled", "true")
            .unwrap();
        db.set_app_setting("repo:r1:claude_flag:--add-dir:value", "/x")
            .unwrap();
        let loaded = load_repo_overrides(&db, "r1").unwrap();
        assert!(
            loaded.is_empty(),
            "entries without :override sentinel should be skipped, got {:?}",
            loaded,
        );
    }

    #[test]
    fn resolve_for_repo_with_none_repo_uses_global() {
        let (db, _td) = open_db();
        set_global_flag(&db, "--debug", true, None).unwrap();
        let defs = vec![ClaudeFlagDef {
            name: "--debug".to_string(),
            short: None,
            takes_value: false,
            value_placeholder: None,
            enum_choices: None,
            description: String::new(),
            is_dangerous: false,
        }];
        let resolved = resolve_for_repo(&db, &defs, None).unwrap();
        assert_eq!(resolved, vec![("--debug".to_string(), None)]);
    }
}
