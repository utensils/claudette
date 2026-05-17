//! Multi-provider usage telemetry.
//!
//! The composer's battery indicator + popover used to be hard-wired to
//! Anthropic's OAuth Usage API (subscription bucket utilization). With
//! Codex Native, OpenAI-compatible (incl. OpenRouter) and Pi/local
//! backends now first-class, the indicator surfaces provider-appropriate
//! data per session and the Anthropic source becomes one of several.
//!
//! Source dispatch happens in [`commands::usage`](crate) on the Tauri side
//! (it needs `AppState`/`Database`). This module owns:
//! - the unified wire shape [`UsageSnapshot`] / [`UsageBucket`],
//! - per-source fetchers (`anthropic_oauth`, `local_aggregate`,
//!   `codex_account`, `openrouter`) that each return a `UsageSnapshot`,
//! - the [`pricing`] table used by the OpenAI/OpenRouter cost path.

pub mod anthropic_oauth;
pub mod codex_account;
pub mod local_aggregate;
pub mod openrouter;
pub mod pricing;

use serde::{Deserialize, Serialize};

use crate::agent_backend::AgentBackendKind;

/// Unified usage snapshot returned to the frontend regardless of which
/// underlying source produced it. Each source maps its native shape onto
/// a list of [`UsageBucket`]s plus a `source_label` ("Pro/Max",
/// "Codex Plus", "OpenRouter credits", "Local").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSnapshot {
    /// Provider this snapshot represents. The frontend uses this to pick
    /// styling / footnotes and to detect whether the indicator should
    /// be rendered in its disabled state (Anthropic family with the
    /// experimental flag off — see `kind` field on the stub variant).
    pub provider_kind: AgentBackendKind,
    /// Short label shown in the popover header. Examples: `"Max"`,
    /// `"Codex Plus"`, `"OpenRouter credits"`, `"Local"`.
    pub source_label: String,
    /// Buckets in display order. Empty when the source has nothing to
    /// surface (e.g. brand-new session with zero tokens yet).
    pub buckets: Vec<UsageBucket>,
    /// Optional one-line footnote shown under the bucket list. Replaces
    /// the legacy "Burn-rate weighted..." footer when present.
    pub note: Option<String>,
    /// `Date.now()` millis when this snapshot was produced. The frontend
    /// uses it to age out stale snapshots when switching sessions
    /// rapidly.
    pub fetched_at_ms: i64,
    /// True when this snapshot is the "experimental gate is off" stub
    /// for an Anthropic-family backend. The frontend renders the
    /// indicator in disabled (greyed) mode and `buckets` is empty.
    #[serde(default)]
    pub experimental_disabled: bool,
}

/// One row in the popover's bucket list. Shape is intentionally
/// renderer-agnostic so the same React component handles Anthropic
/// subscription buckets and local token aggregates.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageBucket {
    /// Stable key. Sources pick from a small set: `"session_5h"`,
    /// `"week_all"`, `"week_sonnet"`, `"week_opus"`, `"extra_usage"`,
    /// `"local_session"`, `"local_today"`, `"openrouter_credits"`,
    /// `"codex_plan"`. New keys are fine — the frontend only switches
    /// on a couple of them for special-case rendering.
    pub key: String,
    /// User-visible label, e.g. `"Session (5h)"`, `"This session"`.
    pub label: String,
    /// 0.0..1.0 fraction of the limit consumed. `0.0` for unbounded
    /// buckets (token totals with no cap). The frontend caps at 1.0
    /// when rendering the bar fill.
    pub utilization: f32,
    /// Primary readout: `"24%"`, `"12.4M tok"`, `"$2.41 / $5"`.
    pub primary_text: String,
    /// Secondary readout under the bar: `"resets in 2h 20m"`,
    /// `"since 09:00 local time"`. Optional.
    pub secondary_text: Option<String>,
    /// `false` for unbounded buckets — frontend renders the bar as
    /// a throughput indicator rather than a fill-toward-limit.
    pub is_bounded: bool,
    /// True when `utilization >= 1.0`. Frontend uses this to swap the
    /// readout for a reset-countdown chip.
    pub exhausted: bool,
}

impl UsageSnapshot {
    /// Stub used when the active session is on an Anthropic-family backend
    /// but the user has not opted in to the experimental Anthropic OAuth
    /// Usage API. The frontend reads `experimental_disabled` and renders
    /// the indicator greyed out with a click-to-open-settings affordance.
    pub fn experimental_stub(provider_kind: AgentBackendKind, fetched_at_ms: i64) -> Self {
        Self {
            provider_kind,
            source_label: String::from("Claude Code Usage off"),
            buckets: Vec::new(),
            note: Some(String::from(
                "Enable Claude Code Usage in Settings → Experimental to surface subscription limits.",
            )),
            fetched_at_ms,
            experimental_disabled: true,
        }
    }
}

// -- Backwards-compat re-exports ----------------------------------------
//
// The legacy ClaudeCodeUsage shape from `anthropic_oauth` is still
// consumed by `useUsageInsightsPoller` (global 5-min poller that runs
// regardless of the active session). Re-export the types it uses at the
// module root so existing callers can keep `claudette::usage::{...}`
// imports unchanged through the refactor.
pub use anthropic_oauth::{
    ClaudeCodeUsage, CredentialFile, ExtraUsage, OAuthCredentials, TokenRefreshResponse,
    UsageCacheEntry, UsageData, UsageLimit, get_usage, warm_user_agent_cache_sync,
};
