import { invoke } from "@tauri-apps/api/core";
import type {
  AnalyticsMetrics,
  DashboardMetrics,
  WorkspaceMetrics,
} from "../../types/metrics";

export function getDashboardMetrics(): Promise<DashboardMetrics> {
  return invoke("get_dashboard_metrics");
}

export function getWorkspaceMetricsBatch(
  ids: string[]
): Promise<Record<string, WorkspaceMetrics>> {
  return invoke("get_workspace_metrics_batch", { ids });
}

export function getAnalyticsMetrics(): Promise<AnalyticsMetrics> {
  return invoke("get_analytics_metrics");
}
