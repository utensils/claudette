import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Dedicated vitest config so we can pin a coverage allowlist for the
// interactive-claude patch set without touching the dev/build pipeline in
// vite.config.ts. The `test:coverage:interactive` script in package.json
// runs `vitest run --coverage` and picks this up automatically.
//
// The include list below is the explicit set of files the interactive-claude
// coverage plan gates on (>=85% across statements/branches/functions/lines).
// Tasks B-F raised coverage on each file until the patch met the gate; the
// thresholds below are enforced — vitest exits non-zero if any of them
// regresses. See the interactive-claude coverage plan (Task G1) for context.
export default defineConfig({
  plugins: [react()],
  test: {
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary"],
      include: [
        "src/components/chat/InteractiveTurnView.tsx",
        "src/components/chat/InteractiveTurns.tsx",
        "src/components/chat/InteractiveTerminalMode.tsx",
        "src/components/chat/InteractiveTerminalModeToggle.tsx",
        "src/components/chat/useInteractiveChatMode.ts",
        "src/hooks/useInteractiveTurnAssembler.ts",
        "src/services/interactive.ts",
        "src/components/sidebar/InteractiveBadge.tsx",
        "src/stores/slices/interactiveSessionsSlice.ts",
      ],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
    },
  },
});
