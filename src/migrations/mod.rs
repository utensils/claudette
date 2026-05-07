/// A single schema migration.
///
/// Identity is the string `id` (typically `YYYYMMDDHHMMSS_snake_case`). Two
/// migrations authored on separate branches append entries to [`MIGRATIONS`]
/// with distinct IDs, so both run regardless of merge order.
pub struct Migration {
    pub id: &'static str,
    pub sql: &'static str,
    /// For migrations that existed before the `schema_migrations` redesign,
    /// the `PRAGMA user_version` this migration corresponds to. Used only
    /// during one-time backfill on pre-redesign databases. `None` for any
    /// migration added after the redesign.
    pub legacy_version: Option<i32>,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        id: "20250101000001_initial_repos_and_workspaces",
        sql: include_str!("20250101000001_initial_repos_and_workspaces.sql"),
        legacy_version: Some(1),
    },
    Migration {
        id: "20250101000002_chat_messages",
        sql: include_str!("20250101000002_chat_messages.sql"),
        legacy_version: Some(2),
    },
    Migration {
        id: "20250101000003_repository_icon_and_app_settings",
        sql: include_str!("20250101000003_repository_icon_and_app_settings.sql"),
        legacy_version: Some(3),
    },
    Migration {
        id: "20250101000004_terminal_tabs",
        sql: include_str!("20250101000004_terminal_tabs.sql"),
        legacy_version: Some(4),
    },
    Migration {
        id: "20250101000005_setup_script_column",
        sql: include_str!("20250101000005_setup_script_column.sql"),
        legacy_version: Some(5),
    },
    Migration {
        id: "20250101000006_custom_instructions_column",
        sql: include_str!("20250101000006_custom_instructions_column.sql"),
        legacy_version: Some(6),
    },
    Migration {
        id: "20250101000007_remote_connections",
        sql: include_str!("20250101000007_remote_connections.sql"),
        legacy_version: Some(7),
    },
    Migration {
        id: "20250101000008_slash_command_usage",
        sql: include_str!("20250101000008_slash_command_usage.sql"),
        legacy_version: Some(8),
    },
    Migration {
        id: "20250101000009_workspace_session_and_turn_count",
        sql: include_str!("20250101000009_workspace_session_and_turn_count.sql"),
        legacy_version: Some(9),
    },
    Migration {
        id: "20250101000010_conversation_checkpoints",
        sql: include_str!("20250101000010_conversation_checkpoints.sql"),
        legacy_version: Some(10),
    },
    Migration {
        id: "20250101000011_turn_tool_activities_and_message_count",
        sql: include_str!("20250101000011_turn_tool_activities_and_message_count.sql"),
        legacy_version: Some(11),
    },
    Migration {
        id: "20250101000012_repository_sort_order",
        sql: include_str!("20250101000012_repository_sort_order.sql"),
        legacy_version: Some(12),
    },
    Migration {
        id: "20250101000013_chat_message_thinking",
        sql: include_str!("20250101000013_chat_message_thinking.sql"),
        legacy_version: Some(13),
    },
    Migration {
        id: "20250101000014_branch_rename_preferences",
        sql: include_str!("20250101000014_branch_rename_preferences.sql"),
        legacy_version: Some(14),
    },
    Migration {
        id: "20250101000015_checkpoint_files",
        sql: include_str!("20250101000015_checkpoint_files.sql"),
        legacy_version: Some(15),
    },
    Migration {
        id: "20250101000016_attachments",
        sql: include_str!("20250101000016_attachments.sql"),
        legacy_version: Some(16),
    },
    Migration {
        id: "20250101000017_repository_mcp_servers",
        sql: include_str!("20250101000017_repository_mcp_servers.sql"),
        legacy_version: Some(17),
    },
    Migration {
        id: "20250101000018_repository_mcp_servers_enabled",
        sql: include_str!("20250101000018_repository_mcp_servers_enabled.sql"),
        legacy_version: Some(18),
    },
    Migration {
        id: "20250101000019_setup_script_auto_run",
        sql: include_str!("20250101000019_setup_script_auto_run.sql"),
        legacy_version: Some(19),
    },
    Migration {
        id: "20260420001941_chat_message_token_tracking",
        sql: include_str!("20260420001941_chat_message_token_tracking.sql"),
        legacy_version: Some(20),
    },
    Migration {
        id: "20260420185200_agent_metrics",
        sql: include_str!("20260420185200_agent_metrics.sql"),
        legacy_version: Some(21),
    },
    Migration {
        id: "20260420185201_agent_metrics_repo_indexes",
        sql: include_str!("20260420185201_agent_metrics_repo_indexes.sql"),
        legacy_version: Some(22),
    },
    Migration {
        id: "20260421192849_workspace_branch_auto_rename_claimed",
        sql: include_str!("20260421192849_workspace_branch_auto_rename_claimed.sql"),
        legacy_version: Some(23),
    },
    Migration {
        id: "20260421202734_deleted_workspace_summaries_tokens_and_chat_index",
        sql: include_str!("20260421202734_deleted_workspace_summaries_tokens_and_chat_index.sql"),
        legacy_version: Some(24),
    },
    Migration {
        id: "20260422000000_chat_sessions",
        sql: include_str!("20260422000000_chat_sessions.sql"),
        legacy_version: Some(25),
    },
    Migration {
        id: "20260423000001_repository_base_branch_and_default_remote",
        sql: include_str!("20260423000001_repository_base_branch_and_default_remote.sql"),
        legacy_version: None,
    },
    Migration {
        id: "20260423190000_scm_status_cache",
        sql: include_str!("20260423190000_scm_status_cache.sql"),
        legacy_version: None,
    },
    Migration {
        id: "20260424044912_pinned_commands",
        sql: include_str!("20260424044912_pinned_commands.sql"),
        legacy_version: None,
    },
    Migration {
        id: "20260425003451_attachments_origin_and_tool_use",
        sql: include_str!("20260425003451_attachments_origin_and_tool_use.sql"),
        legacy_version: None,
    },
    Migration {
        id: "20260430030147_pinned_prompts",
        sql: include_str!("20260430030147_pinned_prompts.sql"),
        legacy_version: None,
    },
    Migration {
        id: "20260505055527_agent_task_terminal_tabs",
        sql: include_str!("20260505055527_agent_task_terminal_tabs.sql"),
        legacy_version: None,
    },
    Migration {
        id: "20260505180023_workspace_sort_order",
        sql: include_str!("20260505180023_workspace_sort_order.sql"),
        legacy_version: None,
    },
    Migration {
        id: "20260505214219_turn_tool_activity_chronology",
        sql: include_str!("20260505214219_turn_tool_activity_chronology.sql"),
        legacy_version: None,
    },
    Migration {
        id: "20260506170933_heal_turn_tool_activity_agent_tool_calls_json",
        sql: include_str!("20260506170933_heal_turn_tool_activity_agent_tool_calls_json.sql"),
        legacy_version: None,
    },
    Migration {
        id: "20260506220711_workspace_manual_order_modes",
        sql: include_str!("20260506220711_workspace_manual_order_modes.sql"),
        legacy_version: None,
    },
    Migration {
        id: "20260506000001_archive_script_column",
        sql: include_str!("20260506000001_archive_script_column.sql"),
        legacy_version: None,
    },
];
