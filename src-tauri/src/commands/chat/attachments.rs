use tauri::State;

use claudette::base64_encode;
use claudette::db::Database;

use crate::state::AppState;

use super::AttachmentResponse;

/// Load attachment metadata for a single session's chat history.
///
/// Images (< ~5 MB base64) include inline data for immediate rendering.
/// Documents (PDFs, potentially 20+ MB) omit the body — use
/// [`load_attachment_data`] to fetch on demand.
#[tauri::command]
pub async fn load_attachments_for_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<AttachmentResponse>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let messages = db
        .list_chat_messages_for_session(&session_id)
        .map_err(|e| e.to_string())?;
    let message_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
    let att_map = db
        .list_attachments_for_messages(&message_ids)
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for (_, atts) in att_map {
        for a in atts {
            // Inline base64 data for images and text-shaped attachments —
            // PDFs are too large to push through IPC eagerly and would stall
            // the renderer.
            let is_text = matches!(
                a.media_type.as_str(),
                "text/plain" | "text/csv" | "text/markdown" | "application/json"
            );
            let data_base64 = if a.media_type.starts_with("image/") || is_text {
                base64_encode(&a.data)
            } else {
                String::new()
            };
            let text_content = if is_text {
                std::str::from_utf8(&a.data).ok().map(str::to_owned)
            } else {
                None
            };
            result.push(AttachmentResponse {
                id: a.id,
                message_id: a.message_id,
                filename: a.filename,
                media_type: a.media_type,
                data_base64,
                text_content,
                width: a.width,
                height: a.height,
                size_bytes: a.size_bytes,
                origin: a.origin,
                tool_use_id: a.tool_use_id,
            });
        }
    }
    Ok(result)
}

/// Fetch the full base64-encoded body of a single attachment by ID.
/// Used for on-demand loading of large attachments (PDFs).
#[tauri::command]
pub async fn load_attachment_data(
    attachment_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let att = db
        .get_attachment(&attachment_id)
        .map_err(|e| e.to_string())?
        .ok_or("Attachment not found")?;
    Ok(base64_encode(&att.data))
}

