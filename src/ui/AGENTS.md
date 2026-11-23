# Frontend (`src/ui/`)

React + TypeScript (strict) + Zustand + CSS modules, built with Vite and Bun, tested with vitest (not Jest).

## Checks

Run all four after any change here, test files included:

```bash
bunx tsc -b && bun run lint:css && bun run test && bun run lint
```

vitest compiles with esbuild and does **not** type-check, so tests can pass while types are broken. CI runs `tsc` and `lint:css` but not ESLint.

## Rules

- **Types:** no `any`, `as any`, or `@ts-ignore`. `noUnusedLocals`, `noUnusedParameters` and `noFallthroughCasesInSwitch` are on.
- **State** that must survive navigation, workspace switching or event replay goes in the Zustand slices under `src/stores/slices/`, not in component-local state.
- **Tauri IPC** goes through the typed wrappers in `src/services/tauri/` (one module per domain; `services/tauri.ts` only re-exports them). Keep command names and payload shapes aligned with the Rust side, and don't add one-off `invoke` calls.
- **Colors:** every color is a `var(--token-name)` from `src/styles/theme.css`. Raw hex, `rgb()` or `rgba()` literals fail `bun run lint:css`. Allowed exceptions:
  - `rgba(var(--*-rgb), <alpha>)` for alpha layering
  - the `getPropertyValue(...) || "#..."` fallbacks in `theme.ts`
  - the CommandPalette `accentPreview` swatches
- **Strings:** user-visible strings use i18n keys from `src/locales/<lang>/`. Don't drop existing keys.
- **Layout:** macOS uses an overlay title bar (`titleBarStyle: "Overlay"`), which affects layout near the top of the window.
- **Preserve workflows:** each of these is a regression unless the task asks for it:
  - a removed button or context-menu action
  - changed keyboard behavior
  - lost selection
  - broken scrolling or terminal sizing
  - reordered tabs or sessions
  - a missing loading or error state
- **God files:** keep diffs in the frontend god files (root `AGENTS.md`) surgical. Extract a child component, hook or pure helper instead.

## Tests

- Use `describe` / `it` / `expect`.
- Reset Zustand state with `useAppStore.setState()` in `beforeEach`.
- No test database: frontend tests cover pure state and logic. Move behavior-heavy UI logic into pure helpers and test those.
- Build fixtures from the real type definitions (for example `TerminalTab` in `types/terminal.ts`); never guess field names. Reuse the `make*` helpers in nearby test files.
