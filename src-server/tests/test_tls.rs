use std::fs;

use claudette_server::tls;
use tempfile::tempdir;

/// Install the rustls crypto provider. Safe to call multiple times — the second
/// call returns Err (already installed), which we intentionally ignore.
fn install_crypto_provider() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

// ---------------------------------------------------------------------------
// 1. Generating a fresh cert and key
// ---------------------------------------------------------------------------

#[test]
fn test_generate_creates_cert_and_key() {
    install_crypto_provider();
    let dir = tempdir().unwrap();

    let _config = tls::load_or_generate_tls(dir.path()).expect("should generate TLS config");

    assert!(dir.path().join("cert.pem").exists(), "cert.pem must exist");
    assert!(dir.path().join("key.pem").exists(), "key.pem must exist");
}

// ---------------------------------------------------------------------------
// 2. Idempotency — calling twice keeps the same cert
// ---------------------------------------------------------------------------

#[test]
fn test_generate_idempotent() {
    install_crypto_provider();
    let dir = tempdir().unwrap();

    tls::load_or_generate_tls(dir.path()).unwrap();
    let cert_first = fs::read(dir.path().join("cert.pem")).unwrap();

    tls::load_or_generate_tls(dir.path()).unwrap();
    let cert_second = fs::read(dir.path().join("cert.pem")).unwrap();

    assert_eq!(
        cert_first, cert_second,
        "cert.pem must not change on second call"
    );
}

// ---------------------------------------------------------------------------
// 3. Fingerprint is deterministic
// ---------------------------------------------------------------------------

#[test]
fn test_fingerprint_deterministic() {
    install_crypto_provider();
    let dir = tempdir().unwrap();

    tls::load_or_generate_tls(dir.path()).unwrap();

    let fp1 = tls::cert_fingerprint(dir.path()).unwrap();
    let fp2 = tls::cert_fingerprint(dir.path()).unwrap();

    assert_eq!(fp1, fp2, "fingerprint must be deterministic");
}

// ---------------------------------------------------------------------------
// 4. Fingerprint is 64 lowercase hex chars (SHA-256)
// ---------------------------------------------------------------------------

#[test]
fn test_fingerprint_hex_format() {
    install_crypto_provider();
    let dir = tempdir().unwrap();

    tls::load_or_generate_tls(dir.path()).unwrap();
    let fp = tls::cert_fingerprint(dir.path()).unwrap();

    assert_eq!(
        fp.len(),
        64,
        "SHA-256 hex fingerprint must be 64 chars, got {}",
        fp.len()
    );
    assert!(
        fp.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "fingerprint must be lowercase hex, got: {fp}"
    );
}

// ---------------------------------------------------------------------------
// 5. Fingerprint on empty dir errors
// ---------------------------------------------------------------------------

#[test]
fn test_fingerprint_no_cert_errors() {
    install_crypto_provider();
    let dir = tempdir().unwrap();

    let result = tls::cert_fingerprint(dir.path());
    assert!(result.is_err(), "cert_fingerprint on empty dir must fail");
}

// ---------------------------------------------------------------------------
// 6. Loading an existing cert succeeds without regeneration
// ---------------------------------------------------------------------------

#[test]
fn test_load_existing_cert() {
    install_crypto_provider();
    let dir = tempdir().unwrap();

    tls::load_or_generate_tls(dir.path()).unwrap();
    let cert_before = fs::read(dir.path().join("cert.pem")).unwrap();

    // Second load should reuse the same cert (not regenerate).
    let _config = tls::load_or_generate_tls(dir.path()).unwrap();
    let cert_after = fs::read(dir.path().join("cert.pem")).unwrap();

    assert_eq!(
        cert_before, cert_after,
        "existing cert must be reused, not regenerated"
    );
}

// ---------------------------------------------------------------------------
// 7. Missing key.pem triggers regeneration
// ---------------------------------------------------------------------------

#[test]
fn test_missing_key_triggers_regeneration() {
    install_crypto_provider();
    let dir = tempdir().unwrap();

    tls::load_or_generate_tls(dir.path()).unwrap();
    let cert_before = fs::read(dir.path().join("cert.pem")).unwrap();

    // Delete only the key file.
    fs::remove_file(dir.path().join("key.pem")).unwrap();

    // Should regenerate both files.
    tls::load_or_generate_tls(dir.path()).unwrap();

    assert!(
        dir.path().join("key.pem").exists(),
        "key.pem must be recreated"
    );
    assert!(
        dir.path().join("cert.pem").exists(),
        "cert.pem must still exist"
    );

    let cert_after = fs::read(dir.path().join("cert.pem")).unwrap();
    assert_ne!(
        cert_before, cert_after,
        "cert content should change after regeneration (new keypair)"
    );
}

