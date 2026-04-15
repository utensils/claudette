use std::collections::HashSet;

use claudette_server::auth::{
    AuthSection, MAX_SESSIONS, ServerConfig, ServerSection, SessionEntry, generate_token,
};
use tempfile::tempdir;

/// Helper: build a minimal ServerConfig for tests that don't need filesystem.
fn test_config() -> ServerConfig {
    ServerConfig {
        server: ServerSection {
            name: "test-host".to_string(),
            port: 7683,
            bind: "0.0.0.0".to_string(),
        },
        auth: AuthSection {
            pairing_token: generate_token(),
        },
        sessions: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// 1. Token generation
// ---------------------------------------------------------------------------

#[test]
fn token_length_is_43_chars() {
    // 32 bytes -> ceil(32*4/3) = 43 URL-safe base64 characters without padding.
    let token = generate_token();
    assert_eq!(
        token.len(),
        43,
        "Expected 43-char token, got {} chars: {token}",
        token.len()
    );
}

#[test]
fn token_contains_only_url_safe_base64_chars() {
    for _ in 0..50 {
        let token = generate_token();
        for ch in token.chars() {
            assert!(
                ch.is_ascii_alphanumeric() || ch == '-' || ch == '_',
                "Unexpected character '{ch}' in token: {token}"
            );
        }
    }
}

#[test]
fn hundred_tokens_all_unique() {
    let tokens: HashSet<String> = (0..100).map(|_| generate_token()).collect();
    assert_eq!(
        tokens.len(),
        100,
        "Expected 100 unique tokens, got {}",
        tokens.len()
    );
}

#[test]
fn token_has_no_padding() {
    for _ in 0..20 {
        let token = generate_token();
        assert!(
            !token.contains('='),
            "Token should not contain '=' padding: {token}"
        );
    }
}

#[test]
fn token_has_no_plus_or_slash() {
    // URL-safe base64 uses - and _ instead of + and /
    for _ in 0..20 {
        let token = generate_token();
        assert!(
            !token.contains('+'),
            "Token contains '+' (not URL-safe): {token}"
        );
        assert!(
            !token.contains('/'),
            "Token contains '/' (not URL-safe): {token}"
        );
    }
}

// ---------------------------------------------------------------------------
// 2. load_or_create
// ---------------------------------------------------------------------------

#[test]
fn load_or_create_nonexistent_creates_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.toml");
    assert!(!path.exists());

    let config = ServerConfig::load_or_create(&path).unwrap();
    assert!(path.exists(), "Config file should be created on disk");
    assert!(!config.auth.pairing_token.is_empty());
    assert!(config.sessions.is_empty());
}

#[test]
fn load_or_create_creates_parent_directories() {
    let dir = tempdir().unwrap();
    let path = dir
        .path()
        .join("deeply")
        .join("nested")
        .join("dir")
        .join("server.toml");
    assert!(!path.exists());

    let config = ServerConfig::load_or_create(&path).unwrap();
    assert!(path.exists());
    assert!(!config.auth.pairing_token.is_empty());
}

#[test]
fn load_or_create_existing_valid_file_loads_correctly() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.toml");

    let original = test_config();
    original.save(&path).unwrap();

    let loaded = ServerConfig::load_or_create(&path).unwrap();
    assert_eq!(loaded.auth.pairing_token, original.auth.pairing_token);
    assert_eq!(loaded.server.name, original.server.name);
    assert_eq!(loaded.server.port, original.server.port);
}

#[test]
fn load_or_create_malformed_toml_returns_err() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.toml");
    std::fs::write(&path, "this is not valid {{ toml ]]").unwrap();

    let result = ServerConfig::load_or_create(&path);
    assert!(result.is_err(), "Malformed TOML should produce an error");
}

#[test]
fn load_or_create_empty_file_returns_err() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.toml");
    std::fs::write(&path, "").unwrap();

    let result = ServerConfig::load_or_create(&path);
    assert!(
        result.is_err(),
        "Empty file should fail to deserialize into ServerConfig"
    );
}

