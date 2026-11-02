import { useMemo } from "react";

import { countCsvRows, parseCsv } from "../../utils/csvParse";
import {
  TextDataAttachmentCard,
  type TextDataAttachmentProps,
} from "./TextDataAttachmentCard";
import styles from "./MessageAttachment.module.css";

/** Inline preview for a CSV attachment: header row + first ~50 data rows
 *  rendered as an HTML table. Files larger than the preview window show a
 *  "+ N more rows" footer. */
export function CsvAttachmentCard(props: TextDataAttachmentProps) {
  return (
    <TextDataAttachmentCard
      {...props}
      mediaType="text/csv"
      collapsible={false}
      render={(text) => <CsvBody text={text} />}
    />
  );
}

function CsvBody({ text }: { text: string }) {
  const parsed = useMemo(() => {
    const rows = parseCsv(text, 51); // 1 header + 50 data rows
    // Use the quote-aware row counter so files with multiline quoted
    // fields or blank lines don't produce a wrong "+ N more rows".
    const totalRows = countCsvRows(text);
    return { rows, totalRows };
  }, [text]);

  if (parsed.rows.length === 0) {
    return <div className={styles.error}>(empty)</div>;
  }
  return (
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
  );
}
