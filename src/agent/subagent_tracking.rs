//! Correlate Claude task events only after observing an Agent tool. Bash and
//! Workflow share the same task notification protocol.
use crate::agent::{
    AgentEvent, ContentBlock, InnerStreamEvent, StartContentBlock, StreamEvent, SubagentRunUpdate,
};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Default)]
pub struct SubagentTracker {
    agent_tools: HashSet<String>,
}

impl SubagentTracker {
    pub fn observe(&mut self, event: &AgentEvent) -> Option<SubagentRunUpdate> {
        match event {
            AgentEvent::SubagentRun(update) => Some(update.clone()),
            AgentEvent::Stream(StreamEvent::Stream {
                event:
                    InnerStreamEvent::ContentBlockStart {
                        content_block: Some(StartContentBlock::ToolUse { id, name, .. }),
                        ..
                    },
            }) if name == "Agent" || name == "Task" => {
                self.agent_tools.insert(id.clone());
                None
            }
            AgentEvent::Stream(StreamEvent::Assistant { message }) => {
                for block in &message.content {
                    if let ContentBlock::ToolUse { id, name } = block
                        && (name == "Agent" || name == "Task")
                    {
                        self.agent_tools.insert(id.clone());
                    }
                }
                None
            }
            AgentEvent::Stream(StreamEvent::System {
                subtype,
                task_id: Some(id),
                tool_use_id: Some(tool),
                description,
                summary,
                status,
                ..
            }) if self.agent_tools.contains(tool)
                && matches!(
                    subtype.as_str(),
                    "task_started" | "task_progress" | "task_notification"
                ) =>
            {
                let status = match status.as_deref() {
                    Some("completed") => "completed",
                    Some("failed" | "error") => "failed",
                    Some("stopped" | "killed") => "stopped",
                    Some("running" | "starting") | None => "running",
                    _ => return None,
                };
                if matches!(status, "completed" | "stopped" | "failed") {
                    self.agent_tools.remove(tool);
                }
                Some(SubagentRunUpdate {
                    harness: "claude".into(),
                    run_id: id.clone(),
                    tool_use_id: Some(tool.clone()),
                    assignment: (subtype == "task_started")
                        .then(|| description.clone())
                        .flatten(),
                    summary: summary.clone().or_else(|| {
                        if subtype == "task_progress" {
                            description.clone()
                        } else {
                            None
                        }
                    }),
                    status: Some(status.into()),
                    ..Default::default()
                })
            }
            _ => None,
        }
    }
}

pub fn claude_subagent_hook(input: &Value) -> Option<SubagentRunUpdate> {
    let field = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let run_id = field("agent_id")?.to_owned();
    let (status, summary) = match field("hook_event_name")? {
        "SubagentStart" => ("running", None),
        "SubagentStop" => (
            if input
                .get("error")
                .is_some_and(|e| !e.is_null() && e != false && e != "")
            {
                "failed"
            } else {
                "completed"
            },
            field("last_assistant_message").or_else(|| field("claudette_agent_final_result")),
        ),
        _ => return None,
    };
    Some(SubagentRunUpdate {
        run_id,
        harness: "claude".into(),
        status: Some(status.into()),
        tool_use_id: field("tool_use_id").map(str::to_owned),
        summary: summary.map(str::to_owned),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shell_tasks_do_not_create_workers_and_only_explicit_stops_complete_them() {
        let task = |tool: &str| {
            AgentEvent::Stream(serde_json::from_value(json!({"type":"system","subtype":"task_started","task_id":"a","tool_use_id":tool,"description":"Review docs"})).unwrap())
        };
        let mut tracker = SubagentTracker::default();
        assert!(tracker.observe(&task("bash")).is_none());
        let start=AgentEvent::Stream(serde_json::from_value(json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"agent","name":"Agent"}}})).unwrap());
        tracker.observe(&start);
        let update = tracker.observe(&task("agent")).unwrap();
        assert_eq!(update.assignment.as_deref(), Some("Review docs"));
        assert_eq!(update.status.as_deref(), Some("running"));
        let stop=claude_subagent_hook(&json!({"hook_event_name":"SubagentStop","agent_id":"a","last_assistant_message":"Reviewed"})).unwrap();
        assert_eq!(stop.run_id, update.run_id);
        assert_eq!(stop.status.as_deref(), Some("completed"));
    }
}
