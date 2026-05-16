//! Anthropic ↔ OpenAI/Codex wire translation for the BackendGateway.
//!
//! Two outbound shapes:
//! - **OpenAI Responses** (`call_openai_responses`) — translates an
//!   Anthropic `messages` request into the OpenAI `/v1/responses`
//!   shape, calls upstream, and rebuilds the response back into
//!   Anthropic shape (with optional SSE).
//! - **Codex** (`call_codex_responses`) — same OpenAI Responses target
//!   but with the Codex-CLI auth material and the SSE-only response
//!   path that mirrors the ChatGPT subscription flow.
//!
//! `proxy_anthropic_messages` is the LM Studio fast-path: LM Studio
//! 0.4.1+ speaks Anthropic's wire format natively, so we forward bytes
//! and only fix up upstream HTTP status codes for the SDK's retry
//! classifier.
//!
//! All three converge on `GatewayUpstreamError` so the gateway's HTTP
//! handler can write a consistent Anthropic-shape error envelope back
//! to the Claude CLI via `write_anthropic_error_response`.

use std::collections::HashMap;

use claudette::agent_backend::{AgentBackendConfig, AgentBackendKind};
use claudette::plugin::load_secure_secret;
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

use super::codex_auth::{CODEX_DEFAULT_BASE_URL, CodexAuthMaterial};
use super::config::{SECRET_BUCKET, backend_models_contain};
use super::discovery::openai_api_url;

/// Error from a gateway request that needs to be turned back into an HTTP
/// response for the Claude CLI. Carries both the upstream-extracted message
/// and the response status we want the gateway to emit — so a 4xx from LM
/// Studio (e.g. context-length exceeded) propagates as 4xx and the SDK does
/// not retry it as a transient 5xx.
#[derive(Debug, Clone)]
pub(super) struct GatewayUpstreamError {
    pub(super) status: u16,
    pub(super) message: String,
}

impl GatewayUpstreamError {
    /// Wrap a local/internal failure (couldn't even reach the upstream).
    /// Surfaces as 502 to the CLI.
    pub(super) fn internal(message: impl Into<String>) -> Self {
        Self {
            status: 502,
            message: message.into(),
        }
    }

    /// Build from an upstream non-2xx response. Parses the OpenAI-shaped
    /// `{error: {message: ...}}` envelope when present, else falls back to
    /// the raw body. Preserves 4xx status codes so the CLI fails fast on
    /// permanent input errors instead of retrying with backoff.
    pub(super) fn from_upstream(status: u16, body: &str) -> Self {
        let message = serde_json::from_str::<Value>(body)
            .ok()
            .as_ref()
            .and_then(|v| v.get("error"))
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if body.trim().is_empty() {
                    format!("upstream returned HTTP {status} with no body")
                } else {
                    // Cap the raw-body fallback so a cloud proxy's giant
                    // HTML 502 page or an upstream debug dump can't
                    // balloon error responses or log lines. The full
                    // body is logged via tracing::warn for postmortem.
                    truncate_for_error_message(body)
                }
            });
        // 4xx → forward as-is so retries stop. 5xx that are *semantically*
        // permanent (LM Studio classifies "tokens to keep > context length"
        // as HTTP 500 even though it's a hard input error) get demoted to
        // 400 so the Anthropic SDK does not retry them with backoff.
        // Anything else collapses to 502 (bad gateway) for the SDK consumer.
        let outbound = if (400..500).contains(&status) {
            status
        } else if upstream_message_is_permanent_failure(&message) {
            400
        } else {
            502
        };
        Self {
            status: outbound,
            message,
        }
    }
}

/// Map an outbound HTTP status to the Anthropic error-envelope `type`
/// string the Claude CLI / SDK expect for that class. Default is
/// `api_error` (transient — SDK may retry); 4xx → kind-specific labels
/// so 401/403/404/429 don't all collapse to `invalid_request_error`,
/// which would re-classify `429`s out of the SDK's rate-limit retry path.
pub(super) fn anthropic_error_type_for(status: u16) -> &'static str {
    match status {
        401 => "authentication_error",
        403 => "permission_error",
        404 => "not_found_error",
        413 => "request_too_large",
        429 => "rate_limit_error",
        400..=499 => "invalid_request_error",
        _ => "api_error",
    }
}

