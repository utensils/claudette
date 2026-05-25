//! Claude Code usage source backed by ptywright.
//!
//! This intentionally drives the official interactive `claude` app and
//! reads the rendered `/usage` screen through ptywright's `claude-code`
//! adapter. It avoids the old Anthropic OAuth usage endpoint entirely.

use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::{Datelike, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone};
use serde_json::{Value, json};
use tokio::sync::RwLock;

use super::anthropic_oauth::{ClaudeCodeUsage, ExtraUsage, UsageData, UsageLimit};
use super::{UsageBucket, UsageSnapshot};
use crate::agent::resolve_claude_path_blocking;
use crate::agent_backend::AgentBackendKind;

const COMPLETED_TURN_STABLE_MS: u64 = 300;
const STARTUP_READY_TIMEOUT: Duration = Duration::from_secs(5);
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(150);
const USAGE_TIMEOUT: Duration = Duration::from_secs(45);
const USAGE_DATA_READY_TIMEOUT: Duration = Duration::from_secs(12);
const USAGE_DATA_POLL_INTERVAL: Duration = Duration::from_millis(250);
const USAGE_CACHE_TTL_MS: u64 = 5 * 60_000;

#[derive(Clone)]
struct CachedUsage {
    usage: ClaudeCodeUsage,
    fetched_at: u64,
}

fn cache() -> &'static RwLock<Option<CachedUsage>> {
    static CACHE: OnceLock<RwLock<Option<CachedUsage>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(None))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Fetch Claude Code subscription usage via the official interactive app.
pub async fn get_usage() -> Result<ClaudeCodeUsage, String> {
    let now = now_millis();
    if let Some(cached) = cache().read().await.as_ref()
        && now.saturating_sub(cached.fetched_at) < USAGE_CACHE_TTL_MS
    {
        return Ok(cached.usage.clone());
    }

    let mut guard = cache().write().await;
    let now = now_millis();
    if let Some(cached) = guard.as_ref()
        && now.saturating_sub(cached.fetched_at) < USAGE_CACHE_TTL_MS
    {
        return Ok(cached.usage.clone());
    }

    let usage = tokio::task::spawn_blocking(fetch_usage_sync)
        .await
        .map_err(|e| format!("Failed to join ptywright usage task: {e}"))??;
    *guard = Some(CachedUsage {
        usage: usage.clone(),
        fetched_at: usage.fetched_at,
    });
    Ok(usage)
}

fn fetch_usage_sync() -> Result<ClaudeCodeUsage, String> {
    let claude_path = resolve_claude_path_blocking();
    let cwd = dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".claudette")
        .join("usage-probe");
    std::fs::create_dir_all(&cwd)
        .map_err(|e| format!("Failed to create Claude Code usage probe directory: {e}"))?;
    let mut target = ptywright::Target::new(claude_path.to_string_lossy().into_owned()).cwd(cwd);
    target = target
        .env(
            "PATH",
            crate::env::enriched_path().to_string_lossy().into_owned(),
        )
        .env("TERM", "xterm-256color")
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("CLAUDETTE_PTYWRIGHT_USAGE", "1")
        .env("CLAUDE_CODE_SKIP_PROMPT_HISTORY", "1")
        .env("CLAUDE_CODE_DISABLE_MOUSE", "1")
        .env("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1")
        .env("CLAUDE_CODE_DISABLE_MESSAGE_ACTIONS", "1")
        .env("CLAUDE_CODE_DISABLE_ATTACHMENTS", "1")
        .env("CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "1")
        .env("CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL", "1");

    let session = ptywright::Session::spawn(ptywright::SessionConfig::new(target))
        .map_err(|e| format!("Failed to spawn Claude Code for usage: {e}"))?;
    let extension = ptywright::LuaExtension::built_in("claude-code")
        .map_err(|e| format!("Failed to load ptywright claude-code plugin: {e}"))?;
    let mut handle =
        ptywright::ExtensionHandle::start(Box::new(extension), session, COMPLETED_TURN_STABLE_MS);

    let result = fetch_usage_from_handle(&mut handle);
    let _ = handle.session().terminate(Duration::from_secs(2));
    result
}

