use serde::{Deserialize, Serialize};

pub fn agent_bash_output_path(chat_session_id: &str) -> std::path::PathBuf {
    std::env::temp_dir()
        .join("claudette-agent-bash")
        .join(chat_session_id)
        .join("agent-shell.output")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BashStart {
    pub command: Option<String>,
    pub run_in_background: bool,
}

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
    pub tool_use_id: Option<String>,
    pub output_file: Option<String>,
    pub status: Option<String>,
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

pub fn parse_bash_start(input_json: &str) -> Option<BashStart> {
    let value: serde_json::Value = serde_json::from_str(input_json).ok()?;
    let run_in_background = value
        .get("run_in_background")
        .and_then(serde_json::Value::as_bool)
        == Some(true);
    let command = value
        .get("command")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    Some(BashStart {
        command,
        run_in_background,
    })
}

pub fn parse_background_bash_start(input_json: &str) -> Option<BackgroundBashStart> {
    let start = parse_bash_start(input_json)?;
    if !start.run_in_background {
        return None;
    }
    Some(BackgroundBashStart {
        command: start.command,
    })
}

pub fn is_tail_bash_command(command: &str) -> bool {
    let Some(first) = first_shell_word(command.trim_start()) else {
        return false;
    };
    let command_name = first.rsplit('/').next().unwrap_or(first);
    command_name == "tail" || command_name == "gtail"
}

fn first_shell_word(command: &str) -> Option<&str> {
    let mut end = 0;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (idx, ch) in command.char_indices() {
        if escaped {
            escaped = false;
            end = idx + ch.len_utf8();
            continue;
        }
        if ch == '\\' {
            escaped = true;
            end = idx + ch.len_utf8();
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            end = idx + ch.len_utf8();
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            end = idx + ch.len_utf8();
            continue;
        }
        if ch.is_whitespace() || matches!(ch, '|' | '&' | ';' | '(' | ')') {
            break;
        }
        end = idx + ch.len_utf8();
    }
    let word = command.get(..end)?.trim();
    if word.is_empty() { None } else { Some(word) }
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
    Some(TaskNotification {
        task_id,
        tool_use_id: extract_xml_tag(text, "tool-use-id"),
        output_file: extract_xml_tag(text, "output-file"),
        status: extract_xml_tag(text, "status"),
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
    fn parses_explicit_foreground_bash_start() {
        let start = parse_bash_start(r#"{"command":"pwd","run_in_background":false}"#).unwrap();
        assert_eq!(start.command.as_deref(), Some("pwd"));
        assert!(!start.run_in_background);
        assert!(
            parse_background_bash_start(r#"{"command":"pwd","run_in_background":false}"#).is_none()
        );
    }

    #[test]
    fn parses_foreground_bash_start() {
        let start = parse_bash_start(r#"{"command":"pwd"}"#).unwrap();
        assert_eq!(start.command.as_deref(), Some("pwd"));
        assert!(!start.run_in_background);
    }

    #[test]
    fn parses_empty_bash_command_as_none() {
        let start = parse_bash_start(r#"{"command":"   ","run_in_background":true}"#).unwrap();
        assert_eq!(start.command, None);
        assert!(start.run_in_background);
    }

    #[test]
    fn rejects_invalid_bash_start_json() {
        assert!(parse_bash_start("not json").is_none());
        assert!(parse_background_bash_start("not json").is_none());
    }

    #[test]
    fn detects_tail_commands() {
        assert!(is_tail_bash_command("tail -f /tmp/out"));
        assert!(is_tail_bash_command(" /usr/bin/tail -n 20 file"));
        assert!(is_tail_bash_command("gtail -F file"));
        assert!(!is_tail_bash_command("tailwindcss --help"));
        assert!(!is_tail_bash_command("cat file | tail -n 1"));
    }

    #[test]
    fn detects_tail_commands_with_shell_prefix_boundaries() {
        assert!(is_tail_bash_command("tail\t-f /tmp/out"));
        assert!(is_tail_bash_command("/opt/homebrew/bin/gtail && true"));
        assert!(!is_tail_bash_command("env tail -f /tmp/out"));
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
    fn parses_background_task_binding_inside_tool_text() {
        let binding = parse_background_task_binding(
            "Started.\nCommand running in background with ID: task_123.\nOutput is being written to: /tmp/out.log.\n",
        )
        .unwrap();
        assert_eq!(binding.task_id, "task_123");
        assert_eq!(binding.output_path, "/tmp/out.log");
    }

    #[test]
    fn rejects_incomplete_background_task_binding() {
        assert!(
            parse_background_task_binding("Command running in background with ID: task_123.")
                .is_none()
        );
        assert!(
            parse_background_task_binding(
                "Command running in background with ID: . Output is being written to: /tmp/out.log",
            )
            .is_none()
        );
    }

    #[test]
    fn parses_task_notification_xml() {
        let notification = parse_task_notification(
            "<task-notification><task-id>task_123</task-id><tool-use-id>toolu_1</tool-use-id><output-file>/tmp/out.log</output-file><status>completed</status><summary>exit 0</summary></task-notification>",
        )
        .unwrap();
        assert_eq!(notification.task_id, "task_123");
        assert_eq!(notification.tool_use_id.as_deref(), Some("toolu_1"));
        assert_eq!(notification.output_file.as_deref(), Some("/tmp/out.log"));
        assert_eq!(notification.status.as_deref(), Some("completed"));
        assert_eq!(notification.summary.as_deref(), Some("exit 0"));
    }

    #[test]
    fn parses_statusless_task_notification_xml() {
        let notification = parse_task_notification(
            "<task-notification><task-id>task_123</task-id><output-file>/tmp/out.log</output-file><summary>waiting for input</summary></task-notification>",
        )
        .unwrap();
        assert_eq!(notification.task_id, "task_123");
        assert_eq!(notification.status, None);
        assert_eq!(notification.summary.as_deref(), Some("waiting for input"));
    }

    #[test]
    fn parses_task_notification_with_escaped_fields() {
        let notification = parse_task_notification(
            "<task-notification><task-id>task_123</task-id><summary>done &amp; wrote &lt;file&gt;</summary></task-notification>",
        )
        .unwrap();
        assert_eq!(notification.summary.as_deref(), Some("done & wrote <file>"));
    }

    #[test]
    fn rejects_task_notification_without_task_id() {
        assert!(
            parse_task_notification(
                "<task-notification><status>completed</status></task-notification>",
            )
            .is_none()
        );
        assert!(parse_task_notification("plain text").is_none());
    }
}
