import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri Mobile config. The dev port is intentionally one higher than the
// desktop's default (14253 in scripts/dev.sh) so both apps can run side-
// by-side during development. `strictPort: true` makes the build fail
// loudly if something already holds the port instead of silently
// rebinding underneath the running webview.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 14254,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows"
        ? "chrome105"
        : "safari16",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
