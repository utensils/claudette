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

impl std::str::FromStr for ChatRole {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s {
            "assistant" => Self::Assistant,
            "system" => Self::System,
            _ => Self::User,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)]
pub struct ChatMessage {
    pub id: String,
    pub workspace_id: String,
    pub role: ChatRole,
    pub content: String,
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<i64>,
    pub created_at: String,
    pub thinking: Option<String>,
}
