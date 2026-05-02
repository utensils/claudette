//! Minisign signature verification for the community registry.
//!
//! Trust model: the only trust anchor for `registry.json` is a
//! [minisign](https://jedisct1.github.io/minisign/) signature produced
//! by a key whose public half is **embedded in the Claudette binary**
//! at compile time (see `trust/community-registry.pub`). The fetched
//! `registry.json.sig` is verified against this embedded key before
//! `registry.json` is parsed; nothing about the network response or
//! the registry contents is trusted until that check passes.
//!
//! Rotation: [`accepted_public_keys`] returns a slice — today it has
//! one entry, but adding a second keypair is a one-line change that
//! lets a new release accept signatures from either key while the old
//! one is retired. See `keys/README.md` in `claudette-community` for
//! the procedure.
//!
//! Verifier-only: this module never signs. Signing happens in the
//! `claudette-community` CI with a secret stored only in GitHub
//! Actions Secrets.
//!
//! Note on attack surface: an attacker who can swap `registry.json`
//! and `registry.json.sig` on the network can at most cause Claudette
//! to refuse the install (if the sig doesn't verify) or replay an
//! older signed registry (if they captured one previously). The first
//! is a denial-of-service, not a code-execution path; the second is
//! mitigated by per-entry content hashes — installing a stale registry
//! still pins each contribution to its sha256.

use std::sync::LazyLock;

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

/// Raw text of the embedded community-registry public key.
const EMBEDDED_PUBKEY_TEXT: &str = include_str!("trust/community-registry.pub");

/// Parsed pubkey + key-id fingerprint, lazily decoded from
/// [`EMBEDDED_PUBKEY_TEXT`]. Stored as a `Result` so a malformed
/// embedded file surfaces as a [`SignatureError::EmbeddedKey`] on the
/// first verify call rather than panicking the process.
///
/// Each entry corresponds to one trusted signing key. Today: one.
/// Adding a second slot is how key rotation works — ship a release
/// with `[OLD, NEW]`, switch the CI signer to `NEW`, then ship a
/// release with `[NEW]` only. The verifier accepts a signature from
/// any embedded key.
#[derive(Debug)]
struct EmbeddedKey {
    pubkey: PublicKey,
    /// Hex (uppercase) of the 8 key-id bytes from the parsed pubkey
    /// payload. This is the same value `minisign` itself prints, but
    /// derived from the cryptographic key bytes — not from the
    /// `untrusted comment:` line, which is plaintext metadata that
    /// could drift from the real key id if the file were hand-edited.
    fingerprint: String,
}

static EMBEDDED_KEYS: LazyLock<Result<Vec<EmbeddedKey>, String>> =
    LazyLock::new(|| parse_embedded_keys(EMBEDDED_PUBKEY_TEXT));

fn parse_embedded_keys(pub_text: &str) -> Result<Vec<EmbeddedKey>, String> {
    let key_b64 = pub_text
        .lines()
        .find(|l| !l.is_empty() && !l.starts_with("untrusted comment:"))
        .ok_or("embedded community-registry.pub is malformed (no key line)")?
        .trim();
    let pubkey = PublicKey::from_base64(key_b64).map_err(|e| {
        format!("embedded community-registry.pub is not a valid minisign pubkey: {e}")
    })?;
    let fingerprint = derive_fingerprint(key_b64)?;
    Ok(vec![EmbeddedKey {
        pubkey,
        fingerprint,
    }])
}

/// Decode the minisign pubkey payload (`<algo:2><key_id:8><key:32>` =
/// 42 bytes, base64-encoded) and return the hex-uppercase key id.
/// Bound directly to the cryptographic key bytes — independent of the
/// `untrusted comment:` line.
fn derive_fingerprint(key_b64: &str) -> Result<String, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(key_b64.as_bytes())
        .map_err(|e| format!("embedded pubkey base64 decode: {e}"))?;
    if raw.len() < 10 {
        return Err(format!(
            "embedded pubkey payload too short ({} bytes; expected ≥ 10)",
            raw.len()
        ));
    }
    // Bytes layout: [algo:2][key_id:8][ed25519:32]. minisign displays
    // the key_id in reversed (little-endian) byte order in its
    // `untrusted comment: minisign public key <FP>` line and in
    // `-V` / `-G` output, so we reverse here to match. The bytes
    // themselves are still derived from the cryptographic payload —
    // not from the plaintext comment line.
    let mut key_id = [0u8; 8];
    key_id.copy_from_slice(&raw[2..10]);
    key_id.reverse();
    let mut hex = String::with_capacity(16);
    for b in &key_id {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{b:02X}");
    }
    Ok(hex)
}

