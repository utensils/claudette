//! Stdio MCP server. Runs as a grandchild of the Tauri parent: the parent
//! tells the Claude CLI (via `--mcp-config`) to spawn `claudette-tauri
//! --agent-mcp`, and the CLI hands stdin/stdout to that grandchild as the
//! MCP transport. The grandchild authenticates back to the parent over a
//! local socket whose address + token come in via env vars.
//!
//! Wire format: line-delimited JSON-RPC 2.0 (one request per line on stdin,
//! one response per line on stdout). Notifications (no `id`) get no reply.

use std::io;

use interprocess::local_socket::tokio::{Stream, prelude::*};
use interprocess::local_socket::{GenericFilePath, GenericNamespaced, Name};

#[cfg(unix)]
#[allow(dead_code)]
const _UNUSED_ON_UNIX: Option<GenericNamespaced> = None;
#[cfg(windows)]
#[allow(dead_code)]
const _UNUSED_ON_WINDOWS: Option<GenericFilePath> = None;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::agent_mcp::protocol::{
    BridgePayload, BridgeRequest, BridgeResponse, JsonRpcRequest, JsonRpcResponse,
    MCP_PROTOCOL_VERSION, error_codes,
};
use crate::agent_mcp::tools::send_to_user::{
    ALLOWED_DOCUMENT_TYPES, ALLOWED_IMAGE_TYPES, allowed_text_types,
};

pub const ENV_SOCKET_ADDR: &str = "CLAUDETTE_MCP_SOCKET";
pub const ENV_TOKEN: &str = "CLAUDETTE_MCP_TOKEN";
pub const TOOL_NAME: &str = "send_to_user";
pub const SERVER_NAME: &str = "claudette";

/// Run the stdio MCP server until stdin EOFs.
///
/// Reads `CLAUDETTE_MCP_SOCKET` and `CLAUDETTE_MCP_TOKEN` from the environment
/// to know how to talk back to the parent. If either is missing, returns an
/// error immediately so a misconfigured spawn fails loud.
pub async fn run_stdio() -> io::Result<()> {
    let socket_addr = std::env::var(ENV_SOCKET_ADDR)
        .map_err(|_| io::Error::other(format!("{ENV_SOCKET_ADDR} not set")))?;
    let token =
        std::env::var(ENV_TOKEN).map_err(|_| io::Error::other(format!("{ENV_TOKEN} not set")))?;

    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    serve(BufReader::new(stdin), &mut stdout, &socket_addr, &token).await
}

/// Generic server loop, parameterised over the IO so we can unit-test it
/// against in-memory pipes.
pub async fn serve<R, W>(
    mut reader: R,
    writer: &mut W,
    socket_addr: &str,
    token: &str,
) -> io::Result<()>
where
    R: AsyncBufReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Ok(());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<JsonRpcRequest>(trimmed) {
            Err(e) => Some(JsonRpcResponse::error(
                Value::Null,
                error_codes::PARSE_ERROR,
                format!("parse error: {e}"),
            )),
            Ok(req) => handle_request(req, socket_addr, token).await,
        };

        if let Some(resp) = response {
            let mut bytes = serde_json::to_vec(&resp)
                .map_err(|e| io::Error::other(format!("serialize response: {e}")))?;
            bytes.push(b'\n');
            writer.write_all(&bytes).await?;
            writer.flush().await?;
        }
    }
}

async fn handle_request(
    req: JsonRpcRequest,
    socket_addr: &str,
    token: &str,
) -> Option<JsonRpcResponse> {
    // Notifications carry no id and expect no response.
    let id = req.id.clone()?;

    match req.method.as_str() {
        "initialize" => Some(JsonRpcResponse::success(id, initialize_result())),
        "tools/list" => Some(JsonRpcResponse::success(id, tools_list_result())),
        "tools/call" => Some(handle_tools_call(id, req.params, socket_addr, token).await),
        _ => Some(JsonRpcResponse::error(
            id,
            error_codes::METHOD_NOT_FOUND,
            format!("method not found: {}", req.method),
        )),
    }
}