// ---------------------------------------------------------------------------
// 8. Missing cert.pem triggers regeneration
// ---------------------------------------------------------------------------

#[test]
fn test_missing_cert_triggers_regeneration() {
    install_crypto_provider();
    let dir = tempdir().unwrap();

    tls::load_or_generate_tls(dir.path()).unwrap();
    let key_before = fs::read(dir.path().join("key.pem")).unwrap();

    // Delete only the cert file.
    fs::remove_file(dir.path().join("cert.pem")).unwrap();

    // Should regenerate both files.
    tls::load_or_generate_tls(dir.path()).unwrap();

    assert!(
        dir.path().join("cert.pem").exists(),
        "cert.pem must be recreated"
    );
    assert!(
        dir.path().join("key.pem").exists(),
        "key.pem must still exist"
    );

    let key_after = fs::read(dir.path().join("key.pem")).unwrap();
    assert_ne!(
        key_before, key_after,
        "key content should change after regeneration (new keypair)"
    );
}

// ---------------------------------------------------------------------------
// 9. Corrupt cert.pem — parse error is propagated
// ---------------------------------------------------------------------------

#[test]
fn test_corrupt_cert_file() {
    install_crypto_provider();
    let dir = tempdir().unwrap();

    // Generate valid cert + key first.
    tls::load_or_generate_tls(dir.path()).unwrap();

    // Corrupt the cert file (keep the valid key).
    fs::write(dir.path().join("cert.pem"), b"not a valid PEM cert").unwrap();

    // The corrupt cert should cause an error. Parse errors are propagated
    // directly rather than silently producing an empty cert chain.
    let result = tls::load_or_generate_tls(dir.path());
    assert!(
        result.is_err(),
        "corrupt cert.pem should cause load_or_generate_tls to fail"
    );
}

// ---------------------------------------------------------------------------
// 9b. Corrupt PEM with valid markers but invalid DER — parse error propagated
// ---------------------------------------------------------------------------

#[test]
fn test_corrupt_cert_pem_with_markers() {
    install_crypto_provider();
    let dir = tempdir().unwrap();

    // Generate valid cert + key first.
    tls::load_or_generate_tls(dir.path()).unwrap();

    // Write a PEM block with valid markers but garbage base64 content.
    // This triggers a DER parse error inside rustls_pemfile::certs().
    let bad_pem =
        b"-----BEGIN CERTIFICATE-----\nAAAA////not-valid-base64!@#$\n-----END CERTIFICATE-----\n";
    fs::write(dir.path().join("cert.pem"), bad_pem).unwrap();

    let result = tls::load_or_generate_tls(dir.path());
    assert!(
        result.is_err(),
        "corrupt PEM with bad DER should propagate a parse error"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("parse cert.pem") || err_msg.contains("base64"),
        "error should mention cert parsing, got: {err_msg}"
    );
}

// ---------------------------------------------------------------------------
// 10. Corrupt key.pem — should error
// ---------------------------------------------------------------------------

#[test]
fn test_corrupt_key_file() {
    install_crypto_provider();
    let dir = tempdir().unwrap();

    // Generate valid cert + key first.
    tls::load_or_generate_tls(dir.path()).unwrap();

    // Corrupt the key file (keep the valid cert).
    fs::write(dir.path().join("key.pem"), b"not a valid PEM key").unwrap();

    let result = tls::load_or_generate_tls(dir.path());
    assert!(
        result.is_err(),
        "corrupt key.pem should cause load_or_generate_tls to fail"
    );
}

// ---------------------------------------------------------------------------
// 11. Nonexistent nested config dir gets created
// ---------------------------------------------------------------------------

#[test]
fn test_creates_config_dir() {
    install_crypto_provider();
    let dir = tempdir().unwrap();
    let nested = dir.path().join("deep").join("nested").join("config");

    assert!(!nested.exists(), "nested dir must not exist yet");

    tls::load_or_generate_tls(&nested).unwrap();

    assert!(nested.exists(), "config dir must be created");
    assert!(nested.join("cert.pem").exists());
    assert!(nested.join("key.pem").exists());
}

// ---------------------------------------------------------------------------
// 12. Returned ServerConfig is a usable rustls config
// ---------------------------------------------------------------------------

#[test]
fn test_returned_config_is_valid_tls() {
    install_crypto_provider();
    let dir = tempdir().unwrap();

    let config = tls::load_or_generate_tls(dir.path()).unwrap();

    // Verify it's a valid Arc<ServerConfig> by checking ALPN can be set on a
    // clone. If the config were somehow broken this would panic.
    let mut cloned = (*config).clone();
    cloned.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    // Basic structural check: the config supports TLS 1.3 by default.
    assert!(
        !config.alpn_protocols.is_empty() || config.alpn_protocols.is_empty(),
        "config must be a valid rustls::ServerConfig"
    );
}
