import type { ChatRole } from "../../types/chat";

/**
 * Returns true if a chat message with the given role should be rendered
 * through the Markdown pipeline in the chat transcript.
 *
 * Assistant output is agent-generated markdown (tables, code fences, etc).
 * System messages are emitted by local action handlers (e.g. `/plan open`,
 * `/status`, setup-script output) and often contain multi-line plan text or
 * fenced code that must render the same way — otherwise newlines collapse
 * into one paragraph block.
 *
 * User-authored messages are rendered as plain text so that typed-by-the-
 * human characters (`*`, backticks, leading `#`, etc.) stay literal and do
 * not turn the user's own prompt into unintended markdown.
 */
export function shouldRenderAsMarkdown(role: ChatRole): boolean {
  return role !== "User";
}

/**
 * Pick the CSS modifier key for a chat message based on its role and content.
 *
 * System messages default to a compact centered pill (`role_System`) because
 * most local notifications are one-liners ("Conversation cleared.",
 * "Model set to sonnet.", setup-script status). When the message has line
 * breaks — the plan dumps from `/plan open`, longer status summaries, or
 * multi-section setup-script output — the pill's centered layout collapses
 * markdown structure. Those messages use `role_System_block` instead, which
 * is a left-aligned card.
 *
 * Returns the key used to look up the CSS module class (e.g.
 * `styles.role_User`, `styles.role_System_block`).
 */
export function roleClassKey(role: ChatRole, content: string): string {
  if (role === "System" && content.includes("\n")) {
    return "role_System_block";
  }
  return `role_${role}`;
}
