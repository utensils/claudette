use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentBackendKind {
    Anthropic,
    Ollama,
    #[serde(rename = "openai_api")]
    OpenAiApi,
    CodexSubscription,
    CustomAnthropic,
    #[serde(rename = "custom_openai")]
    CustomOpenAi,
    LmStudio,
}

impl AgentBackendKind {
    pub fn is_anthropic_compatible(self) -> bool {
        matches!(self, Self::Anthropic | Self::Ollama | Self::CustomAnthropic)
    }

    pub fn needs_gateway(self) -> bool {
        matches!(
            self,
            Self::OpenAiApi | Self::CodexSubscription | Self::CustomOpenAi | Self::LmStudio
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBackendCapabilities {
    pub thinking: bool,
    pub effort: bool,
    pub fast_mode: bool,
    pub one_m_context: bool,
    pub tools: bool,
    pub vision: bool,
}

impl AgentBackendCapabilities {
    pub fn claude() -> Self {
        Self {
            thinking: true,
            effort: true,
            fast_mode: true,
            one_m_context: true,
            tools: true,
            vision: true,
        }
    }

    pub fn gateway() -> Self {
        Self {
            thinking: false,
            effort: false,
            fast_mode: false,
            one_m_context: false,
            tools: true,
            vision: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBackendModel {
    pub id: String,
    pub label: String,
    pub context_window_tokens: u32,
    pub discovered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBackendConfig {
    pub id: String,
    pub label: String,
    pub kind: AgentBackendKind,
    pub base_url: Option<String>,
    pub enabled: bool,
    pub default_model: Option<String>,
    pub manual_models: Vec<AgentBackendModel>,
    pub discovered_models: Vec<AgentBackendModel>,
    pub auth_ref: Option<String>,
    pub capabilities: AgentBackendCapabilities,
    pub context_window_default: u32,
    pub model_discovery: bool,
    pub has_secret: bool,
}

impl AgentBackendConfig {
    pub fn builtin_anthropic() -> Self {
        Self {
            id: "anthropic".to_string(),
            label: "Claude Code".to_string(),
            kind: AgentBackendKind::Anthropic,
            base_url: None,
            enabled: true,
            default_model: Some("opus".to_string()),
            manual_models: Vec::new(),
            discovered_models: Vec::new(),
            auth_ref: None,
            capabilities: AgentBackendCapabilities::claude(),
            context_window_default: 200_000,
            model_discovery: false,
            has_secret: false,
        }
    }

    pub fn builtin_ollama() -> Self {
        Self {
            id: "ollama".to_string(),
            label: "Ollama".to_string(),
            kind: AgentBackendKind::Ollama,
            base_url: Some("http://localhost:11434".to_string()),
            enabled: false,
            default_model: None,
            manual_models: Vec::new(),
            discovered_models: Vec::new(),
            auth_ref: Some("agent-backend:ollama".to_string()),
            capabilities: AgentBackendCapabilities {
                thinking: true,
                effort: false,
                fast_mode: false,
                one_m_context: false,
                tools: true,
                vision: true,
            },
            context_window_default: 64_000,
            model_discovery: true,
            has_secret: false,
        }
    }

    pub fn builtin_openai_api() -> Self {
        Self {
            id: "openai-api".to_string(),
            label: "OpenAI API".to_string(),
            kind: AgentBackendKind::OpenAiApi,
            base_url: Some("https://api.openai.com".to_string()),
            enabled: false,
            default_model: None,
            manual_models: Vec::new(),
            discovered_models: Vec::new(),
            auth_ref: Some("agent-backend:openai-api".to_string()),
            capabilities: AgentBackendCapabilities::gateway(),
            context_window_default: 400_000,
            model_discovery: true,
            has_secret: false,
        }
    }

    pub fn builtin_codex_subscription() -> Self {
        Self {
            id: "codex-subscription".to_string(),
            label: "Codex".to_string(),
            kind: AgentBackendKind::CodexSubscription,
            base_url: None,
            enabled: false,
            default_model: None,
            manual_models: Vec::new(),
            discovered_models: Vec::new(),
            auth_ref: Some("codex-cli".to_string()),
            capabilities: AgentBackendCapabilities::gateway(),
            context_window_default: 400_000,
            model_discovery: true,
            has_secret: false,
        }
    }

    pub fn builtin_lm_studio() -> Self {
        Self {
            id: "lm-studio".to_string(),
            label: "LM Studio".to_string(),
            kind: AgentBackendKind::LmStudio,
            base_url: Some("http://localhost:1234".to_string()),
            enabled: false,
            default_model: None,
            manual_models: Vec::new(),
            discovered_models: Vec::new(),
            auth_ref: Some("agent-backend:lm-studio".to_string()),
            capabilities: AgentBackendCapabilities::gateway(),
            // Most LM Studio loadouts default to a 4-8k context window; pick a
            // safer floor than the OpenAI-style 400k. Per-model values from
            // /api/v0/models override this when discovery succeeds.
            context_window_default: 8_192,
            model_discovery: true,
            has_secret: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentBackendRuntime {
    pub backend_id: Option<String>,
    pub env: Vec<(String, String)>,
    pub hash: String,
}

impl AgentBackendRuntime {
    pub fn apply_to_command(&self, cmd: &mut tokio::process::Command) {
        if self.env.is_empty() {
            return;
        }
        for key in [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_MODEL",
            "ANTHROPIC_CUSTOM_MODEL_OPTION",
            "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
            "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
            "CLAUDE_CODE_SUBAGENT_MODEL",
            "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
        ] {
            cmd.env_remove(key);
        }
        for (key, value) in &self.env {
            cmd.env(key, value);
        }
    }
}
