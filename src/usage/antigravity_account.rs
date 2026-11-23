//! Antigravity quota/usage reader via `agy -p /usage --output-format json`.
//!
//! Mirrors Orca's safety guards (`src/main/rate-limits/providers/antigravity/`):
//! - Checks `agy --version >= 1.1.11` before invoking `/usage` (older versions
//!   treat `/usage` as a billed model prompt!).
//! - Never passes `--disable-slash-commands` (also turns `/usage` into a billed
//!   prompt!).
//! - Latches a process-wide guard if stdout ever shows `num_turns > 0` or a
//!   non-empty `conversation_id`, so an incompatible build never spends quota
//!   twice.
//! - Detects interactive sign-in stderr (`Authentication required`) so polling
//!   doesn't spawn repeated browser sign-in windows.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;

use crate::agent_backend::AgentBackendKind;

use super::{UsageBucket, UsageSnapshot};

const MIN_USAGE_VERSION: (u64, u64, u64) = (1, 1, 11);
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const USAGE_TIMEOUT: Duration = Duration::from_secs(25);

/// Latched if a running `agy` binary ever executes `/usage` as a billed model
/// turn (proven by `num_turns > 0` or a non-empty `conversation_id`).
static UNSUPPORTED_USAGE_LATCH: AtomicBool = AtomicBool::new(false);

/// Latched when `agy -p /usage` prints an interactive sign-in prompt, so
/// periodic polls don't pop browser tabs repeatedly. Cleared after login.
static SIGN_IN_HOLD: AtomicBool = AtomicBool::new(false);

pub fn clear_sign_in_hold() {
    SIGN_IN_HOLD.store(false, Ordering::SeqCst);
}

/// Fetch live Antigravity quota buckets via `agy -p /usage --output-format json`.
/// Returns `Ok(None)` when the CLI is unavailable, older than 1.1.11, signed
/// out, or returns no quota buckets — callers should fall back to local
/// aggregate token counts.
pub async fn fetch_usage_snapshot(now_ms: i64) -> Result<Option<UsageSnapshot>, String> {
    if UNSUPPORTED_USAGE_LATCH.load(Ordering::SeqCst) || SIGN_IN_HOLD.load(Ordering::SeqCst) {
        return Ok(None);
    }

    let agy_path = crate::agent::resolve_agy_path().await;

    // 1. Version gate: `agy --version` must be >= 1.1.11 so `/usage` is
    //    handled locally instead of spending a billed model turn.
    let mut ver_cmd = crate::process::command(&agy_path);
    ver_cmd
        .arg("--version")
        .env("PATH", crate::env::enriched_path())
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    let ver_out = match tokio::time::timeout(VERSION_TIMEOUT, ver_cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => out,
        _ => return Ok(None),
    };
    let ver_text = {
        let stdout = String::from_utf8_lossy(&ver_out.stdout);
        if !stdout.trim().is_empty() {
            stdout.into_owned()
        } else {
            String::from_utf8_lossy(&ver_out.stderr).into_owned()
        }
    };
    let Some(version) = parse_semver_triple(&ver_text) else {
        return Ok(None);
    };
    if version < MIN_USAGE_VERSION {
        return Ok(None);
    }

    // 2. Run `agy -p /usage --output-format json --print-timeout 20s`.
    //    Never pass `--disable-slash-commands`.
    let mut cmd = crate::process::command(&agy_path);
    cmd.args([
        "-p",
        "/usage",
        "--output-format",
        "json",
        "--print-timeout",
        "20s",
    ])
    .env("PATH", crate::env::enriched_path())
    .env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    if !crate::agent::antigravity_acp::agy_uses_api_key(dirs::home_dir().as_deref()) {
        cmd.env_remove("GEMINI_API_KEY");
        cmd.env_remove("GOOGLE_API_KEY");
    }

    let output = match tokio::time::timeout(USAGE_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => out,
        _ => return Ok(None),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if let Some(snapshot) = parse_usage_stdout(&stdout, now_ms) {
        return Ok(Some(snapshot));
    }

    if stderr_shows_interactive_sign_in(&stderr) {
        SIGN_IN_HOLD.store(true, Ordering::SeqCst);
        return Ok(None);
    }

    if stdout_shows_model_turn(&stdout) {
        UNSUPPORTED_USAGE_LATCH.store(true, Ordering::SeqCst);
    }

    Ok(None)
}

pub fn parse_semver_triple(text: &str) -> Option<(u64, u64, u64)> {
    for token in text.split(|c: char| !c.is_ascii_alphanumeric() && c != '.') {
        let token = token.trim_start_matches('v');
        let mut parts = token.split('.');
        let (Some(a), Some(b), Some(c)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if let (Ok(major), Ok(minor), Ok(patch)) =
            (a.parse::<u64>(), b.parse::<u64>(), c.parse::<u64>())
        {
            return Some((major, minor, patch));
        }
    }
    None
}

pub fn stderr_shows_interactive_sign_in(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("authentication required. please visit the url")
        || lower.contains("please sign in")
}

fn extract_json_values_from_stdout(stdout: &str) -> Vec<Value> {
    let trimmed = stdout.trim();
    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
        return vec![val];
    }
    let mut values = Vec::new();
    for line in stdout.lines() {
        let line_trimmed = line.trim();
        if line_trimmed.starts_with('{')
            && let Ok(val) = serde_json::from_str::<Value>(line_trimmed)
        {
            values.push(val);
        }
    }
    if !values.is_empty() {
        return values;
    }
    if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}'))
        && start < end
        && let Ok(val) = serde_json::from_str::<Value>(&trimmed[start..=end])
    {
        values.push(val);
    }
    values
}

