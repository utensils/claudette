import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port is chosen by the devshell `dev` helper (which probes for the first
// free port starting at CLAUDETTE_VITE_PORT_BASE) and passed in via
// VITE_PORT. strictPort stays true so a race between pre-flight and Vite
// startup fails loudly instead of silently landing on a port Tauri isn't
// pointed at.
//
// We deliberately moved off Tauri's stock port 1420 because every Tauri
// starter template defaults to it — when another Tauri dev build launches
// nearby, its dev script (often `lsof -ti:1420 | xargs kill`) can rebind
// our port underneath the running webview, swapping in a foreign bundle.
// A non-default port avoids the most common source of cross-app hijack;
// the inline guard in index.html catches the rest.
//
// parseInt instead of Number so an empty/garbage VITE_PORT falls back
// instead of failing with "port NaN already in use".
const DEFAULT_VITE_PORT = 14253
const parsed = parseInt(process.env.VITE_PORT ?? '', 10)
const port = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VITE_PORT

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
  },
})
