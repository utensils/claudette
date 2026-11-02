import { invoke } from "@tauri-apps/api/core";
import { sendRemoteCommand } from "./remote";
import { remoteConnectionForWorkspace } from "./remoteRouting";

/**
 * Terminals opened on a paired server, keyed by the local alias ID the
 * Rust side hands back (see `src-tauri/src/remote_pty.rs`). Lets the
 * ID-only write / resize / close calls find their connection.
 */
const remotePtyConnections = new Map<number, string>();

export async function spawnPty(
  workingDir: string,
  workspaceName: string,
  workspaceId: string,
  rootPath: string,
  defaultBranch: string,
  branchName: string,
): Promise<number> {
  const connectionId = remoteConnectionForWorkspace(workspaceId);
  if (connectionId) {
    const result = (await sendRemoteCommand(connectionId, "spawn_pty", {
      workspace_id: workspaceId,
      cwd: workingDir,
    })) as { pty_id: number };
    remotePtyConnections.set(result.pty_id, connectionId);
    return result.pty_id;
  }
  return invoke("spawn_pty", {
    workingDir,
    workspaceName,
    workspaceId,
    rootPath,
    defaultBranch,
    branchName,
  });
}

export function writePty(ptyId: number, data: number[]): Promise<void> {
  const connectionId = remotePtyConnections.get(ptyId);
  if (connectionId) {
    return sendRemoteCommand(connectionId, "write_pty", {
      pty_id: ptyId,
      data,
    }) as Promise<void>;
  }
  return invoke("write_pty", { ptyId, data });
}

export function resizePty(
  ptyId: number,
  cols: number,
  rows: number
): Promise<void> {
  const connectionId = remotePtyConnections.get(ptyId);
  if (connectionId) {
    return sendRemoteCommand(connectionId, "resize_pty", {
      pty_id: ptyId,
      cols,
      rows,
    }) as Promise<void>;
  }
  return invoke("resize_pty", { ptyId, cols, rows });
}

export function closePty(ptyId: number): Promise<void> {
  const connectionId = remotePtyConnections.get(ptyId);
  if (connectionId) {
    remotePtyConnections.delete(ptyId);
    return sendRemoteCommand(connectionId, "close_pty", {
      pty_id: ptyId,
    }) as Promise<void>;
  }
  return invoke("close_pty", { ptyId });
}

/** Forget remote terminals after their connection drops. */
export function forgetRemotePtys(connectionId: string): void {
  for (const [ptyId, owner] of remotePtyConnections) {
    if (owner === connectionId) remotePtyConnections.delete(ptyId);
  }
}

export function interruptPtyForeground(ptyId: number): Promise<void> {
  // Foreground-process tracking is local-only; Ctrl-C still reaches a
  // remote shell through the terminal's normal input path.
  if (remotePtyConnections.has(ptyId)) return Promise.resolve();
  return invoke("interrupt_pty_foreground", { ptyId });
}

export function startAgentTaskTail(
  tabId: number,
  outputPath: string,
): Promise<void> {
  return invoke("start_agent_task_tail", { tabId, outputPath });
}

export function stopAgentTaskTail(tabId: number): Promise<void> {
  return invoke("stop_agent_task_tail", { tabId });
}

export function stopAgentBackgroundTask(
  chatSessionId: string,
  taskId: string,
): Promise<void> {
  return invoke("stop_agent_background_task", {
    chatSessionId,
    taskId,
  });
}
