import { invoke } from "@tauri-apps/api/core";

export function readPlanFile(path: string): Promise<string> {
  return invoke("read_plan_file", { path });
}
