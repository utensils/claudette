import { useMemo } from "react";

import {
  TextDataAttachmentCard,
  type TextDataAttachmentProps,
} from "./TextDataAttachmentCard";
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
export function JsonAttachmentCard(props: TextDataAttachmentProps) {
  return (
    <TextDataAttachmentCard
      {...props}
      mediaType="application/json"
      collapsible
      render={(text) => <JsonBody text={text} />}
    />
  );
}

function JsonBody({ text }: { text: string }) {
  const result = useMemo(() => prettyPrintJson(text), [text]);
  return (
    <>
      {!result.parsed && (
        <div className={styles.error}>(invalid JSON — showing raw)</div>
      )}
      <pre className={styles.preBody}>{result.formatted}</pre>
    </>
  );
}
