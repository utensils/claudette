import "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/layout/ErrorBoundary";
import { prewarmHighlighter } from "./utils/highlight";
import App from "./App.tsx";

// Spawn the syntax-highlight worker and kick off Shiki/WASM init in parallel
// with React mount, so the first code block on the first workspace doesn't
// have to wait on the cold-start path.
prewarmHighlighter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