/// Hex (uppercase) of the embedded production public key's key id —
/// derived from the parsed key bytes, **not** from the `untrusted
/// comment:` line. Matches the value `minisign` itself displays.
///
/// Returns `"unknown"` if the embedded file failed to parse; the
/// verify path returns the underlying error in that case.
pub fn embedded_key_fingerprint() -> String {
    match EMBEDDED_KEYS.as_ref() {
        Ok(keys) => keys
            .first()
            .map(|k| k.fingerprint.clone())
            .unwrap_or_else(|| "unknown".to_string()),
        Err(_) => "unknown".to_string(),
    }
}

#[derive(Debug)]
pub enum SignatureError {
    /// The signature file couldn't be parsed — wrong format, truncated,
    /// or empty bytes.
    MalformedSignature(minisign_verify::Error),
    /// Signature parsed cleanly but doesn't verify against any embedded
    /// public key — either the message was tampered with, the signature
    /// was forged, or it was signed with a key Claudette doesn't trust.
    InvalidSignature {
        embedded_fingerprint: String,
        underlying: minisign_verify::Error,
    },
    /// The pubkey baked into the binary at compile time couldn't be
    /// parsed. Should never happen in a release build (the file is
    /// in-tree and the test suite parses it); guards against a future
    /// hand-edit that breaks the format without us noticing.
    EmbeddedKey(String),
}

impl std::fmt::Display for SignatureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MalformedSignature(e) => {
                write!(f, "registry.json.sig is malformed: {e}")
            }
            Self::InvalidSignature {
                embedded_fingerprint,
                underlying,
            } => {
                write!(
                    f,
                    "registry.json.sig does not verify against the embedded \
                     community-registry public key (fingerprint {embedded_fingerprint}): \
                     {underlying}"
                )
            }
            Self::EmbeddedKey(msg) => {
                write!(
                    f,
                    "embedded community-registry public key could not be loaded: {msg} \
                     (this is a build-time bug — please file an issue)"
                )
            }
        }
    }
}

impl std::error::Error for SignatureError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::MalformedSignature(e) | Self::InvalidSignature { underlying: e, .. } => Some(e),
            Self::EmbeddedKey(_) => None,
        }
    }
}

