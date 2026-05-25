//! Multi-provider usage telemetry.
//!
//! The composer's battery indicator + popover surfaces provider-appropriate
//! data per session. Claude-family sessions read the official Claude Code
//! `/usage` screen via ptywright; Codex, OpenAI-compatible (incl. OpenRouter),
//! and Pi/local backends use their provider-specific or local aggregate data.
//!
//! Source dispatch happens in [`commands::usage`](crate) on the Tauri side
//! (it needs `AppState`/`Database`). This module owns:
//! - the unified wire shape [`UsageSnapshot`] / [`UsageBucket`],
//! - per-source fetchers (`ptywright_claude`, `local_aggregate`,
//!   `codex_account`, `openrouter`) that each return a `UsageSnapshot`,
//! - the [`pricing`] table used by the OpenAI/OpenRouter cost path.

pub mod anthropic_oauth;
pub mod codex_account;
pub mod local_aggregate;
pub mod openrouter;
pub mod pricing;
pub mod ptywright_claude;

use serde::{Deserialize, Serialize};

use crate::agent_backend::AgentBackendKind;

/// Unified usage snapshot returned to the frontend regardless of which
/// underlying source produced it. Each source maps its native shape onto
/// a list of [`UsageBucket`]s plus a `source_label` ("Pro/Max",
/// "Codex Plus", "OpenRouter credits", "Local").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSnapshot {
    /// Provider this snapshot represents. The frontend uses this to pick
    /// styling / footnotes.
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
    /// Legacy compatibility bit from the old experimental usage gate.
    /// New snapshots always leave this false.
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
    /// `"local_session"`, `"local_24h"`, `"openrouter_credits"`,
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

// -- Backwards-compat re-exports ----------------------------------------
//
// The legacy ClaudeCodeUsage shape is still the frontend contract for the
// Settings > Usage panel. Re-export the types so callers can keep
// `claudette::usage::{...}` imports unchanged while the data source moves
// from Anthropic OAuth to ptywright's Claude Code adapter.
pub use anthropic_oauth::{
    ClaudeCodeUsage, CredentialFile, ExtraUsage, OAuthCredentials, TokenRefreshResponse,
    UsageCacheEntry, UsageData, UsageLimit, warm_user_agent_cache_sync,
};
pub use ptywright_claude::get_usage;