fn initialize_result() -> Value {
    // The `instructions` field is the spec-blessed channel for telling the
    // host (and through it, the model) when this server is relevant. It
    // complements the per-tool description rather than duplicating it: the
    // tool description covers *how* to call `send_to_user`, this paragraph
    // covers *when* the whole server is the right tool to reach for.
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": "The Claudette MCP server lets the agent deliver a \
            file inline in the user's chat surface. Use `send_to_user` whenever \
            you produce a deliverable artifact the user should be able to view \
            or download immediately — generated images, PDFs, or short \
            text-shaped data files (CSV, Markdown, JSON, plain text). Do NOT \
            use it for arbitrary binaries, archives, or oversized files; for \
            those, tell the user the absolute path on disk so they can open \
            them themselves."
    })
}

fn tools_list_result() -> Value {
    let allowed_types: Vec<&str> = ALLOWED_IMAGE_TYPES
        .iter()
        .chain(ALLOWED_DOCUMENT_TYPES.iter())
        .copied()
        .chain(allowed_text_types())
        .collect();

    json!({
        "tools": [{
            "name": TOOL_NAME,
            "description": "Deliver a file to the user inline in the Claudette chat surface. \
                           Supported types: images (PNG/JPEG/GIF/WebP/SVG), PDF, plain text, \
                           CSV, JSON, and Markdown. Each type has its own size cap; the call \
                           is rejected for oversized or unsupported types. The file must \
                           already exist on disk — pass its absolute path. Renders inline \
                           with a type-aware preview; the user can click to enlarge or \
                           download. For anything outside the supported set (binaries, \
                           archives, oversized files), do NOT call this tool — instead, \
                           tell the user the absolute path on disk so they can open it \
                           manually.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute path to the file on the local filesystem."
                    },
                    "media_type": {
                        "type": "string",
                        "description": "MIME type of the file.",
                        "enum": allowed_types,
                    },
                    "caption": {
                        "type": "string",
                        "description": "Optional caption shown alongside the attachment."
                    }
                },
                "required": ["file_path", "media_type"]
            }
        }]
    })
}

async fn handle_tools_call(
    id: Value,
    params: Option<Value>,
    socket_addr: &str,
    token: &str,
) -> JsonRpcResponse {
    let params = match params {
        Some(p) => p,
        None => {
            return JsonRpcResponse::error(
                id,
                error_codes::INVALID_PARAMS,
                "missing params for tools/call",
            );
        }
    };

    let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
    if name != TOOL_NAME {
        return JsonRpcResponse::error(
            id,
            error_codes::METHOD_NOT_FOUND,
            format!("no tool named {name:?}"),
        );
    }

    let args = params.get("arguments").cloned().unwrap_or(Value::Null);
    let file_path = match args.get("file_path").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            return tool_error_result(id, "file_path is required");
        }
    };
    let media_type = match args.get("media_type").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            return tool_error_result(id, "media_type is required");
        }
    };
    let caption = args
        .get("caption")
        .and_then(|v| v.as_str())
        .map(String::from);

    let bridge_req = BridgeRequest {
        token: token.to_string(),
        payload: BridgePayload::SendAttachment {
            file_path: file_path.clone(),
            media_type: media_type.clone(),
            caption: caption.clone(),
        },
    };

    match send_to_bridge(socket_addr, &bridge_req).await {
        Ok(BridgeResponse {
            ok: true,
            attachment_id: Some(att_id),
            ..
        }) => tool_success_result(id, att_id, &file_path, caption.as_deref()),
        Ok(BridgeResponse {
            error: Some(msg), ..
        }) => tool_error_result(id, &msg),
        Ok(_) => tool_error_result(id, "bridge returned malformed response"),
        Err(e) => tool_error_result(id, &format!("bridge IPC failed: {e}")),
    }
}

