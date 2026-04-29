//! Aggregation queries for the dashboard metrics widgets.
//!
//! Queries run against the v21+ schema: `agent_sessions`, `agent_commits`, and
//! `deleted_workspace_summaries` (introduced in migration v21; `repository_id`
//! indexes added in v22). Frozen summaries are merged with live rows so
//! lifetime stats survive workspace hard-deletes.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::Connection;

use crate::model::{
    AnalyticsMetrics, DashboardMetrics, HeatmapCell, RepoLeaderRow, SessionDot, WorkspaceMetrics,
};

/// 8 turn-count buckets: [1,2], [3,4], [5,8], [9,16], [17,32], [33,64], [65,128], [129+].
const TURN_BUCKET_UPPER_BOUNDS: [i64; 7] = [2, 4, 8, 16, 32, 64, 128];

pub fn dashboard_metrics(db_path: &Path) -> Result<DashboardMetrics, rusqlite::Error> {
    let conn = Connection::open(db_path)?;
    dashboard_metrics_with(&conn)
}

pub fn workspace_metrics_batch(
    db_path: &Path,
    ids: &[String],
) -> Result<HashMap<String, WorkspaceMetrics>, rusqlite::Error> {
    let conn = Connection::open(db_path)?;
    workspace_metrics_batch_with(&conn, ids)
}

pub fn analytics_metrics(db_path: &Path) -> Result<AnalyticsMetrics, rusqlite::Error> {
    let conn = Connection::open(db_path)?;
    analytics_metrics_with(&conn)
}

/// Scrape git for any new commits in `worktree_path` made since the agent
/// session started, and append them to `agent_commits`. Idempotent on
/// `(workspace_id, commit_hash)`.
///
/// Called from the chat command layer after every `Result` event (turn
/// boundary) so persistent sessions — whose `claude` subprocess stays alive
/// across turns and therefore never triggers `ProcessExited` — still get
/// their commits captured. Also called from the `ProcessExited` handler as
/// a final cleanup pass.
///
/// Failures are swallowed: this runs off the critical path and a git parse
/// failure should be logged rather than surfaced to the user. Returns the
/// number of commits scraped from git for this session — `INSERT OR IGNORE`
/// means some may already exist, so this is an upper bound on newly-inserted
/// rows. 0 on any error.
pub async fn capture_session_commits(
    db_path: &Path,
    workspace_id: &str,
    session_id: &str,
    repository_id: &str,
    worktree_path: &str,
) -> usize {
    if session_id.is_empty() {
        return 0;
    }
    let Ok(db) = crate::db::Database::open(db_path) else {
        return 0;
    };
    let Some(since) = db.get_agent_session_started_at(session_id).ok().flatten() else {
        return 0;
    };
    match crate::git::commits_since(worktree_path, &since).await {
        Ok(new_commits) if !new_commits.is_empty() => {
            let models: Vec<crate::model::AgentCommit> = new_commits
                .into_iter()
                .map(|c| crate::model::AgentCommit {
                    commit_hash: c.hash,
                    workspace_id: Some(workspace_id.to_string()),
                    repository_id: repository_id.to_string(),
                    session_id: Some(session_id.to_string()),
                    additions: c.additions,
                    deletions: c.deletions,
                    files_changed: c.files_changed,
                    committed_at: c.committed_at,
                })
                .collect();
            let count = models.len();
            match db.insert_agent_commits_batch(
                workspace_id,
                repository_id,
                Some(session_id),
                &models,
            ) {
                Ok(()) => count,
                Err(e) => {
                    eprintln!("[metrics] insert_agent_commits_batch failed: {e}");
                    0
                }
            }
        }
        Ok(_) => 0,
        Err(e) => {
            eprintln!("[metrics] commits_since failed: {e}");
            0
        }
    }
}

