export const EARLY_PTY_OUTPUT_BUFFER_BYTE_LIMIT = 128 * 1024;

export interface PtyOutputPayload {
  pty_id: number;
  data: number[];
}

interface BufferedPtyOutput {
  chunks: number[][];
  bytes: number;
  start: number;
}

export type EarlyPtyOutputBuffer = Map<number, BufferedPtyOutput>;

/**
 * Buffer PTY output observed before the frontend knows which backend pty_id
 * belongs to the just-spawned terminal pane. The backend starts its reader
 * before `spawn_pty` resolves, so the shell's first prompt can otherwise be
 * emitted before the pane subscribes to it.
 */
export function bufferEarlyPtyOutput(
  buffer: EarlyPtyOutputBuffer,
  payload: PtyOutputPayload,
  limitBytes = EARLY_PTY_OUTPUT_BUFFER_BYTE_LIMIT,
) {
  if (payload.data.length === 0 || limitBytes <= 0) return;

  let entry = buffer.get(payload.pty_id);
  if (!entry) {
    entry = { chunks: [], bytes: 0, start: 0 };
    buffer.set(payload.pty_id, entry);
  }

  entry.chunks.push(payload.data);
  entry.bytes += payload.data.length;

  while (entry.bytes > limitBytes && entry.start < entry.chunks.length) {
    const removed = entry.chunks[entry.start];
    entry.bytes -= removed?.length ?? 0;
    entry.start += 1;
  }

  if (entry.start >= entry.chunks.length) {
    buffer.delete(payload.pty_id);
  } else if (entry.start > 32 && entry.start * 2 > entry.chunks.length) {
    entry.chunks = entry.chunks.slice(entry.start);
    entry.start = 0;
  }
}

export function flushEarlyPtyOutput(
  buffer: EarlyPtyOutputBuffer,
  ptyId: number,
  write: (data: number[]) => void,
) {
  const entry = buffer.get(ptyId);
  if (!entry) return;
  buffer.delete(ptyId);
  for (let i = entry.start; i < entry.chunks.length; i += 1) {
    const chunk = entry.chunks[i];
    if (!chunk) continue;
    write(chunk);
  }
}
