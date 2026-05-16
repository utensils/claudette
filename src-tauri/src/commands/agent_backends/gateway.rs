//! BackendGateway: a tiny TCP/HTTP server we spin up per-backend so
//! the Anthropic-shape Claude CLI subprocess can talk to a non-Anthropic
//! upstream (cloud OpenAI, Codex subscription, LM Studio, etc.) without
//! knowing the difference. Each gateway is keyed on
//! (backend, secret, model) — change any one and we tear down the old
//! listener and spawn a fresh one with new auth + a new bearer token.
//!
//! Wire-format translation is delegated to [`gateway_translate`].

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;
use claudette::agent_backend::{AgentBackendConfig, AgentBackendKind};
use rand::RngCore;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, RwLock};

use super::config::runtime_hash;
use super::gateway_translate::{
    call_openai_responses, proxy_anthropic_messages, write_anthropic_error_response,
};

#[derive(Debug, Clone)]
struct GatewayServer {
    base_url: String,
    auth_token: String,
    hash: String,
    cancel: Arc<Notify>,
}

#[derive(Default)]
pub struct BackendGateway {
    servers: RwLock<HashMap<String, GatewayServer>>,
}

impl BackendGateway {
    pub fn new() -> Self {
        Self::default()
    }

    pub(super) async fn ensure(
        &self,
        config: AgentBackendConfig,
        upstream_secret: Option<String>,
        model: Option<String>,
    ) -> Result<(String, String, String), String> {
        let hash = runtime_hash(&config, upstream_secret.as_deref(), model.as_deref());
        if let Some(existing) = self.servers.read().await.get(&config.id)
            && existing.hash == hash
        {
            // Reuse path: every chat session that hits the same backend
            // with matching (config, secret, model) shares this single
            // gateway URL + auth token. Stamp the reuse so a postmortem
            // can tell when N concurrent sessions are funneling through
            // one process — the cardinality matters for diagnosing
            // whether a leak rides on the shared surface.
            tracing::debug!(
                target: "claudette::backend",
                backend_id = %config.id,
                model = ?model,
                base_url = %existing.base_url,
                "gateway reuse"
            );
            return Ok((existing.base_url.clone(), existing.auth_token.clone(), hash));
        }

        if let Some(existing) = self.servers.write().await.remove(&config.id) {
            tracing::info!(
                target: "claudette::backend",
                backend_id = %config.id,
                model = ?model,
                "config drift — tearing down old gateway"
            );
            existing.cancel.notify_waiters();
        }

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("Failed to bind backend gateway: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to read gateway address: {e}"))?
            .port();
        let base_url = format!("http://127.0.0.1:{port}");
        let auth_token = generate_gateway_token();
        let cancel = Arc::new(Notify::new());
        let server = GatewayServer {
            base_url: base_url.clone(),
            auth_token: auth_token.clone(),
            hash: hash.clone(),
            cancel: Arc::clone(&cancel),
        };
        self.servers.write().await.insert(config.id.clone(), server);

        tokio::spawn(run_gateway(
            listener,
            cancel,
            config,
            upstream_secret,
            auth_token.clone(),
        ));
        Ok((base_url, auth_token, hash))
    }
}

fn generate_gateway_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

async fn run_gateway(
    listener: TcpListener,
    cancel: Arc<Notify>,
    config: AgentBackendConfig,
    upstream_secret: Option<String>,
    auth_token: String,
) {
    let local_addr = listener
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| "<unknown>".to_string());
    tracing::info!(
        target: "claudette::backend",
        backend_id = %config.id,
        backend_label = %config.label,
        addr = %local_addr,
        "gateway listening"
    );
    loop {
        tokio::select! {
            _ = cancel.notified() => {
                tracing::info!(
                    target: "claudette::backend",
                    backend_id = %config.id,
                    addr = %local_addr,
                    "gateway shutting down"
                );
                break;
            }
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                let config = config.clone();
                let upstream_secret = upstream_secret.clone();
                let auth_token = auth_token.clone();
                let backend_id = config.id.clone();
                tokio::spawn(async move {
                    if let Err(err) =
                        handle_gateway_connection(stream, config, upstream_secret, &auth_token).await
                    {
                        // Connection-scoped errors carry both the
                        // backend id and the peer endpoint so a
                        // postmortem can tie a failure to the specific
                        // Claude CLI process that hit the gateway.
                        tracing::warn!(
                            target: "claudette::backend",
                            backend_id = %backend_id,
                            peer = %peer,
                            error = %err,
                            "gateway connection error"
                        );
                    }
                });
            }
        }
    }
}