pub fn stdout_shows_model_turn(stdout: &str) -> bool {
    for val in extract_json_values_from_stdout(stdout) {
        if val
            .get("num_turns")
            .and_then(Value::as_u64)
            .is_some_and(|n| n > 0)
        {
            return true;
        }
        if val
            .get("conversation_id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.trim().is_empty())
        {
            return true;
        }
    }
    false
}

pub fn parse_usage_stdout(stdout: &str, now_ms: i64) -> Option<UsageSnapshot> {
    for val in extract_json_values_from_stdout(stdout) {
        if let Some(snapshot) = parse_usage_envelope(&val, now_ms) {
            return Some(snapshot);
        }
    }
    None
}

pub fn parse_usage_envelope(value: &Value, now_ms: i64) -> Option<UsageSnapshot> {
    if value.get("status").and_then(Value::as_str) != Some("SUCCESS") {
        return None;
    }
    let command = value.get("command")?;
    if command.get("name").and_then(Value::as_str) != Some("usage") {
        return None;
    }
    let data = command.get("data")?;
    let groups = data.get("groups").and_then(Value::as_array)?;

    let mut buckets = Vec::new();
    for group in groups {
        let Some(group_name) = group
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let Some(raw_buckets) = group.get("buckets").and_then(Value::as_array) else {
            continue;
        };
        let enabled: Vec<&Value> = raw_buckets
            .iter()
            .filter(|b| b.get("disabled").and_then(Value::as_bool) != Some(true))
            .collect();
        let siblings = enabled.len();
        for raw in enabled {
            let Some(id) = raw
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let Some(remaining) = raw.get("remaining_fraction").and_then(Value::as_f64) else {
                continue;
            };
            if !remaining.is_finite() {
                continue;
            }
            let used_fraction = (1.0 - remaining).clamp(0.0, 1.0);
            let used_percent = (used_fraction * 100.0).round() as i64;
            let window_name = raw
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let label = match window_name {
                Some(name) if siblings > 1 => format!("{group_name} · {name}"),
                _ => group_name.to_string(),
            };
            let secondary_text = raw
                .get("reset_time")
                .and_then(Value::as_str)
                .and_then(|iso| chrono::DateTime::parse_from_rfc3339(iso).ok())
                .and_then(|dt| format_resets_in(dt.timestamp_millis(), now_ms));

            buckets.push(UsageBucket {
                key: format!("antigravity_{id}"),
                label,
                utilization: used_fraction as f32,
                primary_text: format!("{used_percent}%"),
                secondary_text,
                is_bounded: true,
                exhausted: used_percent >= 100,
            });
        }
    }

    if buckets.is_empty() {
        return None;
    }

    let note = data
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| Some("Live Antigravity quota — fetched via `agy /usage`.".to_string()));

    Some(UsageSnapshot {
        provider_kind: AgentBackendKind::Antigravity,
        source_label: "Antigravity".to_string(),
        buckets,
        note,
        fetched_at_ms: now_ms,
        experimental_disabled: false,
    })
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_semver_triples_from_version_output() {
        assert_eq!(parse_semver_triple("1.5.15\n"), Some((1, 5, 15)));
        assert_eq!(parse_semver_triple("agy v1.1.11 (abc)"), Some((1, 1, 11)));
        assert_eq!(parse_semver_triple("unknown"), None);
    }

    #[test]
    fn detects_billed_model_turn_envelopes() {
        assert!(stdout_shows_model_turn(
            r#"{"status":"SUCCESS","num_turns":1,"conversation_id":"abc"}"#
        ));
        assert!(!stdout_shows_model_turn(
            r#"{"status":"SUCCESS","num_turns":0,"conversation_id":"","command":{"name":"usage"}}"#
        ));
    }

    #[test]
    fn parses_antigravity_usage_envelope_skipping_disabled_buckets() {
        let raw = r#"{
            "status": "SUCCESS",
            "command": {
                "name": "usage",
                "data": {
                    "description": "Google AI Pro",
                    "groups": [
                        {
                            "name": "Gemini",
                            "buckets": [
                                {
                                    "id": "gemini-5h",
                                    "name": "5h",
                                    "window": "5h",
                                    "remaining_fraction": 0.75,
                                    "reset_time": "2026-11-23T20:00:00Z",
                                    "disabled": false
                                },
                                {
                                    "id": "gemini-disabled",
                                    "name": "Disabled",
                                    "window": "weekly",
                                    "remaining_fraction": 1.0,
                                    "disabled": true
                                }
                            ]
                        }
                    ]
                }
            }
        }"#;
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-23T18:30:00Z")
            .unwrap()
            .timestamp_millis();
        let snap = parse_usage_stdout(raw, now).expect("should parse usage snapshot");
        assert_eq!(snap.source_label, "Antigravity");
        assert_eq!(snap.provider_kind, AgentBackendKind::Antigravity);
        assert_eq!(snap.buckets.len(), 1);
        assert_eq!(snap.buckets[0].key, "antigravity_gemini-5h");
        assert_eq!(snap.buckets[0].label, "Gemini");
        assert_eq!(snap.buckets[0].primary_text, "25%");
        assert_eq!(
            snap.buckets[0].secondary_text.as_deref(),
            Some("resets in 1h 30m")
        );
        assert!(!snap.buckets[0].exhausted);
    }
}