fn tool_success_result(
    id: Value,
    attachment_id: String,
    file_path: &str,
    caption: Option<&str>,
) -> JsonRpcResponse {
    let filename = std::path::Path::new(file_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(file_path);
    let mut text = format!("Delivered {filename} to the user inline (id: {attachment_id}).");
    if let Some(c) = caption {
        text.push_str(&format!(" Caption: {c}"));
    }
    JsonRpcResponse::success(
        id,
        json!({
            "content": [{ "type": "text", "text": text }],
            "isError": false,
        }),
    )
}

fn tool_error_result(id: Value, message: &str) -> JsonRpcResponse {
    JsonRpcResponse::success(
        id,
        json!({
            "content": [{ "type": "text", "text": format!("send_to_user failed: {message}") }],
            "isError": true,
        }),
    )
}

/// Open a fresh connection to the parent for a single round trip. The
/// per-call connection is intentional — keeps state simple and means a
/// flaky parent doesn't poison subsequent calls.
async fn send_to_bridge(socket_addr: &str, req: &BridgeRequest) -> io::Result<BridgeResponse> {
    let name = name_for(socket_addr).map_err(io::Error::other)?;
    let conn = Stream::connect(name).await?;
    let mut reader = BufReader::new(&conn);
    let mut writer = &conn;
    let mut bytes = serde_json::to_vec(req)
        .map_err(|e| io::Error::other(format!("serialize bridge request: {e}")))?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await?;

    let mut line = String::new();
    reader.read_line(&mut line).await?;
    serde_json::from_str(line.trim())
        .map_err(|e| io::Error::other(format!("parse bridge response: {e}")))
}

fn name_for(addr: &str) -> Result<Name<'static>, String> {
    let owned = addr.to_string();
    #[cfg(unix)]
    {
        owned
            .to_fs_name::<GenericFilePath>()
            .map_err(|e| format!("fs name {addr}: {e}"))
    }
    #[cfg(windows)]
    {
        owned
            .to_ns_name::<GenericNamespaced>()
            .map_err(|e| format!("ns name {addr}: {e}"))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = owned;
        Err("unsupported platform".into())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_mcp::bridge::{McpBridgeSession, Sink};
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};

    /// Walk `serve` through a scripted set of input lines, collecting the
    /// JSON responses written back. The bridge connection is unused for
    /// inputs that don't reach `tools/call`.
    async fn drive_serve(input: &str, socket_addr: &str, token: &str) -> Vec<Value> {
        let (mut client, server) = duplex(64 * 1024);
        let (mut server_out, mut client_out) = duplex(64 * 1024);

        // Feed input in a separate task.
        let inp = input.to_string();
        let writer_task = tokio::spawn(async move {
            client.write_all(inp.as_bytes()).await.unwrap();
            client.shutdown().await.unwrap();
        });

        let socket_addr = socket_addr.to_string();
        let token = token.to_string();
        let server_task = tokio::spawn(async move {
            let mut reader = BufReader::new(server);
            super::serve(&mut reader, &mut server_out, &socket_addr, &token)
                .await
                .unwrap();
        });

        // Read all output.
        let mut buf = Vec::new();
        client_out.read_to_end(&mut buf).await.unwrap();
        let _ = writer_task.await;
        let _ = server_task.await;

        let s = String::from_utf8(buf).unwrap();
        s.lines()
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_str(l).expect("valid json"))
            .collect()
    }

    #[tokio::test]
    async fn initialize_returns_protocol_version_and_capabilities() {
        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {}
        });
        let input = format!("{req}\n");
        let resps = drive_serve(&input, "ignored", "ignored").await;
        assert_eq!(resps.len(), 1);
        let r = &resps[0];
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], MCP_PROTOCOL_VERSION);
        assert_eq!(r["result"]["serverInfo"]["name"], SERVER_NAME);
        assert!(r["result"]["capabilities"]["tools"].is_object());
        // The `instructions` field is what spec-compliant hosts surface to
        // the model so it knows when the whole server is relevant. Confirm
        // it ships and mentions both the affirmative use case and the
        // explicit "do not use for X" guard so future edits don't quietly
        // drop the latter.
        let instructions = r["result"]["instructions"]
            .as_str()
            .expect("instructions field is required");
        assert!(
            instructions.contains("send_to_user"),
            "instructions should mention send_to_user, got: {instructions}"
        );
        assert!(
            instructions.to_lowercase().contains("do not"),
            "instructions should describe when NOT to use, got: {instructions}"
        );
    }

    #[tokio::test]
    async fn tools_list_advertises_send_to_user() {
        let req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
        });
        let input = format!("{req}\n");
        let resps = drive_serve(&input, "ignored", "ignored").await;
        let tools = &resps[0]["result"]["tools"];
        assert!(tools.is_array());
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(
            names.contains(&TOOL_NAME),
            "{names:?} should contain {TOOL_NAME}"
        );
    }

    #[tokio::test]
    async fn unknown_method_returns_error() {
        let req = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "no/such/thing",
        });
        let input = format!("{req}\n");
        let resps = drive_serve(&input, "ignored", "ignored").await;
        assert_eq!(resps[0]["error"]["code"], error_codes::METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn notification_receives_no_response() {
        let req = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        });
        let input = format!("{req}\n");
        let resps = drive_serve(&input, "ignored", "ignored").await;
        assert!(resps.is_empty(), "notifications must not get a response");
    }

    #[tokio::test]
    async fn parse_error_returns_jsonrpc_parse_error() {
        let input = "not-json\n";
        let resps = drive_serve(input, "ignored", "ignored").await;
        assert_eq!(resps[0]["error"]["code"], error_codes::PARSE_ERROR);
    }

    // --- end-to-end with real bridge ---

    struct EchoSink {
        count: AtomicU32,
    }

    impl Sink for EchoSink {
        fn handle(
            &self,
            _payload: BridgePayload,
        ) -> Pin<Box<dyn Future<Output = BridgeResponse> + Send + '_>> {
            Box::pin(async move {
                self.count.fetch_add(1, Ordering::SeqCst);
                BridgeResponse::ok("att-from-bridge")
            })
        }
    }

    #[tokio::test]
    async fn tools_call_send_to_user_round_trips_through_bridge() {
        let sink = Arc::new(EchoSink {
            count: AtomicU32::new(0),
        });
        let session = McpBridgeSession::start(Arc::clone(&sink)).await.unwrap();
        let handle = session.handle().clone();

        let req = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {
                "name": TOOL_NAME,
                "arguments": {
                    "file_path": "/tmp/example.png",
                    "media_type": "image/png",
                    "caption": "the screenshot"
                }
            }
        });
        let input = format!("{req}\n");
        let resps = drive_serve(&input, &handle.socket_addr, &handle.token).await;
        assert_eq!(resps.len(), 1);
        let r = &resps[0];
        assert_eq!(r["id"], 7);
        assert_eq!(r["result"]["isError"], false);
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("att-from-bridge"), "got: {text}");
        assert!(text.contains("example.png"), "got: {text}");
        assert_eq!(sink.count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn tools_call_with_bad_token_returns_error_text() {
        // Bridge expects a different token than what the server sends.
        let sink = Arc::new(EchoSink {
            count: AtomicU32::new(0),
        });
        let session = McpBridgeSession::start(Arc::clone(&sink)).await.unwrap();
        let handle = session.handle().clone();

        let req = json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {
                "name": TOOL_NAME,
                "arguments": {
                    "file_path": "/tmp/x.png",
                    "media_type": "image/png"
                }
            }
        });
        let input = format!("{req}\n");
        let resps = drive_serve(&input, &handle.socket_addr, "wrong-token").await;
        let r = &resps[0];
        assert_eq!(r["result"]["isError"], true);
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("unauthorized"), "got: {text}");
        assert_eq!(sink.count.load(Ordering::SeqCst), 0);
    }
}
