CREATE TABLE IF NOT EXISTS subagent_runs (
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    launch_message_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
    harness TEXT NOT NULL,
    run_id TEXT NOT NULL,
    parent_run_id TEXT,
    assignment TEXT,
    status TEXT,
    summary TEXT,
    tool_use_id TEXT,
    report_kind TEXT,
    report_summary TEXT,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (session_id, harness, run_id)
);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_message ON subagent_runs(launch_message_id);
