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

/// Allowed text-file MIME type. Inbound currently only allows `text/plain`;
/// keeping the same set on outbound prevents the agent from injecting
/// unexpected MIME types.
pub const ALLOWED_TEXT_TYPES: &[&str] = &["text/plain"];

/// Per-type size caps (raw bytes, pre-base64). Mirrors the constants in
/// `src/ui/src/utils/attachmentValidation.ts`.
pub const MAX_IMAGE_BYTES: u64 = 3_932_160; // 3.75 MiB
pub const MAX_PDF_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_TEXT_BYTES: u64 = 500 * 1024;

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
    } else if ALLOWED_TEXT_TYPES.contains(&media_type) {
        MAX_TEXT_BYTES
    } else {
        return Err(format!(
            "media type {media_type:?} is not allowed; supported: images (png/jpeg/gif/webp/svg), application/pdf, text/plain"
        ));
    };

    if size_bytes > max {
        return Err(format!(
            "file too large for {media_type}: {size_bytes} bytes (max {max})"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
            // --- rejected: disallowed types ---
            ("application/x-msdownload", 100, "evil.exe", Err(())),
            ("application/zip", 100, "bundle.zip", Err(())),
            ("text/html", 100, "page.html", Err(())),
            // --- rejected: oversize ---
            ("image/png", MAX_IMAGE_BYTES + 1, "huge.png", Err(())),
            ("application/pdf", MAX_PDF_BYTES + 1, "huge.pdf", Err(())),
            ("text/plain", MAX_TEXT_BYTES + 1, "huge.txt", Err(())),
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
}
