mod attachment;
pub mod cesp;
mod chat_message;
mod chat_session;
mod checkpoint;
pub mod diff;
mod metrics;
mod pinned_prompt;
mod remote_connection;
mod repository;
mod repository_input;
mod terminal_tab;
mod workspace;

pub use attachment::{Attachment, AttachmentOrigin};
pub use cesp::{
    CespCategorySounds, CespManifest, CespSound, InstalledPack, InstalledPackMeta, RegistryIndex,
    RegistryPack,
};
pub use chat_message::{ChatMessage, ChatRole};
pub use chat_session::{AttentionKind, ChatSession, SessionStatus, validate_session_name};
pub use checkpoint::{CheckpointFile, CompletedTurnData, ConversationCheckpoint, TurnToolActivity};
pub use metrics::{
    AgentCommit, AgentSession, AnalyticsMetrics, DashboardMetrics, DeletedWorkspaceSummary,
    HeatmapCell, RepoLeaderRow, SessionDot, WorkspaceMetrics,
};
pub use pinned_prompt::PinnedPrompt;
pub use remote_connection::RemoteConnection;
pub use repository::Repository;
pub use repository_input::{
    RepositoryInputField, coerce_value as coerce_input_value, validate_input_key,
    validate_schema as validate_input_schema,
};
pub use terminal_tab::{TerminalTab, TerminalTabKind};
pub use workspace::{AgentStatus, Workspace, WorkspaceStatus};
