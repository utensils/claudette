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

/// Wire-level envelope for client→host requests.
///
/// Every request frame on the socket is one of these. The `request_id` is a
/// client-side monotonic u64 that the server echoes back in the matching
/// `InboundFrame::Response` so a single connection can multiplex multiple
/// in-flight requests. By convention the initial `Request::Hello` carries
/// `request_id == 0`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RequestEnvelope {
    pub request_id: u64,
    pub request: Request,
}

/// Wire-level envelope for host→client frames.
///
/// Responses carry the originating `request_id` for correlation; events are
/// fire-and-forget (the per-session `sid` inside the `Event` is the only
/// routing key). Encoded as an untagged enum so the wire shape stays
/// `{ "request_id": .., "response": .. }` for responses and the bare event
/// JSON for events — distinguishable by the presence of `request_id`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum InboundFrame {
    Response { request_id: u64, response: Response },
    Event(Event),
}

pub mod frame {
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

    pub const MAX_FRAME: usize = 8 * 1024 * 1024; // 8 MB ceiling.

    pub async fn write_frame<W: AsyncWrite + Unpin>(
        w: &mut W,
        payload: &[u8],
    ) -> std::io::Result<()> {
        let len =
            u32::try_from(payload.len()).map_err(|_| std::io::Error::other("frame too large"))?;
        w.write_all(&len.to_be_bytes()).await?;
        w.write_all(payload).await?;
        Ok(())
    }

    pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Vec<u8>> {
        let mut hdr = [0u8; 4];
        r.read_exact(&mut hdr).await?;
        let len = u32::from_be_bytes(hdr) as usize;
        if len > MAX_FRAME {
            return Err(std::io::Error::other("frame too large"));
        }
        let mut buf = vec![0u8; len];
        r.read_exact(&mut buf).await?;
        Ok(buf)
    }
}

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

    #[test]
    fn request_envelope_round_trips() {
        let env = RequestEnvelope {
            request_id: 42,
            request: Request::Status,
        };
        let s = serde_json::to_string(&env).unwrap();
        let back: RequestEnvelope = serde_json::from_str(&s).unwrap();
        assert_eq!(back.request_id, 42);
        assert_eq!(back, env);
    }

    #[test]
    fn inbound_frame_response_round_trips() {
        let frame = InboundFrame::Response {
            request_id: 7,
            response: Response::Ok,
        };
        let s = serde_json::to_string(&frame).unwrap();
        let back: InboundFrame = serde_json::from_str(&s).unwrap();
        assert_eq!(back, frame);
    }

    #[test]
    fn inbound_frame_event_round_trips() {
        let ev = Event::Output {
            sid: "x".into(),
            bytes_b64: "aGk=".into(),
            seq: 1,
        };
        let frame = InboundFrame::Event(ev.clone());
        let s = serde_json::to_string(&frame).unwrap();
        let back: InboundFrame = serde_json::from_str(&s).unwrap();
        match back {
            InboundFrame::Event(got) => assert_eq!(got, ev),
            other => panic!("expected Event variant, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod frame_tests {
    use super::frame::{read_frame, write_frame};
    use tokio::io::{AsyncWriteExt, duplex};

    #[tokio::test]
    async fn frame_round_trip() {
        let (mut a, mut b) = duplex(64 * 1024);
        write_frame(&mut a, b"{\"hi\":1}").await.unwrap();
        a.shutdown().await.unwrap();
        let buf = read_frame(&mut b).await.unwrap();
        assert_eq!(buf, b"{\"hi\":1}");
    }

    #[tokio::test]
    async fn frame_rejects_oversized() {
        let (mut a, mut b) = duplex(64 * 1024);
        // 100 MB header — must reject without allocating.
        let header = (100u32 * 1024 * 1024).to_be_bytes();
        a.write_all(&header).await.unwrap();
        let err = read_frame(&mut b).await.unwrap_err();
        assert!(err.to_string().contains("frame too large"), "got: {err}");
    }

    #[tokio::test]
    async fn frame_rejects_truncated_header() {
        let (mut a, mut b) = duplex(64 * 1024);
        // Write only 2 bytes of the 4-byte length prefix, then close the
        // writer so the reader observes EOF instead of hanging.
        a.write_all(&[0u8, 0u8]).await.unwrap();
        a.shutdown().await.unwrap();
        let err = read_frame(&mut b).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof, "got: {err}");
    }

    #[tokio::test]
    async fn frame_rejects_partial_payload() {
        let (mut a, mut b) = duplex(64 * 1024);
        // Announce a 100-byte payload but only deliver 50 before closing.
        let header = 100u32.to_be_bytes();
        a.write_all(&header).await.unwrap();
        a.write_all(&[0u8; 50]).await.unwrap();
        a.shutdown().await.unwrap();
        let err = read_frame(&mut b).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof, "got: {err}");
    }

    #[tokio::test]
    async fn frame_accepts_zero_length_payload() {
        let (mut a, mut b) = duplex(64 * 1024);
        // A zero-length payload is a valid frame: just the 4-byte length=0
        // header with no body.
        a.write_all(&[0u8, 0u8, 0u8, 0u8]).await.unwrap();
        a.shutdown().await.unwrap();
        let buf = read_frame(&mut b).await.unwrap();
        assert_eq!(buf, Vec::<u8>::new());
    }
}