fn dashboard_metrics_with(conn: &Connection) -> Result<DashboardMetrics, rusqlite::Error> {
    let active_sessions: u32 = conn.query_row(
        "SELECT COUNT(*) FROM agent_sessions WHERE ended_at IS NULL",
        [],
        |row| row.get::<_, i64>(0).map(|n| n as u32),
    )?;

    // Range form on raw `started_at` keeps `idx_agent_sessions_started` usable.
    // `started_at` is stored as naive UTC (`datetime('now')` form), so comparing
    // it against UTC boundary timestamps is well-defined lexicographically.
    let sessions_today: u32 = conn.query_row(
        "SELECT COUNT(*) FROM agent_sessions
         WHERE started_at >= datetime('now', 'localtime', 'start of day', 'utc')
           AND started_at <  datetime('now', 'localtime', 'start of day', '+1 day', 'utc')",
        [],
        |row| row.get::<_, i64>(0).map(|n| n as u32),
    )?;

    let commits_today: u32 = conn.query_row(
        "SELECT COUNT(*) FROM agent_commits WHERE date(committed_at, 'localtime') = date('now', 'localtime')",
        [],
        |row| row.get::<_, i64>(0).map(|n| n as u32),
    )?;

    let (additions_7d, deletions_7d): (u64, u64) = conn.query_row(
        "SELECT COALESCE(SUM(additions), 0), COALESCE(SUM(deletions), 0)
         FROM agent_commits
         WHERE date(committed_at, 'localtime') >= date('now', 'localtime', '-6 days')",
        [],
        |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
    )?;

    let live_cost_30d: f64 = conn.query_row(
        "SELECT COALESCE(SUM(cost_usd), 0) FROM chat_messages
         WHERE created_at >= datetime('now', 'localtime', 'start of day', '-29 days', 'utc')",
        [],
        |row| row.get(0),
    )?;
    let deleted_cost_30d: f64 = conn.query_row(
        "SELECT COALESCE(SUM(total_cost_usd), 0) FROM deleted_workspace_summaries
         WHERE last_message_at IS NOT NULL
           AND last_message_at >= datetime('now', 'localtime', 'start of day', '-29 days', 'utc')",
        [],
        |row| row.get(0),
    )?;
    let cost_30d_usd = live_cost_30d + deleted_cost_30d;

    let success_rate_30d: f32 = conn
        .query_row(
            "SELECT AVG(CASE WHEN completed_ok THEN 1.0 ELSE 0.0 END)
             FROM agent_sessions
             WHERE ended_at IS NOT NULL
               AND started_at >= datetime('now', 'localtime', 'start of day', '-29 days', 'utc')",
            [],
            |row| row.get::<_, Option<f64>>(0),
        )?
        .unwrap_or(0.0) as f32;

    let (live_input_30d, live_output_30d): (u64, u64) = conn.query_row(
        "SELECT COALESCE(SUM(COALESCE(input_tokens, 0)), 0),
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0)
         FROM chat_messages
         WHERE created_at >= datetime('now', 'localtime', 'start of day', '-29 days', 'utc')",
        [],
        |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
    )?;
    let (deleted_input_30d, deleted_output_30d): (u64, u64) = conn.query_row(
        "SELECT COALESCE(SUM(total_input_tokens), 0),
                COALESCE(SUM(total_output_tokens), 0)
         FROM deleted_workspace_summaries
         WHERE last_message_at IS NOT NULL
           AND last_message_at >= datetime('now', 'localtime', 'start of day', '-29 days', 'utc')",
        [],
        |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
    )?;
    let total_input_tokens_30d = live_input_30d + deleted_input_30d;
    let total_output_tokens_30d = live_output_30d + deleted_output_30d;

    let (cache_reads_30d, cache_denom_30d): (u64, u64) = conn.query_row(
        "SELECT COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0),
                COALESCE(SUM(
                    COALESCE(input_tokens, 0)
                    + COALESCE(cache_creation_tokens, 0)
                    + COALESCE(cache_read_tokens, 0)
                ), 0)
         FROM chat_messages
         WHERE role = 'assistant'
           AND created_at >= datetime('now', 'localtime', 'start of day', '-29 days', 'utc')",
        [],
        |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
    )?;
    let cache_hit_rate_30d = if cache_denom_30d > 0 {
        cache_reads_30d as f32 / cache_denom_30d as f32
    } else {
        0.0
    };

    let commits_daily_14d = daily_counts_14d(conn)?;
    let cost_daily_30d = daily_cost_30d(conn)?;
    let tokens_daily_30d = daily_tokens_30d(conn)?;

    Ok(DashboardMetrics {
        active_sessions,
        sessions_today,
        commits_today,
        additions_7d,
        deletions_7d,
        cost_30d_usd,
        success_rate_30d,
        commits_daily_14d,
        cost_daily_30d,
        total_input_tokens_30d,
        total_output_tokens_30d,
        cache_hit_rate_30d,
        tokens_daily_30d,
    })
}

fn daily_counts_14d(conn: &Connection) -> Result<Vec<u32>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT date(committed_at, 'localtime') AS d, COUNT(*) FROM agent_commits
         WHERE date(committed_at, 'localtime') >= date('now', 'localtime', '-13 days')
         GROUP BY d",
    )?;
    let counts: HashMap<String, u32> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u32))
        })?
        .collect::<Result<_, _>>()?;
    fill_last_n_days(conn, 14, |d| counts.get(d).copied().unwrap_or(0))
}

fn daily_cost_30d(conn: &Connection) -> Result<Vec<f64>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT date(created_at, 'localtime') AS d, COALESCE(SUM(cost_usd), 0) FROM chat_messages
         WHERE created_at >= datetime('now', 'localtime', 'start of day', '-29 days', 'utc')
         GROUP BY d",
    )?;
    let costs: HashMap<String, f64> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })?
        .collect::<Result<_, _>>()?;
    fill_last_n_days(conn, 30, |d| costs.get(d).copied().unwrap_or(0.0))
}

fn daily_tokens_30d(conn: &Connection) -> Result<Vec<u64>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT date(created_at, 'localtime') AS d,
                COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0)
         FROM chat_messages
         WHERE created_at >= datetime('now', 'localtime', 'start of day', '-29 days', 'utc')
         GROUP BY d",
    )?;
    let tokens: HashMap<String, u64> = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
        })?
        .collect::<Result<_, _>>()?;
    fill_last_n_days(conn, 30, |d| tokens.get(d).copied().unwrap_or(0))
}

fn fill_last_n_days<T, F>(conn: &Connection, n: i64, mut f: F) -> Result<Vec<T>, rusqlite::Error>
where
    F: FnMut(&str) -> T,
{
    // Use SQLite's own date() with 'localtime' so day boundaries match the user's system timezone.
    let mut stmt = conn.prepare("SELECT date('now', 'localtime', ?1 || ' days')")?;
    let mut out = Vec::with_capacity(n as usize);
    for offset in (0..n).rev() {
        let day: String = stmt.query_row([format!("-{offset}")], |row| row.get(0))?;
        out.push(f(&day));
    }
    Ok(out)
}

