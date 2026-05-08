---
applyTo: "src/ui/**/*.ts,src/ui/**/*.tsx,src/ui/**/*.css"
---

Frontend code is React, TypeScript strict mode, Zustand, CSS modules, Vite, Bun, and Vitest. Do not use `any`; read the actual type definitions before constructing fixtures or Tauri payloads.

State belongs in the existing Zustand slices under `src/ui/src/stores/slices/`. Add or update a domain slice instead of growing component-local state that must survive navigation, workspace switching, or event replay.

Keep large components from becoming god files. Before adding substantial logic to `Sidebar.tsx`, `ChatPanel.tsx`, `ChatInputArea.tsx`, `TerminalPanel.tsx`, settings sections, or large CSS modules, prefer a focused child component, hook, pure helper, or testable logic module in the same feature folder.

Preserve established workflows and UI affordances. Treat removed buttons, changed keyboard behavior, lost selection, broken scrolling, altered terminal sizing, dropped context-menu actions, changed tab/session ordering, and missing loading/error states as regressions unless explicitly requested.

Use existing service wrappers in `src/ui/src/services/` for Tauri IPC. Keep command names and payload shapes aligned with Rust models and commands. Do not bypass typed wrappers for one-off `invoke` calls when a service module owns the domain.

All colors outside `src/ui/src/styles/theme.css` must use CSS custom properties, usually `var(--token-name)` or `rgba(var(--token-rgb), alpha)`. Do not add raw hex/rgb/rgba literals to components or CSS modules.

Prefer logic tests for behavior-heavy UI. Put pure behavior in helpers when possible and cover it with Vitest. For TypeScript changes, run `cd src/ui && bunx tsc -b`; test passing alone is not enough.

Do not update `bun.lock` unless dependency changes are intentional. Use Bun commands, not npm or yarn.
