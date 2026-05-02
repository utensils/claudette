/// Developer-bundled system prompt injected into every agent session.
/// Edit `src/global-system-prompt.md` to update the content — changes take
/// effect after a rebuild (the string is compiled in via `include_str!`).
pub const GLOBAL_SYSTEM_PROMPT: &str = include_str!("global-system-prompt.md");
