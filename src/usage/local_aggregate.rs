//! Local-aggregate usage source.
//!
//! For backends that don't expose a remote subscription-quota API
//! (Codex Native, OpenAI-compatible cards, Pi-routed local models),
//! we compute usage from what Claudette already records per chat
//! turn in `chat_messages`: `input_tokens`, `output_tokens`,
//! `cache_*_tokens`, and `cost_usd` when populated.
//!
//! Two buckets are produced:
//!  - `local_session` — totals for the active `chat_session_id`.
//!  - `local_24h` — totals for the workspace over the trailing 24h.
//!
//! Both are unbounded (`is_bounded = false`) — the frontend renders
//! them as throughput readouts rather than fill-toward-limit bars.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use super::{UsageBucket, UsageSnapshot};
use crate::agent_backend::AgentBackendKind;

/// Raw aggregate row returned by [`session_totals`] / [`workspace_24h_totals`].
/// Kept distinct from [`UsageBucket`] so the SQL layer doesn't have to
/// know about display strings.
#[derive(Debug, Clone, Default, Serialize)]
pub struct LocalAggregate {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    /// Sum of `cost_usd` rows. SQL `COALESCE(SUM(cost_usd), 0.0)`
    /// treats NULL rows as zero, so a partially-populated range
    /// undercounts. The snapshot adapter substitutes a
    /// `pricing::lookup`-derived estimate only when the SUM is
    /// exactly zero (no rows recorded a dollar value at all). Mixed
    /// populated/NULL ranges keep the SUM and silently undercount —
    /// good enough for the meter's ballpark spend readout.
    pub cost_usd: f64,
    /// Count of rows aggregated. Used to suppress empty buckets.
    pub message_count: i64,
}

impl LocalAggregate {
    fn total_tokens(&self) -> i64 {
        self.input_tokens + self.output_tokens
    }
}

/// Sum tokens / cost across every assistant message in the given chat
/// session. User messages aren't included — they're already accounted
/// for in the assistant message's `input_tokens` (the CLI reports the
/// full conversation token count, not the per-message delta).
pub fn session_totals(
    conn: &Connection,
    chat_session_id: &str,
) -> rusqlite::Result<LocalAggregate> {
    fetch_aggregate(
        conn,
        "SELECT
            COALESCE(SUM(input_tokens),          0),
            COALESCE(SUM(output_tokens),         0),
            COALESCE(SUM(cache_read_tokens),     0),
            COALESCE(SUM(cache_creation_tokens), 0),
            COALESCE(SUM(cost_usd),              0.0),
            COUNT(*)
         FROM chat_messages
         WHERE chat_session_id = ?1 AND role = 'assistant'",
        params![chat_session_id],
    )
}

/// Sum tokens / cost across every assistant message in the workspace
/// over the trailing 24 hours (UTC). Spans chat sessions inside the
/// workspace — useful when the user starts a new session mid-day and
/// still wants to see their day's spend so far.
pub fn workspace_24h_totals(
    conn: &Connection,
    workspace_id: &str,
) -> rusqlite::Result<LocalAggregate> {
    fetch_aggregate(
        conn,
        "SELECT
            COALESCE(SUM(input_tokens),          0),
            COALESCE(SUM(output_tokens),         0),
            COALESCE(SUM(cache_read_tokens),     0),
            COALESCE(SUM(cache_creation_tokens), 0),
            COALESCE(SUM(cost_usd),              0.0),
            COUNT(*)
         FROM chat_messages
         WHERE workspace_id = ?1
           AND role = 'assistant'
           AND created_at >= datetime('now', '-1 day')",
        params![workspace_id],
    )
}

