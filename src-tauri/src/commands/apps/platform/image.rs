use std::path::Path;

use base64::{Engine as _, engine::general_purpose};

// Used by both macOS and Linux icon resolution to synthesize data URLs
// for the workspace-opener UI. Keep this shared so platform modules do
// not each carry their own base64/data-URL implementation.
pub(super) fn data_url_from_bytes(media_type: &str, bytes: &[u8]) -> String {
    format!(
        "data:{media_type};base64,{}",
        general_purpose::STANDARD.encode(bytes)
    )
}

pub(super) fn image_data_url_from_file(path: &Path) -> Option<String> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)?;
    let media_type = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        _ => return None,
    };
    let bytes = std::fs::read(path).ok()?;
    Some(data_url_from_bytes(media_type, &bytes))
}
