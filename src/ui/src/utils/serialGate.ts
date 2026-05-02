/**
 * Tiny guard against concurrent invocations of a single async operation.
 *
 * `gate.run(fn)` invokes `fn` if no call is in flight and forwards its
 * result. If a call is already pending, `run` returns `null` immediately
 * without invoking `fn`. The gate releases as soon as the underlying call
 * resolves OR rejects, so a transient error doesn't permanently disable
 * the caller.
 *
 * Used by SessionTabs to defang rapid double-clicks on the "+ new session"
 * button while the backend create is in flight — see issue 574, where a
 * stalled `create_chat_session` queued every click into a separate tab once
 * the streaming session finally released the agents lock.
 */
export interface SerialGate {
  run<R>(fn: () => Promise<R>): Promise<R | null>;
  isPending(): boolean;
}

export function createSerialGate(): SerialGate {
  let inflight = false;
  return {
    async run<R>(fn: () => Promise<R>): Promise<R | null> {
      if (inflight) return null;
      inflight = true;
      try {
        return await fn();
      } finally {
        inflight = false;
      }
    },
    isPending: () => inflight,
  };
}
