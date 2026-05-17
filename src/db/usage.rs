use rusqlite::Result;

use super::Database;
use crate::usage::local_aggregate::{self, LocalAggregate};

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
}
