// Single source of truth for the URLs the Help surfaces (sidebar Help
// menu, Settings → Help, macOS Help submenu) deep-link to. Kept here
// rather than inline so all surfaces stay aligned — the Rust side
// duplicates these as `const`s in `src-tauri/src/main.rs` (TS and Rust
// can't share a literal across languages; update both together when
// any of these change).

/** Documentation entry point — Getting Started page. */
export const HELP_DOCS_URL =
  "https://utensils.io/claudette/getting-started/installation/";

/** GitHub Releases tag URL prefix. Concatenate with `releaseTagFor(version)`
 * to land on the release notes for the running build. Stable releases use
 * `v<x.y.z>` tags; nightly builds all share the rolling `nightly` tag (the
 * versioned `0.25.0-dev.40.g<sha>` shape stamped by `.github/workflows/nightly.yml`
 * is not a real GitHub tag). */
export const HELP_RELEASE_URL_BASE =
  "https://github.com/utensils/claudette/releases/tag/";

/** Map a `CARGO_PKG_VERSION` string to the GitHub Release tag that actually
 * exists for that build. Nightly versions (which include `-dev.` per the
 * nightly workflow's `${NEXT_MINOR}-dev.${COMMITS}.g${SHORT}` format) all
 * resolve to `nightly`; everything else gets `v<version>`. */
export function releaseTagFor(version: string): string {
  return version.includes("-dev.") ? "nightly" : `v${version}`;
}

/** GitHub "new issue" entry point — bug reports / feature requests.
 * The `?template=bug_report.md` query param pre-selects the bug-report
 * template so users land in a structured form rather than a blank
 * issue body. */
export const HELP_ISSUES_URL =
  "https://github.com/utensils/claudette/issues/new?template=bug_report.md";