/// Verify `sig_bytes` (the raw contents of `registry.json.sig`) is a
/// valid signature over `message` (the raw contents of `registry.json`)
/// produced by any of the embedded public keys.
///
/// Returns `Ok(())` on success. Any failure — malformed sig file,
/// signature that decodes but doesn't verify, signature for a different
/// key, malformed embedded key — collapses into [`SignatureError`]
/// with enough context for the UI to surface a useful error string.
pub fn verify_registry_signature(message: &[u8], sig_bytes: &[u8]) -> Result<(), SignatureError> {
    // Surface a malformed embedded key as a recoverable error rather
    // than panicking the process. Should never trip in a release build
    // (the embedded pubkey is in-tree and parsed by the test suite),
    // but a hand-edit that breaks the format would otherwise crash on
    // first install.
    let keys = EMBEDDED_KEYS
        .as_ref()
        .map_err(|e| SignatureError::EmbeddedKey(e.clone()))?;

    // Signature::decode wants a `&str`. The .sig file is ASCII (base64
    // + comments), so a non-utf8 body is itself a sign of a malformed
    // file — collapse to MalformedSignature rather than panic.
    let sig_str = std::str::from_utf8(sig_bytes)
        .map_err(|_| SignatureError::MalformedSignature(minisign_verify::Error::InvalidEncoding))?;
    let sig = Signature::decode(sig_str).map_err(SignatureError::MalformedSignature)?;

    let mut last_err: Option<minisign_verify::Error> = None;
    for entry in keys {
        match entry.pubkey.verify(message, &sig, false) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    Err(SignatureError::InvalidSignature {
        embedded_fingerprint: embedded_key_fingerprint(),
        underlying: last_err.unwrap_or(minisign_verify::Error::InvalidSignature),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test fixtures generated once with `minisign -G -W` + `minisign
    // -S` (see commit message). Independent of the production keypair
    // so unit tests don't depend on the in-the-wild key state.
    const TEST_PUBKEY: &str = include_str!("trust/test_fixtures/test.pub");
    const TEST_MESSAGE: &[u8] = include_bytes!("trust/test_fixtures/test_message.bin");
    const TEST_SIG: &str = include_str!("trust/test_fixtures/test_message.bin.minisig");

    // Round-trip fixture signed by the *production* key — proves the
    // embedded pubkey actually verifies signatures from the matching
    // secret. Without this, "verify against embedded key" would only
    // be tested negatively (rejection of wrong-key sigs).
    const PROD_MESSAGE: &[u8] = include_bytes!("trust/test_fixtures/prod_test_message.bin");
    const PROD_SIG: &str = include_str!("trust/test_fixtures/prod_test_message.bin.minisig");

    /// Helper: verify TEST_MESSAGE + TEST_SIG against TEST_PUBKEY
    /// directly (bypassing the embedded-key path) so the cryptographic
    /// portion of the test is independent of the embedded key. We also
    /// test the embedded-key path separately below.
    fn verify_with_test_key(
        message: &[u8],
        sig_bytes: &[u8],
    ) -> Result<(), minisign_verify::Error> {
        let key_b64 = TEST_PUBKEY
            .lines()
            .find(|l| !l.is_empty() && !l.starts_with("untrusted comment:"))
            .expect("test pubkey malformed");
        let pubkey = PublicKey::from_base64(key_b64.trim()).expect("test pubkey decode");
        let sig_str = std::str::from_utf8(sig_bytes).expect("test sig is ascii");
        let sig = Signature::decode(sig_str).expect("test sig decode");
        pubkey.verify(message, &sig, false)
    }

    #[test]
    fn fixture_sig_verifies_against_fixture_pubkey() {
        // Sanity: the committed fixture is internally consistent. This
        // is the test you'd add to catch a future "someone overwrote
        // test.pub with the wrong file" mistake.
        verify_with_test_key(TEST_MESSAGE, TEST_SIG.as_bytes())
            .expect("fixture sig should verify against fixture pubkey");
    }

    #[test]
    fn fixture_sig_rejects_tampered_message() {
        let mut tampered = TEST_MESSAGE.to_vec();
        tampered[0] ^= 0x01;
        let err = verify_with_test_key(&tampered, TEST_SIG.as_bytes()).unwrap_err();
        // minisign-verify reports this as InvalidSignature.
        assert!(
            matches!(err, minisign_verify::Error::InvalidSignature),
            "expected InvalidSignature for tampered message, got {err:?}"
        );
    }

    #[test]
    fn embedded_pubkey_parses_successfully() {
        // The embedded community-registry.pub must parse cleanly. A
        // malformed file would surface as Err here rather than crash
        // the app at first install.
        let keys = EMBEDDED_KEYS
            .as_ref()
            .expect("embedded pubkey must parse successfully in the test build");
        assert!(!keys.is_empty(), "embedded pubkey slice must not be empty");
    }

    #[test]
    fn embedded_fingerprint_is_derived_from_key_bytes_not_comment() {
        // The fingerprint comes from base64-decoding the key payload
        // and hex-encoding bytes 2..10 (the minisign key id) — not
        // from the `untrusted comment:` line. This test would catch a
        // future regression where someone reverts to comment-parsing.
        let fp = embedded_key_fingerprint();
        // Production key fingerprint, also documented in the trust
        // model docs and in the community repo's keys/README.md.
        // Cross-checked: minisign-cli prints the same value in the
        // pubkey's untrusted-comment line and in `-V` output.
        assert_eq!(fp, "982022ABB1139C7B");
    }

    #[test]
    fn derive_fingerprint_works_for_arbitrary_pubkey() {
        // Use the test fixture's key — confirms the derivation works
        // for any valid minisign pubkey, not just the one we baked in.
        // The fingerprint of test.pub (printed by `minisign -G`):
        // `RWQGBBQ5L3rDN...` → key id `06041439 2F7AC337` → 0604143...
        let test_key_b64 = TEST_PUBKEY
            .lines()
            .find(|l| !l.is_empty() && !l.starts_with("untrusted comment:"))
            .unwrap()
            .trim();
        let fp = derive_fingerprint(test_key_b64).unwrap();
        // Cross-check against `untrusted comment: minisign public key
        // 37C37A2F39140406` from the test fixture — derive_fingerprint
        // matches minisign's display convention exactly.
        assert_eq!(fp, "37C37A2F39140406");
    }

    #[test]
    fn derive_fingerprint_rejects_short_payload() {
        // Base64-encode 8 bytes (less than the required 10).
        let too_short = base64::engine::general_purpose::STANDARD.encode([0u8; 8]);
        let err = derive_fingerprint(&too_short).unwrap_err();
        assert!(
            err.contains("too short"),
            "expected length-error message, got: {err}"
        );
    }

    #[test]
    fn parse_embedded_keys_surfaces_malformed_input_as_err() {
        // Feed a bogus pubkey body — should return Err, not panic.
        let err = parse_embedded_keys("untrusted comment: junk\nnot-real-base64!!!\n").unwrap_err();
        assert!(
            !err.is_empty(),
            "parse_embedded_keys should return a non-empty error message"
        );
    }

    #[test]
    fn parse_embedded_keys_rejects_missing_key_line() {
        // Comment-only file → no key line found.
        let err = parse_embedded_keys("untrusted comment: only\nuntrusted comment: comments\n")
            .unwrap_err();
        assert!(
            err.contains("no key line"),
            "expected 'no key line' error, got: {err}"
        );
    }

    #[test]
    fn verify_against_embedded_pubkey_accepts_production_sig() {
        // Positive: a signature produced by the *real* production
        // secret key verifies against the embedded production pubkey.
        verify_registry_signature(PROD_MESSAGE, PROD_SIG.as_bytes())
            .expect("production-signed fixture should verify against embedded pubkey");
    }

    #[test]
    fn verify_against_embedded_pubkey_rejects_tampered_production_message() {
        // Same production sig + message with one byte flipped → reject.
        let mut tampered = PROD_MESSAGE.to_vec();
        tampered[0] ^= 0x01;
        let err = verify_registry_signature(&tampered, PROD_SIG.as_bytes()).unwrap_err();
        assert!(
            matches!(err, SignatureError::InvalidSignature { .. }),
            "expected InvalidSignature for tampered production message, got {err:?}"
        );
    }

    #[test]
    fn verify_against_embedded_pubkey_rejects_test_fixture_sig() {
        // The test fixture was signed by a different key; verifying
        // against the embedded production key must fail. Any other
        // result would mean either the embedded pubkey is wrong OR the
        // verifier isn't actually checking the key id.
        let err = verify_registry_signature(TEST_MESSAGE, TEST_SIG.as_bytes()).unwrap_err();
        assert!(
            matches!(err, SignatureError::InvalidSignature { .. }),
            "expected InvalidSignature against embedded key, got {err:?}"
        );
    }

    #[test]
    fn verify_rejects_empty_sig_bytes() {
        let err = verify_registry_signature(TEST_MESSAGE, b"").unwrap_err();
        assert!(
            matches!(err, SignatureError::MalformedSignature(_)),
            "expected MalformedSignature for empty bytes, got {err:?}"
        );
    }

    #[test]
    fn verify_rejects_truncated_sig() {
        // Lop off the trailing global signature line (last line) — the
        // file still has plausible-looking data but is incomplete.
        let truncated: String = TEST_SIG.lines().take(2).collect::<Vec<_>>().join("\n");
        let err = verify_registry_signature(TEST_MESSAGE, truncated.as_bytes()).unwrap_err();
        assert!(
            matches!(err, SignatureError::MalformedSignature(_)),
            "expected MalformedSignature for truncated sig, got {err:?}"
        );
    }

    #[test]
    fn verify_rejects_non_utf8_sig() {
        let err = verify_registry_signature(TEST_MESSAGE, b"\xff\xfe\xfd not utf-8").unwrap_err();
        assert!(
            matches!(err, SignatureError::MalformedSignature(_)),
            "expected MalformedSignature for non-utf8 bytes, got {err:?}"
        );
    }

    #[test]
    fn verify_rejects_garbage_that_resembles_sig_format() {
        // Right shape (multiple lines, comment-line-then-base64), but
        // the base64 decodes to bytes that aren't a valid minisign
        // signature payload.
        let garbage =
            "untrusted comment: not really a sig\nAAAAAAAAAAAA\ntrusted comment: x\nAAAA\n";
        let err = verify_registry_signature(TEST_MESSAGE, garbage.as_bytes()).unwrap_err();
        assert!(
            matches!(err, SignatureError::MalformedSignature(_)),
            "expected MalformedSignature for garbage sig, got {err:?}"
        );
    }

    #[test]
    fn signature_error_display_includes_fingerprint_for_invalid_sig() {
        // The fingerprint is the bridge between an error message and
        // the key the user can compare against the published pubkey;
        // make sure it appears in the rendered string.
        let err = verify_registry_signature(TEST_MESSAGE, TEST_SIG.as_bytes()).unwrap_err();
        let rendered = err.to_string();
        assert!(
            rendered.contains("982022ABB1139C7B"),
            "rendered error should include embedded fingerprint, got: {rendered}",
        );
    }
}
