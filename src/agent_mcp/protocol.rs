//! Wire types for two protocols:
//!   1. **MCP JSON-RPC over stdio** — what the Claude CLI ↔ MCP grandchild speak.
//!   2. **IPC framing over the local socket** — what the grandchild ↔ Tauri parent speak.
//!
//! Both are line-delimited JSON to keep the implementation small and the
//! traffic easy to inspect.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// MCP JSON-RPC envelope (stdio)
// ---------------------------------------------------------------------------

pub const JSONRPC_VERSION: &str = "2.0";
pub const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

/// Reserved JSON-RPC error codes we use. The MCP spec is 2.0-compliant.
pub mod error_codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    /// Notifications carry no `id`; requests do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<serde_json::Value>,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl JsonRpcResponse {
    pub fn success(id: serde_json::Value, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.into(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: serde_json::Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.into(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// IPC framing (parent ↔ grandchild over interprocess socket)
// ---------------------------------------------------------------------------

/// Envelope sent from the MCP grandchild to the Tauri parent over the local
/// socket. Every request is authenticated by the bearer token issued at spawn
/// time (transmitted via env var `CLAUDETTE_MCP_TOKEN`). The token isn't a
/// security boundary against a local attacker — it just prevents stray
/// connections to the socket from being accepted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeRequest {
    pub token: String,
    pub payload: BridgePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BridgePayload {
    /// Deliver a file from disk as an inline chat attachment.
    SendAttachment {
        /// Absolute path to the file the agent wants to send.
        file_path: String,
        /// MIME type the agent declared. Validated against [`super::tools::send_to_user::policy`].
        media_type: String,
        /// Optional caption the agent attached.
        caption: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeResponse {
    pub ok: bool,
    /// Set on success — the row id assigned to the attachment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_id: Option<String>,
    /// Set on failure — human-readable message that gets surfaced back to
    /// the agent in the MCP tool result so the model can adjust.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BridgeResponse {
    pub fn ok(attachment_id: impl Into<String>) -> Self {
        Self {
            ok: true,
            attachment_id: Some(attachment_id.into()),
            error: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            attachment_id: None,
            error: Some(message.into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jsonrpc_request_round_trips() {
        let req = JsonRpcRequest {
            jsonrpc: JSONRPC_VERSION.into(),
            id: Some(json!(1)),
            method: "tools/call".into(),
            params: Some(json!({"name": "claudette__send_to_user"})),
        };
        let s = serde_json::to_string(&req).unwrap();
        let back: JsonRpcRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.method, "tools/call");
        assert_eq!(back.id, Some(json!(1)));
    }

    #[test]
    fn jsonrpc_notification_omits_id() {
        // Notifications (no id) are common in MCP — `notifications/initialized`
        // is sent right after the handshake.
        let req = JsonRpcRequest {
            jsonrpc: JSONRPC_VERSION.into(),
            id: None,
            method: "notifications/initialized".into(),
            params: None,
        };
        let s = serde_json::to_string(&req).unwrap();
        assert!(
            !s.contains("\"id\""),
            "notification must not serialize id: {s}"
        );
    }

    #[test]
    fn jsonrpc_error_response_shape() {
        let resp = JsonRpcResponse::error(json!(7), error_codes::METHOD_NOT_FOUND, "no such tool");
        let v = serde_json::to_value(&resp).unwrap();
        assert_eq!(v["error"]["code"], -32601);
        assert_eq!(v["error"]["message"], "no such tool");
        assert!(v.get("result").is_none() || v["result"].is_null());
    }

    #[test]
    fn bridge_send_attachment_round_trips() {
        let req = BridgeRequest {
            token: "abc".into(),
            payload: BridgePayload::SendAttachment {
                file_path: "/tmp/x.png".into(),
                media_type: "image/png".into(),
                caption: Some("look".into()),
            },
        };
        let s = serde_json::to_string(&req).unwrap();
        let back: BridgeRequest = serde_json::from_str(&s).unwrap();
        match back.payload {
            BridgePayload::SendAttachment {
                file_path,
                media_type,
                caption,
            } => {
                assert_eq!(file_path, "/tmp/x.png");
                assert_eq!(media_type, "image/png");
                assert_eq!(caption.as_deref(), Some("look"));
            }
        }
    }

    #[test]
    fn bridge_response_helpers() {
        let ok = BridgeResponse::ok("att-1");
        assert!(ok.ok);
        assert_eq!(ok.attachment_id.as_deref(), Some("att-1"));
        assert!(ok.error.is_none());

        let err = BridgeResponse::err("nope");
        assert!(!err.ok);
        assert!(err.attachment_id.is_none());
        assert_eq!(err.error.as_deref(), Some("nope"));
    }
}
