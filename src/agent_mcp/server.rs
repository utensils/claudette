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
use crate::agent_mcp::tools::interaction;
use crate::agent_mcp::tools::send_to_user::{
    ALLOWED_DOCUMENT_TYPES, ALLOWED_IMAGE_TYPES, allowed_text_types,
};

pub const ENV_SOCKET_ADDR: &str = "CLAUDETTE_MCP_SOCKET";
pub const ENV_TOKEN: &str = "CLAUDETTE_MCP_TOKEN";
pub const SEND_TO_USER_TOOL_NAME: &str = "send_to_user";
pub const SCHEDULE_WAKEUP_TOOL_NAME: &str = "ScheduleWakeup";
pub const CRON_CREATE_TOOL_NAME: &str = "CronCreate";
pub const CRON_LIST_TOOL_NAME: &str = "CronList";
pub const CRON_DELETE_TOOL_NAME: &str = "CronDelete";
pub const MONITOR_TOOL_NAME: &str = "Monitor";
pub const ASK_USER_TOOL_NAME: &str = "ask_user";
pub const REQUEST_REVIEW_TOOL_NAME: &str = "request_review";
pub const PRESENT_CONCLUSION_TOOL_NAME: &str = "present_conclusion";
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
            file inline in the user's chat surface and gives agents native \
            scheduling tools. Use `send_to_user` for deliverable artifacts. \
            Do NOT use it for arbitrary binaries, archives, or oversized \
            files; for those, tell the user the absolute path on disk. \
            Use `ScheduleWakeup` for one-shot delayed re-entry, `CronCreate`, \
            `CronList`, and `CronDelete` for recurring routines, and `Monitor` \
            to subscribe to background task output without polling. \
            For interaction with the user, prefer these Claudette-native tools \
            over plain chat text (and over harness-specific controls when \
            present): `ask_user` to ask one or more questions and wait for the \
            answer, `request_review` to have the user approve / deny / suggest \
            changes to a plan or decision and wait for their verdict, and \
            `present_conclusion` to deliver a final summary of completed work \
            (it is recorded in the transcript)."
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
            "name": SEND_TO_USER_TOOL_NAME,
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
        }, {
            "name": SCHEDULE_WAKEUP_TOOL_NAME,
            "description": "Schedule a one-shot native Claudette wakeup for this chat session. \
                           Provide either delaySeconds or fireAt. When it fires, Claudette \
                           persists a user-visible scheduled prompt and re-enters the agent.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "delaySeconds": { "type": "integer", "description": "Positive delay in seconds." },
                    "fireAt": { "type": "string", "description": "RFC3339 UTC/local timestamp to fire at." },
                    "prompt": { "type": "string", "description": "Prompt to send when the wakeup fires." },
                    "reason": { "type": "string", "description": "Optional short reason shown in the wakeup context." }
                },
                "required": ["prompt"]
            }
        }, {
            "name": CRON_CREATE_TOOL_NAME,
            "description": "Create a native Claudette scheduled routine using a standard 5-field cron expression in local time.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Optional stable name for manual run/delete." },
                    "cron": { "type": "string", "description": "Standard 5-field cron: minute hour day-of-month month day-of-week." },
                    "prompt": { "type": "string", "description": "Prompt to send each time the routine fires." },
                    "recurring": { "type": "boolean", "description": "true by default. false fires once at the next match then disables itself." }
                },
                "required": ["cron", "prompt"]
            }
        }, {
            "name": CRON_LIST_TOOL_NAME,
            "description": "List native Claudette scheduled wakeups and routines.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }, {
            "name": CRON_DELETE_TOOL_NAME,
            "description": "Delete a native Claudette scheduled routine by id or name.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Routine id or name." }
                },
                "required": ["id"]
            }
        }, {
            "name": MONITOR_TOOL_NAME,
            "description": "Subscribe this chat session to future output lines from a background Bash task. \
                           The task id must come from a prior Bash run_in_background result.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string", "description": "Background task id or originating tool_use_id." },
                    "until": { "type": "string", "description": "Optional condition the agent is waiting for." }
                },
                "required": ["task_id"]
            }
        }, {
            "name": ASK_USER_TOOL_NAME,
            "description": "REQUIRED way to ask the user a question in Claudette. Ask one or more \
                           questions and BLOCK until they answer. Use this instead of asking in \
                           plain chat text, and instead of any native/built-in question tool \
                           (e.g. AskUserQuestion) — `mcp__claudette__ask_user` is the correct \
                           tool here. Renders as interactive option buttons in the Claudette \
                           chat surface (the user can also type a freeform answer). Returns the \
                           user's answers keyed by question text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "description": "1–4 questions to ask.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question": { "type": "string", "description": "The full question text." },
                                "header": { "type": "string", "description": "Short label/chip for the question (optional)." },
                                "multiSelect": { "type": "boolean", "description": "Allow selecting multiple options (optional)." },
                                "options": {
                                    "type": "array",
                                    "description": "Up to 8 choices (optional). An 'Other'/freeform path always exists.",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "label": { "type": "string", "description": "The choice the user sees." },
                                            "description": { "type": "string", "description": "Optional explanation of the choice." }
                                        },
                                        "required": ["label"]
                                    }
                                }
                            },
                            "required": ["question"]
                        }
                    }
                },
                "required": ["questions"]
            }
        }, {
            "name": REQUEST_REVIEW_TOOL_NAME,
            "description": "REQUIRED way to get the user's sign-off on a plan or decision in \
                           Claudette. Ask the user to review and BLOCK until they respond with a \
                           verdict: approve, deny, or suggest changes (with an optional note). \
                           Call `mcp__claudette__request_review` (not plain chat) before acting \
                           on a plan or any consequential, hard-to-reverse decision. Returns the \
                           verdict and any note the user left.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "summary": { "type": "string", "description": "The plan or decision to review, as concise markdown." },
                    "detail": { "type": "string", "description": "Optional additional detail / rationale shown below the summary." }
                },
                "required": ["summary"]
            }
        }, {
            "name": PRESENT_CONCLUSION_TOOL_NAME,
            "description": "Call `mcp__claudette__present_conclusion` when you finish a unit of \
                           work to present a final summary. Recorded in the transcript and \
                           surfaced to the user as a conclusion card. Does NOT block — use it as \
                           you wrap up, not to ask a question. List any produced files in \
                           `artifacts` (deliver them separately with send_to_user if the user \
                           should see them inline).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "summary": { "type": "string", "description": "Markdown summary of what was done." },
                    "title": { "type": "string", "description": "Optional short headline for the conclusion card." },
                    "artifacts": {
                        "type": "array",
                        "description": "Optional list of file paths produced by the work.",
                        "items": { "type": "string" }
                    }
                },
                "required": ["summary"]
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
    let args = params.get("arguments").cloned().unwrap_or(Value::Null);
    match name {
        SEND_TO_USER_TOOL_NAME => handle_send_to_user_tool(id, args, socket_addr, token).await,
        SCHEDULE_WAKEUP_TOOL_NAME => {
            handle_schedule_wakeup_tool(id, args, socket_addr, token).await
        }
        CRON_CREATE_TOOL_NAME => handle_cron_create_tool(id, args, socket_addr, token).await,
        CRON_LIST_TOOL_NAME => {
            handle_simple_bridge_tool(id, BridgePayload::CronList, socket_addr, token).await
        }
        CRON_DELETE_TOOL_NAME => handle_cron_delete_tool(id, args, socket_addr, token).await,
        MONITOR_TOOL_NAME => handle_monitor_tool(id, args, socket_addr, token).await,
        ASK_USER_TOOL_NAME => handle_ask_user_tool(id, args, socket_addr, token).await,
        REQUEST_REVIEW_TOOL_NAME => handle_request_review_tool(id, args, socket_addr, token).await,
        PRESENT_CONCLUSION_TOOL_NAME => {
            handle_present_conclusion_tool(id, args, socket_addr, token).await
        }
        _ => JsonRpcResponse::error(
            id,
            error_codes::METHOD_NOT_FOUND,
            format!("no tool named {name:?}"),
        ),
    }
}

