import { useEffect, useState } from "react";

import { loadAttachmentData } from "../../services/tauri";
import { base64ToBytes } from "../../utils/base64";

/**
 * Resolve an attachment's text content, loading it lazily from the backend
 * if not already present. Mirrors the strategy used by `PdfThumbnail`:
 * persisted attachments strip `data_base64` after the first load to keep IPC
 * payloads small, so we may need to re-fetch on demand.
 *
 * Returns:
 *  - `text === null && !error` while loading
 *  - `text === string` when the body has been decoded
 *  - `error` set if the fetch / decode failed
 */
export function useAttachmentText(opts: {
  text_content?: string | null;
  data_base64?: string | null;
  attachmentId?: string;
}): { text: string | null; error: string | null } {
  const { text_content, data_base64, attachmentId } = opts;
  const [text, setText] = useState<string | null>(text_content ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (text !== null) return;
    let cancelled = false;
    (async () => {
      try {
        let b64 = data_base64 ?? null;
        if (!b64 && attachmentId) {
          b64 = await loadAttachmentData(attachmentId);
        }
        if (cancelled) return;
        if (!b64) {
          // Neither inline bytes nor a row id to fetch from — without
          // setting an explicit error the card would render
          // "Loading…" forever. Surface the missing source so the
          // caller renders the standard error state instead.
          setError("attachment has no inline data and no id to fetch");
          return;
        }
        const bytes = base64ToBytes(b64);
        const decoded = new TextDecoder("utf-8").decode(bytes);
        setText(decoded);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text, data_base64, attachmentId]);

  return { text, error };
}
