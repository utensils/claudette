//! Codex usage source.
//!
//! Powered by Codex's v2 protocol rate-limit endpoint:
//!
//! - **`account/rateLimits/read`** + **`account/rateLimits/updated`**
//!   notifications return a
//!   [`CodexRateLimitSnapshot`](crate::agent::codex_app_server::CodexRateLimitSnapshot)
//!   with `primary` / `secondary` `RateLimitWindow`s, an optional
//!   `credits` balance, and a `plan_type` ("plus", "pro", …). The
//!   Tauri host caches the latest snapshot in
//!   `AppState.codex_rate_limits` and feeds it through
//!   [`snapshot_from_rate_limits`] below; the popover header is
//!   derived from `plan_type` via [`format_plan_label`], so the user
//!   sees "Codex Plus" / "Codex Pro" instead of a bare "Codex".
//!
//! When no live snapshot exists yet (cold app, no Codex turn ever
//! issued this run), the dispatcher falls back to
//! [`local_aggregate`](super::local_aggregate) with a plain "Codex"
//! label so the meter always shows *something*. We don't currently
//! issue a separate `account/read` to derive the plan label in that
//! fallback — the rate-limits snapshot is the single source of
//! plan-tier truth.

use crate::agent::codex_app_server::{CodexRateLimitSnapshot, CodexRateLimitWindow};

use super::{UsageBucket, UsageSnapshot};

/// Capitalize a plan label like `"plus"` → `"Plus"`. Used to build the
/// `source_label` shown in the popover header.
pub fn format_plan_label(plan_type: Option<&str>) -> String {
    match plan_type {
        Some(plan) if !plan.is_empty() => {
            let mut chars = plan.chars();
            let head = chars.next().unwrap().to_uppercase().collect::<String>();
            format!("Codex {head}{rest}", rest = chars.as_str())
        }
        _ => String::from("Codex"),
    }
}

/// Human-readable label for a rate-limit window derived from its
/// `windowDurationMins` value. Codex's app-server doesn't ship a
/// label, but the standard windows match Anthropic's: 300 min → 5-hour
/// session, 10080 min → weekly, 43200 min → monthly. Anything else
/// falls back to a generic minute/hour/day rendering.
///
/// For weekly/monthly durations we return the prefix as-is — the
/// caller already conveys the period in `"Weekly"` / `"Monthly"`,
/// and `"Weekly (week)"` reads redundant. The 5h/24h cases keep
/// their parenthetical because the prefix (`"Session"`, `"Daily"`)
/// doesn't already imply the exact length.
pub fn format_window_label(prefix: &str, duration_mins: Option<i64>) -> String {
    match duration_mins {
        Some(300) => format!("{prefix} (5h)"),
        Some(1440) => format!("{prefix} (24h)"),
        Some(10080) | Some(43200) => prefix.to_string(),
        Some(mins) if mins >= 1440 && mins % 1440 == 0 => {
            format!("{prefix} ({}d)", mins / 1440)
        }
        Some(mins) if mins >= 60 && mins % 60 == 0 => {
            format!("{prefix} ({}h)", mins / 60)
        }
        Some(mins) => format!("{prefix} ({mins}m)"),
        None => prefix.to_string(),
    }
}

/// Render the "resets in …" countdown line for a bucket. `resets_at`
/// is unix millis; `now_ms` is supplied separately so callers can
/// drive deterministic tests. Returns `None` for past timestamps so
/// stale data doesn't render a "resets in -2m" string.
fn format_resets_in(resets_at_ms: i64, now_ms: i64) -> Option<String> {
    let delta_ms = resets_at_ms - now_ms;
    if delta_ms <= 0 {
        return None;
    }
    let seconds = delta_ms / 1000;
    let minutes = seconds / 60;
    let hours = minutes / 60;
    let days = hours / 24;
    Some(if days >= 1 {
        format!("resets in {days}d {h}h", h = hours - days * 24)
    } else if hours >= 1 {
        format!("resets in {hours}h {m}m", m = minutes - hours * 60)
    } else if minutes >= 1 {
        format!("resets in {minutes}m")
    } else {
        format!("resets in {seconds}s")
    })
}

