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

    /// The harness chosen for this kind when the backend config does
    /// not pin an explicit `runtime_harness`. The default is the
    /// dispatch the user gets out of the box; alternatives are listed
    /// by `available_harnesses` and surfaced as a Runtime select on
    /// the Settings → Models card.
    pub fn default_harness(self) -> AgentBackendRuntimeHarness {
        match self {
            // Claude subscription / Anthropic-compatible local proxies
            // stay on the Claude CLI by default — Pi has its own
            // Anthropic provider that requires Pi-side credentials, and
            // we explicitly do not route subscription OAuth through it.
            Self::Anthropic | Self::CustomAnthropic | Self::CodexSubscription => {
                AgentBackendRuntimeHarness::ClaudeCode
            }
            // Local model runtimes flip to Pi by default. The previous
            // Claude-CLI proxy path stays available as an explicit
            // fallback for users who need it.
            Self::Ollama | Self::LmStudio => AgentBackendRuntimeHarness::PiSdk,
            // Cloud OpenAI-compatible backends keep the gateway path by
            // default; Pi is an opt-in.
            Self::OpenAiApi | Self::CustomOpenAi => AgentBackendRuntimeHarness::ClaudeCode,
            Self::CodexNative => AgentBackendRuntimeHarness::CodexAppServer,
            Self::PiSdk => AgentBackendRuntimeHarness::PiSdk,
        }
    }

    /// When this backend routes through Pi, the prefix used to map a
    /// raw model id (e.g. `"gpt-5.4"`, `"llama3"`) onto Pi's registry
    /// (which keys models as `"<provider>/<modelId>"`). Returns `None`
    /// for kinds that must not be exposed via Pi (subscription-OAuth
    /// Anthropic flavors) and for the Pi card itself (whose model ids
    /// are already provider-qualified).
    pub fn pi_provider_prefix(self) -> Option<&'static str> {
        match self {
            Self::Ollama => Some("ollama"),
            Self::LmStudio => Some("lmstudio"),
            Self::OpenAiApi | Self::CustomOpenAi | Self::CodexNative => Some("openai"),
            Self::Anthropic | Self::CustomAnthropic | Self::CodexSubscription | Self::PiSdk => None,
        }
    }

    /// The harnesses the user is allowed to pick for a backend of this
    /// kind. The first entry is the default. Pinning a value not in
    /// this list is rejected by the resolver as defense-in-depth.
    pub fn available_harnesses(self) -> &'static [AgentBackendRuntimeHarness] {
        match self {
            Self::Anthropic | Self::CustomAnthropic | Self::CodexSubscription => {
                &[AgentBackendRuntimeHarness::ClaudeCode]
            }
            Self::Ollama | Self::LmStudio => &[
                AgentBackendRuntimeHarness::PiSdk,
                AgentBackendRuntimeHarness::ClaudeCode,
            ],
            Self::OpenAiApi | Self::CustomOpenAi => &[
                AgentBackendRuntimeHarness::ClaudeCode,
                AgentBackendRuntimeHarness::PiSdk,
            ],
            Self::CodexNative => &[
                AgentBackendRuntimeHarness::CodexAppServer,
                AgentBackendRuntimeHarness::PiSdk,
            ],
            Self::PiSdk => &[AgentBackendRuntimeHarness::PiSdk],
        }
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
    /// User override for which runtime harness handles this backend.
    /// `None` means use [`AgentBackendKind::default_harness`]. Persisted
    /// as JSON inside `app_settings`; the `serde(default)` keeps older
    /// configs forward-compatible without a migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_harness: Option<AgentBackendRuntimeHarness>,
}

impl AgentBackendConfig {
    /// Effective harness for this config: the persisted override when
    /// set and allowed for the kind, otherwise the kind's default.
    /// Defense-in-depth: a value that escapes `available_harnesses`
    /// (corrupted store, hand-edited DB, downgrade) is treated as
    /// absent so the resolver never dispatches to a harness the kind
    /// can't actually use.
    pub fn effective_harness(&self) -> AgentBackendRuntimeHarness {
        match self.runtime_harness {
            Some(harness) if self.kind.available_harnesses().contains(&harness) => harness,
            _ => self.kind.default_harness(),
        }
    }
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
            runtime_harness: None,
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
            runtime_harness: None,
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
            runtime_harness: None,
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
            runtime_harness: None,
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
            runtime_harness: None,
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
            runtime_harness: None,
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
            runtime_harness: None,
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
    /// The model id to actually hand to the spawned harness. Usually
    /// equals the input model the caller passed to
    /// `resolve_backend_runtime`, but the Pi harness needs ids
    /// qualified as `<provider>/<modelId>` and rewrites bare ids
    /// here so the sidecar's `ModelRegistry.find(provider, id)`
    /// lookup hits — without this override, a non-Pi backend (Ollama,
    /// LM Studio, OpenAI API, Codex Native) routed through Pi would
    /// hand the sidecar a bare id like `gpt-5.4` or a slash-containing
    /// id like `library/llama3` that the sidecar splits on the first
    /// slash and never resolves. `None` means "use the caller's input
    /// unchanged", which keeps non-Pi paths invisible to this field.
    #[serde(default)]
    pub model: Option<String>,
    /// Tells the Pi sidecar to register an ad-hoc provider via
    /// `ModelRegistry.registerProvider` before it spawns the agent
    /// session. Pi ships bundled providers for cloud vendors, but
    /// local servers like Ollama / LM Studio aren't in its registry
    /// unless the user has wired them up via `~/.pi/agent/models.json`
    /// — without this override Pi's `findModel(<provider>/<id>)`
    /// lookup misses and the turn fails to start. We synthesize the
    /// provider entry from the user's Claudette backend config
    /// (`base_url` + the resolved model row) so an upgrading user
    /// gets a working Pi-routed turn without any separate Pi setup.
    /// `None` for all other paths (Pi card itself, cloud backends
    /// whose names would shadow Pi's bundled providers, etc.).
    #[serde(default)]
    pub pi_provider_override: Option<PiProviderOverride>,
}

