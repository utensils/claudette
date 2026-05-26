import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// The Tauri events emitted by `src-mobile/src/commands.rs::spawn_event_forwarder`
// each carry `{connection_id, payload}`. `payload` is the same shape the
// WSS server pushed to the transport — see
// `src-server/src/handler.rs::handle_send_chat_message`.

interface ForwardedEvent<T> {
  connection_id: string;
  payload: T;
}

export interface AgentStreamPayload {
  workspace_id: string;
  session_id: string;
  event: unknown;
}

export interface PermissionPromptPayload {
  workspace_id: string;
  chat_session_id: string;
  tool_use_id: string;
  tool_name: string;
  request_id: string;
  input: unknown;
}

export async function onAgentStream(
  connectionId: string,
  handler: (payload: AgentStreamPayload) => void,
): Promise<UnlistenFn> {
  return listen<ForwardedEvent<AgentStreamPayload>>("agent-stream", (event) => {
    if (event.payload.connection_id !== connectionId) return;
    handler(event.payload.payload);
  });
}

export async function onPermissionPrompt(
  connectionId: string,
  handler: (payload: PermissionPromptPayload) => void,
): Promise<UnlistenFn> {
  return listen<ForwardedEvent<PermissionPromptPayload>>(
    "agent-permission-prompt",
    (event) => {
      if (event.payload.connection_id !== connectionId) return;
      handler(event.payload.payload);
    },
  );
}