/// Cap an upstream body / payload that might end up in a user-visible
/// error string. Keeps just enough context to be actionable; protects
/// log files and chat UI from being flooded by upstream HTML / proxy
/// error pages. Caller is responsible for tracing::warn-ing the full
/// body if a postmortem-quality copy is needed.
pub(super) fn truncate_for_error_message(body: &str) -> String {
    const MAX: usize = 512;
    let mut trimmed = body.trim();
    if trimmed.len() <= MAX {
        return trimmed.to_string();
    }
    // Walk back to the last char boundary at or below MAX so we never
    // slice into a multibyte UTF-8 sequence.
    let mut cut = MAX;
    while cut > 0 && !trimmed.is_char_boundary(cut) {
        cut -= 1;
    }
    trimmed = &trimmed[..cut];
    format!(
        "{trimmed}… [truncated, {total} bytes total]",
        total = body.len()
    )
}

/// Returns true when the upstream message describes a hard input error that
/// will fail identically on retry — context-window overflow, model not
/// loaded, model not found, etc. Matched case-insensitively against
/// substrings observed in the wild from LM Studio, llama.cpp, vLLM, and
/// OpenAI-compatible gateways. Keep the list narrow: false positives mean
/// users miss out on transient-failure retries.
pub(super) fn upstream_message_is_permanent_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "context length",
        "tokens to keep",
        "context window",
        "exceeds the maximum",
        "model is not loaded",
        "model not loaded",
        "model not found",
        "no model is loaded",
        "input is too long",
        "prompt is too long",
    ];
    NEEDLES.iter().any(|needle| lower.contains(needle))
}

impl std::fmt::Display for GatewayUpstreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (status={})", self.message, self.status)
    }
}

impl From<String> for GatewayUpstreamError {
    fn from(message: String) -> Self {
        Self::internal(message)
    }
}

// Gateway backends that go through the OpenAI-Responses translation
// path (OpenAi, Codex, CustomOpenAi) require a real API key — they
// hit api.openai.com or chatgpt.com and need real auth. LM Studio is
// also gateway-routed but takes the Anthropic-shape pass-through in
// `proxy_anthropic_messages` instead of this helper, and its
// local-first placeholder-bearer logic lives there + in
// `discover_lm_studio_models` (where it's actually exercised).
pub(super) fn openai_compatible_bearer_token(secret: Option<&str>) -> Result<String, String> {
    secret
        .map(str::to_string)
        .ok_or_else(|| "OpenAI-compatible backend requires an API key".to_string())
}

pub(super) fn openai_compatible_default_base(_kind: AgentBackendKind) -> &'static str {
    "https://api.openai.com"
}

/// Approximate the prompt+tools size and compare against the backend's
/// known context window for `model`. Returns Some(error) when the request
/// is obviously too large to fit, so we can fail fast at 400 instead of
/// waiting on the upstream server to tokenize and reject it. Returns None
/// when the model's context window isn't known (e.g. user added a manual
/// model without a discovered context size) — in that case we still send
/// upstream and let the runtime classify any overflow via
/// `from_upstream` + `upstream_message_is_permanent_failure`.
pub(super) fn preflight_context_window_check(
    config: &AgentBackendConfig,
    model: &str,
    openai_req: &Value,
) -> Option<GatewayUpstreamError> {
    let context = config
        .discovered_models
        .iter()
        .chain(config.manual_models.iter())
        .find(|m| m.id == model)
        .map(|m| m.context_window_tokens)
        .filter(|n| *n > 0)?;
    // Body length / 4 is a deliberate over-estimate for English text and
    // a conservative match for tokenizer-dense JSON tool schemas. Same
    // approximation we use in /v1/messages/count_tokens, so the count
    // and the gate stay consistent.
    let approx_tokens = openai_req.to_string().len() / 4;
    // Reserve some headroom for completion tokens — even a 1-token reply
    // needs a slot. 90% of the window is a reasonable hard ceiling.
    let limit = (context as usize).saturating_mul(9) / 10;
    if approx_tokens <= limit {
        return None;
    }
    Some(GatewayUpstreamError {
        status: 400,
        message: format!(
            "Prompt is too large for the model's loaded context window. \
             Approx {approx_tokens} tokens of input vs {context} tokens \
             of context for `{model}`. Reload the model in {label} with a \
             larger context length, or pick a model with a bigger window.",
            label = config.label,
        ),
    })
}

