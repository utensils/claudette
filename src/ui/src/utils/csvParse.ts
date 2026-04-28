/**
 * Quote-aware CSV parser. Handles `,` inside `"..."` quoted fields,
 * `""` as an escaped quote inside a quoted field, and CRLF / LF line
 * endings. Newlines inside quoted fields are preserved as part of the
 * field, not treated as row terminators. Completely-blank physical
 * lines (`""` with no commas) are skipped wherever they appear, not
 * just at the end — keeps the preview clean. `countCsvRows` mirrors
 * this rule so the truncated-rows footer stays in sync.
 *
 * No Papa Parse dependency — the data goes through one render pass
 * and gets truncated to a preview window, so a small handwritten
 * splitter is enough.
 */
export function parseCsv(input: string, maxRows: number = 200): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const len = input.length;

  for (let i = 0; i < len; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      // Skip \r\n pair so we don't emit an empty row.
      if (ch === "\r" && input[i + 1] === "\n") {
        i++;
      }
      // Skip completely-blank physical lines (no commas, no content).
      if (!(row.length === 1 && row[0] === "")) {
        rows.push(row);
        if (rows.length >= maxRows) {
          return rows;
        }
      }
      row = [];
      continue;
    }
    field += ch;
  }
  // Flush trailing field/row if the file didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Quote-aware row count over the same logical model as `parseCsv` —
 * newlines inside quoted fields don't increment the count, and
 * completely-blank physical lines are skipped. Used by the CSV
 * preview's "+ N more rows" footer; it must follow the same rules as
 * `parseCsv` or the footer reports the wrong number for files with
 * multiline quoted fields or scattered blank lines.
 */
export function countCsvRows(input: string): number {
  if (input.length === 0) return 0;
  let count = 0;
  let inQuotes = false;
  let lineHadContent = false;
  let lineHadComma = false;

  const finishLine = () => {
    // Mirror parseCsv's blank-line skip: a physical line with no
    // commas and no content is dropped.
    if (lineHadComma || lineHadContent) {
      count++;
    }
    lineHadContent = false;
    lineHadComma = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          i++;
          lineHadContent = true;
        } else {
          inQuotes = false;
        }
      } else {
        // Newlines inside quotes are part of the field, not row
        // terminators.
        lineHadContent = true;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      lineHadContent = true;
      continue;
    }
    if (ch === ",") {
      lineHadComma = true;
      continue;
    }
    if (ch === "\n") {
      finishLine();
      continue;
    }
    if (ch === "\r") {
      finishLine();
      if (input[i + 1] === "\n") {
        i++;
      }
      continue;
    }
    lineHadContent = true;
  }
  // Flush trailing row if input didn't end with a newline.
  finishLine();
  return count;
}
