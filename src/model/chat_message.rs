#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum ChatRole {
    User,
    Assistant,
    System,
}

#[allow(dead_code)]
impl ChatRole {
    pub fn as_str(&self) -> &str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "assistant" => Self::Assistant,
            "system" => Self::System,
            _ => Self::User,
        }
    }
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ChatMessage {
    pub id: String,
    pub workspace_id: String,
    pub role: ChatRole,
    pub content: String,
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<i64>,
    pub created_at: String,
}
