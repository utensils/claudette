use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundBashStart {
    pub command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundTaskBinding {
    pub task_id: String,
    pub output_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskNotification {
    pub task_id: String,
    pub output_file: Option<String>,
    pub status: String,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentBackgroundTaskEventKind {
    Starting,
    Bound,
    Status,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentBackgroundTaskEvent {
    pub kind: AgentBackgroundTaskEventKind,
    pub workspace_id: String,
    pub chat_session_id: String,
    pub tab: crate::model::TerminalTab,
}

pub fn parse_background_bash_start(input_json: &str) -> Option<BackgroundBashStart> {
    let value: serde_json::Value = serde_json::from_str(input_json).ok()?;
    if value
        .get("run_in_background")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return None;
    }
    let command = value
        .get("command")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    Some(BackgroundBashStart { command })
}

pub fn parse_background_task_binding(text: &str) -> Option<BackgroundTaskBinding> {
    const PREFIX: &str = "Command running in background with ID:";
    const MIDDLE: &str = "Output is being written to:";
    let start = text.find(PREFIX)? + PREFIX.len();
    let rest = text[start..].trim_start();
    let middle = rest.find(MIDDLE)?;
    let task_id = rest[..middle].trim().trim_end_matches('.');
    let output_path = rest[middle + MIDDLE.len()..].trim();
    let output_path = output_path.trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    if task_id.is_empty() || output_path.is_empty() {
        return None;
    }
    Some(BackgroundTaskBinding {
        task_id: task_id.to_string(),
        output_path: output_path.to_string(),
    })
}

pub fn parse_task_notification(text: &str) -> Option<TaskNotification> {
    if !text.contains("<task-notification") {
        return None;
    }
    let task_id = extract_xml_tag(text, "task-id")?;
    let status = extract_xml_tag(text, "status")?;
    Some(TaskNotification {
        task_id,
        output_file: extract_xml_tag(text, "output-file"),
        status,
        summary: extract_xml_tag(text, "summary"),
    })
}

fn extract_xml_tag(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    let value = text[start..end].trim();
    if value.is_empty() {
        None
    } else {
        Some(unescape_xml(value))
    }
}

fn unescape_xml(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_background_bash_start() {
        let start =
            parse_background_bash_start(r#"{"command":"bun run dev","run_in_background":true}"#)
                .unwrap();
        assert_eq!(start.command.as_deref(), Some("bun run dev"));
    }

    #[test]
    fn ignores_foreground_bash() {
        assert!(parse_background_bash_start(r#"{"command":"pwd"}"#).is_none());
    }

    #[test]
    fn parses_background_task_binding() {
        let binding = parse_background_task_binding(
            "Command running in background with ID: task_123. Output is being written to: /tmp/out.log",
        )
        .unwrap();
        assert_eq!(binding.task_id, "task_123");
        assert_eq!(binding.output_path, "/tmp/out.log");
    }

    #[test]
    fn parses_task_notification_xml() {
        let notification = parse_task_notification(
            "<task-notification><task-id>task_123</task-id><output-file>/tmp/out.log</output-file><status>completed</status><summary>exit 0</summary></task-notification>",
        )
        .unwrap();
        assert_eq!(notification.task_id, "task_123");
        assert_eq!(notification.output_file.as_deref(), Some("/tmp/out.log"));
        assert_eq!(notification.status, "completed");
        assert_eq!(notification.summary.as_deref(), Some("exit 0"));
    }
}
