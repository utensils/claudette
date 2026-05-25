export interface UsageLimit {
  utilization: number;
  resets_at: string | number;
}

export interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
}

export interface UsageData {
  five_hour: UsageLimit | null;
  seven_day: UsageLimit | null;
  seven_day_sonnet: UsageLimit | null;
  seven_day_opus: UsageLimit | null;
  extra_usage: ExtraUsage | null;
}

export interface ClaudeCodeUsage {
  subscription_type: string | null;
  rate_limit_tier: string | null;
  usage: UsageData;
  fetched_at: number;
}

// -----------------------------------------------------------------------------
// Multi-provider snapshot shape (returned by `get_session_usage`).
//
// Mirrors `claudette::usage::{UsageSnapshot, UsageBucket}` on the Rust side.
// One snapshot per chat session, with the data source chosen by backend kind:
//  - Anthropic family                            → Claude Code /usage buckets via ptywright
//  - Codex Native / OpenAI / OpenRouter / Pi / Ollama / LM Studio → local-aggregate
//    of `chat_messages` rows, plus provider-specific extras (Codex plan label,
//    OpenRouter credit balance).
// -----------------------------------------------------------------------------

import type { AgentBackendKind } from "../services/tauri/agentBackends";

/** One row in the popover bucket list. Shape is renderer-agnostic so
 *  the same React component handles every source. */
export interface UsageBucket {
  /** Stable key. Common values: "session_5h", "week_all", "week_sonnet",
   *  "week_opus", "extra_usage", "local_session", "local_24h",
   *  "openrouter_credits". The frontend only switches on a couple. */
  key: string;
  /** User-visible label, e.g. "Session (5h)" or "This session". */
  label: string;
  /** 0.0..1.0 fraction of the limit consumed. `0.0` for unbounded buckets. */
  utilization: number;
  /** Primary readout: "24%", "12.4M tok", "$2.41 / $5". */
  primary_text: string;
  /** Secondary readout under the bar — usually a reset countdown or
   *  cost estimate. Optional. */
  secondary_text: string | null;
  /** false for unbounded buckets (token throughput indicators). */
  is_bounded: boolean;
  /** utilization >= 1.0 */
  exhausted: boolean;
}

/** Unified per-session usage snapshot returned by `get_session_usage`. */
export interface UsageSnapshot {
  provider_kind: AgentBackendKind;
  /** Short label shown in the popover header: "Max", "Codex Plus",
   *  "OpenRouter credits", "Local". */
  source_label: string;
  buckets: UsageBucket[];
  note: string | null;
  fetched_at_ms: number;
  /** Legacy compatibility bit for snapshots from older app versions. */
  experimental_disabled: boolean;
}