/// Convert a [`CodexRateLimitWindow`] to a bounded [`UsageBucket`].
/// `key` and `prefix` identify the window slot (typically
/// `"codex_primary"` / `"Session"` and `"codex_secondary"` / `"Weekly"`).
fn bucket_from_window(
    key: &str,
    prefix: &str,
    window: &CodexRateLimitWindow,
    now_ms: i64,
) -> UsageBucket {
    let utilization = (window.used_percent as f32 / 100.0).clamp(0.0, 1.0);
    let label = format_window_label(prefix, window.window_duration_mins);
    let secondary = window.resets_at.and_then(|ts| format_resets_in(ts, now_ms));
    UsageBucket {
        key: key.to_string(),
        label,
        utilization,
        primary_text: format!("{}%", window.used_percent.clamp(0, 100)),
        secondary_text: secondary,
        is_bounded: true,
        exhausted: window.used_percent >= 100,
    }
}

/// Build the full [`UsageSnapshot`] for a Codex backend from a live
/// rate-limit snapshot. `provider_kind` lets the frontend dispatch on
/// the same field the local-aggregate path uses. `fallback_label` is
/// the source-label string to use when `snapshot.plan_type` is absent
/// (typically `"Codex"`).
pub fn snapshot_from_rate_limits(
    provider_kind: crate::agent_backend::AgentBackendKind,
    snapshot: &CodexRateLimitSnapshot,
    fallback_label: &str,
    fetched_at_ms: i64,
) -> UsageSnapshot {
    let source_label =
        format_plan_label(snapshot.plan_type.as_deref()).into_owned_or(fallback_label.to_string());

    let mut buckets = Vec::new();
    if let Some(ref primary) = snapshot.primary {
        buckets.push(bucket_from_window(
            "codex_primary",
            "Session",
            primary,
            fetched_at_ms,
        ));
    }
    if let Some(ref secondary) = snapshot.secondary {
        buckets.push(bucket_from_window(
            "codex_secondary",
            "Weekly",
            secondary,
            fetched_at_ms,
        ));
    }
    if let Some(ref credits) = snapshot.credits
        && credits.has_credits
        && !credits.unlimited
        && let Some(balance) = credits.balance.as_deref()
    {
        // Credits aren't a "% used" bucket — render as a dollar
        // readout. Utilization is left at 0 so the bar shows as
        // empty; the primary text carries the real signal.
        buckets.push(UsageBucket {
            key: String::from("codex_credits"),
            label: String::from("Credits"),
            utilization: 0.0,
            primary_text: format!("${balance}"),
            secondary_text: None,
            is_bounded: false,
            exhausted: false,
        });
    }

    let note = match snapshot.rate_limit_reached_type.as_deref() {
        Some(reason) if !reason.is_empty() => Some(format!(
            "Rate limit reached: {reason}. Try again after the next reset."
        )),
        _ => Some(String::from(
            "Live Codex quota — pushed from the app-server's account/rateLimits notifications.",
        )),
    };

    UsageSnapshot {
        provider_kind,
        source_label,
        buckets,
        note,
        fetched_at_ms,
        experimental_disabled: false,
    }
}

/// Trait-style helper to keep the `format_plan_label(...).into_owned_or(...)`
/// call site readable. `format_plan_label` returns `"Codex"` (no plan)
/// for absent input, so we use the caller's explicit fallback only when
/// the helper produced the bare default and the caller wants something
/// richer.
trait IntoOwnedOr {
    fn into_owned_or(self, fallback: String) -> String;
}