/// Forward an Anthropic Messages API request to LM Studio's native
/// `/v1/messages` endpoint. Bypasses the OpenAI Responses translation
/// `call_openai_responses` does — LM Studio 0.4.1+ implements Anthropic's
/// wire format natively, so the only thing we need from the gateway is
/// **status-code translation**: LM Studio returns HTTP 500 for hard
/// input errors like context-window overflow, which the Anthropic SDK
/// retries with backoff. The response body is in Anthropic shape
/// (`{type: error, error: {type, message}}`) — we just need to fix the
/// status before forwarding to the CLI.
///
/// Successful (2xx) responses are streamed through unchanged so the
/// agent UI gets per-chunk SSE events as LM Studio produces them
/// (preserving TTFT). The pass-through writes directly to `out_stream`
/// rather than buffering into a `Value` like the OpenAI-Responses path.
pub(super) async fn proxy_anthropic_messages(
    config: &AgentBackendConfig,
    anthropic_req: &Value,
    out_stream: &mut TcpStream,
) -> Result<(), GatewayUpstreamError> {
    let base = config
        .base_url
        .as_deref()
        .unwrap_or("http://localhost:1234")
        .trim_end_matches('/');
    // LM Studio's `/v1/messages` accepts any bearer locally — but a user
    // who fronts the server with an authenticating proxy would reject a
    // missing Authorization header. Always send the placeholder so both
    // setups work.
    let bearer = load_secure_secret(SECRET_BUCKET, &config.id)
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "lm-studio".to_string());
    // Pre-flight: same approximation we use for OpenAI-Responses-routed
    // backends. LM Studio enforces its own context check too, but our
    // pre-flight wins on UX (~1 ms vs ~40 s round-trip to LM Studio's
    // tokenizer) and produces a tailored message that names the actual
    // numbers.
    let model = anthropic_req
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !model.is_empty()
        && let Some(err) = preflight_context_window_check(config, &model, anthropic_req)
    {
        return Err(err);
    }

    let stream_requested = anthropic_req
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let response = reqwest::Client::new()
        .post(format!("{base}/v1/messages"))
        .bearer_auth(&bearer)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("anthropic-version", "2023-06-01")
        .json(anthropic_req)
        .send()
        .await
        .map_err(|e| GatewayUpstreamError::internal(format!("LM Studio request failed: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.map_err(|e| {
            GatewayUpstreamError::internal(format!("Invalid LM Studio response body: {e}"))
        })?;
        return Err(GatewayUpstreamError::from_upstream(status.as_u16(), &body));
    }

    // Forward the response. We mirror the upstream Content-Type so the
    // CLI sees `text/event-stream` for streaming requests and JSON for
    // non-streaming ones, then close the connection at end-of-body so
    // we can stream without committing to a Content-Length. Same
    // `Connection: close` pattern the OpenAI-Responses fallback uses.
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if stream_requested {
                "text/event-stream".to_string()
            } else {
                "application/json".to_string()
            }
        });
    let header_block = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: {content_type}\r\n\
         Cache-Control: no-cache\r\n\
         Connection: close\r\n\
         \r\n"
    );
    out_stream
        .write_all(header_block.as_bytes())
        .await
        .map_err(|e| GatewayUpstreamError::internal(format!("write headers failed: {e}")))?;

    let mut body_stream = response.bytes_stream();
    while let Some(chunk) = body_stream.next().await {
        let chunk = chunk
            .map_err(|e| GatewayUpstreamError::internal(format!("upstream stream error: {e}")))?;
        out_stream
            .write_all(&chunk)
            .await
            .map_err(|e| GatewayUpstreamError::internal(format!("write chunk failed: {e}")))?;
    }
    out_stream
        .flush()
        .await
        .map_err(|e| GatewayUpstreamError::internal(format!("flush failed: {e}")))?;
    Ok(())
}

