//! Tauri commands surfacing the **language-grammar** plugin kind to
//! the webview. Frontend uses these to discover languages contributed
//! by plugins (chat code blocks, diff viewer, file editor) and lazy-
//! load each grammar's TextMate JSON when a language first appears.
//!
//! Two commands:
//!   * `list_language_grammars` — returns the language + grammar
//!     metadata for every enabled `language-grammar` plugin. Frontend
//!     uses this to register Monaco languages and seed Shiki's
//!     known-language list.
//!   * `read_language_grammar` — returns the JSON body of one grammar.
//!     Frontend invokes this on first use of a language; the heavy
//!     payload (often hundreds of KB) is paid lazily, not at startup.
//!
//! Path-traversal protection lives in [`claudette::grammar_provider`]
//! — the manifest must declare the requested path AND the resolved
//! file must descend from the plugin directory.

use tauri::State;

use claudette::grammar_provider::{self, GrammarRegistry};

use crate::state::AppState;

#[tauri::command]
pub async fn list_language_grammars(state: State<'_, AppState>) -> Result<GrammarRegistry, String> {
    let registry = state.plugins.read().await;
    Ok(grammar_provider::list_registry(&registry))
}

#[tauri::command]
pub async fn read_language_grammar(
    plugin_name: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let registry = state.plugins.read().await;
    grammar_provider::read_grammar(&registry, &plugin_name, &path).map_err(|e| e.to_string())
}
