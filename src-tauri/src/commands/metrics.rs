use std::collections::HashMap;

use claudette::metrics::{self, AnalyticsMetrics, DashboardMetrics, WorkspaceMetrics};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn get_dashboard_metrics(state: State<'_, AppState>) -> Result<DashboardMetrics, String> {
    metrics::dashboard_metrics(&state.db_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_workspace_metrics_batch(
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<HashMap<String, WorkspaceMetrics>, String> {
    metrics::workspace_metrics_batch(&state.db_path, &ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_analytics_metrics(state: State<'_, AppState>) -> Result<AnalyticsMetrics, String> {
    metrics::analytics_metrics(&state.db_path).map_err(|e| e.to_string())
}
