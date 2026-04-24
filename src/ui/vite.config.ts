import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port is chosen by the devshell `dev` helper (which probes for the first
// free port starting at 1420) and passed in via VITE_PORT. strictPort stays
// true so a race between pre-flight and Vite startup fails loudly instead
// of silently landing on a port Tauri isn't pointed at.
const port = Number(process.env.VITE_PORT ?? 1420)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
  },
})
