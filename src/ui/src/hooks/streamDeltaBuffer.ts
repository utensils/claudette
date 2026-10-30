/**
 * Coalesces high-frequency stream deltas (assistant text, thinking, tool
 * input JSON) into at most one store write per frame per session/tool.
 *
 * Why: every `text_delta` / `input_json_delta` used to be its own Zustand
 * `set`. A streamed `Write` of a 20 KB file is hundreds of chunks, and each
 * chunk rebuilt the session's tool-activity array — re-rendering the whole
 * transcript and re-running every store selector in the app per chunk.
 *
 * Ordering contract: the caller must `flush()` before handling any event
 * that is *not* a buffered delta (and before reading the buffered fields
 * back out of the store). That keeps every observable store state identical
 * to the unbuffered sequence at each non-delta boundary — `content_block_stop`
 * still sees the complete tool input, `finalizeTurn` still snapshots the
 * whole turn — and only intermediate per-chunk states are skipped.
 */
export interface StreamDeltaSink {
  appendText: (sessionId: string, text: string) => void;
  appendThinking: (sessionId: string, text: string) => void;
  appendToolInput: (sessionId: string, toolUseId: string, json: string) => void;
}

export type FlushScheduler = (flush: () => void) => void;

/** One animation frame, with a timer backstop: `requestAnimationFrame` is
 *  paused while the window is hidden (and macOS suspends hidden webviews'
 *  rAF entirely), which would otherwise hold deltas until the next
 *  non-delta event. */
export const frameScheduler: FlushScheduler = (flush) => {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    flush();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  setTimeout(run, 50);
};

export class StreamDeltaBuffer {
  private text = new Map<string, string>();
  private thinking = new Map<string, string>();
  private toolInput = new Map<string, Map<string, string>>();
  private scheduled = false;
  private readonly sink: StreamDeltaSink;
  private readonly schedule: FlushScheduler;

  constructor(sink: StreamDeltaSink, schedule: FlushScheduler = frameScheduler) {
    this.sink = sink;
    this.schedule = schedule;
  }

  appendText(sessionId: string, text: string): void {
    this.text.set(sessionId, (this.text.get(sessionId) ?? "") + text);
    this.request();
  }

  appendThinking(sessionId: string, text: string): void {
    this.thinking.set(sessionId, (this.thinking.get(sessionId) ?? "") + text);
    this.request();
  }

  appendToolInput(sessionId: string, toolUseId: string, json: string): void {
    let byTool = this.toolInput.get(sessionId);
    if (!byTool) {
      byTool = new Map();
      this.toolInput.set(sessionId, byTool);
    }
    byTool.set(toolUseId, (byTool.get(toolUseId) ?? "") + json);
    this.request();
  }

  /** Apply everything buffered, synchronously. Safe to call when empty. */
  flush(): void {
    this.scheduled = false;
    if (this.text.size === 0 && this.thinking.size === 0 && this.toolInput.size === 0) {
      return;
    }
    // Swap before applying so a sink that (indirectly) appends again lands
    // in a fresh buffer rather than mutating the one being iterated.
    const text = this.text;
    const thinking = this.thinking;
    const toolInput = this.toolInput;
    this.text = new Map();
    this.thinking = new Map();
    this.toolInput = new Map();
    for (const [sessionId, chunk] of thinking) this.sink.appendThinking(sessionId, chunk);
    for (const [sessionId, chunk] of text) this.sink.appendText(sessionId, chunk);
    for (const [sessionId, byTool] of toolInput) {
      for (const [toolUseId, chunk] of byTool) {
        this.sink.appendToolInput(sessionId, toolUseId, chunk);
      }
    }
  }

  private request(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      if (this.scheduled) this.flush();
    });
  }
}