/// Format a `GatewayUpstreamError` as the JSON error envelope the
/// Anthropic CLI / SDK expect, picking the most accurate `error.type`
/// for the outbound HTTP status. Centralized so every gateway code path
/// (OpenAI-Responses translation, LM Studio pass-through) produces an
/// identical shape.
pub(super) async fn write_anthropic_error_response(
    stream: &mut TcpStream,
    err: GatewayUpstreamError,
) -> Result<(), String> {
    let error_type = anthropic_error_type_for(err.status);
    super::gateway::write_json_response(
        stream,
        err.status,
        json!({
            "type":"error",
            "error":{"type":error_type,"message":err.message},
        }),
    )
    .await
}

pub(super) async fn call_openai_responses(
    config: &AgentBackendConfig,
    secret: Option<&str>,
    anthropic_req: Value,
) -> Result<Value, GatewayUpstreamError> {
    if config.kind == AgentBackendKind::CodexSubscription {
        return call_codex_responses(config, secret, anthropic_req).await;
    }
    let secret = openai_compatible_bearer_token(secret)?;
    let base = config
        .base_url
        .as_deref()
        .unwrap_or_else(|| openai_compatible_default_base(config.kind))
        .trim_end_matches('/');
    let model = openai_compatible_request_model(config, &anthropic_req)?;
    let openai_req = json!({
        "model": model.clone(),
        "input": transcript_from_anthropic(&anthropic_req),
        "tools": tools_from_anthropic(&anthropic_req),
        "max_output_tokens": anthropic_req.get("max_tokens").cloned().unwrap_or(json!(4096)),
    });
    // Pre-flight: when the backend reports a per-model context window
    // (LM Studio's `loaded_context_length`, OpenAI's `context_window_tokens`)
    // and the serialized request obviously won't fit, fail fast with a
    // user-actionable message instead of waiting ~40s for LM Studio to
    // tokenize the prompt and reject it as HTTP 500.
    if let Some(err) = preflight_context_window_check(config, &model, &openai_req) {
        return Err(err);
    }
    let client = reqwest::Client::new();
    let response = client
        .post(openai_api_url(base, "responses"))
        .bearer_auth(secret)
        .json(&openai_req)
        .send()
        .await
        .map_err(|e| GatewayUpstreamError::internal(format!("OpenAI request failed: {e}")))?;
    let status = response.status();
    // Read the body unconditionally — on error this is where LM Studio
    // returns the "load with larger context" message that we want to
    // surface verbatim instead of swallowing via error_for_status().
    let body = response
        .text()
        .await
        .map_err(|e| GatewayUpstreamError::internal(format!("Invalid OpenAI response: {e}")))?;
    if !status.is_success() {
        return Err(GatewayUpstreamError::from_upstream(status.as_u16(), &body));
    }
    let value = serde_json::from_str::<Value>(&body).map_err(|e| {
        // Cap the body in the user-visible error so a non-JSON proxy
        // page (e.g. a Cloudflare 502 HTML splash) doesn't drown the
        // chat UI. Full body still goes to the tracing log via the
        // gateway connection-error path.
        GatewayUpstreamError::internal(format!(
            "Invalid OpenAI response: {e}: {snippet}",
            snippet = truncate_for_error_message(&body)
        ))
    })?;
    Ok(anthropic_message_from_openai(
        &model,
        value,
        anthropic_req
            .get("stream")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    ))
}

