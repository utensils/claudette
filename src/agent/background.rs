use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};

/// Workspace-scoped output file for the Claudette Terminal tab. This is
/// the single destination for the workspace's unified provisioning +
/// agent-shell transcript: env-provider stdout/stderr, the
/// `.claudette.json` setup script, every chat session's Bash tool
/// commands (foreground and the mirror of background tasks). xterm.js
/// tails this one file; the tab created on workspace create/fork
/// points here from the start and never rebinds, so users can scroll
/// back through the recent workspace transcript.
///
/// The file is a **tail-bounded ring**, not an append-only log: when
/// the next append would push it past [`TERMINAL_OUTPUT_MAX_BYTES`]
/// the writer rewrites it in place to keep only the last
/// [`TERMINAL_OUTPUT_TAIL_BYTES`] (preceded by a truncation banner).
/// See [`append_terminal_output_sync`] for the writer and issue #937
/// for the rationale.
pub fn workspace_terminal_output_path(workspace_id: &str) -> PathBuf {
    std::env::temp_dir()
        .join("claudette-workspace-terminal")
        .join(workspace_id)
        .join("terminal.output")
}

/// Hard ceiling for any workspace `terminal.output` file. Once a file would
/// exceed this size on the next append, the writer rotates it in place to
/// keep only the most recent [`TERMINAL_OUTPUT_TAIL_BYTES`] (preceded by a
/// truncation banner) so a chatty long-running background bash cannot grow
/// the file unbounded. The Claudette Terminal tail reader already handles
/// in-place shrinkage (`tail_agent_task_file` resets when `len < offset`).
///
/// 64 MiB / 32 MiB is enough scrollback for any practical debugging session
/// while bounding the worst-case heap retained by the Tauri → xterm.js
/// pipeline. See issue #937 for the OOM that motivated the cap.
pub const TERMINAL_OUTPUT_MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const TERMINAL_OUTPUT_TAIL_BYTES: u64 = 32 * 1024 * 1024;

