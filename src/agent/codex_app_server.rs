use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::TokenUsage;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcId {
    Integer(i64),
    String(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcMessage {
    Request(JsonRpcRequest),
    Notification(JsonRpcNotification),
    Response(JsonRpcResponse),
    Error(JsonRpcError),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub id: JsonRpcId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub id: JsonRpcId,
    pub result: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub id: JsonRpcId,
    pub error: JsonRpcErrorBody,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JsonRpcErrorBody {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexPermissionLevel {
    Readonly,
    Standard,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexApprovalPolicy {
    #[serde(rename = "untrusted")]
    UnlessTrusted,
    OnRequest,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexSandboxMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexSandboxPolicy {
    DangerFullAccess,
    #[serde(rename_all = "camelCase")]
    ReadOnly {
        network_access: bool,
    },
    #[serde(rename_all = "camelCase")]
    WorkspaceWrite {
        network_access: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodexPermissionMapping {
    pub approval_policy: CodexApprovalPolicy,
    pub thread_sandbox: CodexSandboxMode,
    pub turn_sandbox_policy: CodexSandboxPolicy,
}

impl CodexPermissionLevel {
    pub fn from_claudette_level(level: &str) -> Self {
        match level {
            "readonly" => Self::Readonly,
            "standard" => Self::Standard,
            "full" => Self::Full,
            _ => Self::Readonly,
        }
    }

    pub fn mapping(self) -> CodexPermissionMapping {
        match self {
            Self::Readonly => CodexPermissionMapping {
                approval_policy: CodexApprovalPolicy::UnlessTrusted,
                thread_sandbox: CodexSandboxMode::ReadOnly,
                turn_sandbox_policy: CodexSandboxPolicy::ReadOnly {
                    network_access: false,
                },
            },
            Self::Standard => CodexPermissionMapping {
                approval_policy: CodexApprovalPolicy::OnRequest,
                thread_sandbox: CodexSandboxMode::WorkspaceWrite,
                turn_sandbox_policy: CodexSandboxPolicy::WorkspaceWrite {
                    network_access: false,
                },
            },
            Self::Full => CodexPermissionMapping {
                approval_policy: CodexApprovalPolicy::Never,
                thread_sandbox: CodexSandboxMode::DangerFullAccess,
                turn_sandbox_policy: CodexSandboxPolicy::DangerFullAccess,
            },
        }
    }
}

pub fn parse_jsonrpc_line(line: &str) -> Result<JsonRpcMessage, serde_json::Error> {
    serde_json::from_str(line)
}

pub fn build_initialize_request(id: i64, client_version: &str) -> JsonRpcRequest {
    JsonRpcRequest {
        id: JsonRpcId::Integer(id),
        method: "initialize".to_string(),
        params: Some(json!({
            "clientInfo": {
                "name": "claudette",
                "title": "Claudette",
                "version": client_version,
            },
            "capabilities": {
                "experimentalApi": true,
            },
        })),
    }
}

pub fn build_initialized_notification() -> JsonRpcNotification {
    JsonRpcNotification {
        method: "initialized".to_string(),
        params: None,
    }
}

pub fn build_thread_start_request(
    id: i64,
    model: Option<&str>,
    cwd: &Path,
    permission_level: CodexPermissionLevel,
) -> JsonRpcRequest {
    let mapping = permission_level.mapping();
    JsonRpcRequest {
        id: JsonRpcId::Integer(id),
        method: "thread/start".to_string(),
        params: Some(json!({
            "model": model,
            "modelProvider": "openai",
            "cwd": cwd,
            "approvalPolicy": mapping.approval_policy,
            "approvalsReviewer": "user",
            "sandbox": mapping.thread_sandbox,
            "threadSource": "user",
        })),
    }
}

pub fn build_turn_start_request(
    id: i64,
    thread_id: &str,
    prompt: &str,
    cwd: &Path,
    model: Option<&str>,
    permission_level: CodexPermissionLevel,
) -> JsonRpcRequest {
    let mapping = permission_level.mapping();
    JsonRpcRequest {
        id: JsonRpcId::Integer(id),
        method: "turn/start".to_string(),
        params: Some(json!({
            "threadId": thread_id,
            "input": [{
                "type": "text",
                "text": prompt,
                "textElements": [],
            }],
            "cwd": cwd,
            "approvalPolicy": mapping.approval_policy,
            "approvalsReviewer": "user",
            "sandboxPolicy": mapping.turn_sandbox_policy,
            "model": model,
        })),
    }
}

pub fn build_turn_steer_request(
    id: i64,
    thread_id: &str,
    expected_turn_id: &str,
    prompt: &str,
) -> JsonRpcRequest {
    JsonRpcRequest {
        id: JsonRpcId::Integer(id),
        method: "turn/steer".to_string(),
        params: Some(json!({
            "threadId": thread_id,
            "expectedTurnId": expected_turn_id,
            "input": [{
                "type": "text",
                "text": prompt,
                "textElements": [],
            }],
        })),
    }
}

pub fn build_turn_interrupt_request(id: i64, thread_id: &str, turn_id: &str) -> JsonRpcRequest {
    JsonRpcRequest {
        id: JsonRpcId::Integer(id),
        method: "turn/interrupt".to_string(),
        params: Some(json!({
            "threadId": thread_id,
            "turnId": turn_id,
        })),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodexNotificationEvent {
    AgentMessageDelta {
        thread_id: String,
        turn_id: String,
        item_id: String,
        delta: String,
    },
    CommandOutputDelta {
        thread_id: String,
        turn_id: String,
        item_id: String,
        delta: String,
    },
    TokenUsageUpdated {
        thread_id: String,
        turn_id: String,
        usage: TokenUsage,
    },
    TurnCompleted {
        thread_id: String,
        turn_id: String,
        duration_ms: Option<i64>,
    },
    TurnFailed {
        thread_id: String,
        turn_id: Option<String>,
        message: String,
    },
    Unknown {
        method: String,
        params: Option<Value>,
    },
}

pub fn decode_notification(notification: JsonRpcNotification) -> CodexNotificationEvent {
    let params = notification.params;
    match (notification.method.as_str(), params.as_ref()) {
        ("item/agentMessage/delta", Some(params)) => CodexNotificationEvent::AgentMessageDelta {
            thread_id: string_field(params, "threadId"),
            turn_id: string_field(params, "turnId"),
            item_id: string_field(params, "itemId"),
            delta: string_field(params, "delta"),
        },
        ("item/commandExecution/outputDelta", Some(params)) => {
            CodexNotificationEvent::CommandOutputDelta {
                thread_id: string_field(params, "threadId"),
                turn_id: string_field(params, "turnId"),
                item_id: string_field(params, "itemId"),
                delta: string_field(params, "delta"),
            }
        }
        ("thread/tokenUsage/updated", Some(params)) => CodexNotificationEvent::TokenUsageUpdated {
            thread_id: string_field(params, "threadId"),
            turn_id: string_field(params, "turnId"),
            usage: token_usage_from_params(params),
        },
        ("turn/completed", Some(params)) => {
            let turn = params.get("turn").unwrap_or(&Value::Null);
            CodexNotificationEvent::TurnCompleted {
                thread_id: string_field(params, "threadId"),
                turn_id: string_field(turn, "id"),
                duration_ms: turn.get("durationMs").and_then(Value::as_i64),
            }
        }
        ("turn/failed", Some(params)) => {
            let turn = params.get("turn");
            let error = turn
                .and_then(|turn| turn.get("error"))
                .or_else(|| params.get("error"))
                .unwrap_or(&Value::Null);
            CodexNotificationEvent::TurnFailed {
                thread_id: string_field(params, "threadId"),
                turn_id: turn.map(|turn| string_field(turn, "id")),
                message: string_field(error, "message"),
            }
        }
        (method, params) => CodexNotificationEvent::Unknown {
            method: method.to_string(),
            params: params.cloned(),
        },
    }
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn token_usage_from_params(params: &Value) -> TokenUsage {
    let total = params
        .get("tokenUsage")
        .and_then(|usage| usage.get("total"))
        .unwrap_or(&Value::Null);
    let input_tokens = total
        .get("inputTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let cached_input_tokens = total
        .get("cachedInputTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let output_tokens = total
        .get("outputTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let reasoning_output_tokens = total
        .get("reasoningOutputTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    TokenUsage {
        input_tokens,
        output_tokens: output_tokens + reasoning_output_tokens,
        cache_creation_input_tokens: None,
        cache_read_input_tokens: Some(cached_input_tokens),
        iterations: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_request_matches_codex_app_server_shape() {
        let request = build_initialize_request(1, "0.24.0");
        let value = serde_json::to_value(&request).expect("request serializes");

        assert_eq!(value["id"], 1);
        assert_eq!(value["method"], "initialize");
        assert_eq!(value["params"]["clientInfo"]["name"], "claudette");
        assert_eq!(value["params"]["capabilities"]["experimentalApi"], true);
        assert!(value.get("jsonrpc").is_none());
    }

    #[test]
    fn initialized_notification_omits_empty_params() {
        let value = serde_json::to_value(build_initialized_notification()).unwrap();
        assert_eq!(value, json!({"method": "initialized"}));
    }

    #[test]
    fn permission_levels_map_to_codex_policy_and_sandbox() {
        assert_eq!(
            CodexPermissionLevel::from_claudette_level("readonly").mapping(),
            CodexPermissionMapping {
                approval_policy: CodexApprovalPolicy::UnlessTrusted,
                thread_sandbox: CodexSandboxMode::ReadOnly,
                turn_sandbox_policy: CodexSandboxPolicy::ReadOnly {
                    network_access: false
                },
            }
        );
        assert_eq!(
            CodexPermissionLevel::from_claudette_level("standard").mapping(),
            CodexPermissionMapping {
                approval_policy: CodexApprovalPolicy::OnRequest,
                thread_sandbox: CodexSandboxMode::WorkspaceWrite,
                turn_sandbox_policy: CodexSandboxPolicy::WorkspaceWrite {
                    network_access: false
                },
            }
        );
        assert_eq!(
            CodexPermissionLevel::from_claudette_level("full").mapping(),
            CodexPermissionMapping {
                approval_policy: CodexApprovalPolicy::Never,
                thread_sandbox: CodexSandboxMode::DangerFullAccess,
                turn_sandbox_policy: CodexSandboxPolicy::DangerFullAccess,
            }
        );
    }

    #[test]
    fn turn_start_request_carries_text_model_and_permission_overrides() {
        let request = build_turn_start_request(
            7,
            "thread-1",
            "hello",
            Path::new("/tmp/work"),
            Some("gpt-5.1-codex"),
            CodexPermissionLevel::Standard,
        );
        let value = serde_json::to_value(request).unwrap();

        assert_eq!(value["method"], "turn/start");
        assert_eq!(value["params"]["threadId"], "thread-1");
        assert_eq!(value["params"]["input"][0]["type"], "text");
        assert_eq!(value["params"]["input"][0]["text"], "hello");
        assert_eq!(value["params"]["model"], "gpt-5.1-codex");
        assert_eq!(value["params"]["approvalPolicy"], "on-request");
        assert_eq!(
            value["params"]["sandboxPolicy"]["workspaceWrite"]["networkAccess"],
            false
        );
    }

    #[test]
    fn parses_agent_message_delta_notification() {
        let message = parse_jsonrpc_line(
            r#"{"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"u","itemId":"i","delta":"hi"}}"#,
        )
        .expect("jsonrpc parses");
        let JsonRpcMessage::Notification(notification) = message else {
            panic!("expected notification");
        };

        assert_eq!(
            decode_notification(notification),
            CodexNotificationEvent::AgentMessageDelta {
                thread_id: "t".to_string(),
                turn_id: "u".to_string(),
                item_id: "i".to_string(),
                delta: "hi".to_string(),
            }
        );
    }

    #[test]
    fn maps_token_usage_notification_to_claudette_usage() {
        let event = decode_notification(JsonRpcNotification {
            method: "thread/tokenUsage/updated".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "tokenUsage": {
                    "total": {
                        "inputTokens": 100,
                        "cachedInputTokens": 20,
                        "outputTokens": 7,
                        "reasoningOutputTokens": 3
                    },
                    "last": {
                        "inputTokens": 100,
                        "cachedInputTokens": 20,
                        "outputTokens": 7,
                        "reasoningOutputTokens": 3
                    },
                    "modelContextWindow": 400000
                }
            })),
        });

        assert_eq!(
            event,
            CodexNotificationEvent::TokenUsageUpdated {
                thread_id: "thread-1".to_string(),
                turn_id: "turn-1".to_string(),
                usage: TokenUsage {
                    input_tokens: 100,
                    output_tokens: 10,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: Some(20),
                    iterations: None,
                },
            }
        );
    }
}
