//! Claude Code hook command entrypoint.
//!
//! The parent process injects this binary as a command hook. Claude Code sends
//! each hook input as JSON on stdin; this helper forwards that payload to the
//! already-running per-session bridge so the Tauri UI can show nested
//! subagent tool activity without scraping DEBUG logs.

use std::io::{self, BufRead, Read, Seek, SeekFrom};
use std::path::Path;

use tokio::io::AsyncReadExt;

use crate::agent_mcp::protocol::{BridgePayload, BridgeRequest};

const MAX_TRANSCRIPT_TAIL_BYTES: u64 = 512 * 1024;
const MAX_TRANSCRIPT_LINES: usize = 2_000;
const MAX_THINKING_BLOCKS: usize = 32;
const MAX_THINKING_TOTAL_CHARS: usize = 32_000;
const MAX_RESULT_CHARS: usize = 32_000;

/// Run a one-shot hook forwarder.
pub async fn run_stdin() -> io::Result<()> {
    let Ok(socket_addr) = std::env::var(super::server::ENV_SOCKET_ADDR) else {
        return Ok(());
    };
    let Ok(token) = std::env::var(super::server::ENV_TOKEN) else {
        return Ok(());
    };

    let mut input = String::new();
    tokio::io::stdin().read_to_string(&mut input).await?;
    let mut hook_input = serde_json::from_str::<serde_json::Value>(&input)
        .map_err(|e| io::Error::other(format!("parse hook input: {e}")))?;
    enrich_subagent_stop(&mut hook_input);

    let req = BridgeRequest {
        token,
        payload: BridgePayload::HookEvent { input: hook_input },
    };
    let _ = super::server::send_to_bridge(&socket_addr, &req).await;
    Ok(())
}

fn enrich_subagent_stop(input: &mut serde_json::Value) {
    let Some(obj) = input.as_object_mut() else {
        return;
    };
    if obj
        .get("hook_event_name")
        .and_then(serde_json::Value::as_str)
        != Some("SubagentStop")
    {
        return;
    }

    let path = obj
        .get("agent_transcript_path")
        .or_else(|| obj.get("transcript_path"))
        .and_then(serde_json::Value::as_str);
    let Some(path) = path else {
        return;
    };
    let Ok(snapshot) = extract_subagent_transcript_snapshot(Path::new(path)) else {
        return;
    };

    if !snapshot.thinking_blocks.is_empty() {
        obj.insert(
            "claudette_agent_thinking_blocks".to_string(),
            serde_json::json!(snapshot.thinking_blocks),
        );
    }
    if obj
        .get("last_assistant_message")
        .and_then(serde_json::Value::as_str)
        .is_none_or(str::is_empty)
        && let Some(result) = snapshot.final_result
    {
        obj.insert(
            "claudette_agent_final_result".to_string(),
            serde_json::Value::String(result),
        );
    }
}

struct SubagentTranscriptSnapshot {
    thinking_blocks: Vec<String>,
    final_result: Option<String>,
}

fn extract_subagent_transcript_snapshot(path: &Path) -> io::Result<SubagentTranscriptSnapshot> {
    let tail = read_transcript_tail(path)?;
    let reader = std::io::BufReader::new(std::io::Cursor::new(tail));
    let mut thinking_blocks = Vec::new();
    let mut thinking_chars = 0usize;
    let mut final_result = None;

    for line in reader.lines().take(MAX_TRANSCRIPT_LINES) {
        let line = line?;
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(content) = assistant_content_blocks(&value) else {
            continue;
        };

        let mut text_blocks = Vec::new();
        for block in content {
            let Some(block_type) = block.get("type").and_then(serde_json::Value::as_str) else {
                continue;
            };
            match block_type {
                "thinking" => {
                    if let Some(thinking) =
                        block.get("thinking").and_then(serde_json::Value::as_str)
                    {
                        push_capped_thinking(&mut thinking_blocks, &mut thinking_chars, thinking);
                    }
                }
                "text" => {
                    if let Some(text) = block.get("text").and_then(serde_json::Value::as_str) {
                        let text = text.trim();
                        if !text.is_empty() {
                            text_blocks.push(text.to_string());
                        }
                    }
                }
                _ => {}
            }
        }

        if !text_blocks.is_empty() {
            final_result = Some(truncate_chars(&text_blocks.join("\n\n"), MAX_RESULT_CHARS));
        }
    }

    Ok(SubagentTranscriptSnapshot {
        thinking_blocks,
        final_result,
    })
}

