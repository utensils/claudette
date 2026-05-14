use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentBackendKind {
    Anthropic,
    Ollama,
    #[serde(rename = "openai_api")]
    OpenAiApi,
    CodexSubscription,
    CodexNative,
    PiSdk,
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
        // LM Studio 0.4.1+ implements `/v1/messages` natively (same
        // Anthropic wire format Ollama uses), so we *could* point the
        // spawned claude CLI directly at it. But LM Studio classifies
        // hard input errors like context-window overflow as HTTP 500
        // with an Anthropic-shaped body whose `error.type` is
        // `api_error`. That's a transient classification — Anthropic's
        // SDK retries it with exponential backoff — so a permanent
        // input failure ends up as a multi-minute spinner with no
        // surfaced error, even though the upstream message is right
        // there.
        //
        // Routing LM Studio through our gateway gives us a place to
        // demote those mis-classified 5xx responses to 4xx (via
        // `GatewayUpstreamError::from_upstream` +
        // `upstream_message_is_permanent_failure`). The gateway
        // forwards 2xx bodies through unchanged so streaming events
        // still flow without translation overhead — only the error
        // path gets rewritten. See `proxy_anthropic_messages` and the
        // matching test fixtures.
        matches!(
            self,
            Self::OpenAiApi | Self::CodexSubscription | Self::CustomOpenAi | Self::LmStudio
        )
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentBackendRuntimeHarness {
    #[default]
    ClaudeCode,
    CodexAppServer,
    PiSdk,
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

    pub fn codex_native() -> Self {
        Self {
            thinking: true,
            effort: true,
            fast_mode: true,
            one_m_context: false,
            tools: true,
            vision: false,
        }
    }

    pub fn pi_sdk() -> Self {
        Self {
            thinking: true,
            effort: true,
            fast_mode: false,
            one_m_context: false,
            tools: true,
            vision: false,
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

    pub fn builtin_codex_native() -> Self {
        Self {
            id: "codex".to_string(),
            label: "Codex".to_string(),
            kind: AgentBackendKind::CodexNative,
            base_url: None,
            enabled: true,
            default_model: Some("gpt-5.4".to_string()),
            manual_models: vec![
                AgentBackendModel {
                    id: "gpt-5.4".to_string(),
                    label: "GPT-5.4".to_string(),
                    context_window_tokens: 272_000,
                    discovered: false,
                },
                AgentBackendModel {
                    id: "gpt-5.3-codex".to_string(),
                    label: "GPT-5.3 Codex".to_string(),
                    context_window_tokens: 272_000,
                    discovered: false,
                },
            ],
            discovered_models: Vec::new(),
            auth_ref: Some("codex-cli".to_string()),
            capabilities: AgentBackendCapabilities::codex_native(),
            context_window_default: 272_000,
            model_discovery: true,
            has_secret: false,
        }
    }

    pub fn builtin_pi_sdk() -> Self {
        Self {
            id: "pi".to_string(),
            label: "Pi".to_string(),
            kind: AgentBackendKind::PiSdk,
            base_url: None,
            enabled: true,
            default_model: None,
            manual_models: vec![
                AgentBackendModel {
                    id: "anthropic/claude-opus-4-5".to_string(),
                    label: "Claude Opus 4.5".to_string(),
                    context_window_tokens: 200_000,
                    discovered: false,
                },
                AgentBackendModel {
                    id: "openai/gpt-5.4".to_string(),
                    label: "GPT-5.4".to_string(),
                    context_window_tokens: 272_000,
                    discovered: false,
                },
            ],
            discovered_models: Vec::new(),
            auth_ref: Some("pi".to_string()),
            capabilities: AgentBackendCapabilities::pi_sdk(),
            context_window_default: 200_000,
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
    #[serde(default)]
    pub harness: AgentBackendRuntimeHarness,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_codex_builtin_uses_app_server_harness_shape() {
        let backend = AgentBackendConfig::builtin_codex_native();

        assert_eq!(backend.id, "codex");
        assert_eq!(backend.label, "Codex");
        assert_eq!(backend.kind, AgentBackendKind::CodexNative);
        assert!(backend.enabled);
        assert!(!backend.kind.needs_gateway());
        assert!(!backend.kind.is_anthropic_compatible());
        assert!(backend.model_discovery);
        assert!(backend.capabilities.thinking);
        assert!(backend.capabilities.effort);
        assert!(backend.capabilities.fast_mode);
        assert!(!backend.capabilities.vision);
        assert_eq!(backend.context_window_default, 272_000);
        assert!(!backend.manual_models.is_empty());
        assert!(
            backend
                .manual_models
                .iter()
                .all(|model| model.context_window_tokens == 272_000)
        );
    }

    #[test]
    fn runtime_defaults_to_claude_code_harness() {
        let runtime = AgentBackendRuntime::default();

        assert_eq!(runtime.harness, AgentBackendRuntimeHarness::ClaudeCode);
        assert_eq!(runtime.backend_id, None);
        assert!(runtime.env.is_empty());
    }

    #[test]
    fn pi_builtin_uses_pi_sdk_harness_shape() {
        let backend = AgentBackendConfig::builtin_pi_sdk();

        assert_eq!(backend.id, "pi");
        assert_eq!(backend.label, "Pi");
        assert_eq!(backend.kind, AgentBackendKind::PiSdk);
        assert!(backend.enabled);
        assert!(!backend.kind.needs_gateway());
        assert!(backend.model_discovery);
        assert!(backend.capabilities.tools);
        assert!(!backend.capabilities.fast_mode);
    }
}
