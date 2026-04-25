import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port is chosen by the devshell `dev` helper (which probes for the first
// free port starting at 1420) and passed in via VITE_PORT. strictPort stays
// true so a race between pre-flight and Vite startup fails loudly instead
// of silently landing on a port Tauri isn't pointed at.
//
// parseInt instead of Number so an empty/garbage VITE_PORT falls back to
// 1420 instead of failing with "port NaN already in use".
const parsed = parseInt(process.env.VITE_PORT ?? '', 10)
const port = Number.isFinite(parsed) && parsed > 0 ? parsed : 1420

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
  },
})
