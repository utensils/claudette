import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import type { McpStatusSnapshot } from "../types/mcp";
import { useAppStore } from "../stores/useAppStore";
import { ensureAndValidateMcps } from "../services/mcp";

/**
 * Listen for "mcp-status-changed" events from the Rust MCP supervisor
 * and update the Zustand store with the latest per-repository status.
 *
 * Also triggers MCP detection + validation when the active workspace changes.
 */
export function useMcpStatus() {
  const setMcpStatus = useAppStore((s) => s.setMcpStatus);
  const clearMcpStatus = useAppStore((s) => s.clearMcpStatus);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const lastRepoId = useRef<string | null>(null);

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

  // When the selected workspace changes, ensure MCPs are detected + validated.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
    if (!ws) return;
    const repoId = ws.repository_id;

    // Skip if we already validated this repo during this session.
    // This avoids re-running detection on every workspace switch within the
    // same repo. The AttachMenu always re-detects on open for fresh state.
    if (lastRepoId.current === repoId) return;
    lastRepoId.current = repoId;

    // Check repo exists.
    if (!repositories.some((r) => r.id === repoId)) return;

    ensureAndValidateMcps(repoId)
      .then((snapshot) => setMcpStatus(repoId, snapshot))
      .catch(() => {});
  }, [selectedWorkspaceId, workspaces, repositories, setMcpStatus]);
}
