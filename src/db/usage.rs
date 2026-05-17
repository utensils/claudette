use rusqlite::Result;

use super::Database;
use crate::agent::CodexRateLimitSnapshot;
use crate::usage::local_aggregate::{self, LocalAggregate};

/// `app_settings` key holding the last Codex rate-limits snapshot as
/// JSON. Persisted so the composer's usage meter can render real plan
/// quotas the moment the user selects a Codex backend after an app
/// restart, instead of waiting for the next chat turn to repopulate
/// the in-memory cache.
const CODEX_RATE_LIMITS_KEY: &str = "codex:rate_limits:snapshot";

impl Database {
    /// Aggregate input/output/cost across every assistant message in
    /// the given chat session. See [`local_aggregate::session_totals`].
    pub fn usage_session_totals(&self, chat_session_id: &str) -> Result<LocalAggregate> {
        local_aggregate::session_totals(&self.conn, chat_session_id)
    }

    /// Aggregate input/output/cost across the workspace's assistant
    /// messages over the trailing 24 hours.
    /// See [`local_aggregate::workspace_24h_totals`].
    pub fn usage_workspace_24h_totals(&self, workspace_id: &str) -> Result<LocalAggregate> {
        local_aggregate::workspace_24h_totals(&self.conn, workspace_id)
    }

    /// Load the most recently persisted Codex rate-limits snapshot.
    /// Returns `Ok(None)` when nothing has ever been saved or the
    /// stored JSON fails to deserialize (e.g. after a snapshot-schema
    /// migration); callers fall back to local-aggregate until a fresh
    /// snapshot arrives.
    pub fn load_codex_rate_limits(&self) -> Result<Option<CodexRateLimitSnapshot>> {
        let raw = self.get_app_setting(CODEX_RATE_LIMITS_KEY)?;
        Ok(raw.and_then(|json| serde_json::from_str::<CodexRateLimitSnapshot>(&json).ok()))
    }

    /// Persist `snapshot` so a future app start can hydrate the
    /// in-memory cache before the user spawns any Codex session.
    /// Best-effort: serialization is infallible for the snapshot
    /// shape, so any error is a real SQLite write failure worth
    /// surfacing.
    pub fn save_codex_rate_limits(&self, snapshot: &CodexRateLimitSnapshot) -> Result<()> {
        let json = serde_json::to_string(snapshot).expect("CodexRateLimitSnapshot serializes");
        self.set_app_setting(CODEX_RATE_LIMITS_KEY, &json)
    }
}