impl IntoOwnedOr for String {
    fn into_owned_or(self, fallback: String) -> String {
        if self == "Codex" { fallback } else { self }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_plan_label_capitalizes_known_plans() {
        assert_eq!(format_plan_label(Some("plus")), "Codex Plus");
        assert_eq!(format_plan_label(Some("pro")), "Codex Pro");
        assert_eq!(format_plan_label(Some("team")), "Codex Team");
    }

    #[test]
    fn format_plan_label_falls_back_when_missing() {
        assert_eq!(format_plan_label(None), "Codex");
        assert_eq!(format_plan_label(Some("")), "Codex");
    }

    #[test]
    fn format_window_label_picks_known_durations() {
        assert_eq!(format_window_label("Session", Some(300)), "Session (5h)");
        // Weekly / Monthly drop the redundant parenthetical — the prefix
        // already conveys the period.
        assert_eq!(format_window_label("Weekly", Some(10080)), "Weekly");
        assert_eq!(format_window_label("Monthly", Some(43200)), "Monthly");
    }

    #[test]
    fn format_window_label_handles_arbitrary_durations() {
        assert_eq!(format_window_label("Custom", Some(360)), "Custom (6h)");
        assert_eq!(format_window_label("Custom", Some(2880)), "Custom (2d)");
        assert_eq!(format_window_label("Custom", Some(13)), "Custom (13m)");
        assert_eq!(format_window_label("Custom", None), "Custom");
    }

    #[test]
    fn format_resets_in_renders_relative_time() {
        let now = 1_700_000_000_000_i64;
        assert_eq!(
            format_resets_in(now + 90 * 60 * 1000, now).as_deref(),
            Some("resets in 1h 30m")
        );
        assert_eq!(
            format_resets_in(now + 25 * 60 * 60 * 1000, now).as_deref(),
            Some("resets in 1d 1h")
        );
        assert_eq!(
            format_resets_in(now + 45 * 1000, now).as_deref(),
            Some("resets in 45s")
        );
        assert!(format_resets_in(now - 1000, now).is_none());
    }

    fn sample_snapshot() -> CodexRateLimitSnapshot {
        CodexRateLimitSnapshot {
            limit_id: Some("codex".to_string()),
            limit_name: Some("Codex".to_string()),
            plan_type: Some("pro".to_string()),
            primary: Some(CodexRateLimitWindow {
                used_percent: 24,
                resets_at: Some(2_000_000_000_000_i64),
                window_duration_mins: Some(300),
            }),
            secondary: Some(CodexRateLimitWindow {
                used_percent: 12,
                resets_at: Some(2_000_000_000_000_i64),
                window_duration_mins: Some(10080),
            }),
            credits: Some(crate::agent::codex_app_server::CodexCreditsSnapshot {
                balance: Some("2.41".to_string()),
                has_credits: true,
                unlimited: false,
            }),
            rate_limit_reached_type: None,
        }
    }

    #[test]
    fn snapshot_renders_codex_plus_header_and_bounded_windows() {
        use crate::agent_backend::AgentBackendKind;
        let snapshot = sample_snapshot();
        let usage = snapshot_from_rate_limits(
            AgentBackendKind::CodexNative,
            &snapshot,
            "Codex",
            1_900_000_000_000_i64,
        );
        assert_eq!(usage.source_label, "Codex Pro");
        assert_eq!(usage.buckets.len(), 3);

        let primary = &usage.buckets[0];
        assert_eq!(primary.key, "codex_primary");
        assert_eq!(primary.label, "Session (5h)");
        assert!((primary.utilization - 0.24).abs() < 0.001);
        assert_eq!(primary.primary_text, "24%");
        assert!(primary.is_bounded);
        assert!(!primary.exhausted);
        assert!(
            primary
                .secondary_text
                .as_deref()
                .unwrap()
                .starts_with("resets in")
        );

        let credits = usage
            .buckets
            .iter()
            .find(|b| b.key == "codex_credits")
            .unwrap();
        assert_eq!(credits.primary_text, "$2.41");
        assert!(!credits.is_bounded);
    }

    #[test]
    fn snapshot_falls_back_to_plain_codex_when_plan_absent() {
        use crate::agent_backend::AgentBackendKind;
        let mut snapshot = sample_snapshot();
        snapshot.plan_type = None;
        snapshot.credits = None;
        let usage =
            snapshot_from_rate_limits(AgentBackendKind::CodexSubscription, &snapshot, "Codex", 0);
        assert_eq!(usage.source_label, "Codex");
    }

    #[test]
    fn snapshot_marks_exhausted_when_window_at_cap() {
        use crate::agent_backend::AgentBackendKind;
        let mut snapshot = sample_snapshot();
        snapshot.primary = Some(CodexRateLimitWindow {
            used_percent: 100,
            resets_at: Some(2_000_000_000_000_i64),
            window_duration_mins: Some(300),
        });
        snapshot.rate_limit_reached_type = Some("rate_limit_reached".to_string());
        let usage = snapshot_from_rate_limits(AgentBackendKind::CodexNative, &snapshot, "Codex", 0);
        let primary = usage
            .buckets
            .iter()
            .find(|b| b.key == "codex_primary")
            .unwrap();
        assert!(primary.exhausted);
        assert!(
            usage
                .note
                .as_deref()
                .unwrap()
                .contains("Rate limit reached")
        );
    }

    #[test]
    fn snapshot_drops_unlimited_credits_bucket() {
        use crate::agent_backend::AgentBackendKind;
        let mut snapshot = sample_snapshot();
        snapshot.credits = Some(crate::agent::codex_app_server::CodexCreditsSnapshot {
            balance: None,
            has_credits: true,
            unlimited: true,
        });
        let usage = snapshot_from_rate_limits(AgentBackendKind::CodexNative, &snapshot, "Codex", 0);
        assert!(usage.buckets.iter().all(|b| b.key != "codex_credits"));
    }
}
