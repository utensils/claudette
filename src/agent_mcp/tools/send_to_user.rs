//! `claudette__send_to_user` — agent-callable MCP tool that delivers an image,
//! PDF, or small text/data file to the user inline in chat.
//!
//! This module owns only the *policy* layer (validation) and metadata. The
//! IPC plumbing that actually persists the file into `attachments` and emits
//! the Tauri event lives in `agent_mcp::bridge` (slice 5).

/// Hard upper bound a tool argument's `media_type` string is allowed to take
/// before validation rejects it as malformed input. Mirrors a defensive check
/// against unbounded strings reaching `policy()`.
pub const MAX_MEDIA_TYPE_LEN: usize = 128;

/// Hard upper bound on filename length to keep DB rows and UI labels sane.
pub const MAX_FILENAME_LEN: usize = 255;

/// Allowed image MIME types. Mirrors `SUPPORTED_IMAGE_TYPES` in
/// `src/ui/src/utils/attachmentValidation.ts` plus `image/svg+xml` — SVG is
/// rendered via `<img src="data:image/svg+xml;base64,…">` in
/// `AttachmentLightbox.tsx`, which the browser sandboxes (no script execution,
/// no external loads) so it's safe to accept from the agent.
pub const ALLOWED_IMAGE_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
];

/// Allowed document types — currently PDF only, matches inbound rules.
pub const ALLOWED_DOCUMENT_TYPES: &[&str] = &["application/pdf"];

/// Single source of truth for the text/data MIME types the agent may send,
/// paired with their per-type size caps. Both `policy()` and the JSON-Schema
/// `enum` advertised to the model derive from this table — keep them
/// consistent by editing only here. Each entry must also have a matching
/// preview component in `src/ui/src/components/chat/MessageAttachment.tsx`.
pub const TEXT_TYPE_RULES: &[(&str, u64)] = &[
    ("text/plain", 1024 * 1024),
    ("text/csv", 2 * 1024 * 1024),
    ("text/markdown", 1024 * 1024),
    ("application/json", 1024 * 1024),
];

/// Allowed text/data MIME types — derived from [`TEXT_TYPE_RULES`] so the
/// schema enum stays in lock-step with `policy()`'s size table.
pub fn allowed_text_types() -> impl Iterator<Item = &'static str> {
    TEXT_TYPE_RULES.iter().map(|(m, _)| *m)
}

/// Per-type size caps (raw bytes, pre-base64). Mirrors the constants in
/// `src/ui/src/utils/attachmentValidation.ts`.
pub const MAX_IMAGE_BYTES: u64 = 3_932_160; // 3.75 MiB
pub const MAX_PDF_BYTES: u64 = 20 * 1024 * 1024;
// The `MAX_*_BYTES` text-type aliases were folded into `TEXT_TYPE_RULES`.
// Tests reference rule rows directly so the table is the only place to
// touch when caps change.

/// Decide whether the agent is allowed to send this file to the user.
/// Returns `Ok(())` to accept; `Err(reason)` to reject. The `reason` string
/// is surfaced back to the agent in the MCP tool result so the model can
/// adjust and retry.
///
/// Inputs:
/// - `media_type` — MIME type the agent declared (e.g. `"image/png"`).
/// - `size_bytes` — raw file size on disk before base64.
/// - `filename` — basename of the file (no directory components — the bridge
///   strips path before calling this).
///
/// Symmetry with the inbound user-side rules in
/// `src/ui/src/utils/attachmentValidation.ts` is the default. Loosening this
/// would let the agent deliver content the user can't compose; tightening it
/// would limit the feature.
///
pub fn policy(media_type: &str, size_bytes: u64, filename: &str) -> Result<(), String> {
    if filename.is_empty() {
        return Err("filename is required".into());
    }
    if filename.len() > MAX_FILENAME_LEN {
        return Err(format!(
            "filename too long ({} > {MAX_FILENAME_LEN})",
            filename.len()
        ));
    }
    if media_type.len() > MAX_MEDIA_TYPE_LEN {
        return Err(format!(
            "media_type too long ({} > {MAX_MEDIA_TYPE_LEN})",
            media_type.len()
        ));
    }

    let max = if ALLOWED_IMAGE_TYPES.contains(&media_type) {
        MAX_IMAGE_BYTES
    } else if ALLOWED_DOCUMENT_TYPES.contains(&media_type) {
        MAX_PDF_BYTES
    } else {
        match max_text_bytes_for(media_type) {
            Some(m) => m,
            None => {
                return Err(format!(
                    "media type {media_type:?} is not supported inline (filename: \
                     {filename:?}). Supported: images (png/jpeg/gif/webp/svg), \
                     application/pdf, text/plain, text/csv, text/markdown, \
                     application/json. For unsupported types, do NOT retry this \
                     tool — instead tell the user the absolute path you wrote the \
                     file to so they can open it manually."
                ));
            }
        }
    };

    if size_bytes > max {
        return Err(format!(
            "file too large for {media_type}: {size_bytes} bytes (max {max}, \
             filename: {filename:?}). Do NOT retry this tool — instead tell the \
             user the absolute path you wrote the file to so they can open it \
             directly."
        ));
    }
    Ok(())
}

