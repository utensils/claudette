import { invoke } from "@tauri-apps/api/core";

export function debugEvalJs(js: string): Promise<string> {
  return invoke("debug_eval_js", { js });
}

// Expose invoke on window in dev builds so debug_eval_js can call back.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__CLAUDETTE_INVOKE__ = invoke;
}