async fn handle_send_to_user_tool(
    id: Value,
    args: Value,
    socket_addr: &str,
    token: &str,
) -> JsonRpcResponse {
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

async fn handle_schedule_wakeup_tool(
    id: Value,
    args: Value,
    socket_addr: &str,
    token: &str,
) -> JsonRpcResponse {
    let prompt = match args.get("prompt").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return tool_error_result(id, "prompt is required"),
    };
    let payload = BridgePayload::ScheduleWakeup {
        delay_seconds: args
            .get("delaySeconds")
            .or_else(|| args.get("delay_seconds"))
            .and_then(|v| v.as_i64()),
        fire_at: args
            .get("fireAt")
            .or_else(|| args.get("fire_at"))
            .and_then(|v| v.as_str())
            .map(ToOwned::to_owned),
        prompt,
        reason: args
            .get("reason")
            .and_then(|v| v.as_str())
            .map(ToOwned::to_owned),
    };
    handle_simple_bridge_tool(id, payload, socket_addr, token).await
}

async fn handle_cron_create_tool(
    id: Value,
    args: Value,
    socket_addr: &str,
    token: &str,
) -> JsonRpcResponse {
    let cron_expr = match args
        .get("cron")
        .or_else(|| args.get("cron_expr"))
        .and_then(|v| v.as_str())
    {
        Some(s) => s.to_string(),
        None => return tool_error_result(id, "cron is required"),
    };
    let prompt = match args.get("prompt").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return tool_error_result(id, "prompt is required"),
    };
    let payload = BridgePayload::CronCreate {
        name: args
            .get("name")
            .and_then(|v| v.as_str())
            .map(ToOwned::to_owned),
        cron_expr,
        prompt,
        recurring: args
            .get("recurring")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
    };
    handle_simple_bridge_tool(id, payload, socket_addr, token).await
}