async fn call_codex_responses(
    config: &AgentBackendConfig,
    secret: Option<&str>,
    anthropic_req: Value,
) -> Result<Value, GatewayUpstreamError> {
    let auth = serde_json::from_str::<CodexAuthMaterial>(secret.ok_or_else(|| {
        GatewayUpstreamError::internal(
            "Codex subscription backend requires Codex CLI authentication",
        )
    })?)
    .map_err(|e| {
        GatewayUpstreamError::internal(format!("Invalid Codex gateway auth material: {e}"))
    })?;
    let model = openai_compatible_request_model(config, &anthropic_req)?;
    let instructions = codex_instructions_from_anthropic(&anthropic_req);
    let request_id = uuid::Uuid::new_v4().to_string();
    let codex_req = json!({
        "model": model.clone(),
        "store": false,
        "stream": true,
        "instructions": instructions,
        "input": codex_input_from_anthropic(&anthropic_req),
        "text": {"verbosity": "low"},
        "include": ["reasoning.encrypted_content"],
        "tools": tools_from_anthropic(&anthropic_req),
        "tool_choice": "auto",
        "parallel_tool_calls": true,
    });
    let client = reqwest::Client::new();
    let mut request = client
        .post(codex_responses_url(config.base_url.as_deref()))
        .bearer_auth(&auth.access_token)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("OpenAI-Beta", "responses=experimental")
        .header("originator", "claudette")
        .header("x-client-request-id", request_id)
        .json(&codex_req);
    if let Some(account_id) = auth.account_id.as_deref()
        && !account_id.trim().is_empty()
    {
        request = request.header("chatgpt-account-id", account_id);
    }
    let response = request
        .send()
        .await
        .map_err(|e| GatewayUpstreamError::internal(format!("Codex request failed: {e}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| GatewayUpstreamError::internal(format!("Invalid Codex response body: {e}")))?;
    if !status.is_success() {
        return Err(GatewayUpstreamError::from_upstream(status.as_u16(), &body));
    }
    let value = openai_response_from_sse(&body).map_err(GatewayUpstreamError::internal)?;
    Ok(anthropic_message_from_openai(
        &model,
        value,
        anthropic_req
            .get("stream")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    ))
}

pub(super) fn openai_compatible_request_model(
    config: &AgentBackendConfig,
    anthropic_req: &Value,
) -> Result<String, String> {
    let requested = anthropic_req
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty());
    if let Some(model) = requested
        && (backend_models_contain(config, model) || !is_claude_code_model_alias(model))
    {
        return Ok(model.to_string());
    }

    config
        .default_model
        .as_deref()
        .filter(|model| !model.trim().is_empty())
        .or_else(|| {
            config
                .discovered_models
                .first()
                .or_else(|| config.manual_models.first())
                .map(|model| model.id.as_str())
        })
        .map(ToString::to_string)
        .or_else(|| requested.map(ToString::to_string))
        .ok_or_else(|| "Missing model".to_string())
}

pub(super) fn is_claude_code_model_alias(model: &str) -> bool {
    let lower = model.trim().to_ascii_lowercase();
    let without_context_suffix = lower.strip_suffix("[1m]").unwrap_or(&lower);
    matches!(
        without_context_suffix,
        "sonnet" | "opus" | "haiku" | "opusplan"
    ) || without_context_suffix.starts_with("claude-")
        || without_context_suffix.starts_with("anthropic.claude-")
        || without_context_suffix.contains(".anthropic.claude-")
}

fn codex_instructions_from_anthropic(req: &Value) -> String {
    req.get("system")
        .map(content_value_text)
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "You are a concise coding assistant.".to_string())
}

pub(super) fn codex_input_from_anthropic(req: &Value) -> Value {
    let input = req
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|message| {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user");
            let content = message.get("content").unwrap_or(&Value::Null);
            if role == "assistant" {
                assistant_input_items_from_anthropic(content)
            } else {
                user_input_items_from_anthropic(role, content)
            }
        })
        .collect::<Vec<_>>();
    Value::Array(input)
}

fn assistant_input_items_from_anthropic(content: &Value) -> Vec<Value> {
    let mut items = Vec::new();
    match content {
        Value::Array(blocks) => {
            let mut text_parts = Vec::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str)
                            && !text.is_empty()
                        {
                            text_parts.push(text.to_string());
                        }
                    }
                    Some("tool_use") => {
                        let call_id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("call")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        let arguments = block
                            .get("input")
                            .map(Value::to_string)
                            .unwrap_or_else(|| "{}".to_string());
                        items.push(json!({
                            "type": "function_call",
                            "call_id": call_id,
                            "name": name,
                            "arguments": arguments,
                            "status": "completed",
                        }));
                    }
                    _ => {}
                }
            }
            if !text_parts.is_empty() {
                items.insert(
                    0,
                    json!({
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": text_parts.join("\n"), "annotations": []}],
                        "status": "completed",
                    }),
                );
            }
        }
        Value::String(text) if !text.is_empty() => {
            items.push(json!({
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
                "status": "completed",
            }));
        }
        other if !other.is_null() => {
            items.push(json!({
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": other.to_string(), "annotations": []}],
                "status": "completed",
            }));
        }
        _ => {}
    }
    items
}

