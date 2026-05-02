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

use std::sync::OnceLock;

use minisign_verify::{PublicKey, Signature};

/// Hex of the embedded production public key fingerprint, surfaced in
/// error messages so users can compare against what's published in the
/// `claudette-community/keys/README.md` and out-of-band channels.
///
/// Computed once from the embedded pubkey when first read.
pub fn embedded_key_fingerprint() -> &'static str {
    // Last 16 hex chars (8 bytes) of the key id — same form minisign
    // itself prints in the `untrusted comment:` line of the pubkey.
    // Parsed lazily so a malformed embedded key surfaces during the
    // first verify, not at static-init time.
    static FP: OnceLock<String> = OnceLock::new();
    FP.get_or_init(|| {
        let pub_text = include_str!("trust/community-registry.pub");
        // The first line is `untrusted comment: minisign public key <FP>`;
        // pull the fingerprint out for diagnostics. Fall back to
        // "unknown" if the file isn't shaped as expected — the verify
        // path will fail with a clearer error in that case.
        pub_text
            .lines()
            .next()
            .and_then(|l| l.rsplit(' ').next())
            .map(str::to_string)
            .unwrap_or_else(|| "unknown".to_string())
    })
}

/// Embedded production public keys. Today: one. Adding a second slot
/// is how key rotation works — ship a release with `[OLD, NEW]`,
/// switch the CI signer to `NEW`, then ship a release with `[NEW]`.
fn embedded_pubkeys() -> &'static [PublicKey] {
    static KEYS: OnceLock<Vec<PublicKey>> = OnceLock::new();
    KEYS.get_or_init(|| {
        let pub_text = include_str!("trust/community-registry.pub");
        // PublicKey::from_base64 takes only the base64-encoded key
        // bytes (no comment lines), so split out the second line.
        let key_b64 = pub_text
            .lines()
            .find(|l| !l.is_empty() && !l.starts_with("untrusted comment:"))
            .expect("embedded community-registry.pub is malformed (no key line)");
        let key = PublicKey::from_base64(key_b64.trim())
            .expect("embedded community-registry.pub is not a valid minisign pubkey");
        vec![key]
    })
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
        }
    }
}

impl std::error::Error for SignatureError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::MalformedSignature(e) | Self::InvalidSignature { underlying: e, .. } => Some(e),
        }
    }
}

/// Verify `sig_bytes` (the raw contents of `registry.json.sig`) is a
/// valid signature over `message` (the raw contents of `registry.json`)
/// produced by any of the embedded public keys.
///
/// Returns `Ok(())` on success. Any failure — malformed sig file,
/// signature that decodes but doesn't verify, signature for a different
/// key — collapses into [`SignatureError`] with enough context for the
/// UI to surface a useful error string.
pub fn verify_registry_signature(message: &[u8], sig_bytes: &[u8]) -> Result<(), SignatureError> {
    // Signature::decode wants a `&str`. The .sig file is ASCII (base64
    // + comments), so a non-utf8 body is itself a sign of a malformed
    // file — collapse to MalformedSignature rather than panic.
    let sig_str = std::str::from_utf8(sig_bytes)
        .map_err(|_| SignatureError::MalformedSignature(minisign_verify::Error::InvalidEncoding))?;
    let sig = Signature::decode(sig_str).map_err(SignatureError::MalformedSignature)?;

    let mut last_err: Option<minisign_verify::Error> = None;
    for pubkey in embedded_pubkeys() {
        match pubkey.verify(message, &sig, false) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    Err(SignatureError::InvalidSignature {
        embedded_fingerprint: embedded_key_fingerprint().to_string(),
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
    fn embedded_pubkey_parses_without_panic() {
        // If the embedded community-registry.pub is malformed,
        // embedded_pubkeys() panics on first call. Force the panic to
        // surface here rather than at first install.
        let keys = embedded_pubkeys();
        assert!(!keys.is_empty(), "embedded pubkey slice must not be empty");
    }

    #[test]
    fn embedded_fingerprint_is_extracted() {
        let fp = embedded_key_fingerprint();
        // Production key fingerprint, also documented in the trust
        // model docs and in the community repo's keys/README.md.
        assert_eq!(fp, "982022ABB1139C7B");
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