fn fetch_usage_from_handle(
    handle: &mut ptywright::ExtensionHandle,
) -> Result<ClaudeCodeUsage, String> {
    for attempt in 0..3 {
        clear_startup_barriers(handle)?;
        let (state, _) = handle
            .turn(
                "slash_command",
                json!({ "command": "usage" }),
                Some("wait_turn_matcher"),
                json!({}),
                USAGE_TIMEOUT,
            )
            .map_err(|e| {
                let screen = handle.session().snapshot().plain_text;
                format!(
                    "Failed to read Claude Code usage via ptywright: {e}; screen tail: {}",
                    debug_tail(&screen, 600)
                )
            })?;

        if matches!(state.state.as_str(), "waiting_for_trust" | "starting") && attempt < 2 {
            handle_startup_barrier(handle, &state)?;
            continue;
        }

        return wait_for_usage_data(handle, state);
    }

    Err("Claude Code usage screen did not become available".to_string())
}

fn clear_startup_barriers(handle: &mut ptywright::ExtensionHandle) -> Result<(), String> {
    let deadline = Instant::now() + STARTUP_READY_TIMEOUT;
    while Instant::now() < deadline {
        let state = handle.state();
        if handle_startup_barrier(handle, &state)? {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }

        if state.state != "starting" || Instant::now() >= deadline {
            return Ok(());
        }

        std::thread::sleep(STARTUP_POLL_INTERVAL);
    }

    let state = handle.state();
    tracing::debug!(
        target: "claudette::usage",
        ptywright_state = %state.state,
        evidence = %state.evidence,
        metadata_keys = ?metadata_keys(state.metadata.as_ref()),
        "Claude Code usage probe startup barrier wait expired"
    );
    Ok(())
}

