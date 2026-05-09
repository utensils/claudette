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

import "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "./components/layout/ErrorBoundary";
import { prewarmHighlighter } from "./utils/highlight";
import { bootstrapGrammarRegistry } from "./utils/grammarRegistry";
import {
  installFrontendLogBridge,
  setFrontendLogVerbosity,
  type FrontendLogVerbosity,
} from "./utils/log";
import App from "./App.tsx";

// Install the frontend → backend log bridge BEFORE React mounts so a
// crash inside any module's import-time side effects (i18n, grammar
// bootstrap) lands in the daily log file under `claudette::frontend`
// instead of evaporating into the devtools console.
//
// Default verbosity is `errors` (matches the Settings default). The
// async fetch below upgrades it once `get_diagnostics_settings`
// returns the user's persisted choice — which is fine because nothing
// in the boot path emits at warn/info that we'd want to mirror.
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