async fn handle_gateway_connection(
    mut stream: TcpStream,
    config: AgentBackendConfig,
    upstream_secret: Option<String>,
    auth_token: &str,
) -> Result<(), String> {
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 4096];
    let header_end = loop {
        let n = stream
            .read(&mut tmp)
            .await
            .map_err(|e| format!("read failed: {e}"))?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() > 1024 * 1024 {
            return Err("request headers too large".to_string());
        }
    };
    let header = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = header.lines();
    let request_line = lines.next().ok_or("missing request line")?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or("").to_string();
    let path = request_parts.next().unwrap_or("").to_string();
    let route_path = route_path(&path);
    if gateway_route_requires_auth(&method, route_path)
        && !gateway_auth_matches(&header, auth_token)
    {
        return write_json_response(
            &mut stream,
            401,
            json!({"type":"error","error":{"type":"authentication_error","message":"Unauthorized"}}),
        )
        .await;
    }
    let content_length = header
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    let body_start = header_end + 4;
    while buf.len() < body_start + content_length {
        let n = stream
            .read(&mut tmp)
            .await
            .map_err(|e| format!("body read failed: {e}"))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body = &buf[body_start..usize::min(buf.len(), body_start + content_length)];
    match (method.as_str(), route_path) {
        ("HEAD", "/") | ("HEAD", "/health") => write_empty_response(&mut stream, 200).await,
        ("GET", "/health") => write_json_response(&mut stream, 200, json!({"ok": true})).await,
        ("GET", "/v1/models") => {
            let data: Vec<_> = config
                .manual_models
                .iter()
                .chain(config.discovered_models.iter())
                .map(|model| json!({"id": model.id, "display_name": model.label, "type": "model"}))
                .collect();
            write_json_response(&mut stream, 200, json!({"data": data})).await
        }
        ("POST", "/v1/messages/count_tokens") => {
            let req = serde_json::from_slice::<Value>(body).unwrap_or_else(|_| json!({}));
            let approx = req.to_string().len() / 4;
            write_json_response(&mut stream, 200, json!({"input_tokens": approx})).await
        }
        ("POST", "/v1/messages") => {
            let req = serde_json::from_slice::<Value>(body)
                .map_err(|e| format!("invalid messages request: {e}"))?;
            // LM Studio speaks Anthropic's wire format natively — there's
            // no OpenAI-Responses translation work to do, just forward
            // bytes. The pass-through writes the response (including
            // streaming SSE) directly to the client TCP stream so we
            // preserve TTFT, and intercepts non-2xx upstream responses
            // to apply the same status-demotion logic the gateway uses
            // for OpenAI-shape backends (otherwise LM Studio's HTTP 500
            // for context-overflow triggers the SDK's retry-with-backoff
            // path and the user sees a multi-minute spinner instead of
            // the actual error message).
            if config.kind == AgentBackendKind::LmStudio {
                match proxy_anthropic_messages(&config, &req, &mut stream).await {
                    Ok(()) => Ok(()),
                    Err(err) => write_anthropic_error_response(&mut stream, err).await,
                }
            } else {
                let response =
                    call_openai_responses(&config, upstream_secret.as_deref(), req).await;
                match response {
                    Ok(message) => write_json_or_sse_response(&mut stream, message).await,
                    Err(err) => write_anthropic_error_response(&mut stream, err).await,
                }
            }
        }
        _ => {
            write_json_response(
                &mut stream,
                404,
                json!({"type":"error","error":{"type":"not_found","message":"Not found"}}),
            )
            .await
        }
    }
}