#[test]
fn load_or_create_missing_sections_returns_err() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.toml");
    // Valid TOML but missing required sections.
    std::fs::write(&path, "[server]\nname = \"x\"\n").unwrap();

    let result = ServerConfig::load_or_create(&path);
    assert!(
        result.is_err(),
        "Incomplete config should fail deserialization"
    );
}

// ---------------------------------------------------------------------------
// 3. Save roundtrip
// ---------------------------------------------------------------------------

#[test]
fn save_and_load_roundtrip_preserves_all_fields() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.toml");

    let mut original = test_config();
    original.server.name = "custom-name".to_string();
    original.server.port = 9999;
    original.server.bind = "127.0.0.1".to_string();
    // Add a session manually.
    original.sessions.push(SessionEntry {
        token: "session-tok-abc".to_string(),
        name: "my-laptop".to_string(),
        created_at: "2025-01-01T00:00:00Z".to_string(),
        last_seen: "2025-01-02T00:00:00Z".to_string(),
    });

    original.save(&path).unwrap();
    let loaded = ServerConfig::load_or_create(&path).unwrap();

    assert_eq!(loaded.server.name, "custom-name");
    assert_eq!(loaded.server.port, 9999);
    assert_eq!(loaded.server.bind, "127.0.0.1");
    assert_eq!(loaded.auth.pairing_token, original.auth.pairing_token);
    assert_eq!(loaded.sessions.len(), 1);
    assert_eq!(loaded.sessions[0].token, "session-tok-abc");
    assert_eq!(loaded.sessions[0].name, "my-laptop");
    assert_eq!(loaded.sessions[0].created_at, "2025-01-01T00:00:00Z");
    assert_eq!(loaded.sessions[0].last_seen, "2025-01-02T00:00:00Z");
}

#[test]
fn save_overwrites_existing_file() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.toml");

    let mut config = test_config();
    config.server.port = 1111;
    config.save(&path).unwrap();

    config.server.port = 2222;
    config.save(&path).unwrap();

    let loaded = ServerConfig::load_or_create(&path).unwrap();
    assert_eq!(loaded.server.port, 2222);
}

// ---------------------------------------------------------------------------
// 4. pair()
// ---------------------------------------------------------------------------

#[test]
fn pair_correct_token_returns_some() {
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();

    let result = config.pair(&pairing_token, "client-1");
    assert!(result.is_some(), "Correct pairing token should return Some");
}

#[test]
fn pair_wrong_token_returns_none() {
    let mut config = test_config();

    let result = config.pair("completely-wrong-token", "client-1");
    assert!(result.is_none(), "Wrong pairing token should return None");
}

#[test]
fn pair_empty_token_returns_none() {
    let mut config = test_config();

    let result = config.pair("", "client-1");
    assert!(result.is_none(), "Empty pairing token should return None");
}

#[test]
fn pair_creates_session_with_correct_client_name() {
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();

    config.pair(&pairing_token, "my-macbook");
    assert_eq!(config.sessions.len(), 1);
    assert_eq!(config.sessions[0].name, "my-macbook");
}

#[test]
fn pair_returned_token_validates_as_session() {
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();

    let session_token = config.pair(&pairing_token, "client").unwrap();
    assert!(config.validate_session(&session_token));
}

#[test]
fn pair_sequential_caps_sessions_at_max() {
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();
    let total = MAX_SESSIONS + 10;

    let mut all_tokens = Vec::new();
    for i in 0..total {
        let st = config.pair(&pairing_token, &format!("client-{i}")).unwrap();
        all_tokens.push(st);
    }

    assert_eq!(
        config.sessions.len(),
        MAX_SESSIONS,
        "Sessions should be capped at MAX_SESSIONS"
    );

    // The first 10 sessions should have been evicted.
    for evicted in &all_tokens[..10] {
        assert!(
            !config.validate_session(evicted),
            "Evicted session token should no longer validate"
        );
    }

    // The newest sessions should still validate.
    for valid in &all_tokens[total - 5..] {
        assert!(
            config.validate_session(valid),
            "Recent session token should still validate"
        );
    }
}