/// Per-path mutexes used to serialize size-cap rotations against concurrent
/// appenders. Each workspace's `terminal.output` gets its own lock, so
/// unrelated workspaces never block each other; rotations and appends to
/// the same path are serialized so the truncate-to-tail rewrite cannot
/// lose concurrent writes.
///
/// Both writers to the workspace terminal file — the agent stream path
/// in `commands::chat::send` and the env-provider /  setup-script sink
/// in `commands::env` — take this lock from sync context. The async
/// agent path defers to `tokio::task::spawn_blocking` so the std mutex
/// is never held across an await.
fn terminal_output_lock_for(path: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    // Tolerate poisoning: a prior panic while holding the lock map mutex
    // would otherwise propagate a panic into every subsequent terminal-
    // output write and crash the app. The map's data is just `Arc`
    // handles and `PathBuf` keys — recovering the inner value is safe.
    let mut guard = map.lock().unwrap_or_else(|p| p.into_inner());
    guard
        .entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn terminal_output_truncation_banner() -> String {
    format!(
        "\r\n[claudette: terminal output truncated, keeping last {} MiB]\r\n",
        TERMINAL_OUTPUT_TAIL_BYTES / (1024 * 1024)
    )
}

/// Rewrite `path` in place to its last [`TERMINAL_OUTPUT_TAIL_BYTES`] (plus
/// a truncation banner) when the projected post-append size would exceed
/// the cap. Pass `incoming` = bytes about to be appended so a single
/// oversized payload that would jump from "just under the cap" to "well
/// over" is caught before the bytes hit disk.
fn rotate_terminal_output_if_needed_sync(path: &Path, incoming: u64) -> std::io::Result<()> {
    let len = match std::fs::metadata(path) {
        Ok(meta) => meta.len(),
        Err(_) => return Ok(()),
    };
    if len.saturating_add(incoming) <= TERMINAL_OUTPUT_MAX_BYTES {
        return Ok(());
    }
    use std::io::{Read, Seek, SeekFrom, Write};
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?;
    let start = len.saturating_sub(TERMINAL_OUTPUT_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut tail = Vec::with_capacity(TERMINAL_OUTPUT_TAIL_BYTES as usize);
    file.read_to_end(&mut tail)?;
    let banner = terminal_output_truncation_banner();
    file.seek(SeekFrom::Start(0))?;
    file.write_all(banner.as_bytes())?;
    file.write_all(&tail)?;
    let new_len = banner.len() as u64 + tail.len() as u64;
    file.set_len(new_len)?;
    Ok(())
}

/// Sync writer for the workspace `terminal.output` file shared by every
/// path that streams into it (agent bash echoes + mirror, env-provider
/// streaming sink, setup-script sink). All callers must go through this
/// helper so the per-path mutex serializes them with the rotation rewrite
/// — otherwise a concurrent appender can lose bytes during truncation.
///
/// Handles three regimes:
/// 1. `bytes` fits comfortably under the cap → plain append.
/// 2. `bytes` plus the current file size would exceed the cap →
///    rotate-to-tail first, then append.
/// 3. `bytes` *alone* exceeds [`TERMINAL_OUTPUT_TAIL_BYTES`] (e.g. a
///    single huge ToolResult) → write only the tail of the payload,
///    preceded by the same truncation banner, so the resulting file
///    never lives past the ceiling.
pub fn append_terminal_output_sync(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let lock = terminal_output_lock_for(path);
    // Same poisoning policy as the lock map: tolerate a prior panic so
    // a single bad write doesn't silently kill the terminal pipeline.
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());

    let tail_cap = TERMINAL_OUTPUT_TAIL_BYTES as usize;
    let oversized_payload = bytes.len() > tail_cap;

    if oversized_payload {
        // The payload itself is larger than the tail target. Discard the
        // current file (no point preserving any of it — none of it will
        // remain on disk), then write banner + tail-of-payload so the
        // post-write size is `banner + tail_cap` regardless of how big
        // `bytes` was.
        use std::io::Write;
        let banner = terminal_output_truncation_banner();
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)?;
        file.write_all(banner.as_bytes())?;
        let start = bytes.len() - tail_cap;
        return file.write_all(&bytes[start..]);
    }

    rotate_terminal_output_if_needed_sync(path, bytes.len() as u64)?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(bytes)
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

    #[test]
    fn append_caps_terminal_output_via_truncate_to_tail() {
        // Issue #937: workspace `terminal.output` grew to 15.6 GB because a
        // long-running background bash mirror appended without bound. The
        // appender must rotate the file when it exceeds the hard cap so the
        // tail-emit pipeline can't blow up memory.
        let path = std::env::temp_dir().join(format!(
            "claudette-cap-{}.terminal.output",
            uuid::Uuid::new_v4()
        ));
        // Seed the file just past the cap so the next append triggers
        // rotation. Use a small marker at the very end so we can assert
        // recent bytes survive truncation.
        let mut seed = vec![b'A'; TERMINAL_OUTPUT_MAX_BYTES as usize + 1024];
        let marker = b"TAIL_MARKER_KEEP_ME";
        let marker_at = seed.len() - marker.len();
        seed[marker_at..].copy_from_slice(marker);
        std::fs::write(&path, &seed).unwrap();

        append_terminal_output_sync(&path, b"new-line\r\n").unwrap();

        let after = std::fs::read(&path).unwrap();
        // Cap brought us back well under the ceiling. tail bytes + banner +
        // the new "new-line" append must all fit comfortably inside the cap.
        assert!(
            (after.len() as u64) <= TERMINAL_OUTPUT_TAIL_BYTES + 256,
            "file should have been truncated, got {} bytes",
            after.len()
        );
        let after_str = String::from_utf8_lossy(&after);
        assert!(after_str.starts_with("\r\n[claudette: terminal output truncated"));
        // The marker we appended *just before* rotation must survive — the
        // rotator keeps the tail of the file, not the head.
        assert!(
            after.windows(marker.len()).any(|w| w == marker),
            "expected tail marker to survive truncation"
        );
        // The newly appended line is at the very end.
        assert!(
            after_str.ends_with("new-line\r\n"),
            "expected newest append at end"
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn append_rotates_when_post_state_would_exceed_cap() {
        // Regression test for the off-by-one in the cap check. Seed the file
        // at exactly the ceiling so the *current* len is not over-cap, then
        // append a payload that would push it past. The rotator must look
        // at `len + incoming`, not just `len`, otherwise a single large
        // bash result could land the file well past the documented hard
        // ceiling before any future write triggers rotation.
        let path = std::env::temp_dir().join(format!(
            "claudette-cap-post-{}.terminal.output",
            uuid::Uuid::new_v4()
        ));
        let seed = vec![b'B'; TERMINAL_OUTPUT_MAX_BYTES as usize];
        std::fs::write(&path, &seed).unwrap();

        // Appending even a single byte should be enough to trigger rotation
        // now that the helper compares `len + incoming` against the cap.
        append_terminal_output_sync(&path, b"X").unwrap();

        let after_len = std::fs::metadata(&path).unwrap().len();
        assert!(
            after_len <= TERMINAL_OUTPUT_TAIL_BYTES + 256,
            "expected rotation when post-append size would exceed cap, got {after_len} bytes"
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn append_caps_oversized_single_payload_to_tail_of_bytes() {
        // Even rarer corner: the incoming append is *itself* larger than
        // the tail target. A naive rotate-then-append still leaves the
        // file at `banner + tail_cap + bytes.len()` — much bigger than
        // the ceiling. The writer must keep only the tail of the payload
        // so a single massive ToolResult (or env-resolve burst) cannot
        // push the file past the hard ceiling on one write.
        let path = std::env::temp_dir().join(format!(
            "claudette-oversized-{}.terminal.output",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"existing content that should be discarded\n").unwrap();

        // Payload twice the tail target. Lead-in bytes are distinct from
        // tail bytes so we can assert exactly which half survived.
        let lead_size = TERMINAL_OUTPUT_TAIL_BYTES as usize;
        let mut payload = vec![b'H'; lead_size]; // head — should be dropped
        payload.extend(std::iter::repeat_n(b'T', lead_size)); // tail — should survive
        append_terminal_output_sync(&path, &payload).unwrap();

        let after = std::fs::read(&path).unwrap();
        let banner = terminal_output_truncation_banner();
        assert!(
            after.starts_with(banner.as_bytes()),
            "expected truncation banner at start"
        );
        let body = &after[banner.len()..];
        assert_eq!(
            body.len() as u64,
            TERMINAL_OUTPUT_TAIL_BYTES,
            "expected exactly the tail of the payload"
        );
        assert!(
            body.iter().all(|&b| b == b'T'),
            "expected only the tail (T) bytes to survive — head (H) bytes must be dropped"
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn shared_sync_helper_serializes_concurrent_writers_through_rotation() {
        // Multiple writers (the agent stream path and the env-provider /
        // setup-script sinks) all funnel through this helper. The per-path
        // mutex must serialize them with the rotation rewrite — otherwise
        // lines written between the rotator's tail read and `set_len` would
        // be dropped. Hammer the helper from many threads around the cap
        // boundary and assert that every line we wrote survives.
        let path = std::env::temp_dir().join(format!(
            "claudette-shared-{}.terminal.output",
            uuid::Uuid::new_v4()
        ));
        let seed = vec![b'A'; TERMINAL_OUTPUT_MAX_BYTES as usize - 4096];
        std::fs::write(&path, &seed).unwrap();

        const WRITERS: usize = 8;
        const LINES_PER_WRITER: usize = 64;
        let mut handles = Vec::new();
        for w in 0..WRITERS {
            let path = path.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..LINES_PER_WRITER {
                    let line = format!("LINE w{w} i{i}\n");
                    append_terminal_output_sync(&path, line.as_bytes()).unwrap();
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        let after = std::fs::read(&path).unwrap();
        assert!(
            (after.len() as u64) <= TERMINAL_OUTPUT_TAIL_BYTES + 8192,
            "file should have been truncated, got {} bytes",
            after.len()
        );
        let after_str = String::from_utf8_lossy(&after);
        for w in 0..WRITERS {
            for i in 0..LINES_PER_WRITER {
                let needle = format!("LINE w{w} i{i}");
                assert!(
                    after_str.contains(&needle),
                    "missing line {needle:?} — must not be lost during rotation"
                );
            }
        }

        let _ = std::fs::remove_file(path);
    }
}
