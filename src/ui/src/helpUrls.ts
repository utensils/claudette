// Single source of truth for the URLs the Help surfaces (sidebar Help
// menu, Settings → Help, macOS Help submenu) deep-link to. Kept here
// rather than inline so all three surfaces stay aligned — the Rust side
// duplicates `HELP_DOCS_URL` as a `const` in `src-tauri/src/main.rs`
// (TS and Rust can't share a literal across languages).

export const HELP_DOCS_URL =
  "https://utensils.io/claudette/getting-started/installation/";
