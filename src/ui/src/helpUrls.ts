// Single source of truth for the URLs the Help surfaces (sidebar Help
// menu, Settings → Help, macOS Help submenu) deep-link to. Kept here
// rather than inline so all surfaces stay aligned — the Rust side
// duplicates these as `const`s in `src-tauri/src/main.rs` (TS and Rust
// can't share a literal across languages; update both together when
// any of these change).

/** Documentation entry point — Getting Started page. */
export const HELP_DOCS_URL =
  "https://utensils.io/claudette/getting-started/installation/";

/** GitHub Releases tag URL. Append `CARGO_PKG_VERSION` to land on the
 * release notes for the running build (e.g. `${BASE}0.23.0`). */
export const HELP_RELEASE_URL_BASE =
  "https://github.com/utensils/claudette/releases/tag/v";

/** GitHub "new issue" entry point — bug reports / feature requests.
 * The `?template=bug_report.md` query param pre-selects the bug-report
 * template so users land in a structured form rather than a blank
 * issue body. */
export const HELP_ISSUES_URL =
  "https://github.com/utensils/claudette/issues/new?template=bug_report.md";
