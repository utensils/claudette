// Cross-app webview hijack guard runs as an inline <script> in index.html
// BEFORE any module loads — ES imports hoist over top-level statements, so
// putting the check here would let i18n + grammar bootstrap run first
// against a possibly-foreign DOM. The inline check is the source of truth;
// the bootIdentityGuard module is exported only for tests.
//
// If the inline guard rendered an error, `window.__claudetteHijackBlocked`
// is set; we abort early so no further side effects (state, network calls)
// touch the foreign bundle's environment.
if ((window as unknown as { __claudetteHijackBlocked?: boolean }).__claudetteHijackBlocked) {
  throw new Error("Claudette hijack guard refused to mount React.");
}

// Frontend → backend log bridge — imported FIRST so the module's
// load-time side effect arms `window.error` and `unhandledrejection`
// listeners before any other module in this file's import graph
// evaluates. ES module static imports run before top-level
// statements, so a crash inside `./i18n` / `App` / grammar / Shiki
// bootstrap would otherwise happen before any explicit
// `installFrontendLogBridge()` call here could register handlers.
// See the comment block at the top of `./utils/log.ts`.
import {
  installFrontendLogBridge,
  setFrontendLogVerbosity,
  type FrontendLogVerbosity,
} from "./utils/log";
import "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "./components/layout/ErrorBoundary";
import { prewarmHighlighter } from "./utils/highlight";
import { bootstrapGrammarRegistry } from "./utils/grammarRegistry";
// Dev-only: registers window.__CLAUDETTE_THEME_PROOF__ so theme authors can
// audit every token from the devtools console. No effect in release builds.
import "./utils/themeProof";
import App from "./App.tsx";

const platform = navigator.platform.toLowerCase();
document.documentElement.dataset.platform = platform.includes("mac")
  ? "mac"
  : platform.includes("win")
    ? "windows"
    : "linux";

// Phase 2 of the log bridge: console mirroring. The early listeners
// were already armed at `./utils/log` import time above; this call
// only wires `console.{error,warn,info,log}` interception (gated by
// the user's verbosity setting). Default verbosity is `errors` to
// match the Settings UI default.
installFrontendLogBridge("errors");
void invoke<{ frontend_verbosity: string | null }>("get_diagnostics_settings")
  .then((settings) => {
    const v = settings.frontend_verbosity;
    if (v === "errors" || v === "warnings" || v === "all") {
      setFrontendLogVerbosity(v as FrontendLogVerbosity);
    }
  })
  .catch(() => {
    // Backend command not yet registered (e.g. tests) — keep the
    // default. Failing to read this setting is never user-visible.
  });

// Spawn the syntax-highlight worker and kick off Shiki/WASM init in parallel
// with React mount, so the first code block on the first workspace doesn't
// have to wait on the cold-start path.
prewarmHighlighter();

// Pull plugin-contributed language grammars from the backend and load
// them into both the Shiki worker (chat + diff) and the main-thread
// Shiki used by Monaco. Async + non-blocking; the editor's own setup
// awaits this internally before binding tokens.
void bootstrapGrammarRegistry();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
