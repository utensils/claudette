import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import type { McpStatusSnapshot } from "../types/mcp";
import { useAppStore } from "../stores/useAppStore";
import { ensureAndValidateMcps } from "../services/mcp";

/**
 * Listen for "mcp-status-changed" events from the Rust MCP supervisor
 * and update the Zustand store with the latest per-repository status.
 *
 * Triggers MCP detection + validation for every known repository once per
 * session so the sidebar indicators populate without waiting for a workspace
 * to be selected.
 */
export function useMcpStatus() {
  const setMcpStatus = useAppStore((s) => s.setMcpStatus);
  const clearMcpStatus = useAppStore((s) => s.clearMcpStatus);
  const repositories = useAppStore((s) => s.repositories);
  const validated = useRef<Set<string>>(new Set());

  // Listen for supervisor status events.
  useEffect(() => {
    const unlisten = listen<McpStatusSnapshot>(
      "mcp-status-changed",
      (event) => {
        setMcpStatus(event.payload.repository_id, event.payload);
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setMcpStatus]);

  // Listen for status cleared events (e.g. last workspace for a repo deleted).
  useEffect(() => {
    const unlisten = listen<string>("mcp-status-cleared", (event) => {
      clearMcpStatus(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [clearMcpStatus]);

  // Validate MCPs for every repository once per session. Runs on initial load
  // and whenever a new repo is added. The AttachMenu re-detects on open for
  // fresh state, so we don't need to re-validate on workspace switches.
  useEffect(() => {
    for (const repo of repositories) {
      if (!repo.path_valid) continue;
      if (validated.current.has(repo.id)) continue;
      validated.current.add(repo.id);
      ensureAndValidateMcps(repo.id)
        .then((snapshot) => setMcpStatus(repo.id, snapshot))
        .catch(() => {});
    }
  }, [repositories, setMcpStatus]);
}
