use serde::Serialize;

/// An image or file attachment associated with a chat message.
#[derive(Debug, Clone, Serialize)]
pub struct Attachment {
    pub id: String,
    pub message_id: String,
    pub filename: String,
    pub media_type: String,
    /// Raw file bytes. Skipped during default serialization to avoid
    /// accidentally sending BLOBs over Tauri IPC — use `AttachmentResponse`
    /// with base64-encoded data for frontend communication.
    #[serde(skip)]
    pub data: Vec<u8>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub size_bytes: i64,
    pub created_at: String,
}