pub(super) fn gateway_route_requires_auth(method: &str, route_path: &str) -> bool {
    !matches!(
        (method, route_path),
        ("HEAD", "/") | ("HEAD", "/health") | ("GET", "/health")
    )
}

pub(super) fn gateway_auth_matches(header: &str, auth_token: &str) -> bool {
    header.lines().any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("authorization") {
            let mut parts = value.split_whitespace();
            return parts
                .next()
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case("bearer"))
                && parts.next() == Some(auth_token)
                && parts.next().is_none();
        }
        name.eq_ignore_ascii_case("x-api-key") && value == auth_token
    })
}

pub(super) fn route_path(path: &str) -> &str {
    path.split_once('?').map_or(path, |(route, _)| route)
}

async fn write_json_or_sse_response(stream: &mut TcpStream, payload: Value) -> Result<(), String> {
    let stream_requested = payload
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let message = payload.get("message").cloned().unwrap_or_else(|| json!({}));
    if !stream_requested {
        return write_json_response(stream, 200, message).await;
    }
    let body = anthropic_sse_body(&message);
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(headers.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))?;
    stream
        .write_all(body.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))
}

pub(super) fn anthropic_sse_body(message: &Value) -> String {
    let mut out = String::new();
    let mut start_message = message.clone();
    start_message["content"] = json!([]);
    out.push_str("event: message_start\n");
    out.push_str(&format!(
        "data: {}\n\n",
        json!({"type":"message_start","message":start_message})
    ));
    if let Some(content) = message.get("content").and_then(Value::as_array) {
        for (index, block) in content.iter().enumerate() {
            let block_type = block.get("type").and_then(Value::as_str);
            let start_block = if block_type == Some("text") {
                json!({"type":"text","text":""})
            } else if block_type == Some("tool_use") {
                json!({
                    "type": "tool_use",
                    "id": block.get("id").cloned().unwrap_or(json!("toolu_claudette_gateway")),
                    "name": block.get("name").cloned().unwrap_or(json!("tool")),
                    "input": ""
                })
            } else {
                block.clone()
            };
            out.push_str("event: content_block_start\n");
            out.push_str(&format!(
                "data: {}\n\n",
                json!({"type":"content_block_start","index":index,"content_block":start_block})
            ));
            if block_type == Some("text")
                && let Some(text) = block.get("text").and_then(Value::as_str)
                && !text.is_empty()
            {
                out.push_str("event: content_block_delta\n");
                out.push_str(&format!(
                    "data: {}\n\n",
                    json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":text}})
                ));
            }
            if block_type == Some("tool_use") {
                let partial_json = block
                    .get("input")
                    .map(Value::to_string)
                    .unwrap_or_else(|| "{}".to_string());
                out.push_str("event: content_block_delta\n");
                out.push_str(&format!(
                    "data: {}\n\n",
                    json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":partial_json}})
                ));
            }
            out.push_str("event: content_block_stop\n");
            out.push_str(&format!(
                "data: {}\n\n",
                json!({"type":"content_block_stop","index":index})
            ));
        }
    }
    out.push_str("event: message_delta\n");
    out.push_str(&format!(
        "data: {}\n\n",
        json!({"type":"message_delta","delta":{"stop_reason":message.get("stop_reason").cloned().unwrap_or(json!("end_turn")),"stop_sequence":null},"usage":message.get("usage").cloned().unwrap_or(json!({}))})
    ));
    out.push_str("event: message_stop\n");
    out.push_str("data: {\"type\":\"message_stop\"}\n\n");
    out
}

pub(super) async fn write_json_response(
    stream: &mut TcpStream,
    status: u16,
    value: Value,
) -> Result<(), String> {
    let body = value.to_string();
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        502 => "Bad Gateway",
        _ => "OK",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(headers.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))?;
    stream
        .write_all(body.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))
}

async fn write_empty_response(stream: &mut TcpStream, status: u16) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        502 => "Bad Gateway",
        _ => "OK",
    };
    let headers =
        format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    stream
        .write_all(headers.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}
