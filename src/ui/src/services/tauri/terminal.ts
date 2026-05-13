import { invoke } from "@tauri-apps/api/core";
import type { TerminalTab } from "../../types";

export function createTerminalTab(
  workspaceId: string
): Promise<TerminalTab> {
  return invoke("create_terminal_tab", { workspaceId });
}

export function ensureClaudetteTerminalTab(
  workspaceId: string,
  chatSessionId: string
): Promise<TerminalTab> {
  return invoke("ensure_claudette_terminal_tab", { workspaceId, chatSessionId });
}

export function deleteTerminalTab(id: number): Promise<void> {
  return invoke("delete_terminal_tab", { id });
}

export function listTerminalTabs(
  workspaceId: string
): Promise<TerminalTab[]> {
  return invoke("list_terminal_tabs", { workspaceId });
}

export function updateTerminalTabOrder(
  workspaceId: string,
  tabIds: number[],
): Promise<void> {
  return invoke("update_terminal_tab_order", { workspaceId, tabIds });
}
