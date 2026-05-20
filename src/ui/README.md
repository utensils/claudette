# Claudette frontend (`src/ui`)

The React + TypeScript webview for the Claudette desktop app. Built with
Vite and rendered inside the Tauri 2 webview. State lives in a single
Zustand store (`src/stores/useAppStore.ts`, composed from domain slices
under `src/stores/slices/`).

This is **not** a standalone web app — it talks to the Rust backend over
Tauri commands and events. Run the full app with `cargo tauri dev` (or
`./scripts/dev.sh` from the repo root), not `vite` alone.

## Commands

Use `bun` (the project's package manager), run from this directory:

```bash
bun install              # install dependencies (CI uses --frozen-lockfile)
bun run dev              # start the Vite dev server (used by Tauri)
bun run build            # type-check (tsc -b) then vite build
bunx tsc -b              # type-check only — same as CI's check
bun run test             # run vitest once
bun run test:watch       # run vitest in watch mode
bun run lint             # ESLint
bun run lint:css         # design-token + mono-font enforcement (CI-blocking)
bun run preview          # preview a production build
bun run smoke:bundle     # smoke-test the built bundle
```

`vitest` uses esbuild and does **not** type-check — always run `bunx tsc -b`
before committing frontend changes.

## Tooling

- **Vite 8** with `@vitejs/plugin-react`.
- **TypeScript** in strict mode (`noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`); no `any`.
- **ESLint 9** flat config (`eslint.config.js`) with `typescript-eslint`,
  `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`.
- **vitest** is the test runner (not Jest); DOM tests use `happy-dom`.
- CSS colors must reference `var(--token-name)` custom properties defined in
  `src/styles/theme.css` — raw hex/rgba literals fail `bun run lint:css`.

## Dev server port

The Vite port is chosen by `scripts/dev.sh`, which probes for the first free
port starting at base **14253** and passes it via `VITE_PORT`. `strictPort`
is `true`, so a probe/Vite race fails loudly instead of silently binding a
foreign port. The default was deliberately moved off Tauri's stock `1420`
because other Tauri starter templates default to it.

## Layout

- `src/components/` — React components, organized by feature area.
- `src/stores/` — Zustand store and per-domain slices.
- `src/services/` — Tauri command/event wrappers (`tauri.ts`).
- `src/hooks/` — streaming-data and UI hooks.
- `src/styles/` — global CSS and theme tokens.
- `scripts/` — `lint:css` and bundle-smoke helpers.
