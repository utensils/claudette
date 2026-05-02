import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vitest config separated from vite.config.ts so the dev server config
// (port/strictPort) doesn't get pulled into test runs. Tests opt into a
// DOM environment per-file via `// @vitest-environment happy-dom` — most
// existing tests are pure logic tests and run faster in node.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
  },
});
