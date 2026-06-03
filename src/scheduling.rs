use chrono::{DateTime, Datelike, Duration, Local, Timelike, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduledTaskKind {
    Wakeup,
    Cron,
}

impl ScheduledTaskKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wakeup => "wakeup",
            Self::Cron => "cron",
        }
    }
}

impl std::str::FromStr for ScheduledTaskKind {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "wakeup" => Ok(Self::Wakeup),
            "cron" => Ok(Self::Cron),
            other => Err(format!("unknown scheduled task kind: {other}")),
        }
    }
}

/// Where a scheduled task dispatches when it fires. Chosen at creation and
/// recorded on the row (`chat_session_id` + `create_new_session`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleTarget {
    /// Reuse an existing chat session; its workspace is derived at creation.
    Session(String),
    /// Create a fresh chat session in this workspace each time the task fires
    /// (so a recurring cron gets a clean session per run).
    NewSessionInWorkspace(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledTask {
    pub id: String,
    /// Target session for reuse-mode tasks. `None` when `create_new_session`
    /// is true — those rows have no session until the scheduler makes a fresh
    /// one in `workspace_id` at fire time.
    pub chat_session_id: Option<String>,
    pub workspace_id: String,
    /// When true, the scheduler creates a brand-new chat session in
    /// `workspace_id` each time the task fires (so a recurring cron gets a
    /// clean session per run) instead of dispatching into `chat_session_id`.
    pub create_new_session: bool,
    pub kind: ScheduledTaskKind,
    pub name: Option<String>,
    pub prompt: String,
    pub reason: Option<String>,
    pub fire_at: Option<String>,
    pub cron_expr: Option<String>,
    pub recurring: bool,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_fired_at: Option<String>,
    pub next_fire_at: Option<String>,
    pub failure_count: i64,
    pub last_failed_at: Option<String>,
    pub last_error: Option<String>,
    pub disabled_reason: Option<String>,
    /// Backend the task was scheduled under. The scheduler passes this
    /// through to `send_chat_message` so a Codex- or Pi-chat cron fires
    /// on its own backend instead of falling through to the global
    /// `default_agent_backend` app setting. `None` for legacy rows and
    /// for agent-callable scheduling that chose not to pin a backend —
    /// those keep the prior global-default behavior.
    pub backend_id: Option<String>,
    /// Model id captured at schedule time. Forwarded to
    /// `send_chat_message` like [`Self::backend_id`].
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronFields {
    minute: Vec<u32>,
    hour: Vec<u32>,
    day_of_month: Vec<u32>,
    month: Vec<u32>,
    day_of_week: Vec<u32>,
}

#[derive(Debug, Clone, Copy)]
struct FieldRange {
    min: u32,
    max: u32,
}

const FIELD_RANGES: [FieldRange; 5] = [
    FieldRange { min: 0, max: 59 },
    FieldRange { min: 0, max: 23 },
    FieldRange { min: 1, max: 31 },
    FieldRange { min: 1, max: 12 },
    FieldRange { min: 0, max: 6 },
];

pub fn parse_cron_expression(expr: &str) -> Option<CronFields> {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return None;
    }
    let minute = expand_field(parts[0], FIELD_RANGES[0])?;
    let hour = expand_field(parts[1], FIELD_RANGES[1])?;
    let day_of_month = expand_field(parts[2], FIELD_RANGES[2])?;
    let month = expand_field(parts[3], FIELD_RANGES[3])?;
    let day_of_week = expand_field(parts[4], FIELD_RANGES[4])?;
    Some(CronFields {
        minute,
        hour,
        day_of_month,
        month,
        day_of_week,
    })
}

fn expand_field(field: &str, range: FieldRange) -> Option<Vec<u32>> {
    let mut out = BTreeSet::new();
    for part in field.split(',') {
        if part.is_empty() {
            return None;
        }
        if let Some(step) = part.strip_prefix("*/") {
            let step = step.parse::<u32>().ok()?;
            if step == 0 {
                return None;
            }
            let mut value = range.min;
            while value <= range.max {
                out.insert(value);
                value = value.saturating_add(step);
                if value == u32::MAX {
                    break;
                }
            }
            continue;
        }
        if part == "*" {
            for value in range.min..=range.max {
                out.insert(value);
            }
            continue;
        }
        if let Some((bounds, step)) = part.split_once('/') {
            let step = step.parse::<u32>().ok()?;
            if step == 0 {
                return None;
            }
            expand_range(bounds, step, range, &mut out)?;
            continue;
        }
        if part.contains('-') {
            expand_range(part, 1, range, &mut out)?;
            continue;
        }
        let value = normalize_value(part.parse::<u32>().ok()?, range)?;
        out.insert(value);
    }
    if out.is_empty() {
        None
    } else {
        Some(out.into_iter().collect())
    }
}

fn expand_range(bounds: &str, step: u32, range: FieldRange, out: &mut BTreeSet<u32>) -> Option<()> {
    let (lo, hi) = bounds.split_once('-')?;
    let lo = lo.parse::<u32>().ok()?;
    let hi = hi.parse::<u32>().ok()?;
    let is_dow = range.min == 0 && range.max == 6;
    let effective_max = if is_dow { 7 } else { range.max };
    if lo > hi || lo < range.min || hi > effective_max {
        return None;
    }
    let mut value = lo;
    while value <= hi {
        out.insert(if is_dow && value == 7 { 0 } else { value });
        value = value.saturating_add(step);
        if value == u32::MAX {
            break;
        }
    }
    Some(())
}

fn normalize_value(value: u32, range: FieldRange) -> Option<u32> {
    if range.min == 0 && range.max == 6 && value == 7 {
        return Some(0);
    }
    if value < range.min || value > range.max {
        None
    } else {
        Some(value)
    }
}

pub fn next_cron_run_utc(expr: &str, from: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let fields = parse_cron_expression(expr)?;
    let minute = fields.minute.into_iter().collect::<BTreeSet<_>>();
    let hour = fields.hour.into_iter().collect::<BTreeSet<_>>();
    let day_of_month = fields.day_of_month.into_iter().collect::<BTreeSet<_>>();
    let month = fields.month.into_iter().collect::<BTreeSet<_>>();
    let day_of_week = fields.day_of_week.into_iter().collect::<BTreeSet<_>>();
    let dom_wild = day_of_month.len() == 31;
    let dow_wild = day_of_week.len() == 7;

    let mut candidate = from.with_timezone(&Local);
    candidate += Duration::minutes(1);
    candidate = candidate.with_second(0)?.with_nanosecond(0)?;

    for _ in 0..(366 * 24 * 60) {
        let mon = candidate.month();
        if !month.contains(&mon) {
            candidate += Duration::minutes(1);
            continue;
        }
        let dom = candidate.day();
        let dow = candidate.weekday().num_days_from_sunday();
        let day_matches = if dom_wild && dow_wild {
            true
        } else if dom_wild {
            day_of_week.contains(&dow)
        } else if dow_wild {
            day_of_month.contains(&dom)
        } else {
            day_of_month.contains(&dom) || day_of_week.contains(&dow)
        };
        if day_matches && hour.contains(&candidate.hour()) && minute.contains(&candidate.minute()) {
            return Some(candidate.with_timezone(&Utc));
        }
        candidate += Duration::minutes(1);
    }
    None
}

pub fn cron_to_human(expr: &str) -> String {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return expr.to_string();
    }
    let [minute, hour, day_of_month, month, day_of_week] =
        [parts[0], parts[1], parts[2], parts[3], parts[4]];
    if let Some(n) = minute
        .strip_prefix("*/")
        .and_then(|v| v.parse::<u32>().ok())
        && hour == "*"
        && day_of_month == "*"
        && month == "*"
        && day_of_week == "*"
    {
        return if n == 1 {
            "Every minute".to_string()
        } else {
            format!("Every {n} minutes")
        };
    }
    if minute == "0" && hour == "*" && day_of_month == "*" && month == "*" && day_of_week == "*" {
        return "Every hour".to_string();
    }
    if minute.parse::<u32>().is_ok()
        && hour.parse::<u32>().is_ok()
        && day_of_month == "*"
        && month == "*"
        && day_of_week == "*"
    {
        return format!("Every day at {hour}:{minute:0>2}");
    }
    expr.to_string()
}

pub fn utc_now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn parses_cron_subset() {
        let fields = parse_cron_expression("*/5 9-17 * * 1-5").unwrap();
        assert_eq!(fields.minute[0], 0);
        assert!(fields.minute.contains(&55));
        assert_eq!(fields.hour, (9..=17).collect::<Vec<_>>());
        assert_eq!(fields.day_of_week, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn accepts_sunday_alias() {
        let fields = parse_cron_expression("0 9 * * 7").unwrap();
        assert_eq!(fields.day_of_week, vec![0]);
    }

    #[test]
    fn rejects_invalid_cron() {
        assert!(parse_cron_expression("* * * *").is_none());
        assert!(parse_cron_expression("*/0 * * * *").is_none());
        assert!(parse_cron_expression("60 * * * *").is_none());
    }

    #[test]
    fn computes_next_run_strictly_after_input() {
        let from = Utc.with_ymd_and_hms(2026, 5, 17, 12, 0, 0).unwrap();
        let next = next_cron_run_utc("0 12 * * *", from).unwrap();
        assert!(next > from);
    }
}