#[test]
fn pair_evicts_oldest_session() {
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();

    // Fill up to MAX_SESSIONS.
    let mut tokens = Vec::new();
    for i in 0..MAX_SESSIONS {
        let st = config.pair(&pairing_token, &format!("client-{i}")).unwrap();
        tokens.push(st);
    }
    assert_eq!(config.sessions.len(), MAX_SESSIONS);

    // The first token is still valid.
    assert!(config.validate_session(&tokens[0]));

    // One more pairing should evict the oldest (index 0).
    let newest = config.pair(&pairing_token, "overflow-client").unwrap();
    assert_eq!(config.sessions.len(), MAX_SESSIONS);

    // The first token is now gone.
    assert!(
        !config.validate_session(&tokens[0]),
        "Oldest session should be evicted after exceeding MAX_SESSIONS"
    );

    // The newest token works.
    assert!(
        config.validate_session(&newest),
        "Newest session should validate"
    );
}

// ---------------------------------------------------------------------------
// 5. validate_session()
// ---------------------------------------------------------------------------

#[test]
fn validate_session_valid_returns_true() {
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();
    let session_token = config.pair(&pairing_token, "client").unwrap();

    assert!(config.validate_session(&session_token));
}

#[test]
fn validate_session_invalid_returns_false() {
    let mut config = test_config();

    assert!(!config.validate_session("nonexistent-session-token"));
}

#[test]
fn validate_session_empty_returns_false() {
    let mut config = test_config();

    assert!(!config.validate_session(""));
}

#[test]
fn validate_session_updates_last_seen() {
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();
    let session_token = config.pair(&pairing_token, "client").unwrap();

    let original_last_seen = config.sessions[0].last_seen.clone();

    // Sleep briefly to ensure the timestamp could change (at least 1 second
    // granularity in the ISO format).
    std::thread::sleep(std::time::Duration::from_millis(1100));

    config.validate_session(&session_token);
    let updated_last_seen = &config.sessions[0].last_seen;

    assert!(
        updated_last_seen >= &original_last_seen,
        "last_seen should be updated: original={original_last_seen}, updated={updated_last_seen}"
    );
}

#[test]
fn validate_session_does_not_alter_created_at() {
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();
    let session_token = config.pair(&pairing_token, "client").unwrap();

    let original_created_at = config.sessions[0].created_at.clone();

    std::thread::sleep(std::time::Duration::from_millis(1100));
    config.validate_session(&session_token);

    assert_eq!(
        config.sessions[0].created_at, original_created_at,
        "created_at must not change on validate_session"
    );
}

// ---------------------------------------------------------------------------
// 6. regenerate_token()
// ---------------------------------------------------------------------------

#[test]
fn regenerate_token_clears_sessions() {
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();
    config.pair(&pairing_token, "client-1");
    config.pair(&pairing_token, "client-2");
    assert_eq!(config.sessions.len(), 2);

    config.regenerate_token();
    assert!(
        config.sessions.is_empty(),
        "Sessions should be cleared after regenerate"
    );
}

#[test]
fn regenerate_token_changes_pairing_token() {
    let mut config = test_config();
    let old_token = config.auth.pairing_token.clone();

    config.regenerate_token();

    assert_ne!(
        config.auth.pairing_token, old_token,
        "Pairing token should change after regenerate"
    );
    assert_eq!(config.auth.pairing_token.len(), 43);
}

#[test]
fn regenerate_token_invalidates_old_sessions() {
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();
    let session_token = config.pair(&pairing_token, "client").unwrap();

    config.regenerate_token();

    assert!(
        !config.validate_session(&session_token),
        "Old session tokens must be invalid after regenerate"
    );
}

#[test]
fn regenerate_token_rejects_old_pairing_token() {
    let mut config = test_config();
    let old_pairing_token = config.auth.pairing_token.clone();

    config.regenerate_token();

    let result = config.pair(&old_pairing_token, "attacker");
    assert!(
        result.is_none(),
        "Old pairing token must be rejected after regenerate"
    );
}

