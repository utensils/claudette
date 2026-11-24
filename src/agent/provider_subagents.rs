//! Preserve worker identity and reply routing on the parent's JSON-RPC connection.
use super::{AgentEvent, ControlRequestInner, StreamEvent};

pub(super) fn child_control(event: AgentEvent, child_id: &str) -> Option<AgentEvent> {
    let AgentEvent::Stream(mut stream @ StreamEvent::ControlRequest { .. }) = event else {
        return None;
    };
    if let StreamEvent::ControlRequest {
        request_id,
        request: ControlRequestInner::CanUseTool {
            input, tool_use_id, ..
        },
    } = &mut stream
        && let Some(input) = input.as_object_mut()
    {
        input.insert("subagent_run_id".into(), child_id.into());
        // ACP tool-call IDs are session-local. The RPC request ID is unique on
        // the connection and remains the key used to send the provider reply.
        *tool_use_id = format!("subagent-approval-{request_id}");
    }
    Some(AgentEvent::SubagentControl(stream))
}