fn read_transcript_tail(path: &Path) -> io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(MAX_TRANSCRIPT_TAIL_BYTES);
    if start > 0 {
        file.seek(SeekFrom::Start(start))?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    if start > 0
        && let Some(pos) = bytes.iter().position(|b| *b == b'\n')
    {
        bytes.drain(..=pos);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn push_capped_thinking(blocks: &mut Vec<String>, total_chars: &mut usize, thinking: &str) {
    if blocks.len() >= MAX_THINKING_BLOCKS || *total_chars >= MAX_THINKING_TOTAL_CHARS {
        return;
    }
    let thinking = thinking.trim();
    if thinking.is_empty() {
        return;
    }
    let remaining = MAX_THINKING_TOTAL_CHARS - *total_chars;
    let capped = truncate_chars(thinking, remaining);
    *total_chars += capped.chars().count();
    blocks.push(capped);
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn assistant_content_blocks(value: &serde_json::Value) -> Option<&Vec<serde_json::Value>> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("assistant") {
        return None;
    }
    value
        .get("message")
        .and_then(|message| message.get("content"))
        .or_else(|| value.get("content"))
        .and_then(serde_json::Value::as_array)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn extracts_thinking_and_last_assistant_text_from_subagent_transcript() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            file,
            r#"{{"type":"assistant","message":{{"content":[{{"type":"thinking","thinking":" first thought "}},{{"type":"text","text":"intermediate"}}]}}}}"#
        )
        .unwrap();
        writeln!(file, r#"{{"type":"user","message":{{"content":[]}}}}"#).unwrap();
        writeln!(
            file,
            r#"{{"type":"assistant","message":{{"content":[{{"type":"thinking","thinking":"second thought"}},{{"type":"text","text":"final answer"}}]}}}}"#
        )
        .unwrap();

        let snapshot = extract_subagent_transcript_snapshot(file.path()).unwrap();

        assert_eq!(
            snapshot.thinking_blocks,
            vec!["first thought".to_string(), "second thought".to_string()]
        );
        assert_eq!(snapshot.final_result.as_deref(), Some("final answer"));
    }

    #[test]
    fn enriches_subagent_stop_without_overwriting_cli_result() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            file,
            r#"{{"type":"assistant","message":{{"content":[{{"type":"thinking","thinking":"plan"}},{{"type":"text","text":"from transcript"}}]}}}}"#
        )
        .unwrap();
        let mut input = serde_json::json!({
            "hook_event_name": "SubagentStop",
            "agent_transcript_path": file.path().to_string_lossy(),
            "last_assistant_message": "from hook"
        });

        enrich_subagent_stop(&mut input);

        assert_eq!(input["last_assistant_message"], "from hook");
        assert_eq!(
            input["claudette_agent_thinking_blocks"],
            serde_json::json!(["plan"])
        );
        assert!(input.get("claudette_agent_final_result").is_none());
    }

    #[test]
    fn transcript_snapshot_is_bounded_to_tail_and_field_caps() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&vec![b'x'; (MAX_TRANSCRIPT_TAIL_BYTES + 128) as usize])
            .unwrap();
        writeln!(file).unwrap();
        writeln!(
            file,
            r#"{{"type":"assistant","message":{{"content":[{{"type":"thinking","thinking":" tail thought "}},{{"type":"text","text":"{}"}}]}}}}"#,
            "y".repeat(MAX_RESULT_CHARS + 128)
        )
        .unwrap();

        let snapshot = extract_subagent_transcript_snapshot(file.path()).unwrap();

        assert_eq!(snapshot.thinking_blocks, vec!["tail thought".to_string()]);
        assert_eq!(
            snapshot.final_result.as_ref().map(|s| s.chars().count()),
            Some(MAX_RESULT_CHARS)
        );
    }
}