fn workspace_metrics_batch_with(
    conn: &Connection,
    ids: &[String],
) -> Result<HashMap<String, WorkspaceMetrics>, rusqlite::Error> {
    // Pre-seed with zero rows so missing workspaces still appear in the result —
    // matches the pre-batch contract where any requested id always returns a
    // WorkspaceMetrics, even when no commits/sessions exist.
    let mut result: HashMap<String, WorkspaceMetrics> = ids
        .iter()
        .map(|id| (id.clone(), WorkspaceMetrics::default()))
        .collect();
    if ids.is_empty() {
        return Ok(result);
    }

    // Build a single `?,?,?` placeholder string so the IN-clause batches every
    // workspace into one query instead of one-per-id.
    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let id_params: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();

    let commit_sql = format!(
        "SELECT workspace_id,
                COUNT(*),
                COALESCE(SUM(additions), 0),
                COALESCE(SUM(deletions), 0)
         FROM agent_commits
         WHERE workspace_id IN ({placeholders})
         GROUP BY workspace_id"
    );
    let mut commit_stmt = conn.prepare(&commit_sql)?;
    let commit_rows = commit_stmt.query_map(id_params.as_slice(), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)? as u32,
            row.get::<_, i64>(2)? as u64,
            row.get::<_, i64>(3)? as u64,
        ))
    })?;
    for row in commit_rows {
        let (id, commits_count, additions, deletions) = row?;
        if let Some(slot) = result.get_mut(&id) {
            slot.commits_count = commits_count;
            slot.additions = additions;
            slot.deletions = deletions;
        }
    }

    // Latest session per workspace — one pass over agent_sessions instead of
    // one query per id. `started_at` has 1-second resolution, so the inner
    // `ORDER BY started_at DESC, rowid DESC` disambiguates same-second ties
    // deterministically (tie-break wins the later-inserted row).
    let turn_sql = format!(
        "SELECT s.workspace_id, s.turn_count
         FROM agent_sessions s
         WHERE s.workspace_id IN ({placeholders})
           AND s.rowid = (
               SELECT s2.rowid FROM agent_sessions s2
               WHERE s2.workspace_id = s.workspace_id
               ORDER BY s2.started_at DESC, s2.rowid DESC
               LIMIT 1
           )"
    );
    let mut turn_stmt = conn.prepare(&turn_sql)?;
    let turn_rows = turn_stmt.query_map(id_params.as_slice(), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u32))
    })?;
    for row in turn_rows {
        let (id, turns) = row?;
        if let Some(slot) = result.get_mut(&id) {
            slot.latest_session_turns = turns;
        }
    }

    let token_sql = format!(
        "SELECT workspace_id,
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0),
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0)
         FROM chat_messages
         WHERE workspace_id IN ({placeholders})
         GROUP BY workspace_id"
    );
    let mut token_stmt = conn.prepare(&token_sql)?;
    let token_rows = token_stmt.query_map(id_params.as_slice(), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)? as u64,
            row.get::<_, i64>(2)? as u64,
        ))
    })?;
    for row in token_rows {
        let (id, input_tokens, output_tokens) = row?;
        if let Some(slot) = result.get_mut(&id) {
            slot.total_input_tokens = input_tokens;
            slot.total_output_tokens = output_tokens;
        }
    }

    Ok(result)
}

fn analytics_metrics_with(conn: &Connection) -> Result<AnalyticsMetrics, rusqlite::Error> {
    Ok(AnalyticsMetrics {
        repo_leaderboard: repo_leaderboard(conn)?,
        heatmap: heatmap(conn)?,
        turn_histogram: turn_histogram(conn)?,
        top_slash_commands: top_slash_commands(conn)?,
        recent_sessions_24h: recent_sessions_24h(conn)?,
    })
}

