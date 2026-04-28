import { useMemo } from "react";

import { AttachmentCardShell } from "./AttachmentCardShell";
import { useAttachmentText } from "./useAttachmentText";
import styles from "./MessageAttachment.module.css";

/** Pretty-print JSON; falls back to the raw input when parsing fails so the
 *  user still sees something useful. Returns the formatted text and whether
 *  it was a parse miss (for the "(invalid JSON — showing raw)" hint). */
export function prettyPrintJson(input: string): {
  formatted: string;
  parsed: boolean;
} {
  try {
    const value = JSON.parse(input);
    return { formatted: JSON.stringify(value, null, 2), parsed: true };
  } catch {
    return { formatted: input, parsed: false };
  }
}

/** Inline preview for a JSON attachment: pretty-printed with 2-space indent
 *  inside a monospace block. Falls back to the raw input on parse failure. */
export function JsonAttachmentCard({
  attachmentId,
  text_content,
  data_base64,
  filename,
  size_bytes,
  onContextMenu,
}: {
  attachmentId?: string;
  text_content?: string | null;
  data_base64?: string | null;
  filename: string;
  size_bytes: number;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const { text, error } = useAttachmentText({
    text_content,
    data_base64,
    attachmentId,
  });

  const result = useMemo(() => (text === null ? null : prettyPrintJson(text)), [text]);

  return (
    <AttachmentCardShell
      filename={filename}
      mediaType="application/json"
      sizeBytes={size_bytes}
      collapsible
      onContextMenu={onContextMenu}
    >
      {error ? (
        <div className={styles.error}>Failed to load: {error}</div>
      ) : result === null ? (
        <div className={styles.error}>Loading…</div>
      ) : (
        <>
          {!result.parsed && (
            <div className={styles.error}>(invalid JSON — showing raw)</div>
          )}
          <pre className={styles.preBody}>{result.formatted}</pre>
        </>
      )}
    </AttachmentCardShell>
  );
}