/// Per-text-type cap, or `None` if the type isn't a recognized text/data type.
/// Looks up the type in [`TEXT_TYPE_RULES`] so the policy and the schema enum
/// can never disagree about which types are allowed.
fn max_text_bytes_for(media_type: &str) -> Option<u64> {
    TEXT_TYPE_RULES
        .iter()
        .find(|(m, _)| *m == media_type)
        .map(|(_, max)| *max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(media_type: &str) -> u64 {
        max_text_bytes_for(media_type)
            .unwrap_or_else(|| panic!("no text-type rule for {media_type}"))
    }

    /// Each row: (media_type, size_bytes, filename, expected).
    /// `expected = Ok(())` means accept; `Err(_)` means the policy must
    /// reject (the exact error string is up to the implementer).
    #[allow(clippy::type_complexity)]
    fn cases() -> Vec<(&'static str, u64, &'static str, Result<(), ()>)> {
        vec![
            // --- accepted: typical happy paths ---
            ("image/png", 1024, "screenshot.png", Ok(())),
            ("image/jpeg", 500_000, "photo.jpg", Ok(())),
            ("image/gif", 100_000, "anim.gif", Ok(())),
            ("image/webp", 200_000, "pic.webp", Ok(())),
            ("image/svg+xml", 100, "vec.svg", Ok(())),
            ("application/pdf", 1_000_000, "report.pdf", Ok(())),
            ("text/plain", 1024, "notes.txt", Ok(())),
            ("text/csv", 50_000, "rows.csv", Ok(())),
            ("text/markdown", 5_000, "README.md", Ok(())),
            ("application/json", 100, "config.json", Ok(())),
            // --- rejected: disallowed types ---
            ("application/x-msdownload", 100, "evil.exe", Err(())),
            ("application/zip", 100, "bundle.zip", Err(())),
            ("text/html", 100, "page.html", Err(())),
            ("application/x-tar", 100, "bundle.tar", Err(())),
            ("text/yaml", 100, "config.yaml", Err(())),
            // --- rejected: oversize ---
            ("image/png", MAX_IMAGE_BYTES + 1, "huge.png", Err(())),
            ("application/pdf", MAX_PDF_BYTES + 1, "huge.pdf", Err(())),
            ("text/plain", cap("text/plain") + 1, "huge.txt", Err(())),
            ("text/csv", cap("text/csv") + 1, "huge.csv", Err(())),
            (
                "text/markdown",
                cap("text/markdown") + 1,
                "huge.md",
                Err(()),
            ),
            (
                "application/json",
                cap("application/json") + 1,
                "huge.json",
                Err(()),
            ),
            // --- rejected: empty filename ---
            ("image/png", 100, "", Err(())),
            // --- rejected: malformed media_type ---
            (
                // 200-char garbage string — exceeds MAX_MEDIA_TYPE_LEN.
                "x".repeat(200).leak(),
                100,
                "x.png",
                Err(()),
            ),
        ]
    }

    /// `TEXT_TYPE_RULES` is the single source of truth for text-data MIME
    /// types. The schema enum and `policy()` both derive from it, so guard
    /// against accidental drift: every entry must have a non-zero cap and
    /// `max_text_bytes_for` must agree with the table.
    #[test]
    fn text_type_rules_round_trip() {
        for (mime, max) in TEXT_TYPE_RULES {
            assert!(*max > 0, "cap must be positive for {mime}");
            assert_eq!(max_text_bytes_for(mime), Some(*max));
        }
        // Sanity: lookup misses for non-table types.
        assert_eq!(max_text_bytes_for("text/yaml"), None);
        assert_eq!(max_text_bytes_for("application/x-tar"), None);
    }

    #[test]
    fn policy_table() {
        for (mime, size, name, expected) in cases() {
            let got = super::policy(mime, size, name);
            match (expected, got) {
                (Ok(()), Ok(())) | (Err(()), Err(_)) => {}
                (Ok(()), Err(e)) => {
                    panic!("expected accept for ({mime:?}, {size}, {name:?}); got reject: {e}")
                }
                (Err(()), Ok(())) => panic!("expected reject for ({mime:?}, {size}, {name:?})"),
            }
        }
    }

    /// The model uses the rejection text to decide what to do next. Both
    /// reject paths must mention the filename and instruct the model to
    /// tell the user the absolute path it already has, rather than
    /// retrying. The bridge passes only the basename to `policy()`, so
    /// the rejection text must point the model back at the absolute
    /// path it received as `file_path`.
    #[test]
    fn rejection_text_is_actionable() {
        let unsupported = super::policy("application/x-tar", 100, "bundle.tar.gz")
            .expect_err("unsupported should reject");
        assert!(
            unsupported.contains("bundle.tar.gz"),
            "expected filename in rejection: {unsupported}"
        );
        assert!(
            unsupported.contains("absolute path"),
            "expected explicit absolute-path fallback hint: {unsupported}"
        );
        assert!(
            unsupported.contains("Do NOT retry") || unsupported.contains("do NOT retry"),
            "expected explicit do-not-retry instruction: {unsupported}"
        );

        let oversize = super::policy("text/csv", cap("text/csv") + 1, "huge.csv")
            .expect_err("oversize should reject");
        assert!(
            oversize.contains("huge.csv"),
            "expected filename in oversize rejection: {oversize}"
        );
        assert!(
            oversize.contains("absolute path"),
            "expected absolute-path fallback hint in oversize rejection: {oversize}"
        );
    }
}