fn repo_leaderboard(conn: &Connection) -> Result<Vec<RepoLeaderRow>, rusqlite::Error> {
    let sql = "
        WITH repo_ids AS (
            SELECT DISTINCT repository_id FROM agent_sessions
            UNION SELECT DISTINCT repository_id FROM agent_commits
            UNION SELECT DISTINCT repository_id FROM deleted_workspace_summaries
            UNION SELECT DISTINCT w.repository_id FROM chat_messages m JOIN workspaces w ON w.id = m.workspace_id
        ),
        chat_agg AS (
            SELECT w.repository_id,
                   COALESCE(SUM(m.cost_usd), 0) AS total_cost_usd,
                   COALESCE(SUM(COALESCE(m.input_tokens, 0)), 0) AS total_input_tokens,
                   COALESCE(SUM(COALESCE(m.output_tokens, 0)), 0) AS total_output_tokens
            FROM chat_messages m
            JOIN workspaces w ON w.id = m.workspace_id
            GROUP BY w.repository_id
        ),
        live AS (
            SELECT r.repository_id,
                (SELECT COUNT(*) FROM agent_sessions s WHERE s.repository_id = r.repository_id) AS sessions,
                (SELECT COUNT(*) FROM agent_commits  c WHERE c.repository_id = r.repository_id) AS commits,
                COALESCE(ca.total_cost_usd, 0) AS total_cost_usd,
                COALESCE(ca.total_input_tokens, 0) AS total_input_tokens,
                COALESCE(ca.total_output_tokens, 0) AS total_output_tokens
            FROM repo_ids r
            LEFT JOIN chat_agg ca ON ca.repository_id = r.repository_id
        ),
        deleted AS (
            SELECT repository_id,
                COALESCE(SUM(sessions_started), 0) AS sessions,
                COALESCE(SUM(commits_made),    0) AS commits,
                COALESCE(SUM(total_cost_usd),  0) AS total_cost_usd,
                COALESCE(SUM(total_input_tokens),  0) AS total_input_tokens,
                COALESCE(SUM(total_output_tokens), 0) AS total_output_tokens
            FROM deleted_workspace_summaries
            GROUP BY repository_id
        ),
        merged AS (
            SELECT repository_id, sessions, commits, total_cost_usd,
                   total_input_tokens, total_output_tokens FROM live
            UNION ALL
            SELECT repository_id, sessions, commits, total_cost_usd,
                   total_input_tokens, total_output_tokens FROM deleted
        )
        SELECT m.repository_id,
               CAST(COALESCE(SUM(m.sessions), 0) AS INTEGER) AS sessions,
               CAST(COALESCE(SUM(m.commits),  0) AS INTEGER) AS commits,
               COALESCE(SUM(m.total_cost_usd), 0) AS total_cost_usd,
               CAST(COALESCE(SUM(m.total_input_tokens),  0) AS INTEGER) AS total_input_tokens,
               CAST(COALESCE(SUM(m.total_output_tokens), 0) AS INTEGER) AS total_output_tokens
        FROM merged m
        INNER JOIN repositories r ON r.id = m.repository_id
        GROUP BY m.repository_id
        ORDER BY sessions DESC, commits DESC, total_cost_usd DESC
        LIMIT 5
    ";
    let mut stmt = conn.prepare(sql)?;
    stmt.query_map([], |row| {
        Ok(RepoLeaderRow {
            repository_id: row.get(0)?,
            sessions: row.get::<_, i64>(1)? as u32,
            commits: row.get::<_, i64>(2)? as u32,
            total_cost_usd: row.get(3)?,
            total_input_tokens: row.get::<_, i64>(4)? as u64,
            total_output_tokens: row.get::<_, i64>(5)? as u64,
        })
    })?
    .collect()
}

fn heatmap(conn: &Connection) -> Result<Vec<HeatmapCell>, rusqlite::Error> {
    // 13 weeks × 7 days = 91 cells. Week index = days-ago / 7 (0 = most recent).
    let mut stmt = conn.prepare(
        "SELECT CAST(strftime('%w', started_at, 'localtime') AS INTEGER) AS dow,
                CAST((julianday(date('now', 'localtime')) - julianday(date(started_at, 'localtime'))) / 7 AS INTEGER) AS week,
                COUNT(*) AS c
         FROM agent_sessions
         WHERE started_at >= datetime('now', 'localtime', 'start of day', '-90 days', 'utc')
         GROUP BY dow, week",
    )?;
    let mut grid = [[0u32; 13]; 7];
    for row in stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)? as u32,
        ))
    })? {
        let (dow, week, count) = row?;
        if (0..7).contains(&dow) && (0..13).contains(&week) {
            grid[dow as usize][week as usize] = count;
        }
    }
    let mut out = Vec::with_capacity(91);
    for dow in 0u8..7 {
        for week in 0u8..13 {
            out.push(HeatmapCell {
                dow,
                week,
                count: grid[dow as usize][week as usize],
            });
        }
    }
    Ok(out)
}

fn turn_histogram(conn: &Connection) -> Result<Vec<u32>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT turn_count FROM agent_sessions WHERE turn_count > 0")?;
    let mut buckets = vec![0u32; 8];
    for row in stmt.query_map([], |row| row.get::<_, i64>(0))? {
        let count = row?;
        let idx = TURN_BUCKET_UPPER_BOUNDS
            .iter()
            .position(|&upper| count <= upper)
            .unwrap_or(7);
        buckets[idx] += 1;
    }
    Ok(buckets)
}

fn top_slash_commands(conn: &Connection) -> Result<Vec<(String, u32)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT command_name, CAST(SUM(use_count) AS INTEGER) AS total
         FROM slash_command_usage
         GROUP BY command_name
         ORDER BY total DESC
         LIMIT 5",
    )?;
    stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u32))
    })?
    .collect()
}

