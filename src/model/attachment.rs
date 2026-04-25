use serde::{Deserialize, Serialize};

/// Whether the attachment was supplied by the user (composer paste/drop) or
/// authored by the agent via the `claudette__send_to_user` MCP tool.
///
/// Persisted as the SQL string `'user'` or `'agent'` (CHECK-constrained).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentOrigin {
    #[default]
    User,
    Agent,
}

impl AttachmentOrigin {
    pub fn as_sql_str(self) -> &'static str {
        match self {
            AttachmentOrigin::User => "user",
            AttachmentOrigin::Agent => "agent",
        }
    }

    pub fn from_sql_str(s: &str) -> Self {
        match s {
            "agent" => AttachmentOrigin::Agent,
            _ => AttachmentOrigin::User,
        }
    }
}

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
    #[serde(default)]
    pub origin: AttachmentOrigin,
    #[serde(default)]
    pub tool_use_id: Option<String>,
}
