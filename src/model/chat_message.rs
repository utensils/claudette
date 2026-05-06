use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[allow(dead_code)]
pub enum ChatRole {
    User,
    Assistant,
    System,
}

impl ChatRole {
    pub fn as_str(&self) -> &str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
        }
    }
}

/// Returned when a string doesn't correspond to any known [`ChatRole`].
/// Surfacing the unknown value (instead of silently coercing) lets callers
/// detect corrupted DB rows or values written by a forward-version of the app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseChatRoleError(pub String);

impl std::fmt::Display for ParseChatRoleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unknown ChatRole value: {:?}", self.0)
    }
}

impl std::error::Error for ParseChatRoleError {}

impl std::str::FromStr for ChatRole {
    type Err = ParseChatRoleError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "user" => Ok(Self::User),
            "assistant" => Ok(Self::Assistant),
            "system" => Ok(Self::System),
            other => Err(ParseChatRoleError(other.to_string())),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct ChatMessage {
    pub id: String,
    pub workspace_id: String,
    pub chat_session_id: String,
    pub role: ChatRole,
    pub content: String,
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<i64>,
    pub created_at: String,
    pub thinking: Option<String>,
    /// Per-message input tokens reported by the CLI. NULL for historical rows.
    pub input_tokens: Option<i64>,
    /// Per-message output tokens reported by the CLI. NULL for historical rows.
    pub output_tokens: Option<i64>,
    /// Per-message cache-read input tokens (maps to `cache_read_input_tokens`
    /// in the Anthropic API). NULL for historical rows.
    pub cache_read_tokens: Option<i64>,
    /// Per-message cache-creation input tokens (maps to
    /// `cache_creation_input_tokens` in the Anthropic API). NULL for historical rows.
    pub cache_creation_tokens: Option<i64>,
    /// Identifies the connected participant who authored this message in a
    /// collaborative session. In a collab session, the host stamps `"host"`
    /// (see `claudette::room::ParticipantId::HOST`) on its own messages and
    /// the per-pairing id on remote-authored ones. NULL for solo / 1:1
    /// (non-collab) sessions, all Assistant/System rows, and pre-collab
    /// legacy history.
    pub author_participant_id: Option<String>,
    /// Display name captured at submit time so the UI can render an author
    /// chip without resolving the participant id at read time.
    pub author_display_name: Option<String>,
}
