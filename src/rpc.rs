//! Wire types for Claudette's request/response protocols.
//!
//! Both the local-IPC channel (`src-tauri/src/ipc.rs`) and the existing
//! WebSocket server (`claudette-server`) speak line-delimited JSON-RPC v2:
//! a request `{"id", "method", "params"}` and a response `{"id", "result"}`
//! or `{"id", "error": {"code", "message"}}`. This module defines the
//! shared shapes so the CLI client and either server-side speak the same
//! wire format without duplicate definitions.
//!
//! Method names are kept as strings rather than enums — every server
//! decides what it accepts, and a closed enum would force every callsite
//! to be patched whenever a new RPC is added (the CLI's `rpc <method>`
//! escape hatch and `capabilities` discovery work without it).

use serde::{Deserialize, Serialize};

/// Inbound request envelope.
///
/// `id` is opaque to the server — it's echoed in the matching response so
/// pipelined clients can correlate. `method` is a free-form string;
/// `params` is whatever JSON value the method accepts (typically an
/// object, but the type allows arrays/nulls so methods that take no
/// parameters can pass `null`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    pub id: serde_json::Value,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// Outbound response envelope. Exactly one of `result` and `error` is set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse {
    pub id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

/// JSON-RPC-style error payload. We don't use the full JSON-RPC code
/// table — `-1` is the universal "something went wrong" code and clients
/// rely on `message` for human-readable detail.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

impl RpcResponse {
    pub fn ok(id: serde_json::Value, result: serde_json::Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: serde_json::Value, message: impl Into<String>) -> Self {
        Self {
            id,
            result: None,
            error: Some(RpcError {
                code: -1,
                message: message.into(),
            }),
        }
    }
}

/// Capabilities record the IPC server returns from the `capabilities`
/// method. Lets CLI users discover the server's surface without
/// out-of-band documentation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capabilities {
    /// Wire-protocol identifier — `"claudette-ipc"` (local socket) or
    /// `"claudette-ws"` (remote WebSocket). Lets a single client speak to
    /// both surfaces and short-circuit on mismatched expectations.
    pub protocol: String,
    /// Protocol version. Bumped on backwards-incompatible wire changes.
    pub version: u32,
    /// App version that owns this surface (e.g. `"0.21.0"`).
    pub app_version: String,
    /// Sorted list of method names this surface accepts. Useful for
    /// `claudette-cli capabilities` to print a discovery list, and for
    /// future tab-completion.
    pub methods: Vec<String>,
}
