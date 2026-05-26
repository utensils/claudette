//! Thin re-export shim — the implementation moved to
//! [`claudette::usage`] so the multi-provider dispatcher in the lib
//! crate can compose Anthropic OAuth with local-aggregate / Codex /
//! OpenRouter sources. Existing call sites (`crate::usage::...`) keep
//! working through this shim.

pub use claudette::usage::{
    ClaudeCodeUsage, UsageCacheEntry, get_usage, warm_user_agent_cache_sync,
};