#[test]
fn regenerate_token_new_token_works_for_pairing() {
    let mut config = test_config();
    config.regenerate_token();

    let new_pairing_token = config.auth.pairing_token.clone();
    let result = config.pair(&new_pairing_token, "new-client");
    assert!(
        result.is_some(),
        "New pairing token should work after regenerate"
    );
}

// ---------------------------------------------------------------------------
// 7. Edge cases
// ---------------------------------------------------------------------------

#[test]
fn unicode_client_name_survives_roundtrip() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.toml");

    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();
    config.pair(&pairing_token, "James's MacBook Pro");
    config.pair(&pairing_token, "\u{1F4BB} laptop");
    config.pair(&pairing_token, "\u{00E9}\u{00E0}\u{00FC}\u{00F1}");

    config.save(&path).unwrap();
    let loaded = ServerConfig::load_or_create(&path).unwrap();

    assert_eq!(loaded.sessions[0].name, "James's MacBook Pro");
    assert_eq!(loaded.sessions[1].name, "\u{1F4BB} laptop");
    assert_eq!(loaded.sessions[2].name, "\u{00E9}\u{00E0}\u{00FC}\u{00F1}");
}

#[test]
fn empty_client_name_accepted() {
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();

    let result = config.pair(&pairing_token, "");
    assert!(result.is_some(), "Empty client name should be accepted");
    assert_eq!(config.sessions[0].name, "");
}

#[test]
fn session_token_never_equals_pairing_token() {
    // Probabilistically impossible, but verify the code paths differ.
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();

    for _ in 0..100 {
        let session_token = config.pair(&pairing_token, "client").unwrap();
        assert_ne!(
            session_token, pairing_token,
            "Session token must differ from pairing token"
        );
    }
}

#[test]
fn session_timestamps_are_iso8601_format() {
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();
    config.pair(&pairing_token, "client");

    let ts = &config.sessions[0].created_at;
    // Basic ISO-8601 pattern: YYYY-MM-DDTHH:MM:SSZ
    assert_eq!(ts.len(), 20, "Timestamp should be 20 chars: {ts}");
    assert_eq!(&ts[4..5], "-");
    assert_eq!(&ts[7..8], "-");
    assert_eq!(&ts[10..11], "T");
    assert_eq!(&ts[13..14], ":");
    assert_eq!(&ts[16..17], ":");
    assert_eq!(&ts[19..20], "Z");
}

#[test]
fn multiple_sessions_independently_validated() {
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();

    let tok_a = config.pair(&pairing_token, "client-a").unwrap();
    let tok_b = config.pair(&pairing_token, "client-b").unwrap();

    assert!(config.validate_session(&tok_a));
    assert!(config.validate_session(&tok_b));
    assert!(!config.validate_session("nonexistent"));
}

#[test]
fn config_file_is_valid_toml_on_disk() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.toml");

    let config = test_config();
    config.save(&path).unwrap();

    let raw = std::fs::read_to_string(&path).unwrap();
    // Verify it parses as valid TOML.
    let parsed: toml::Value = toml::from_str(&raw).unwrap();
    assert!(parsed.get("server").is_some());
    assert!(parsed.get("auth").is_some());
}

#[test]
fn pair_with_pairing_token_as_session_token_fails() {
    // Ensure the pairing token itself is not accepted as a session token.
    let mut config = test_config();
    let pairing_token = config.auth.pairing_token.clone();

    assert!(
        !config.validate_session(&pairing_token),
        "Pairing token should not be valid as a session token"
    );
}

#[test]
fn load_or_create_two_calls_same_path_yield_same_token() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.toml");

    let first = ServerConfig::load_or_create(&path).unwrap();
    let second = ServerConfig::load_or_create(&path).unwrap();

    assert_eq!(
        first.auth.pairing_token, second.auth.pairing_token,
        "Loading the same file twice should yield the same pairing token"
    );
}