async fn handle_cron_delete_tool(
    id: Value,
    args: Value,
    socket_addr: &str,
    token: &str,
) -> JsonRpcResponse {
    let id_or_name = match args
        .get("id")
        .or_else(|| args.get("name"))
        .and_then(|v| v.as_str())
    {
        Some(s) => s.to_string(),
        None => return tool_error_result(id, "id is required"),
    };
    handle_simple_bridge_tool(
        id,
        BridgePayload::CronDelete { id: id_or_name },
        socket_addr,
        token,
    )
    .await
}

async fn handle_monitor_tool(
    id: Value,
    args: Value,
    socket_addr: &str,
    token: &str,
) -> JsonRpcResponse {
    let task_id = match args
        .get("task_id")
        .or_else(|| args.get("taskId"))
        .and_then(|v| v.as_str())
    {
        Some(s) => s.to_string(),
        None => return tool_error_result(id, "task_id is required"),
    };
    handle_simple_bridge_tool(
        id,
        BridgePayload::Monitor {
            task_id,
            until: args
                .get("until")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned),
        },
        socket_addr,
        token,
    )
    .await
}

async fn handle_ask_user_tool(
    id: Value,
    args: Value,
    socket_addr: &str,
    token: &str,
) -> JsonRpcResponse {
    let questions = match args.get("questions") {
        Some(q) => q.clone(),
        None => return generic_tool_error_result(id, "questions is required"),
    };
    let questions = match interaction::validate_questions(&questions) {
        Ok(q) => q,
        Err(e) => return generic_tool_error_result(id, &e),
    };
    handle_simple_bridge_tool(id, BridgePayload::AskUser { questions }, socket_addr, token).await
}

async fn handle_request_review_tool(
    id: Value,
    args: Value,
    socket_addr: &str,
    token: &str,
) -> JsonRpcResponse {
    let summary = match args.get("summary").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return generic_tool_error_result(id, "summary is required"),
    };
    if let Err(e) = interaction::validate_summary(&summary, "summary") {
        return generic_tool_error_result(id, &e);
    }
    let detail = args
        .get("detail")
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned);
    handle_simple_bridge_tool(
        id,
        BridgePayload::RequestReview {
            summary,
            detail,
            options: None,
        },
        socket_addr,
        token,
    )
    .await
}