fn handle_startup_barrier(
    handle: &mut ptywright::ExtensionHandle,
    state: &ptywright::ExtensionStateSnapshot,
) -> Result<bool, String> {
    match state.state.as_str() {
        "waiting_for_trust" => {
            let dialog_id = state
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("dialog_id"))
                .and_then(Value::as_str)
                .ok_or_else(|| "Claude Code trust dialog did not include dialog_id".to_string())?;
            tracing::debug!(
                target: "claudette::usage",
                dialog_id,
                "approving Claude Code usage probe trust dialog"
            );
            handle
                .send("approve_trust", json!({ "dialog_id": dialog_id }))
                .map_err(|e| {
                    format!("Failed to approve Claude Code usage probe trust dialog: {e}")
                })?;
            Ok(true)
        }
        "starting" if state.evidence.contains("welcome") => {
            tracing::trace!(
                target: "claudette::usage",
                "dismissing Claude Code usage probe welcome screen"
            );
            handle
                .send("dismiss_welcome", json!({}))
                .map_err(|e| format!("Failed to dismiss Claude Code usage welcome screen: {e}"))?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn usage_from_state(
    handle: &ptywright::ExtensionHandle,
    state: &ptywright::ExtensionStateSnapshot,
) -> Result<Option<ClaudeCodeUsage>, String> {
    match state.state.as_str() {
        "completed_turn" | "usage_screen" | "waiting_for_user_input" => {}
        "waiting_for_login" => {
            return Err(
                "Claude Code credentials not found. Sign in with 'claude auth login'.".into(),
            );
        }
        "error" => {
            return Err(format!(
                "Claude Code usage screen reported: {}",
                state.evidence
            ));
        }
        other => {
            tracing::trace!(
                target: "claudette::usage",
                ptywright_state = other,
                evidence = %state.evidence,
                metadata_keys = ?metadata_keys(state.metadata.as_ref()),
                "ptywright Claude usage returned nonterminal state"
            );
        }
    }

    let Some(usage) = state
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("usage"))
    else {
        let screen = handle.session().snapshot().plain_text;
        tracing::trace!(
            target: "claudette::usage",
            ptywright_state = %state.state,
            evidence = %state.evidence,
            metadata_keys = ?metadata_keys(state.metadata.as_ref()),
            screen_tail = %debug_tail(&screen, 600),
            "Claude Code usage screen did not expose structured usage metadata yet"
        );
        return Ok(None);
    };

    let parsed = usage_from_metadata(usage);
    if !usage_has_limit_buckets(&parsed) {
        tracing::debug!(
            target: "claudette::usage",
            ptywright_state = %state.state,
            evidence = %state.evidence,
            metadata_keys = ?metadata_keys(state.metadata.as_ref()),
            usage_keys = ?metadata_keys(Some(usage)),
            "Claude Code usage metadata is present but limit buckets are not ready yet"
        );
        return Ok(None);
    }

    Ok(Some(parsed))
}

fn wait_for_usage_data(
    handle: &mut ptywright::ExtensionHandle,
    initial_state: ptywright::ExtensionStateSnapshot,
) -> Result<ClaudeCodeUsage, String> {
    let deadline = Instant::now() + USAGE_DATA_READY_TIMEOUT;
    let mut state = initial_state;
    let mut tried_usage_tab = false;

    loop {
        if let Some(usage) = usage_from_state(handle, &state)? {
            return Ok(usage);
        }

        if !tried_usage_tab && usage_stats_screen_visible(&handle.session().snapshot().plain_text) {
            tried_usage_tab = true;
            tracing::debug!(
                target: "claudette::usage",
                ptywright_state = %state.state,
                evidence = %state.evidence,
                "Claude Code usage probe landed on stats tab; moving to usage limits tab"
            );
            handle
                .send("key", json!({ "key": "left" }))
                .map_err(|e| format!("Failed to navigate Claude Code usage screen: {e}"))?;
        }

        if Instant::now() >= deadline {
            let screen = handle.session().snapshot().plain_text;
            tracing::warn!(
                target: "claudette::usage",
                ptywright_state = %state.state,
                evidence = %state.evidence,
                metadata_keys = ?metadata_keys(state.metadata.as_ref()),
                screen_tail = %debug_tail(&screen, 600),
                "Claude Code usage screen did not publish limit buckets before timeout"
            );
            return Ok(empty_usage());
        }

        std::thread::sleep(USAGE_DATA_POLL_INTERVAL);
        state = handle.state();
    }
}

fn usage_stats_screen_visible(screen: &str) -> bool {
    let lower = screen.to_ascii_lowercase();
    lower.contains("skills                  % of usage")
        || lower.contains("subagents               % of usage")
        || (lower.contains("d to day") && lower.contains("w to week"))
}

fn usage_from_metadata(value: &Value) -> ClaudeCodeUsage {
    let limits = value.get("limits").and_then(Value::as_object);
    let usage = UsageData {
        five_hour: limits
            .and_then(|m| m.get("current session"))
            .and_then(limit_from_value),
        seven_day: limits
            .and_then(|m| m.get("current week (all models)"))
            .and_then(limit_from_value),
        seven_day_sonnet: limits
            .and_then(|m| m.get("current week (sonnet only)"))
            .and_then(limit_from_value),
        seven_day_opus: limits
            .and_then(|m| m.get("current week (opus only)"))
            .and_then(limit_from_value),
        extra_usage: limits
            .and_then(|m| m.get("extra usage"))
            .map(extra_usage_from_value),
    };

    ClaudeCodeUsage {
        subscription_type: Some("Claude Code".to_string()),
        rate_limit_tier: None,
        usage,
        fetched_at: now_millis(),
    }
}

fn empty_usage() -> ClaudeCodeUsage {
    ClaudeCodeUsage {
        subscription_type: Some("Claude Code".to_string()),
        rate_limit_tier: None,
        usage: UsageData::default(),
        fetched_at: now_millis(),
    }
}

fn usage_has_limit_buckets(usage: &ClaudeCodeUsage) -> bool {
    usage.usage.five_hour.is_some()
        || usage.usage.seven_day.is_some()
        || usage.usage.seven_day_sonnet.is_some()
        || usage.usage.seven_day_opus.is_some()
        || usage.usage.extra_usage.is_some()
}

fn limit_from_value(value: &Value) -> Option<UsageLimit> {
    let utilization = value.get("percent_used").and_then(Value::as_f64)?;
    let resets_at = value
        .get("resets")
        .and_then(Value::as_str)
        .and_then(reset_phrase_to_millis)
        .map(Value::from)
        .unwrap_or_else(|| Value::from(now_millis() + 5 * 60_000));
    Some(UsageLimit {
        utilization,
        resets_at,
    })
}

fn extra_usage_from_value(value: &Value) -> ExtraUsage {
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let utilization = value.get("percent_used").and_then(Value::as_f64);
    ExtraUsage {
        is_enabled: !status.contains("not enabled"),
        monthly_limit: None,
        used_credits: None,
        utilization,
    }
}

/// Map the Claude Code `/usage` shape onto the unified per-session snapshot.
pub fn snapshot_from_usage(
    usage: &ClaudeCodeUsage,
    provider_kind: AgentBackendKind,
    fetched_at_ms: i64,
) -> UsageSnapshot {
    fn bucket(key: &str, label: &str, limit: &UsageLimit) -> UsageBucket {
        let pct = (limit.utilization / 100.0).clamp(0.0, 1.0) as f32;
        UsageBucket {
            key: key.to_string(),
            label: label.to_string(),
            utilization: pct,
            primary_text: format!("{}%", limit.utilization.floor() as i64),
            secondary_text: Some(String::from("from Claude Code /usage")),
            is_bounded: true,
            exhausted: limit.utilization >= 100.0,
        }
    }

    let mut buckets = Vec::new();
    if let Some(ref b) = usage.usage.five_hour {
        buckets.push(bucket("session_5h", "Session (5h)", b));
    }
    if let Some(ref b) = usage.usage.seven_day {
        buckets.push(bucket("week_all", "Week (all)", b));
    }
    if let Some(ref b) = usage.usage.seven_day_sonnet {
        buckets.push(bucket("week_sonnet", "Week (Sonnet)", b));
    }
    if let Some(ref b) = usage.usage.seven_day_opus {
        buckets.push(bucket("week_opus", "Week (Opus)", b));
    }

    UsageSnapshot {
        provider_kind,
        source_label: "Claude Code".to_string(),
        buckets,
        note: None,
        fetched_at_ms,
        experimental_disabled: false,
    }
}

fn reset_phrase_to_millis(raw: &str) -> Option<u64> {
    let phrase = raw.split(" (").next().unwrap_or(raw).trim();
    if phrase.is_empty() {
        return None;
    }

    if let Some(time) = parse_time(phrase) {
        let today = Local::now().date_naive();
        let mut naive = NaiveDateTime::new(today, time);
        let now = Local::now().naive_local();
        if naive <= now {
            naive += chrono::Duration::days(1);
        }
        return local_naive_to_millis(naive);
    }

    if let Some(rest) = phrase.strip_prefix("tomorrow at ")
        && let Some(time) = parse_time(rest)
    {
        let date = Local::now().date_naive() + chrono::Duration::days(1);
        return local_naive_to_millis(NaiveDateTime::new(date, time));
    }

    let (date_part, time_part) = phrase.split_once(" at ")?;
    let mut pieces = date_part.split_whitespace();
    let month = month_number(pieces.next()?)?;
    let day = pieces.next()?.parse::<u32>().ok()?;
    let time = parse_time(time_part)?;
    let mut year = Local::now().year();
    let mut date = NaiveDate::from_ymd_opt(year, month, day)?;
    let now = Local::now().naive_local();
    if NaiveDateTime::new(date, time) <= now {
        year += 1;
        date = NaiveDate::from_ymd_opt(year, month, day)?;
    }
    local_naive_to_millis(NaiveDateTime::new(date, time))
}

fn parse_time(raw: &str) -> Option<NaiveTime> {
    let compact = raw.trim().to_ascii_lowercase().replace(' ', "");
    for fmt in ["%I:%M%P", "%I%P"] {
        if let Ok(time) = NaiveTime::parse_from_str(&compact, fmt) {
            return Some(time);
        }
    }
    None
}

fn month_number(month: &str) -> Option<u32> {
    match month.to_ascii_lowercase().as_str() {
        "jan" | "january" => Some(1),
        "feb" | "february" => Some(2),
        "mar" | "march" => Some(3),
        "apr" | "april" => Some(4),
        "may" => Some(5),
        "jun" | "june" => Some(6),
        "jul" | "july" => Some(7),
        "aug" | "august" => Some(8),
        "sep" | "sept" | "september" => Some(9),
        "oct" | "october" => Some(10),
        "nov" | "november" => Some(11),
        "dec" | "december" => Some(12),
        _ => None,
    }
}

fn local_naive_to_millis(naive: NaiveDateTime) -> Option<u64> {
    let local = Local
        .from_local_datetime(&naive)
        .single()
        .or_else(|| Local.from_local_datetime(&naive).earliest())
        .or_else(|| Local.from_local_datetime(&naive).latest())?;
    Some(local.timestamp_millis() as u64)
}

fn debug_tail(s: &str, max_chars: usize) -> String {
    let mut chars: Vec<char> = s.chars().rev().take(max_chars).collect();
    chars.reverse();
    chars.into_iter().collect()
}

fn metadata_keys(metadata: Option<&Value>) -> Vec<String> {
    metadata
        .and_then(Value::as_object)
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_ptywright_usage_limits_to_legacy_usage_shape() {
        let metadata = json!({
            "limits": {
                "current session": { "percent_used": 2, "resets": "12:40pm (America/Phoenix)" },
                "current week (all models)": { "percent_used": 98, "resets": "May 15 at 1am (America/Phoenix)" },
                "current week (sonnet only)": { "percent_used": 9, "resets": "May 15 at 1am (America/Phoenix)" },
                "current week (opus only)": { "percent_used": 4, "resets": "May 15 at 1am (America/Phoenix)" },
                "extra usage": { "status": "Extra usage not enabled · /extra-usage to enable" }
            }
        });

        let usage = usage_from_metadata(&metadata);
        assert_eq!(usage.usage.five_hour.unwrap().utilization, 2.0);
        assert_eq!(usage.usage.seven_day.unwrap().utilization, 98.0);
        assert_eq!(usage.usage.seven_day_sonnet.unwrap().utilization, 9.0);
        assert_eq!(usage.usage.seven_day_opus.unwrap().utilization, 4.0);
        assert!(!usage.usage.extra_usage.unwrap().is_enabled);
    }

    #[test]
    fn partial_usage_metadata_does_not_error() {
        let usage = usage_from_metadata(&json!({ "cost_usd": 0.0 }));

        assert!(!usage_has_limit_buckets(&usage));
        assert!(usage.usage.five_hour.is_none());
        assert!(usage.usage.seven_day.is_none());
    }

    #[test]
    fn detects_usage_stats_tab_without_limit_buckets() {
        let screen = r#"
Skills                  % of usage
/copilot                        1%
/codex                          1%

Subagents               % of usage
general-purpose                 7%
Explore                         1%

d to day · w to week

Esc to cancel
"#;

        assert!(usage_stats_screen_visible(screen));
        assert!(!usage_stats_screen_visible(
            "Current session\n████████ 24% used\nResets 12:40pm"
        ));
    }

    #[test]
    fn snapshot_uses_claude_code_source_without_experimental_stub() {
        let usage = ClaudeCodeUsage {
            subscription_type: Some("Claude Code".to_string()),
            rate_limit_tier: None,
            usage: UsageData {
                five_hour: Some(UsageLimit {
                    utilization: 50.0,
                    resets_at: Value::from(now_millis() + 60_000),
                }),
                ..UsageData::default()
            },
            fetched_at: 1_000,
        };

        let snapshot = snapshot_from_usage(&usage, AgentBackendKind::Anthropic, 1_000);
        assert_eq!(snapshot.source_label, "Claude Code");
        assert_eq!(snapshot.buckets[0].key, "session_5h");
        assert!(!snapshot.experimental_disabled);
    }
}
