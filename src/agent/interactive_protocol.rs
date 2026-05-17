//! Wire-protocol types for the `claudette-session-host` sidecar.
//!
//! These types are also re-used by the in-process `SidecarHost` client and the
//! `claudette-session-host` binary, so they live in the library crate so both
//! sides see the same definitions.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Request {
    Hello {
        protocol_version: u32,
        claudette_version: String,
    },
    EnsureSession {
        sid: String,
        spec: SessionSpec,
    },
    Attach {
        sid: String,
    },
    SendInput {
        sid: String,
        payload: InputPayload,
    },
    CaptureScreen {
        sid: String,
    },
    Resize {
        sid: String,
        rows: u16,
        cols: u16,
    },
    Detach {
        sid: String,
        attach_id: u64,
    },
    Stop {
        sid: String,
        mode: StopMode,
    },
    Status,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    HelloAck {
        protocol_version: u32,
        host_version: String,
        pid: u32,
    },
    HelloNack {
        reason: String,
        supported_versions: Vec<u32>,
    },
    SessionStarted {
        sid: String,
        pid: u32,
        rows: u16,
        cols: u16,
    },
    AttachStarted {
        attach_id: u64,
    },
    Ok,
    ScreenSnapshot {
        rows: u16,
        cols: u16,
        ansi_bytes_b64: String,
    },
    Stopped {
        exit_status: i32,
    },
    Status {
        sessions: Vec<SessionSummary>,
        host_version: String,
    },
    Error {
        message: String,
        recoverable: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Output {
        sid: String,
        bytes_b64: String,
        seq: u64,
    },
    Hook {
        sid: String,
        hook: HookFired,
    },
    Exit {
        sid: String,
        exit_status: i32,
        reason: String,
    },
    StreamError {
        sid: String,
        message: String,
        recoverable: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSpec {
    pub working_dir: String,
    pub rows: u16,
    pub cols: u16,
    pub claude_binary: String,
    pub claude_args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub claude_config_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSummary {
    pub sid: String,
    pub pid: Option<u32>,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputPayload {
    Text { text: String },
    Keys { name: String },
    Bytes { bytes_b64: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopMode {
    Graceful,
    Force,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HookFired {
    Stop,
    Awaiting {
        reason: Option<String>,
    },
    PromptSubmitted,
    SubagentStop,
    Unknown {
        raw_kind: String,
        raw_payload: String,
    },
}

pub const PROTOCOL_VERSION: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<T>(value: &T)
    where
        T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
    {
        let json = serde_json::to_string(value).unwrap();
        let back: T = serde_json::from_str(&json).unwrap();
        assert_eq!(value, &back);
    }

    #[test]
    fn request_kinds_round_trip() {
        roundtrip(&Request::Hello {
            protocol_version: PROTOCOL_VERSION,
            claudette_version: "0.0.0".into(),
        });
        roundtrip(&Request::EnsureSession {
            sid: "x".into(),
            spec: SessionSpec {
                working_dir: "/tmp".into(),
                rows: 24,
                cols: 80,
                claude_binary: "/bin/claude".into(),
                claude_args: vec!["--model".into(), "opus".into()],
                env: vec![("FOO".into(), "BAR".into())],
                claude_config_dir: "/tmp/cfg".into(),
            },
        });
        roundtrip(&Request::SendInput {
            sid: "x".into(),
            payload: InputPayload::Text {
                text: "hello\r".into(),
            },
        });
        roundtrip(&Request::Stop {
            sid: "x".into(),
            mode: StopMode::Graceful,
        });
    }

    #[test]
    fn event_kinds_round_trip() {
        roundtrip(&Event::Output {
            sid: "x".into(),
            bytes_b64: "aGk=".into(),
            seq: 5,
        });
        roundtrip(&Event::Hook {
            sid: "x".into(),
            hook: HookFired::Awaiting {
                reason: Some("blocked on permission".into()),
            },
        });
    }

    #[test]
    fn hook_unknown_preserves_raw_for_schema_drift() {
        let v = HookFired::Unknown {
            raw_kind: "FutureHook".into(),
            raw_payload: "{\"a\":1}".into(),
        };
        roundtrip(&v);
    }
}
