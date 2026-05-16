import { invoke } from "@tauri-apps/api/core";
import type { PairResult, SavedConnection, VersionInfo } from "../types";

// Thin wrappers around the Tauri-side commands. Centralizing them here
// (rather than calling `invoke<T>(...)` inline everywhere) means a
// screen never has to know the exact Rust command-name string.

export function getVersion(): Promise<VersionInfo> {
  return invoke<VersionInfo>("version");
}

export function pairWithConnectionString(
  connectionString: string,
): Promise<PairResult> {
  return invoke<PairResult>("pair_with_connection_string", {
    connectionString,
  });
}

export function listSavedConnections(): Promise<SavedConnection[]> {
  return invoke<SavedConnection[]>("list_saved_connections");
}

export function connectSaved(id: string): Promise<SavedConnection> {
  return invoke<SavedConnection>("connect_saved", { id });
}

export function forgetConnection(id: string): Promise<void> {
  return invoke<void>("forget_connection", { id });
}