/// Read a file from disk and return it as base64 with metadata.
/// Used by the frontend file picker — avoids needing the `plugin-fs` dependency.
///
/// Known types (images, PDFs) use their specific MIME types and size limits.
/// Unknown extensions are tested for UTF-8 validity — valid text files are
/// returned as `text/plain` with the content in `text_content`.
#[tauri::command]
pub async fn read_file_as_base64(path: String) -> Result<AttachmentResponse, String> {
    use std::path::Path;

    const MAX_IMAGE_SIZE: usize = 3_932_160; // 3.75 MB
    const MAX_PDF_SIZE: usize = 20 * 1024 * 1024; // 20 MB
    const MAX_TEXT_SIZE: usize = 1024 * 1024; // 1 MB
    const MAX_CSV_SIZE: usize = 2 * 1024 * 1024; // 2 MB
    const MAX_MARKDOWN_SIZE: usize = 1024 * 1024; // 1 MB
    const MAX_JSON_SIZE: usize = 1024 * 1024; // 1 MB

    let file_path = Path::new(&path);
    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_string();

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    enum Kind {
        Image,
        Pdf,
        Csv,
        Markdown,
        Json,
    }

    // Map extensions to a Kind. Anything else falls through to UTF-8
    // sniffing below, which classifies the file as plain text or rejects
    // it as binary.
    let known_kind = match ext.as_str() {
        "png" => Some((Kind::Image, "image/png")),
        "jpg" | "jpeg" => Some((Kind::Image, "image/jpeg")),
        "gif" => Some((Kind::Image, "image/gif")),
        "webp" => Some((Kind::Image, "image/webp")),
        "svg" => Some((Kind::Image, "image/svg+xml")),
        "pdf" => Some((Kind::Pdf, "application/pdf")),
        "csv" => Some((Kind::Csv, "text/csv")),
        "md" | "markdown" => Some((Kind::Markdown, "text/markdown")),
        "json" => Some((Kind::Json, "application/json")),
        _ => None,
    };

    // Check file size via metadata before reading to avoid loading huge
    // files into memory only to reject them.
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;
    let file_len = metadata.len() as usize;
    if file_len == 0 {
        return Err("File is empty".to_string());
    }
    let max_for_read = match &known_kind {
        Some((Kind::Pdf, _)) => MAX_PDF_SIZE,
        Some((Kind::Image, _)) => MAX_IMAGE_SIZE,
        Some((Kind::Csv, _)) => MAX_CSV_SIZE,
        Some((Kind::Markdown, _)) => MAX_MARKDOWN_SIZE,
        Some((Kind::Json, _)) => MAX_JSON_SIZE,
        None => MAX_TEXT_SIZE,
    };
    if file_len > max_for_read {
        return Err(format!(
            "File too large: {} (max {})",
            humanize_size(file_len),
            humanize_size(max_for_read)
        ));
    }

    let data = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;

    let size_bytes = data.len() as i64;

    match known_kind {
        Some((Kind::Image, media_type)) => {
            let data_base64 = base64_encode(&data);
            Ok(AttachmentResponse {
                id: String::new(),
                message_id: String::new(),
                filename,
                media_type: media_type.to_string(),
                data_base64,
                text_content: None,
                width: None,
                height: None,
                size_bytes,
                origin: claudette::model::AttachmentOrigin::User,
                tool_use_id: None,
            })
        }
        Some((Kind::Pdf, media_type)) => {
            if !data.starts_with(b"%PDF-") {
                return Err("Invalid PDF file: missing %PDF- header".to_string());
            }
            let data_base64 = base64_encode(&data);
            Ok(AttachmentResponse {
                id: String::new(),
                message_id: String::new(),
                filename,
                media_type: media_type.to_string(),
                data_base64,
                text_content: None,
                width: None,
                height: None,
                size_bytes,
                origin: claudette::model::AttachmentOrigin::User,
                tool_use_id: None,
            })
        }
        Some((Kind::Csv | Kind::Markdown | Kind::Json, media_type)) => {
            // Text-shaped — must be valid UTF-8 *and* contain no NUL bytes.
            // UTF-8 itself permits U+0000, so a binary file with a misleading
            // `.csv` / `.json` / `.md` extension can pass `from_utf8` while
            // clearly being binary. The unknown-extension branch below
            // already rejects on `\0`; mirror that here so the same content
            // doesn't get a free pass purely because the suffix is on the
            // known list.
            let check_len = data.len().min(8192);
            if data[..check_len].contains(&0) {
                return Err(format!("File looks binary (contains NUL bytes): .{ext}"));
            }
            let text = String::from_utf8(data.clone())
                .map_err(|_| format!("File is not valid UTF-8: .{ext}"))?;
            let data_base64 = base64_encode(&data);
            Ok(AttachmentResponse {
                id: String::new(),
                message_id: String::new(),
                filename,
                media_type: media_type.to_string(),
                data_base64,
                text_content: Some(text),
                width: None,
                height: None,
                size_bytes,
                origin: claudette::model::AttachmentOrigin::User,
                tool_use_id: None,
            })
        }
        None => {
            // Unknown extension — attempt to read as text.
            let check_len = data.len().min(8192);
            if data[..check_len].contains(&0) {
                return Err(format!("Unsupported binary file type: .{ext}"));
            }
            match String::from_utf8(data.clone()) {
                Ok(text) => {
                    let data_base64 = base64_encode(&data);
                    Ok(AttachmentResponse {
                        id: String::new(),
                        message_id: String::new(),
                        filename,
                        media_type: "text/plain".to_string(),
                        data_base64,
                        text_content: Some(text),
                        width: None,
                        height: None,
                        size_bytes,
                        origin: claudette::model::AttachmentOrigin::User,
                        tool_use_id: None,
                    })
                }
                Err(_) => Err(format!("Unsupported binary file type: .{ext}")),
            }
        }
    }
}

fn humanize_size(bytes: usize) -> String {
    if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else {
        format!("{} KB", bytes / 1024)
    }
}