/// Minimal `ModelRegistry.registerProvider(name, config)` payload that
/// makes a Claudette-side local backend reachable through Pi. The
/// sidecar mirrors this onto Pi's `ProviderConfigInput`. Kept in this
/// crate so unit tests can build the value without pulling in the
/// Tauri layer, and so the JSON shape is colocated with the other
/// agent-runtime serde types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PiProviderOverride {
    /// Provider name the override registers under. Matches the
    /// first segment of the qualified model id (`ollama/llama3` →
    /// `provider = "ollama"`), so `findModel` resolves cleanly.
    pub provider: String,
    /// Backend root URL — for OpenAI-compatible endpoints Pi expects
    /// the `/v1` suffix to already be present. Caller normalizes.
    pub base_url: String,
    /// Bare model id (no provider prefix). Pi keys models inside a
    /// provider by this id.
    pub model_id: String,
    /// Human-facing model label. Falls back to `model_id` when the
    /// caller doesn't have a friendlier name.
    pub model_label: String,
    /// Context window in tokens. `0` means "use Pi's per-provider
    /// default", which keeps the override forward-compatible if a
    /// future Pi release stops requiring the field.
    pub context_window: u32,
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

    #[test]
    fn runtime_harness_defaults_per_kind() {
        let cases = [
            (
                AgentBackendKind::Anthropic,
                AgentBackendRuntimeHarness::ClaudeCode,
            ),
            (AgentBackendKind::Ollama, AgentBackendRuntimeHarness::PiSdk),
            (
                AgentBackendKind::LmStudio,
                AgentBackendRuntimeHarness::PiSdk,
            ),
            (
                AgentBackendKind::OpenAiApi,
                AgentBackendRuntimeHarness::ClaudeCode,
            ),
            (
                AgentBackendKind::CodexSubscription,
                AgentBackendRuntimeHarness::ClaudeCode,
            ),
            (
                AgentBackendKind::CodexNative,
                AgentBackendRuntimeHarness::CodexAppServer,
            ),
            (AgentBackendKind::PiSdk, AgentBackendRuntimeHarness::PiSdk),
            (
                AgentBackendKind::CustomAnthropic,
                AgentBackendRuntimeHarness::ClaudeCode,
            ),
            (
                AgentBackendKind::CustomOpenAi,
                AgentBackendRuntimeHarness::ClaudeCode,
            ),
        ];
        for (kind, expected) in cases {
            assert_eq!(
                kind.default_harness(),
                expected,
                "{kind:?}::default_harness() should be {expected:?}",
            );
            assert!(
                kind.available_harnesses().contains(&expected),
                "{kind:?}::available_harnesses() must include the default {expected:?}",
            );
        }
    }

    #[test]
    fn anthropic_kind_only_allows_claude_code_harness() {
        // Guard against accidental Pi opt-in for Claude subscription
        // users — Pi must never route the user's OAuth tokens.
        for kind in [
            AgentBackendKind::Anthropic,
            AgentBackendKind::CustomAnthropic,
            AgentBackendKind::CodexSubscription,
        ] {
            let harnesses = kind.available_harnesses();
            assert_eq!(
                harnesses,
                &[AgentBackendRuntimeHarness::ClaudeCode],
                "{kind:?} must lock to ClaudeCode-only",
            );
        }
    }

    #[test]
    fn pi_sdk_kind_locked_to_pi_harness() {
        assert_eq!(
            AgentBackendKind::PiSdk.available_harnesses(),
            &[AgentBackendRuntimeHarness::PiSdk],
        );
    }

    #[test]
    fn effective_harness_returns_kind_default_when_override_absent() {
        let backend = AgentBackendConfig::builtin_ollama();
        assert_eq!(backend.runtime_harness, None);
        assert_eq!(
            backend.effective_harness(),
            AgentBackendRuntimeHarness::PiSdk
        );
    }

    #[test]
    fn effective_harness_honors_allowed_override() {
        let mut backend = AgentBackendConfig::builtin_ollama();
        backend.runtime_harness = Some(AgentBackendRuntimeHarness::ClaudeCode);
        assert_eq!(
            backend.effective_harness(),
            AgentBackendRuntimeHarness::ClaudeCode,
        );
    }

    #[test]
    fn effective_harness_ignores_override_not_in_available_set() {
        // A hand-edited / downgraded config could pin a harness the
        // kind no longer permits. The resolver must fall back to the
        // safe default rather than dispatch into a forbidden harness.
        let mut backend = AgentBackendConfig::builtin_anthropic();
        backend.runtime_harness = Some(AgentBackendRuntimeHarness::PiSdk);
        assert_eq!(
            backend.effective_harness(),
            AgentBackendRuntimeHarness::ClaudeCode,
        );
    }

    /// Single source of truth for the per-kind harness matrix. Both
    /// Rust (this file) and TypeScript (`src/ui/.../modelRegistry.ts`,
    /// `services/tauri/agentBackends.ts`) mirror the same data, and
    /// drift between them silently lets the UI claim a dispatch path
    /// the resolver doesn't actually take. The fixture is checked at
    /// test time from both sides — see `harnessMatrix.test.ts` on the
    /// TS side.
    const MATRIX_FIXTURE: &str = include_str!("agent_backend_matrix.json");

    fn harness_serde_name(harness: AgentBackendRuntimeHarness) -> &'static str {
        match harness {
            AgentBackendRuntimeHarness::ClaudeCode => "claude_code",
            AgentBackendRuntimeHarness::CodexAppServer => "codex_app_server",
            AgentBackendRuntimeHarness::PiSdk => "pi_sdk",
        }
    }

    fn kind_serde_name(kind: AgentBackendKind) -> &'static str {
        match kind {
            AgentBackendKind::Anthropic => "anthropic",
            AgentBackendKind::Ollama => "ollama",
            AgentBackendKind::OpenAiApi => "openai_api",
            AgentBackendKind::CodexSubscription => "codex_subscription",
            AgentBackendKind::CodexNative => "codex_native",
            AgentBackendKind::PiSdk => "pi_sdk",
            AgentBackendKind::CustomAnthropic => "custom_anthropic",
            AgentBackendKind::CustomOpenAi => "custom_openai",
            AgentBackendKind::LmStudio => "lm_studio",
        }
    }

    #[test]
    fn matrix_matches_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(MATRIX_FIXTURE).expect("matrix fixture is valid JSON");
        let kinds = fixture
            .get("kinds")
            .and_then(|v| v.as_object())
            .expect("fixture has a `kinds` object");

        let all_rust_kinds = [
            AgentBackendKind::Anthropic,
            AgentBackendKind::Ollama,
            AgentBackendKind::OpenAiApi,
            AgentBackendKind::CodexSubscription,
            AgentBackendKind::CodexNative,
            AgentBackendKind::PiSdk,
            AgentBackendKind::CustomAnthropic,
            AgentBackendKind::CustomOpenAi,
            AgentBackendKind::LmStudio,
        ];

        // Fixture must list exactly the variants Rust knows about — no
        // ghost entries that the resolver can't honor, no missing entries
        // that the UI couldn't render.
        let rust_kind_names: std::collections::BTreeSet<&str> = all_rust_kinds
            .iter()
            .copied()
            .map(kind_serde_name)
            .collect();
        let fixture_kind_names: std::collections::BTreeSet<&str> =
            kinds.keys().map(String::as_str).collect();
        assert_eq!(
            rust_kind_names, fixture_kind_names,
            "AgentBackendKind variants and fixture `kinds` keys must match"
        );

        for kind in all_rust_kinds {
            let name = kind_serde_name(kind);
            let entry = kinds
                .get(name)
                .and_then(|v| v.as_object())
                .unwrap_or_else(|| panic!("fixture missing entry for `{name}`"));

            let fixture_default = entry
                .get("default")
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| panic!("fixture entry `{name}` missing `default` string"));
            assert_eq!(
                fixture_default,
                harness_serde_name(kind.default_harness()),
                "default_harness mismatch for `{name}`",
            );

            let fixture_available: Vec<&str> = entry
                .get("available")
                .and_then(|v| v.as_array())
                .unwrap_or_else(|| panic!("fixture entry `{name}` missing `available` array"))
                .iter()
                .map(|v| {
                    v.as_str().unwrap_or_else(|| {
                        panic!("fixture `{name}.available` must be strings only")
                    })
                })
                .collect();
            let rust_available: Vec<&str> = kind
                .available_harnesses()
                .iter()
                .copied()
                .map(harness_serde_name)
                .collect();
            assert_eq!(
                fixture_available, rust_available,
                "available_harnesses mismatch for `{name}` (order is significant — first entry is the default)",
            );

            // Sanity check: the fixture's own internal invariant.
            assert_eq!(
                fixture_available.first().copied(),
                Some(fixture_default),
                "fixture entry `{name}`: first available must equal default",
            );
        }
    }
}