fn user_input_items_from_anthropic(role: &str, content: &Value) -> Vec<Value> {
    let mut items = Vec::new();
    match content {
        Value::Array(blocks) => {
            let mut text_parts = Vec::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str)
                            && !text.is_empty()
                        {
                            text_parts.push(text.to_string());
                        }
                    }
                    Some("tool_result") => {
                        if !text_parts.is_empty() {
                            items.push(json!({
                                "role": role,
                                "content": [{"type": "input_text", "text": text_parts.join("\n")}],
                            }));
                            text_parts.clear();
                        }
                        items.push(json!({
                            "type": "function_call_output",
                            "call_id": block.get("tool_use_id").and_then(Value::as_str).unwrap_or("call"),
                            "output": content_value_text(block.get("content").unwrap_or(&Value::Null)),
                        }));
                    }
                    _ => {}
                }
            }
            if !text_parts.is_empty() {
                items.push(json!({
                    "role": role,
                    "content": [{"type": "input_text", "text": text_parts.join("\n")}],
                }));
            }
        }
        Value::String(text) => {
            items.push(json!({
                "role": role,
                "content": [{"type": "input_text", "text": text}],
            }));
        }
        other => {
            items.push(json!({
                "role": role,
                "content": [{"type": "input_text", "text": content_value_text(other)}],
            }));
        }
    }
    items
}

pub(super) fn codex_responses_url(base_url: Option<&str>) -> String {
    let raw = base_url
        .map(str::trim)
        .filter(|base| !base.is_empty())
        .unwrap_or(CODEX_DEFAULT_BASE_URL);
    let normalized = raw.trim_end_matches('/');
    if normalized.ends_with("/codex/responses") {
        normalized.to_string()
    } else if normalized.ends_with("/codex") {
        format!("{normalized}/responses")
    } else {
        format!("{normalized}/codex/responses")
    }
}

pub(super) fn openai_response_from_sse(body: &str) -> Result<Value, String> {
    let mut output_text = String::new();
    let mut last_response = None;
    let mut output_items: HashMap<usize, Value> = HashMap::new();
    let mut function_args: HashMap<usize, String> = HashMap::new();
    for line in body.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" || data.is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(data)
            .map_err(|e| format!("Invalid Codex SSE event: {e}"))?;
        match value.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    output_text.push_str(delta);
                }
            }
            Some("response.output_item.added") => {
                if let Some(index) = event_output_index(&value)
                    && let Some(item) = value.get("item")
                {
                    output_items.insert(index, item.clone());
                }
            }
            Some("response.function_call_arguments.delta") => {
                if let Some(index) = event_output_index(&value)
                    && let Some(delta) = value.get("delta").and_then(Value::as_str)
                {
                    function_args.entry(index).or_default().push_str(delta);
                    if let Some(item) = output_items.get_mut(&index) {
                        item["arguments"] = Value::String(function_args[&index].clone());
                    }
                }
            }
            Some("response.function_call_arguments.done") => {
                if let Some(index) = event_output_index(&value)
                    && let Some(arguments) = value.get("arguments").and_then(Value::as_str)
                {
                    function_args.insert(index, arguments.to_string());
                    if let Some(item) = output_items.get_mut(&index) {
                        item["arguments"] = Value::String(arguments.to_string());
                    }
                }
            }
            Some("response.output_item.done") => {
                if let Some(index) = event_output_index(&value)
                    && let Some(item) = value.get("item")
                {
                    output_items.insert(index, item.clone());
                }
            }
            Some("response.completed") => {
                if let Some(response) = value.get("response") {
                    last_response = Some(response.clone());
                }
            }
            _ => {}
        }
    }
    let mut response = last_response.ok_or("Codex stream ended without response.completed")?;
    if response.get("output_text").is_none() && !output_text.is_empty() {
        response["output_text"] = Value::String(output_text);
    }
    let response_output_empty = response
        .get("output")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    if response_output_empty && !output_items.is_empty() {
        let mut indexed = output_items.into_iter().collect::<Vec<_>>();
        indexed.sort_by_key(|(index, _)| *index);
        response["output"] = Value::Array(indexed.into_iter().map(|(_, item)| item).collect());
    }
    Ok(response)
}

