import { useMemo } from "react";

import { AttachmentCardShell } from "./AttachmentCardShell";
import { useAttachmentText } from "./useAttachmentText";
import { countCsvRows, parseCsv } from "../../utils/csvParse";
import styles from "./MessageAttachment.module.css";

/** Inline preview for a CSV attachment: header row + first ~50 data rows
 *  rendered as an HTML table. Files larger than the preview window show a
 *  "+ N more rows" footer. */
export function CsvAttachmentCard({
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

  const parsed = useMemo(() => {
    if (text === null) return null;
    const rows = parseCsv(text, 51); // 1 header + 50 data rows
    // Use the quote-aware row counter so files with multiline quoted
    // fields or blank lines don't produce a wrong "+ N more rows".
    const totalRows = countCsvRows(text);
    return { rows, totalRows };
  }, [text]);

  return (
    <AttachmentCardShell
      filename={filename}
      mediaType="text/csv"
      sizeBytes={size_bytes}
      collapsible={false}
      onContextMenu={onContextMenu}
    >
      {error ? (
        <div className={styles.error}>Failed to load: {error}</div>
      ) : parsed === null ? (
        <div className={styles.error}>Loading…</div>
      ) : parsed.rows.length === 0 ? (
        <div className={styles.error}>(empty)</div>
      ) : (
        <>
          <div style={{ overflow: "auto", maxHeight: 320 }}>
            <table className={styles.csvTable}>
              <thead>
                <tr>
                  {parsed.rows[0].map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsed.rows.slice(1).map((row, i) => (
                  <tr key={i}>
                    {row.map((c, j) => (
                      <td key={j} title={c}>
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {parsed.totalRows > parsed.rows.length && (
            <div className={styles.csvTruncated}>
              + {parsed.totalRows - parsed.rows.length} more rows
            </div>
          )}
        </>
      )}
    </AttachmentCardShell>
  );
}
