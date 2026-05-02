import "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/layout/ErrorBoundary";
import { prewarmHighlighter } from "./utils/highlight";
import { bootstrapGrammarRegistry } from "./utils/grammarRegistry";
import App from "./App.tsx";

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