fn event_output_index(value: &Value) -> Option<usize> {
    value
        .get("output_index")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok())
}

fn transcript_from_anthropic(req: &Value) -> String {
    let mut out = String::new();
    if let Some(system) = req.get("system") {
        out.push_str("System:\n");
        out.push_str(&content_value_text(system));
        out.push_str("\n\n");
    }
    if let Some(messages) = req.get("messages").and_then(Value::as_array) {
        for message in messages {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user");
            out.push_str(role);
            out.push_str(":\n");
            out.push_str(&content_value_text(
                message.get("content").unwrap_or(&Value::Null),
            ));
            out.push_str("\n\n");
        }
    }
    out
}

fn content_value_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    item.get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                } else if item.get("type").and_then(Value::as_str) == Some("tool_result") {
                    format!(
                        "Tool result {}: {}",
                        item.get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        content_value_text(item.get("content").unwrap_or(&Value::Null))
                    )
                } else if item.get("type").and_then(Value::as_str) == Some("tool_use") {
                    format!(
                        "Tool use {}: {}",
                        item.get("name").and_then(Value::as_str).unwrap_or(""),
                        item.get("input").unwrap_or(&Value::Null)
                    )
                } else {
                    String::new()
                }
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

fn tools_from_anthropic(req: &Value) -> Value {
    let tools = req
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| {
                    Some(json!({
                        "type": "function",
                        "name": tool.get("name")?.as_str()?,
                        "description": tool.get("description").and_then(Value::as_str).unwrap_or(""),
                        "parameters": tool.get("input_schema").cloned().unwrap_or_else(|| json!({"type":"object"})),
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Value::Array(tools)
}

pub(super) fn anthropic_message_from_openai(model: &str, value: Value, stream: bool) -> Value {
    let mut content = Vec::new();
    let fallback_text = value
        .get("output_text")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty());
    let mut has_text_content = false;
    if let Some(output) = value.get("output").and_then(Value::as_array) {
        for item in output {
            match item.get("type").and_then(Value::as_str) {
                Some("message") => {
                    if let Some(parts) = item.get("content").and_then(Value::as_array) {
                        for part in parts {
                            if let Some(text) = part
                                .get("text")
                                .or_else(|| part.get("output_text"))
                                .and_then(Value::as_str)
                                && !text.is_empty()
                            {
                                has_text_content = true;
                                content.push(json!({"type":"text","text":text}));
                            }
                        }
                    }
                }
                Some("function_call") => {
                    let id = item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("call");
                    let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let args = item
                        .get("arguments")
                        .and_then(Value::as_str)
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .unwrap_or_else(|| json!({}));
                    content.push(json!({"type":"tool_use","id":id,"name":name,"input":args}));
                }
                _ => {}
            }
        }
    }
    if !has_text_content && let Some(text) = fallback_text {
        content.insert(0, json!({"type": "text", "text": text}));
    }
    if content.is_empty() {
        content.push(json!({"type":"text","text":""}));
    }
    json!({
        "stream": stream,
        "message": {
            "id": value.get("id").and_then(Value::as_str).unwrap_or("msg_claudette_gateway"),
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": content,
            "stop_reason": if content.iter().any(|c| c.get("type").and_then(Value::as_str) == Some("tool_use")) { "tool_use" } else { "end_turn" },
            "stop_sequence": null,
            "usage": {
                "input_tokens": value.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0),
                "output_tokens": value.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0),
            }
        }
    })
}
