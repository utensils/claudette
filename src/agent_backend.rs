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
    #[cfg(feature = "pi-sdk")]
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
            // Local model runtimes flip to Pi by default when the Pi
            // harness is compiled in. Without it they fall back to the
            // Claude-CLI proxy path, which is also the explicit
            // fallback for users who turn Pi off in Settings.
            #[cfg(feature = "pi-sdk")]
            Self::Ollama | Self::LmStudio => AgentBackendRuntimeHarness::PiSdk,
            #[cfg(not(feature = "pi-sdk"))]
            Self::Ollama | Self::LmStudio => AgentBackendRuntimeHarness::ClaudeCode,
            // Cloud OpenAI-compatible backends keep the gateway path by
            // default; Pi is an opt-in.
            Self::OpenAiApi | Self::CustomOpenAi => AgentBackendRuntimeHarness::ClaudeCode,
            Self::CodexNative => AgentBackendRuntimeHarness::CodexAppServer,
            #[cfg(feature = "pi-sdk")]
            Self::PiSdk => AgentBackendRuntimeHarness::PiSdk,
        }
    }

    /// When this backend routes through Pi, the prefix used to map a
    /// raw model id (e.g. `"gpt-5.4"`, `"llama3"`) onto Pi's registry
    /// (which keys models as `"<provider>/<modelId>"`). Returns `None`
    /// for kinds that must not be exposed via Pi (subscription-OAuth
    /// Anthropic flavors) and for the Pi card itself (whose model ids
    /// are already provider-qualified). Only meaningful when the Pi
    /// harness is compiled in — callers gate the lookup site too.
    #[cfg(feature = "pi-sdk")]
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
    ///
    /// `ClaudeInteractive` is intentionally **not** in this matrix —
    /// it's gated by the `claudeInteractiveEnabled` experimental flag,
    /// not the per-kind allow-list. Callers that have the flag value
    /// available (the Settings runtime picker, the persistence command)
    /// should use [`available_harnesses_with_interactive`] which
    /// conditionally appends `ClaudeInteractive` for the Claude-flavored
    /// kinds when the flag is on. All other call sites (Pi-disabled
    /// downgrade, gateway-hash key) want the matrix shape and should
    /// stick with this method.
    pub fn available_harnesses(self) -> &'static [AgentBackendRuntimeHarness] {
        match self {
            Self::Anthropic | Self::CustomAnthropic | Self::CodexSubscription => {
                &[AgentBackendRuntimeHarness::ClaudeCode]
            }
            #[cfg(feature = "pi-sdk")]
            Self::Ollama | Self::LmStudio => &[
                AgentBackendRuntimeHarness::PiSdk,
                AgentBackendRuntimeHarness::ClaudeCode,
            ],
            #[cfg(not(feature = "pi-sdk"))]
            Self::Ollama | Self::LmStudio => &[AgentBackendRuntimeHarness::ClaudeCode],
            #[cfg(feature = "pi-sdk")]
            Self::OpenAiApi | Self::CustomOpenAi => &[
                AgentBackendRuntimeHarness::ClaudeCode,
                AgentBackendRuntimeHarness::PiSdk,
            ],
            #[cfg(not(feature = "pi-sdk"))]
            Self::OpenAiApi | Self::CustomOpenAi => &[AgentBackendRuntimeHarness::ClaudeCode],
            #[cfg(feature = "pi-sdk")]
            Self::CodexNative => &[
                AgentBackendRuntimeHarness::CodexAppServer,
                AgentBackendRuntimeHarness::PiSdk,
            ],
            #[cfg(not(feature = "pi-sdk"))]
            Self::CodexNative => &[AgentBackendRuntimeHarness::CodexAppServer],
            #[cfg(feature = "pi-sdk")]
            Self::PiSdk => &[AgentBackendRuntimeHarness::PiSdk],
        }
    }

    /// Like [`available_harnesses`] but conditionally appends
    /// [`AgentBackendRuntimeHarness::ClaudeInteractive`] when the
    /// experimental flag is on AND this kind is one of the
    /// Claude-flavored ones (Anthropic, CustomAnthropic,
    /// CodexSubscription). These three kinds are locked to the Claude
    /// CLI runtime so subscription OAuth tokens never reach Pi —
    /// interactive Claude is just another Claude-side harness, so it
    /// belongs alongside `ClaudeCode` for exactly those kinds. Every
    /// other kind ignores the flag and returns the static matrix
    /// unchanged.
    ///
    /// Used by the Settings runtime picker (so the dropdown actually
    /// lists the option when the flag is on) and by
    /// `set_agent_backend_runtime_harness` (so the persistence
    /// validator doesn't reject a sanctioned value). The static-slice
    /// [`available_harnesses`] still gates the gateway-hash key and
    /// the Pi-disabled downgrade because those flows want the matrix
    /// shape, not the experimental gate.
    pub fn available_harnesses_with_interactive(
        self,
        claude_interactive_enabled: bool,
    ) -> Vec<AgentBackendRuntimeHarness> {
        let mut harnesses: Vec<AgentBackendRuntimeHarness> = self.available_harnesses().to_vec();
        if claude_interactive_enabled
            && matches!(
                self,
                Self::Anthropic | Self::CustomAnthropic | Self::CodexSubscription
            )
        {
            harnesses.push(AgentBackendRuntimeHarness::ClaudeInteractive);
        }
        harnesses
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentBackendRuntimeHarness {
    #[default]
    ClaudeCode,
    /// Interactive `claude` running inside an `InteractiveHost` (tmux on
    /// Unix, sidecar elsewhere). Gated on the `claudeInteractiveEnabled`
    /// experimental flag — see
    /// [`AgentBackendConfig::effective_harness_kind`].
    ClaudeInteractive,
    CodexAppServer,
    #[cfg(feature = "pi-sdk")]
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

    #[cfg(feature = "pi-sdk")]
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

    /// Map the persisted runtime selection onto the internal
    /// [`crate::agent::AgentHarnessKind`] the chat dispatcher uses to
    /// pick a session-protocol implementation.
    ///
    /// `ClaudeInteractive` is special: it's gated on the experimental
    /// `claudeInteractiveEnabled` flag and is intentionally absent from
    /// `available_harnesses()` (which keeps the UI runtime selector
    /// honest for non-experimental users). The resolver therefore reads
    /// `runtime_harness` directly here — bypassing the
    /// `available_harnesses` filter — but only when the flag is on. If
    /// the flag is off and the user has somehow pinned
    /// `ClaudeInteractive` (downgrade, hand-edited DB, etc.), we fall
    /// back to the kind's default harness rather than dispatch into a
    /// disabled experiment.
    pub fn effective_harness_kind(
        &self,
        claude_interactive_enabled: bool,
    ) -> crate::agent::AgentHarnessKind {
        if claude_interactive_enabled
            && matches!(
                self.runtime_harness,
                Some(AgentBackendRuntimeHarness::ClaudeInteractive)
            )
        {
            return crate::agent::AgentHarnessKind::ClaudeInteractive;
        }
        match self.effective_harness() {
            AgentBackendRuntimeHarness::ClaudeCode => crate::agent::AgentHarnessKind::ClaudeCode,
            AgentBackendRuntimeHarness::ClaudeInteractive => {
                // `effective_harness()` is filtered by `available_harnesses()`,
                // which never lists `ClaudeInteractive` today, so this
                // arm is unreachable in production. Keep it explicit
                // (over `unreachable!()`) so a future broadening of the
                // allow-list doesn't silently panic — falling back to
                // ClaudeCode matches the gate-off behavior above.
                crate::agent::AgentHarnessKind::ClaudeCode
            }
            AgentBackendRuntimeHarness::CodexAppServer => {
                crate::agent::AgentHarnessKind::CodexAppServer
            }
            #[cfg(feature = "pi-sdk")]
            AgentBackendRuntimeHarness::PiSdk => crate::agent::AgentHarnessKind::PiSdk,
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

    #[cfg(feature = "pi-sdk")]
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
    ///
    /// The field is always present in the struct so non-Pi
    /// construction sites stay compileable, but when the Pi harness
    /// is compiled out `PiProviderOverride` resolves to
    /// `std::convert::Infallible` — so the field can only ever be
    /// `None`, and the resolver fast-paths around it.
    #[serde(default)]
    pub pi_provider_override: Option<PiProviderOverride>,
}

/// Minimal `ModelRegistry.registerProvider(name, config)` payload that
/// makes a Claudette-side local backend reachable through Pi. The
/// sidecar mirrors this onto Pi's `ProviderConfigInput`. Kept in this
/// crate so unit tests can build the value without pulling in the
/// Tauri layer, and so the JSON shape is colocated with the other
/// agent-runtime serde types.
#[cfg(feature = "pi-sdk")]
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

/// Stand-in for `PiProviderOverride` when the Pi harness is compiled
/// out. An empty enum has no constructable values, so the field
/// `Option<PiProviderOverride>` on `AgentBackendRuntime` can only ever
/// be `None` on a no-pi build. This lets non-Pi callers continue to
/// construct `AgentBackendRuntime` literals with
/// `pi_provider_override: None` without sprinkling `#[cfg]` over every
/// construction site, while guaranteeing at the type level that no
/// Pi-routing data ever flows through a build that lacks the Pi
/// sidecar. A stale Pi-routed runtime row that tries to load on a
/// no-pi build deserializes as an error (no variant matches), which
/// is the right failure mode.
#[cfg(not(feature = "pi-sdk"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PiProviderOverride {}

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

    #[cfg(feature = "pi-sdk")]
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
        // When `pi-sdk` is compiled out, Ollama/LmStudio fall back to
        // ClaudeCode (matches the `default_harness` arm), and the
        // PiSdk variant itself is gone from the type.
        #[cfg(feature = "pi-sdk")]
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
        #[cfg(not(feature = "pi-sdk"))]
        let cases = [
            (
                AgentBackendKind::Anthropic,
                AgentBackendRuntimeHarness::ClaudeCode,
            ),
            (
                AgentBackendKind::Ollama,
                AgentBackendRuntimeHarness::ClaudeCode,
            ),
            (
                AgentBackendKind::LmStudio,
                AgentBackendRuntimeHarness::ClaudeCode,
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
    fn available_harnesses_with_interactive_omits_interactive_when_flag_off() {
        // Flag off → identical to the static matrix shape, for every
        // kind. This is the back-compat baseline that callers without
        // the flag value (Pi-disabled downgrade, gateway-hash key) rely
        // on implicitly.
        let kinds = [
            AgentBackendKind::Anthropic,
            AgentBackendKind::CustomAnthropic,
            AgentBackendKind::CodexSubscription,
            AgentBackendKind::Ollama,
            AgentBackendKind::LmStudio,
            AgentBackendKind::OpenAiApi,
            AgentBackendKind::CustomOpenAi,
            AgentBackendKind::CodexNative,
            #[cfg(feature = "pi-sdk")]
            AgentBackendKind::PiSdk,
        ];
        for kind in kinds {
            assert_eq!(
                kind.available_harnesses_with_interactive(false),
                kind.available_harnesses().to_vec(),
                "{kind:?}::available_harnesses_with_interactive(false) must match the static matrix",
            );
            assert!(
                !kind
                    .available_harnesses_with_interactive(false)
                    .contains(&AgentBackendRuntimeHarness::ClaudeInteractive),
                "{kind:?} must never expose ClaudeInteractive when the flag is off",
            );
        }
    }

    #[test]
    fn available_harnesses_with_interactive_appends_for_claude_flavored_kinds() {
        // Flag on → the three Claude-CLI-locked kinds gain
        // ClaudeInteractive as a second option, appended after the
        // existing ClaudeCode entry so the kind's default stays first.
        for kind in [
            AgentBackendKind::Anthropic,
            AgentBackendKind::CustomAnthropic,
            AgentBackendKind::CodexSubscription,
        ] {
            let harnesses = kind.available_harnesses_with_interactive(true);
            assert_eq!(
                harnesses,
                vec![
                    AgentBackendRuntimeHarness::ClaudeCode,
                    AgentBackendRuntimeHarness::ClaudeInteractive,
                ],
                "{kind:?} should expose ClaudeCode then ClaudeInteractive when the flag is on",
            );
        }
    }

    #[test]
    fn available_harnesses_with_interactive_skips_non_claude_kinds_even_with_flag() {
        // ClaudeInteractive is a Claude-runtime variant — Pi / Ollama /
        // LM Studio / OpenAI / CodexNative must never offer it,
        // regardless of the flag. Otherwise the runtime picker would
        // dangle an option the resolver can't honor (Pi can't host an
        // interactive Claude session against user OAuth).
        let kinds = [
            AgentBackendKind::Ollama,
            AgentBackendKind::LmStudio,
            AgentBackendKind::OpenAiApi,
            AgentBackendKind::CustomOpenAi,
            AgentBackendKind::CodexNative,
            #[cfg(feature = "pi-sdk")]
            AgentBackendKind::PiSdk,
        ];
        for kind in kinds {
            let harnesses = kind.available_harnesses_with_interactive(true);
            assert!(
                !harnesses.contains(&AgentBackendRuntimeHarness::ClaudeInteractive),
                "{kind:?} must not expose ClaudeInteractive even when the flag is on",
            );
            // And the rest of the list stays exactly the static matrix.
            assert_eq!(
                harnesses,
                kind.available_harnesses().to_vec(),
                "{kind:?}::available_harnesses_with_interactive(true) must match the static matrix",
            );
        }
    }

    #[test]
    fn effective_harness_kind_round_trips_claude_interactive_override() {
        // Full round-trip: user picks ClaudeInteractive (which the
        // persistence validator allows only when the flag is on), the
        // override is persisted as `runtime_harness =
        // Some(ClaudeInteractive)`, and `effective_harness_kind(true)`
        // dispatches to the interactive harness. Flipping the flag off
        // falls back to the kind's default — defense-in-depth against a
        // stale override surviving a downgrade.
        let mut backend = AgentBackendConfig::builtin_anthropic();
        backend.runtime_harness = Some(AgentBackendRuntimeHarness::ClaudeInteractive);
        assert_eq!(
            backend.effective_harness_kind(true),
            crate::agent::AgentHarnessKind::ClaudeInteractive,
        );
        assert_eq!(
            backend.effective_harness_kind(false),
            crate::agent::AgentHarnessKind::ClaudeCode,
        );
    }

    #[cfg(feature = "pi-sdk")]
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
        #[cfg(feature = "pi-sdk")]
        assert_eq!(
            backend.effective_harness(),
            AgentBackendRuntimeHarness::PiSdk
        );
        #[cfg(not(feature = "pi-sdk"))]
        assert_eq!(
            backend.effective_harness(),
            AgentBackendRuntimeHarness::ClaudeCode
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

    #[cfg(feature = "pi-sdk")]
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
    /// TS side. The fixture itself always contains the Pi entries
    /// (it's the TS-authoritative shape); the Rust-side check below
    /// only runs when the Pi feature is compiled in, so a no-pi build
    /// won't compare its (legitimately smaller) variant set against
    /// the fixture's full shape and falsely fail.
    #[cfg(feature = "pi-sdk")]
    const MATRIX_FIXTURE: &str = include_str!("agent_backend_matrix.json");

    #[cfg(feature = "pi-sdk")]
    fn harness_serde_name(harness: AgentBackendRuntimeHarness) -> &'static str {
        match harness {
            AgentBackendRuntimeHarness::ClaudeCode => "claude_code",
            AgentBackendRuntimeHarness::ClaudeInteractive => "claude_interactive",
            AgentBackendRuntimeHarness::CodexAppServer => "codex_app_server",
            AgentBackendRuntimeHarness::PiSdk => "pi_sdk",
        }
    }

    #[cfg(feature = "pi-sdk")]
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

    #[cfg(feature = "pi-sdk")]
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

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_provider_prefix_maps_every_kind() {
        // The prefix is what the resolver prepends to bare model ids
        // before handing them to Pi's `ModelRegistry.find(provider, id)`
        // lookup. Drift between this map and the harness-side provider
        // registration silently breaks Pi-routed turns, so pin every
        // arm.
        let cases = [
            (AgentBackendKind::Ollama, Some("ollama")),
            (AgentBackendKind::LmStudio, Some("lmstudio")),
            (AgentBackendKind::OpenAiApi, Some("openai")),
            (AgentBackendKind::CustomOpenAi, Some("openai")),
            (AgentBackendKind::CodexNative, Some("openai")),
            (AgentBackendKind::Anthropic, None),
            (AgentBackendKind::CustomAnthropic, None),
            (AgentBackendKind::CodexSubscription, None),
            (AgentBackendKind::PiSdk, None),
        ];
        for (kind, expected) in cases {
            assert_eq!(
                kind.pi_provider_prefix(),
                expected,
                "{kind:?}::pi_provider_prefix() mismatch",
            );
        }
    }

    #[test]
    fn every_builtin_starts_with_no_runtime_harness_override() {
        // Builtin constructors must seed `runtime_harness: None` so the
        // resolver falls through to `kind.default_harness()`. A
        // construction-time pin would silently override the per-kind
        // default and stick around after the user changes their
        // harness preference in Settings.
        let builtins = [
            AgentBackendConfig::builtin_anthropic(),
            AgentBackendConfig::builtin_ollama(),
            AgentBackendConfig::builtin_openai_api(),
            AgentBackendConfig::builtin_codex_subscription(),
            AgentBackendConfig::builtin_codex_native(),
            AgentBackendConfig::builtin_lm_studio(),
            #[cfg(feature = "pi-sdk")]
            AgentBackendConfig::builtin_pi_sdk(),
        ];
        for backend in builtins {
            assert!(
                backend.runtime_harness.is_none(),
                "{:?} should not pin a runtime_harness",
                backend.kind,
            );
        }
    }

    #[test]
    fn lm_studio_builtin_uses_gateway_shape() {
        let backend = AgentBackendConfig::builtin_lm_studio();

        assert_eq!(backend.id, "lm-studio");
        assert_eq!(backend.label, "LM Studio");
        assert_eq!(backend.kind, AgentBackendKind::LmStudio);
        assert!(!backend.enabled);
        assert_eq!(backend.base_url.as_deref(), Some("http://localhost:1234"));
        assert!(backend.model_discovery);
        assert!(!backend.capabilities.thinking);
        assert_eq!(backend.context_window_default, 8_192);
    }

    #[test]
    fn agent_backend_runtime_default_has_no_pi_override() {
        let runtime = AgentBackendRuntime::default();
        assert!(runtime.pi_provider_override.is_none());
        assert!(runtime.model.is_none());
        assert_eq!(runtime.hash, "");
    }
}
