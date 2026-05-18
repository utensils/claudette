// Convert a raw provider error message (the string Pi's agent loop
// hands us in `AssistantMessage.errorMessage` or `auto_retry_end`'s
// `finalError`) into a clean human-readable line for the Claudette
// chat transcript.
//
// Pi's error strings are upstream-provider-shaped: usually an HTTP
// status code prefix plus the raw response body. The body can be:
//   - Anthropic JSON: {"type":"error","error":{"type":"...","message":"..."}}
//   - OpenAI JSON:    {"error":{"message":"...","type":"...","code":"..."}}
//   - GitHub Copilot: plain text like "checking third-party user
//                     token: bad request: Personal Access Tokens are
//                     not supported for this endpoint"
//   - OpenRouter:     {"error":{"message":"...","code":...}}
//
// The chat panel renders the result as markdown so callers can pass
// the output straight through; we use **bold** for the leading
// label so it stands out from streamed text.
//
// Pure / no dependencies — keep it small enough that callers
// (turn_error and turn_end paths) can both invoke it without
// duplicating the parsing logic.

export interface FormattedProviderError {
  /** HTTP status code if the message started with one (e.g. 400). */
  status?: number;
  /** The user-facing error sentence — already unwrapped from any
   *  provider JSON envelope and trimmed. Fallback: the trimmed raw
   *  input if no envelope was recognized. */
  message: string;
  /** Optional secondary detail (provider-side error type / code).
   *  Surfaced as muted text after the main message when present. */
  detail?: string;
}

const HTTP_STATUS_PREFIX = /^(\d{3})\s+/;

/** Try to extract a friendly message from a provider error envelope.
 *  Returns `undefined` when the value doesn't match a known shape so
 *  the caller can fall back to the raw text. */
function unwrapEnvelope(
  value: unknown,
): { message: string; detail?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const root = value as Record<string, unknown>;

  // Anthropic / OpenRouter / OpenAI all use the same shape variants —
  // either `{error: {message, type, code}}` or, less commonly, the
  // `{error: "string", message: "..."}` flat form.
  const errorBlock = root.error;
  if (typeof errorBlock === "string" && errorBlock.trim()) {
    const message = errorBlock.trim();
    const topMessage =
      typeof root.message === "string" && root.message.trim()
        ? root.message.trim()
        : undefined;
    return { message: topMessage ?? message, detail: topMessage ? message : undefined };
  }
  if (errorBlock && typeof errorBlock === "object") {
    const inner = errorBlock as Record<string, unknown>;
    const message = typeof inner.message === "string" ? inner.message.trim() : "";
    if (message) {
      const type = typeof inner.type === "string" ? inner.type.trim() : "";
      const code =
        typeof inner.code === "string"
          ? inner.code.trim()
          : typeof inner.code === "number"
            ? String(inner.code)
            : "";
      const detail = [type, code].filter(Boolean).join(" · ") || undefined;
      return { message, detail };
    }
  }

  // Some providers wrap things one level deeper (Vertex / Bedrock
  // gateway flavours). Handle a single trailing `message` field.
  if (typeof root.message === "string" && root.message.trim()) {
    return { message: root.message.trim() };
  }
  return undefined;
}

export function formatProviderError(raw: string): FormattedProviderError {
  const trimmed = raw.trim();
  if (!trimmed) return { message: "Unknown error" };

  // Pi prefixes the HTTP status (`400 `, `500 `, …) in front of the
  // upstream body. Split it off so we can carry it as structured
  // metadata; the body is what we try to parse.
  let status: number | undefined;
  let body = trimmed;
  const match = trimmed.match(HTTP_STATUS_PREFIX);
  if (match) {
    status = Number.parseInt(match[1] ?? "", 10);
    body = trimmed.slice(match[0].length);
    if (!Number.isFinite(status)) status = undefined;
  }

  // Try JSON envelope first — Anthropic / OpenAI / OpenRouter all
  // wrap upstream errors in a JSON object. Be tolerant of trailing
  // junk by attempting a substring slice up to the last `}` when
  // strict parse fails.
  if (body.startsWith("{") || body.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      const lastBrace = body.lastIndexOf("}");
      if (lastBrace > 0) {
        try {
          parsed = JSON.parse(body.slice(0, lastBrace + 1));
        } catch {
          parsed = undefined;
        }
      }
    }
    const unwrapped = unwrapEnvelope(parsed);
    if (unwrapped) {
      return { status, message: unwrapped.message, detail: unwrapped.detail };
    }
  }

  // Plain text (Copilot's "checking third-party user token: …" style
  // or any unrecognized provider). Cap absurdly long messages so a
  // multi-KB HTML error page can't blow out the chat row — a wrapped
  // <html> response is useless detail.
  const MAX_PLAIN = 600;
  const message = body.length > MAX_PLAIN
    ? `${body.slice(0, MAX_PLAIN).trim()}…`
    : body;
  return { status, message };
}

/** Build the markdown string Rust embeds in the assistant text
 *  block for a turn that failed. Keeps the formatting in one place
 *  so different code paths (turn_error capture, agent_end walk,
 *  auto_retry_end final failure) all produce the same shape. */
export function renderProviderErrorMarkdown(raw: string): string {
  const { status, message, detail } = formatProviderError(raw);
  const label = status ? `**Error · HTTP ${status}**` : "**Error**";
  const trailing = detail ? `\n\n_${detail}_` : "";
  return `${label}\n\n${message}${trailing}`;
}
