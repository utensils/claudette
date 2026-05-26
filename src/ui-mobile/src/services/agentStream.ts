// Minimal parser for the `AgentEvent` shapes the WSS server forwards on
// `agent-stream` events. We only extract the bits the mobile chat view
// needs to render: assistant text, turn-completion signal, and process
// exit. The full agent-event grammar lives in `src/agent/types.rs`;
// covering all of it on mobile would duplicate the desktop's
// `useAgentStream.ts` for marginal UX gain in v1.

export interface ParsedAgentText {
  // Free-form assistant text emitted for this event (may be partial; the
  // server emits one assistant event per content block).
  assistantText: string | null;
  // Free-form thinking text — surfaced separately so the UI can dim it
  // or hide behind a disclosure.
  thinkingText: string | null;
  // True when the turn just completed (a `Result` system event arrived).
  turnComplete: boolean;
  // True when the underlying CLI subprocess exited.
  processExited: boolean;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function parseAgentEvent(raw: unknown): ParsedAgentText {
  const out: ParsedAgentText = {
    assistantText: null,
    thinkingText: null,
    turnComplete: false,
    processExited: false,
  };
  const event = getRecord(raw);
  if (!event) return out;

  if ("ProcessExited" in event) {
    out.processExited = true;
    return out;
  }

  const stream = getRecord(event.Stream);
  if (!stream) return out;

  if (stream.type === "result") {
    out.turnComplete = true;
    return out;
  }

  if (stream.type === "assistant") {
    const message = getRecord(stream.message);
    if (!message) return out;
    const content = message.content;
    if (typeof content === "string") {
      out.assistantText = content;
    } else if (Array.isArray(content)) {
      const textParts: string[] = [];
      const thinkParts: string[] = [];
      for (const entry of content) {
        const block = getRecord(entry);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (
          block.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          thinkParts.push(block.thinking);
        }
      }
      if (textParts.length > 0) out.assistantText = textParts.join("");
      if (thinkParts.length > 0) out.thinkingText = thinkParts.join("");
    }
  }
  return out;
}
