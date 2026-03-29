import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../stores/useAppStore";
import type { AgentStreamPayload } from "../types/agent-events";

export function useAgentStream() {
  const appendStreamingContent = useAppStore((s) => s.appendStreamingContent);
  const setStreamingContent = useAppStore((s) => s.setStreamingContent);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const addToolActivity = useAppStore((s) => s.addToolActivity);
  const updateToolActivity = useAppStore((s) => s.updateToolActivity);
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);

  useEffect(() => {
    const unlisten = listen<AgentStreamPayload>("agent-stream", (event) => {
      const { workspace_id: wsId, event: agentEvent } = event.payload;

      if ("ProcessExited" in agentEvent) {
        updateWorkspace(wsId, { agent_status: "Idle" });
        setStreamingContent(wsId, "");
        return;
      }

      const streamEvent = agentEvent.Stream;
      if (!streamEvent) return;

      // Handle different stream event types based on the Rust enum serialization
      if ("type" in streamEvent) {
        switch (streamEvent.type) {
          case "stream_event": {
            const inner = streamEvent.event;
            if ("type" in inner) {
              switch (inner.type) {
                case "content_block_delta": {
                  const delta = inner.delta;
                  if ("type" in delta && delta.type === "text_delta") {
                    appendStreamingContent(wsId, delta.text);
                  }
                  if (
                    "type" in delta &&
                    delta.type === "input_json_delta" &&
                    delta.partial_json
                  ) {
                    // Append to the last tool activity's input
                  }
                  break;
                }
                case "content_block_start": {
                  if (
                    inner.content_block &&
                    "type" in inner.content_block &&
                    inner.content_block.type === "tool_use"
                  ) {
                    addToolActivity(wsId, {
                      toolUseId: inner.content_block.id,
                      toolName: inner.content_block.name,
                      inputJson: "",
                      resultText: "",
                      collapsed: true,
                    });
                  }
                  break;
                }
              }
            }
            break;
          }
          case "assistant": {
            // Full message received — it's already persisted by the backend.
            // Build display text from content blocks.
            const text = streamEvent.message.content
              .filter(
                (b): b is { type: "text"; text: string } => b.type === "text"
              )
              .map((b) => b.text)
              .join("");
            if (text) {
              addChatMessage(wsId, {
                id: crypto.randomUUID(),
                workspace_id: wsId,
                role: "Assistant",
                content: text,
                cost_usd: null,
                duration_ms: null,
                created_at: new Date().toISOString(),
              });
            }
            setStreamingContent(wsId, "");
            break;
          }
          case "result": {
            updateWorkspace(wsId, { agent_status: "Idle" });
            break;
          }
          case "user": {
            // Tool results — update matching tool activities
            for (const block of streamEvent.message.content) {
              if (block.type === "tool_result") {
                updateToolActivity(wsId, block.tool_use_id, {
                  resultText:
                    typeof block.content === "string"
                      ? block.content
                      : JSON.stringify(block.content),
                });
              }
            }
            break;
          }
        }
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [
    appendStreamingContent,
    setStreamingContent,
    addChatMessage,
    addToolActivity,
    updateToolActivity,
    updateWorkspace,
  ]);
}