fn fetch_aggregate(
    conn: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> rusqlite::Result<LocalAggregate> {
    let row = conn
        .query_row(sql, params, |r| {
            Ok(LocalAggregate {
                input_tokens: r.get(0)?,
                output_tokens: r.get(1)?,
                cache_read_tokens: r.get(2)?,
                cache_creation_tokens: r.get(3)?,
                cost_usd: r.get(4)?,
                message_count: r.get(5)?,
            })
        })
        .optional()?;
    Ok(row.unwrap_or_default())
}

/// Format a token count for human display: `12,345` → `"12.3k tok"`,
/// `1_500_000` → `"1.5M tok"`. Tight enough to fit in the popover's
/// narrow primary slot.
fn format_tokens(n: i64) -> String {
    let n = n.max(0) as f64;
    if n >= 1_000_000.0 {
        format!("{:.1}M tok", n / 1_000_000.0)
    } else if n >= 1_000.0 {
        format!("{:.1}k tok", n / 1_000.0)
    } else {
        format!("{n} tok", n = n as i64)
    }
}

/// Format a dollar figure: `$0.000`, `$0.43`, `$12.40`. Returns
/// `None` when the cost is zero — the popover hides the dollar slot
/// rather than show `$0.00`. Sub-dollar values get 3 decimals so a
/// $0.003 turn doesn't display as `$0.00`.
fn format_cost(cost_usd: f64) -> Option<String> {
    if cost_usd <= 0.0 {
        return None;
    }
    Some(if cost_usd >= 1.0 {
        format!("${cost_usd:.2}")
    } else {
        format!("${cost_usd:.3}")
    })
}

/// Build the unified snapshot from the two aggregates. `default_model`
/// is the backend's currently-selected model id, used by
/// [`crate::usage::pricing`] to estimate cost when `cost_usd` rows are
/// null. `provider_label` is the user-facing source label
/// ("Codex Plus", "OpenRouter", "Local") shown in the popover header.
pub fn snapshot_from_locals(
    provider_kind: AgentBackendKind,
    provider_label: impl Into<String>,
    session: LocalAggregate,
    today: LocalAggregate,
    default_model: Option<&str>,
    extra_buckets: Vec<UsageBucket>,
    fetched_at_ms: i64,
) -> UsageSnapshot {
    let mut buckets = extra_buckets;
    let pricing = default_model.and_then(super::pricing::lookup);

    // Models running entirely on the user's hardware have no marginal
    // per-token cost, so the ≈$X.XX readout is meaningless for them.
    // It would also be misleading: `chat_messages.cost_usd` is summed
    // across the whole workspace over 24h, so a stray Claude / Codex
    // turn earlier in the day would surface a dollar number under an
    // Ollama header. Suppress it entirely for the two backends whose
    // runtime is by definition local.
    let track_cost = !matches!(
        provider_kind,
        AgentBackendKind::Ollama | AgentBackendKind::LmStudio
    );

    let augment_cost = |agg: &LocalAggregate| -> f64 {
        if !track_cost {
            return 0.0;
        }
        if agg.cost_usd > 0.0 {
            return agg.cost_usd;
        }
        match pricing {
            Some(p) => p.cost(agg.input_tokens, agg.output_tokens),
            None => 0.0,
        }
    };

    let push_bucket =
        |buckets: &mut Vec<UsageBucket>, key: &str, label: &str, agg: &LocalAggregate| {
            if agg.message_count == 0 {
                return;
            }
            let cost = augment_cost(agg);
            let primary = format_tokens(agg.total_tokens());
            let secondary = format_cost(cost).map(|c| format!("≈ {c}"));
            buckets.push(UsageBucket {
                key: key.to_string(),
                label: label.to_string(),
                utilization: 0.0,
                primary_text: primary,
                secondary_text: secondary,
                is_bounded: false,
                exhausted: false,
            });
        };

    push_bucket(&mut buckets, "local_session", "This session", &session);
    // "Last 24h" rather than "Today" because the SQL window is a
    // strict trailing 24-hour UTC range, not "since local midnight".
    push_bucket(&mut buckets, "local_24h", "Last 24h", &today);

    // Base the note on whether any local-aggregate bucket was added,
    // not on `buckets.is_empty()` — extras like the OpenRouter
    // credit balance start in the bucket list before the local rows,
    // so a session with no recorded turns but a credit-balance
    // bucket would otherwise be mislabeled "Local tracking".
    let has_local_data = session.message_count > 0 || today.message_count > 0;
    let note = if !has_local_data {
        Some(String::from(
            "No turns recorded yet for this session. The meter will fill in as you chat.",
        ))
    } else {
        Some(String::from(
            "Local tracking — based on tokens recorded by Claudette per turn.",
        ))
    };

    UsageSnapshot {
        provider_kind,
        source_label: provider_label.into(),
        buckets,
        note,
        fetched_at_ms,
        experimental_disabled: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // Minimal schema — only the columns this module touches. Mirrors
        // the production `chat_messages` shape; we don't run the full
        // migration set in unit tests.
        conn.execute_batch(
            "CREATE TABLE chat_messages (
                id                    TEXT PRIMARY KEY,
                workspace_id          TEXT NOT NULL,
                chat_session_id       TEXT,
                role                  TEXT NOT NULL,
                content               TEXT NOT NULL,
                cost_usd              REAL,
                duration_ms           INTEGER,
                created_at            TEXT NOT NULL DEFAULT (datetime('now')),
                thinking              TEXT,
                input_tokens          INTEGER,
                output_tokens         INTEGER,
                cache_read_tokens     INTEGER,
                cache_creation_tokens INTEGER
            );",
        )
        .unwrap();
        conn
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_msg(
        conn: &Connection,
        id: &str,
        workspace: &str,
        session: Option<&str>,
        role: &str,
        input: Option<i64>,
        output: Option<i64>,
        cost: Option<f64>,
        created_at: &str,
    ) {
        conn.execute(
            "INSERT INTO chat_messages
                (id, workspace_id, chat_session_id, role, content,
                 cost_usd, input_tokens, output_tokens, created_at)
             VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, ?7, ?8)",
            params![
                id, workspace, session, role, cost, input, output, created_at
            ],
        )
        .unwrap();
    }

    #[test]
    fn session_totals_sums_assistant_messages_only() {
        let conn = make_db();
        insert_msg(
            &conn,
            "u1",
            "w1",
            Some("s1"),
            "user",
            Some(50),
            None,
            None,
            "2026-05-16 10:00:00",
        );
        insert_msg(
            &conn,
            "a1",
            "w1",
            Some("s1"),
            "assistant",
            Some(100),
            Some(50),
            Some(0.001),
            "2026-05-16 10:00:01",
        );
        insert_msg(
            &conn,
            "a2",
            "w1",
            Some("s1"),
            "assistant",
            Some(200),
            Some(75),
            None,
            "2026-05-16 10:05:00",
        );
        // Different session — must be excluded.
        insert_msg(
            &conn,
            "a3",
            "w1",
            Some("s2"),
            "assistant",
            Some(999),
            Some(999),
            Some(9.99),
            "2026-05-16 10:05:00",
        );

        let agg = session_totals(&conn, "s1").unwrap();
        assert_eq!(agg.input_tokens, 300);
        assert_eq!(agg.output_tokens, 125);
        assert!((agg.cost_usd - 0.001).abs() < 1e-9);
        assert_eq!(agg.message_count, 2);
    }

    #[test]
    fn workspace_24h_totals_filters_by_recency() {
        let conn = make_db();
        // Within last 24h
        insert_msg(
            &conn,
            "a1",
            "w1",
            Some("s1"),
            "assistant",
            Some(100),
            Some(50),
            None,
            &chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        );
        // 48h ago — must be excluded
        let two_days_ago = chrono::Utc::now() - chrono::Duration::hours(48);
        insert_msg(
            &conn,
            "a_old",
            "w1",
            Some("s1"),
            "assistant",
            Some(9999),
            Some(9999),
            None,
            &two_days_ago.format("%Y-%m-%d %H:%M:%S").to_string(),
        );

        let agg = workspace_24h_totals(&conn, "w1").unwrap();
        assert_eq!(agg.input_tokens, 100);
        assert_eq!(agg.output_tokens, 50);
        assert_eq!(agg.message_count, 1);
    }

    #[test]
    fn empty_session_returns_zeroed_aggregate() {
        let conn = make_db();
        let agg = session_totals(&conn, "nonexistent").unwrap();
        assert_eq!(agg.message_count, 0);
        assert_eq!(agg.input_tokens, 0);
    }

    #[test]
    fn snapshot_skips_empty_buckets() {
        let snap = snapshot_from_locals(
            AgentBackendKind::OpenAiApi,
            "OpenAI",
            LocalAggregate::default(),
            LocalAggregate::default(),
            Some("gpt-5.4"),
            Vec::new(),
            42,
        );
        assert_eq!(snap.buckets.len(), 0);
        assert!(snap.note.unwrap().contains("No turns recorded yet"));
    }

    #[test]
    fn snapshot_uses_pricing_lookup_when_cost_missing() {
        let session = LocalAggregate {
            input_tokens: 1_000_000,
            output_tokens: 500_000,
            cost_usd: 0.0,
            message_count: 3,
            ..Default::default()
        };
        let snap = snapshot_from_locals(
            AgentBackendKind::OpenAiApi,
            "OpenAI",
            session,
            LocalAggregate::default(),
            Some("gpt-5.4"),
            Vec::new(),
            0,
        );
        let bucket = &snap.buckets[0];
        assert_eq!(bucket.key, "local_session");
        // 1M prompt * $1.25 + 0.5M completion * $10.00 = $1.25 + $5.00 = $6.25
        let secondary = bucket.secondary_text.as_ref().unwrap();
        assert!(secondary.contains("$6.25"), "secondary = {secondary}");
    }

    #[test]
    fn snapshot_suppresses_cost_for_local_only_backends() {
        // Even when chat_messages.cost_usd has data (e.g. from a prior
        // paid-backend turn in the same workspace), Ollama / LmStudio
        // backends should never surface a dollar readout — their
        // inference is local and has no marginal cost.
        let session = LocalAggregate {
            input_tokens: 5_000,
            output_tokens: 2_000,
            cost_usd: 0.42,
            message_count: 1,
            ..Default::default()
        };
        for kind in [AgentBackendKind::Ollama, AgentBackendKind::LmStudio] {
            let snap = snapshot_from_locals(
                kind,
                "Ollama",
                session.clone(),
                LocalAggregate::default(),
                Some("gpt-5.4"), // even with a model that maps to pricing
                Vec::new(),
                0,
            );
            let bucket = &snap.buckets[0];
            assert_eq!(bucket.key, "local_session");
            assert!(
                bucket.secondary_text.is_none(),
                "{kind:?} bucket should have no cost readout, got {:?}",
                bucket.secondary_text,
            );
        }
    }

    #[test]
    fn snapshot_prefers_recorded_cost_when_present() {
        let session = LocalAggregate {
            input_tokens: 1_000_000,
            output_tokens: 500_000,
            cost_usd: 99.99, // very different from pricing-derived value
            message_count: 1,
            ..Default::default()
        };
        let snap = snapshot_from_locals(
            AgentBackendKind::Anthropic,
            "Claude",
            session,
            LocalAggregate::default(),
            Some("claude-opus-4-7"),
            Vec::new(),
            0,
        );
        let secondary = snap.buckets[0].secondary_text.as_ref().unwrap();
        assert!(
            secondary.contains("$99.99"),
            "recorded cost wins over pricing lookup: secondary = {secondary}"
        );
    }

    #[test]
    fn format_tokens_picks_unit_by_magnitude() {
        assert_eq!(format_tokens(450), "450 tok");
        assert_eq!(format_tokens(12_400), "12.4k tok");
        assert_eq!(format_tokens(1_500_000), "1.5M tok");
    }
}