async fn handle_present_conclusion_tool(
    id: Value,
    args: Value,
    socket_addr: &str,
    token: &str,
) -> JsonRpcResponse {
    let summary = match args.get("summary").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return generic_tool_error_result(id, "summary is required"),
    };
    if let Err(e) = interaction::validate_summary(&summary, "summary") {
        return generic_tool_error_result(id, &e);
    }
    let title = args
        .get("title")
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned);
    let artifacts = args.get("artifacts").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(ToOwned::to_owned))
            .collect::<Vec<_>>()
    });
    handle_simple_bridge_tool(
        id,
        BridgePayload::PresentConclusion {
            title,
            summary,
            artifacts,
        },
        socket_addr,
        token,
    )
    .await
}

async fn handle_simple_bridge_tool(
    id: Value,
    payload: BridgePayload,
    socket_addr: &str,
    token: &str,
) -> JsonRpcResponse {
    let bridge_req = BridgeRequest {
        token: token.to_string(),
        payload,
    };
    match send_to_bridge(socket_addr, &bridge_req).await {
        Ok(BridgeResponse {
            ok: true,
            message,
            data,
            ..
        }) => generic_tool_success_result(id, message.unwrap_or_else(|| "ok".to_string()), data),
        Ok(BridgeResponse {
            error: Some(msg), ..
        }) => generic_tool_error_result(id, &msg),
        Ok(_) => generic_tool_error_result(id, "bridge returned malformed response"),
        Err(e) => generic_tool_error_result(id, &format!("bridge IPC failed: {e}")),
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

/// Tool-result error without the `send_to_user`-specific prefix. Used by every
/// tool that routes through [`handle_simple_bridge_tool`] (cron, scheduling,
/// monitor, ask/review/conclude) so the message the model sees isn't mislabeled.
fn generic_tool_error_result(id: Value, message: &str) -> JsonRpcResponse {
    JsonRpcResponse::success(
        id,
        json!({
            "content": [{ "type": "text", "text": message }],
            "isError": true,
        }),
    )
}

fn generic_tool_success_result(id: Value, message: String, data: Option<Value>) -> JsonRpcResponse {
    let text = if let Some(data) = data {
        format!(
            "{message}\n{}",
            serde_json::to_string_pretty(&data).unwrap_or(data.to_string())
        )
    } else {
        message
    };
    JsonRpcResponse::success(
        id,
        json!({
            "content": [{ "type": "text", "text": text }],
            "isError": false,
        }),
    )
}

/// Open a fresh connection to the parent for a single round trip. The
/// per-call connection is intentional — keeps state simple and means a
/// flaky parent doesn't poison subsequent calls.
pub(crate) async fn send_to_bridge(
    socket_addr: &str,
    req: &BridgeRequest,
) -> io::Result<BridgeResponse> {
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
            names.contains(&SEND_TO_USER_TOOL_NAME),
            "{names:?} should contain {SEND_TO_USER_TOOL_NAME}"
        );
        assert!(names.contains(&SCHEDULE_WAKEUP_TOOL_NAME));
        assert!(names.contains(&CRON_CREATE_TOOL_NAME));
        assert!(names.contains(&MONITOR_TOOL_NAME));
        assert!(names.contains(&ASK_USER_TOOL_NAME));
        assert!(names.contains(&REQUEST_REVIEW_TOOL_NAME));
        assert!(names.contains(&PRESENT_CONCLUSION_TOOL_NAME));
    }

    #[tokio::test]
    async fn ask_user_rejects_missing_questions() {
        // Validation happens in the grandchild before any bridge round trip,
        // so a malformed call returns an isError result without a socket.
        let req = json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": { "name": ASK_USER_TOOL_NAME, "arguments": {} }
        });
        let input = format!("{req}\n");
        let resps = drive_serve(&input, "ignored", "ignored").await;
        assert_eq!(resps[0]["result"]["isError"], true);
        let text = resps[0]["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("questions is required"), "got: {text}");
    }

    #[tokio::test]
    async fn request_review_rejects_empty_summary() {
        let req = json!({
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": { "name": REQUEST_REVIEW_TOOL_NAME, "arguments": { "summary": "  " } }
        });
        let input = format!("{req}\n");
        let resps = drive_serve(&input, "ignored", "ignored").await;
        assert_eq!(resps[0]["result"]["isError"], true);
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
                "name": SEND_TO_USER_TOOL_NAME,
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
                "name": SEND_TO_USER_TOOL_NAME,
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