fn recent_sessions_24h(conn: &Connection) -> Result<Vec<SessionDot>, rusqlite::Error> {
    // workspace_id is nullable in the schema; cascade-delete usually drops the
    // session row, but a defensive filter keeps empty IDs out of the timeline
    // so the click-to-select handler never receives "".
    //
    // `ended_at` is formatted as RFC3339 UTC (`YYYY-MM-DDTHH:MM:SSZ`) rather
    // than the raw `datetime('now')` output so V8's `Date.parse` on the
    // frontend interprets it as UTC. The naive SQLite form is parsed as
    // local time by V8, which would shift every dot by the user's UTC
    // offset — mirroring the backend's `ensure_utc_tz` treatment of
    // SQLite timestamps elsewhere.
    let mut stmt = conn.prepare(
        "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ended_at), completed_ok, workspace_id
         FROM agent_sessions
         WHERE ended_at IS NOT NULL
           AND workspace_id IS NOT NULL
           AND ended_at >= datetime('now','-24 hours')
         ORDER BY ended_at DESC",
    )?;
    stmt.query_map([], |row| {
        Ok(SessionDot {
            ended_at: row.get(0)?,
            completed_ok: row.get::<_, i64>(1)? != 0,
            workspace_id: row.get(2)?,
        })
    })?
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn setup_db() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claudette.db");
        let _db = Database::open(&path).unwrap();
        (dir, path)
    }

    fn insert_repo(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO repositories (id, path, name, path_slug) VALUES (?1, ?2, ?3, ?3)",
            [id, &format!("/tmp/{id}"), id],
        )
        .unwrap();
    }

    fn insert_workspace(conn: &Connection, ws_id: &str, repo_id: &str) {
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, name, branch_name)
             VALUES (?1, ?2, ?1, ?1)",
            [ws_id, repo_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_sessions (id, workspace_id, name, sort_order, status)
             VALUES (?1 || '-sess', ?1, 'Main', 0, 'active')",
            [ws_id],
        )
        .unwrap();
    }

    fn exec(conn: &Connection, sql: &str) {
        conn.execute_batch(sql).unwrap();
    }

    #[test]
    fn dashboard_empty_db_returns_zeros_with_correct_lengths() {
        let (_dir, path) = setup_db();
        let m = dashboard_metrics(&path).unwrap();
        assert_eq!(m.active_sessions, 0);
        assert_eq!(m.sessions_today, 0);
        assert_eq!(m.commits_today, 0);
        assert_eq!(m.additions_7d, 0);
        assert_eq!(m.deletions_7d, 0);
        assert_eq!(m.cost_30d_usd, 0.0);
        assert_eq!(m.success_rate_30d, 0.0);
        assert_eq!(m.commits_daily_14d.len(), 14);
        assert!(m.commits_daily_14d.iter().all(|&n| n == 0));
        assert_eq!(m.cost_daily_30d.len(), 30);
        assert!(m.cost_daily_30d.iter().all(|&n| n == 0.0));
        assert_eq!(m.total_input_tokens_30d, 0);
        assert_eq!(m.total_output_tokens_30d, 0);
        assert_eq!(m.cache_hit_rate_30d, 0.0);
        assert_eq!(m.tokens_daily_30d.len(), 30);
        assert!(m.tokens_daily_30d.iter().all(|&n| n == 0));
    }

    #[test]
    fn dashboard_with_active_and_today_sessions_and_commits() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "repo1");
        insert_workspace(&conn, "ws1", "repo1");
        exec(
            &conn,
            "INSERT INTO agent_sessions (id, workspace_id, repository_id, started_at, last_message_at, turn_count)
             VALUES ('s1', 'ws1', 'repo1', datetime('now'), datetime('now'), 3)",
        );
        exec(
            &conn,
            "INSERT INTO agent_commits (commit_hash, workspace_id, repository_id, additions, deletions, files_changed, committed_at)
             VALUES ('abc', 'ws1', 'repo1', 10, 2, 1, datetime('now'))",
        );

        let m = dashboard_metrics(&path).unwrap();
        assert_eq!(m.active_sessions, 1);
        assert_eq!(m.sessions_today, 1);
        assert_eq!(m.commits_today, 1);
        assert_eq!(m.additions_7d, 10);
        assert_eq!(m.deletions_7d, 2);
        assert_eq!(*m.commits_daily_14d.last().unwrap(), 1);
        assert_eq!(m.commits_daily_14d[..13].iter().sum::<u32>(), 0);
    }

    #[test]
    fn dashboard_success_rate_computes_avg_of_completed_ok() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "r");
        for (id, ok) in [("s1", 1), ("s2", 1), ("s3", 0)] {
            conn.execute(
                "INSERT INTO agent_sessions (id, repository_id, started_at, last_message_at, ended_at, completed_ok)
                 VALUES (?1, 'r', datetime('now','-1 days'), datetime('now','-1 days'), datetime('now'), ?2)",
                rusqlite::params![id, ok],
            ).unwrap();
        }
        // An un-ended session must be ignored.
        exec(
            &conn,
            "INSERT INTO agent_sessions (id, repository_id, started_at, last_message_at, completed_ok)
             VALUES ('s4', 'r', datetime('now'), datetime('now'), 0)",
        );
        let m = dashboard_metrics(&path).unwrap();
        assert!((m.success_rate_30d - 2.0 / 3.0).abs() < 1e-5);
    }

    #[test]
    fn dashboard_cost_merges_live_messages_with_deleted_summaries() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "r");
        insert_workspace(&conn, "ws1", "r");
        exec(
            &conn,
            "INSERT INTO chat_messages (id, workspace_id, chat_session_id, role, content, cost_usd)
             VALUES ('m1', 'ws1', 'ws1-sess', 'assistant', 'hi', 1.25)",
        );
        exec(
            &conn,
            "INSERT INTO deleted_workspace_summaries (id, workspace_id, workspace_name, repository_id, workspace_created_at, total_cost_usd, last_message_at)
             VALUES ('d1', 'wsdel', 'dead', 'r', datetime('now','-10 days'), 3.75, datetime('now','-5 days'))",
        );
        let m = dashboard_metrics(&path).unwrap();
        assert!((m.cost_30d_usd - 5.0).abs() < 1e-6);
    }

    #[test]
    fn workspace_metrics_batch_aggregates_per_workspace() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "r");
        insert_workspace(&conn, "ws1", "r");
        insert_workspace(&conn, "ws2", "r");
        exec(
            &conn,
            "INSERT INTO agent_commits (commit_hash, workspace_id, repository_id, additions, deletions, files_changed, committed_at)
             VALUES ('c1', 'ws1', 'r', 10, 2, 1, datetime('now')),
                    ('c2', 'ws1', 'r',  5, 1, 1, datetime('now')),
                    ('c3', 'ws2', 'r',  3, 0, 1, datetime('now'))",
        );
        exec(
            &conn,
            "INSERT INTO agent_sessions (id, workspace_id, repository_id, started_at, last_message_at, turn_count)
             VALUES ('s_old', 'ws1', 'r', datetime('now','-2 days'), datetime('now','-2 days'), 3),
                    ('s_new', 'ws1', 'r', datetime('now'),           datetime('now'),           7)",
        );

        exec(
            &conn,
            "INSERT INTO chat_messages (id, workspace_id, chat_session_id, role, content, input_tokens, output_tokens)
             VALUES ('m1', 'ws1', 'ws1-sess', 'assistant', 'hi', 5000, 1000),
                    ('m2', 'ws1', 'ws1-sess', 'assistant', 'ok', 3000, 500),
                    ('m3', 'ws2', 'ws2-sess', 'assistant', 'yo', 2000, NULL)",
        );

        let ids = vec!["ws1".to_string(), "ws2".to_string(), "missing".to_string()];
        let m = workspace_metrics_batch(&path, &ids).unwrap();

        let ws1 = m.get("ws1").unwrap();
        assert_eq!(ws1.commits_count, 2);
        assert_eq!(ws1.additions, 15);
        assert_eq!(ws1.deletions, 3);
        assert_eq!(ws1.latest_session_turns, 7);
        assert_eq!(ws1.total_input_tokens, 8000);
        assert_eq!(ws1.total_output_tokens, 1500);

        let ws2 = m.get("ws2").unwrap();
        assert_eq!(ws2.commits_count, 1);
        assert_eq!(ws2.latest_session_turns, 0);
        assert_eq!(ws2.total_input_tokens, 2000);
        assert_eq!(ws2.total_output_tokens, 0);

        let missing = m.get("missing").unwrap();
        assert_eq!(missing.commits_count, 0);
        assert_eq!(missing.latest_session_turns, 0);
        assert_eq!(missing.total_input_tokens, 0);
        assert_eq!(missing.total_output_tokens, 0);
    }

    #[test]
    fn analytics_leaderboard_merges_live_and_deleted_by_repo() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "repoA");
        insert_repo(&conn, "repoB");
        insert_workspace(&conn, "wsA", "repoA");
        exec(
            &conn,
            "INSERT INTO agent_sessions (id, workspace_id, repository_id, started_at, last_message_at)
             VALUES ('s1', 'wsA', 'repoA', datetime('now'), datetime('now')),
                    ('s2', 'wsA', 'repoA', datetime('now'), datetime('now'))",
        );
        exec(
            &conn,
            "INSERT INTO agent_commits (commit_hash, workspace_id, repository_id, committed_at)
             VALUES ('c1', 'wsA', 'repoA', datetime('now'))",
        );
        exec(
            &conn,
            "INSERT INTO chat_messages (id, workspace_id, chat_session_id, role, content, cost_usd, input_tokens, output_tokens)
             VALUES ('m1', 'wsA', 'wsA-sess', 'assistant', 'hi', 2.0, 5000, 1000)",
        );
        exec(
            &conn,
            "INSERT INTO deleted_workspace_summaries (id, workspace_id, workspace_name, repository_id, workspace_created_at, sessions_started, commits_made, total_cost_usd, total_input_tokens, total_output_tokens)
             VALUES ('d1', 'wsGone', 'gone', 'repoA', datetime('now'), 3, 2, 4.0, 20000, 4000)",
        );
        exec(
            &conn,
            "INSERT INTO deleted_workspace_summaries (id, workspace_id, workspace_name, repository_id, workspace_created_at, sessions_started, commits_made, total_cost_usd, total_input_tokens, total_output_tokens)
             VALUES ('d2', 'wsOld', 'old', 'repoB', datetime('now'), 1, 0, 0.5, 3000, 500)",
        );

        let a = analytics_metrics(&path).unwrap();
        let a_row = a
            .repo_leaderboard
            .iter()
            .find(|r| r.repository_id == "repoA")
            .unwrap();
        assert_eq!(a_row.sessions, 5);
        assert_eq!(a_row.commits, 3);
        assert!((a_row.total_cost_usd - 6.0).abs() < 1e-6);
        assert_eq!(a_row.total_input_tokens, 25000);
        assert_eq!(a_row.total_output_tokens, 5000);

        let b_row = a
            .repo_leaderboard
            .iter()
            .find(|r| r.repository_id == "repoB")
            .unwrap();
        assert_eq!(b_row.sessions, 1);
        assert_eq!(b_row.commits, 0);
        assert!((b_row.total_cost_usd - 0.5).abs() < 1e-6);
        assert_eq!(b_row.total_input_tokens, 3000);
        assert_eq!(b_row.total_output_tokens, 500);
    }

    #[test]
    fn analytics_leaderboard_excludes_deleted_repos() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "repoA");
        insert_workspace(&conn, "wsA", "repoA");
        exec(
            &conn,
            "INSERT INTO agent_sessions (id, workspace_id, repository_id, started_at, last_message_at)
             VALUES ('s1', 'wsA', 'repoA', datetime('now'), datetime('now'))",
        );
        exec(
            &conn,
            "INSERT INTO deleted_workspace_summaries (id, workspace_id, workspace_name, repository_id, workspace_created_at, sessions_started, commits_made, total_cost_usd, total_input_tokens, total_output_tokens)
             VALUES ('d1', 'wsGhost', 'ghost', 'repoC', datetime('now'), 10, 5, 50.0, 100000, 20000)",
        );

        let a = analytics_metrics(&path).unwrap();
        assert_eq!(a.repo_leaderboard.len(), 1);
        assert_eq!(a.repo_leaderboard[0].repository_id, "repoA");
    }

    #[test]
    fn analytics_heatmap_has_91_cells_and_buckets_by_week() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "r");
        insert_workspace(&conn, "w", "r");
        exec(
            &conn,
            "INSERT INTO agent_sessions (id, workspace_id, repository_id, started_at, last_message_at)
             VALUES ('s1', 'w', 'r', datetime('now'),           datetime('now')),
                    ('s2', 'w', 'r', datetime('now'),           datetime('now')),
                    ('s3', 'w', 'r', datetime('now','-10 days'), datetime('now','-10 days'))",
        );
        let a = analytics_metrics(&path).unwrap();
        assert_eq!(a.heatmap.len(), 91);
        let total: u32 = a.heatmap.iter().map(|c| c.count).sum();
        assert_eq!(total, 3);
        let older: u32 = a
            .heatmap
            .iter()
            .filter(|c| c.week > 0)
            .map(|c| c.count)
            .sum();
        assert_eq!(older, 1);
    }

    #[test]
    fn analytics_turn_histogram_buckets_correctly() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "r");
        for (id, turns) in [
            ("s1", 1),
            ("s2", 3),
            ("s3", 5),
            ("s4", 9),
            ("s5", 17),
            ("s6", 33),
            ("s7", 65),
            ("s8", 200),
        ] {
            conn.execute(
                "INSERT INTO agent_sessions (id, repository_id, started_at, last_message_at, turn_count)
                 VALUES (?1, 'r', datetime('now'), datetime('now'), ?2)",
                rusqlite::params![id, turns],
            ).unwrap();
        }
        // Zero-turn sessions should be excluded from the histogram.
        exec(
            &conn,
            "INSERT INTO agent_sessions (id, repository_id, started_at, last_message_at, turn_count)
             VALUES ('s0', 'r', datetime('now'), datetime('now'), 0)",
        );
        let a = analytics_metrics(&path).unwrap();
        assert_eq!(a.turn_histogram, vec![1, 1, 1, 1, 1, 1, 1, 1]);
    }

    #[test]
    fn analytics_top_slash_commands_sums_use_count() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "r");
        insert_workspace(&conn, "ws1", "r");
        insert_workspace(&conn, "ws2", "r");
        exec(
            &conn,
            "INSERT INTO slash_command_usage (workspace_id, command_name, use_count)
             VALUES ('ws1', 'commit', 3),
                    ('ws2', 'commit', 2),
                    ('ws1', 'review', 4)",
        );
        let a = analytics_metrics(&path).unwrap();
        assert_eq!(
            a.top_slash_commands,
            vec![("commit".to_string(), 5), ("review".to_string(), 4)]
        );
    }

    #[test]
    fn analytics_recent_sessions_24h_filters_and_orders() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "r");
        insert_workspace(&conn, "w", "r");
        exec(
            &conn,
            "INSERT INTO agent_sessions (id, workspace_id, repository_id, started_at, last_message_at, ended_at, completed_ok)
             VALUES ('old',   'w', 'r', datetime('now','-2 days'),  datetime('now','-2 days'),  datetime('now','-2 days'),     1),
                    ('fresh', 'w', 'r', datetime('now','-1 hours'), datetime('now','-1 hours'), datetime('now','-30 minutes'), 1),
                    ('fail',  'w', 'r', datetime('now','-3 hours'), datetime('now','-3 hours'), datetime('now','-2 hours'),    0)",
        );
        let a = analytics_metrics(&path).unwrap();
        assert_eq!(a.recent_sessions_24h.len(), 2);
        assert_eq!(a.recent_sessions_24h[0].workspace_id, "w");
        assert!(a.recent_sessions_24h[0].completed_ok);
        assert!(!a.recent_sessions_24h[1].completed_ok);
    }

    #[test]
    fn dashboard_tokens_merges_live_and_deleted() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "r");
        insert_workspace(&conn, "ws1", "r");
        exec(
            &conn,
            "INSERT INTO chat_messages (id, workspace_id, chat_session_id, role, content, input_tokens, output_tokens)
             VALUES ('m1', 'ws1', 'ws1-sess', 'assistant', 'hi', 10000, 2000),
                    ('m2', 'ws1', 'ws1-sess', 'assistant', 'bye', 8000, 1500)",
        );
        exec(
            &conn,
            "INSERT INTO deleted_workspace_summaries (id, workspace_id, workspace_name, repository_id, workspace_created_at, total_input_tokens, total_output_tokens, last_message_at)
             VALUES ('d1', 'wsDel', 'dead', 'r', datetime('now','-10 days'), 50000, 7000, datetime('now','-5 days'))",
        );
        let m = dashboard_metrics(&path).unwrap();
        assert_eq!(m.total_input_tokens_30d, 68000);
        assert_eq!(m.total_output_tokens_30d, 10500);
    }

    #[test]
    fn dashboard_cache_hit_rate_computes_correctly() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "r");
        insert_workspace(&conn, "ws1", "r");
        exec(
            &conn,
            "INSERT INTO chat_messages (id, workspace_id, chat_session_id, role, content, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
             VALUES ('m1', 'ws1', 'ws1-sess', 'assistant', 'hi', 1000, 500, 9000, 0)",
        );
        let m = dashboard_metrics(&path).unwrap();
        // cache_reads=9000, denom=1000+0+9000=10000, rate=0.9
        assert!((m.cache_hit_rate_30d - 0.9).abs() < 1e-5);
    }

    #[test]
    fn dashboard_cache_hit_rate_excludes_system_messages() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "r");
        insert_workspace(&conn, "ws1", "r");
        exec(
            &conn,
            "INSERT INTO chat_messages (id, workspace_id, chat_session_id, role, content, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
             VALUES ('m1', 'ws1', 'ws1-sess', 'assistant', 'hi', 2000, 500, 8000, 0),
                    ('m2', 'ws1', 'ws1-sess', 'system', 'COMPACTION:auto:200000:80000:5000', NULL, NULL, 80000, NULL)",
        );
        let m = dashboard_metrics(&path).unwrap();
        // Only the assistant message counts: cache_reads=8000, denom=2000+0+8000=10000
        assert!((m.cache_hit_rate_30d - 0.8).abs() < 1e-5);
    }

    #[test]
    fn dashboard_tokens_daily_30d_has_30_entries() {
        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "r");
        insert_workspace(&conn, "ws1", "r");
        exec(
            &conn,
            "INSERT INTO chat_messages (id, workspace_id, chat_session_id, role, content, input_tokens, output_tokens)
             VALUES ('m1', 'ws1', 'ws1-sess', 'assistant', 'hi', 5000, 1000)",
        );
        let m = dashboard_metrics(&path).unwrap();
        assert_eq!(m.tokens_daily_30d.len(), 30);
        assert_eq!(*m.tokens_daily_30d.last().unwrap(), 6000);
        assert_eq!(m.tokens_daily_30d[..29].iter().sum::<u64>(), 0);
    }

    #[cfg(unix)]
    unsafe extern "C" {
        fn tzset();
    }

    // Serializes tests that mutate process-global TZ. Matches the pattern
    // used in src/mcp.rs and src/plugin.rs for other env-mutating tests so
    // a single shared lock would be straightforward to introduce later if
    // multiple modules need it.
    #[cfg(unix)]
    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(unix)]
    struct TzEnvGuard {
        prev: Option<std::ffi::OsString>,
    }

    #[cfg(unix)]
    impl TzEnvGuard {
        fn override_with(tz: &str) -> Self {
            let prev = std::env::var_os("TZ");
            unsafe {
                std::env::set_var("TZ", tz);
                tzset();
            }
            Self { prev }
        }
    }

    #[cfg(unix)]
    impl Drop for TzEnvGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.prev {
                    Some(v) => std::env::set_var("TZ", v),
                    None => std::env::remove_var("TZ"),
                }
                tzset();
            }
        }
    }

    // Regression guard for the local-timezone fix. CI runs in UTC, where
    // `'localtime'` is a no-op, so without this test the rest of the suite
    // can't tell whether the modifier is present at all. Forces TZ to a
    // non-zero offset zone, inserts a commit at 23:30 local on each of the
    // last 14 days (a time-of-day past midnight UTC under Pacific time, so
    // UTC-only bucketing would shift each row into the next UTC day and
    // miss its slot), and asserts every slot of the 14-day sparkline gets
    // exactly one commit.
    #[test]
    #[cfg(unix)]
    fn dashboard_buckets_commits_by_local_date_under_non_utc_tz() {
        let _env_lock = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let _tz_guard = TzEnvGuard::override_with("America/Los_Angeles");

        // Confirm the TZ override actually produced a non-UTC offset for
        // SQLite. On a host without zoneinfo/tzdata, `tzset()` silently
        // falls back to UTC and `'localtime'` becomes a no-op — under that
        // fallback the assertions below would still pass, hiding a real
        // regression. SQLite has no `%z` strftime token, so compare the
        // julianday of `'now'` against `'now','localtime'`: a non-zero
        // delta (in days) indicates a real local offset. Fail loudly if
        // the override didn't take effect.
        let tz_probe = Connection::open_in_memory().unwrap();
        let offset_hours: f64 = tz_probe
            .query_row(
                "SELECT (julianday('now', 'localtime') - julianday('now')) * 24.0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            offset_hours.abs() > 0.5,
            "TZ=America/Los_Angeles did not produce a non-UTC local offset for SQLite \
             (got {offset_hours:.2}h); this system may be missing tzdata/zoneinfo, \
             so the regression test would be a no-op"
        );

        let (_dir, path) = setup_db();
        let conn = Connection::open(&path).unwrap();
        insert_repo(&conn, "r");
        insert_workspace(&conn, "ws", "r");

        for i in 0..14 {
            let sql = format!(
                "INSERT INTO agent_commits (commit_hash, workspace_id, repository_id, additions, deletions, files_changed, committed_at)
                 VALUES ('c{i}', 'ws', 'r', 0, 0, 0,
                         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', 'localtime', 'start of day', '-{i} days', '+23 hours', '+30 minutes', 'utc'))"
            );
            conn.execute(&sql, []).unwrap();
        }

        let m = dashboard_metrics(&path).unwrap();
        assert_eq!(
            m.commits_daily_14d,
            vec![1; 14],
            "expected one commit per local-day slot under TZ=America/Los_Angeles, got {:?}",
            m.commits_daily_14d
        );
    }
}
