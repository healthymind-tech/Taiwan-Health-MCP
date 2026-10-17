// Client-side preview of a drug index CSV: reads only the head of the file so a
// 100+ MB upload never has to be loaded into memory.

export interface CsvPreview {
  headers: string[];
  rows: string[][];
  /** True when the slice ended mid-file (more rows exist than shown). */
  truncated: boolean;
  bytesRead: number;
  hadBom: boolean;
  /** Likely mis-encoded (e.g. Big5 read as UTF-8). */
  encodingSuspect: boolean;
}

/**
 * Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF/LF/CR line
 * endings and embedded newlines. `complete=false` drops a possibly cut-off
 * final record (the slice may end mid-row).
 */
export function parseCsv(text: string, maxRows: number, complete: boolean): { rows: string[][]; cutShort: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  let cutShort = false;

  const pushRow = () => {
    row.push(field);
    field = "";
    // Skip fully blank lines.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      pushRow();
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      i += 1;
      if (rows.length >= maxRows + 1) {
        cutShort = i < n;
        return { rows, cutShort };
      }
      continue;
    }
    field += ch;
    i += 1;
  }
  // Trailing record without newline.
  if (complete && (field !== "" || row.length > 0)) pushRow();
  else if (!complete) cutShort = true;
  return { rows, cutShort };
}

const HEAD_BYTES = 256 * 1024;

export async function readCsvPreview(file: File, maxRows = 20): Promise<CsvPreview> {
  const complete = file.size <= HEAD_BYTES;
  const buf = await file.slice(0, HEAD_BYTES).arrayBuffer();
  // A multi-byte char may be split at the slice edge; non-fatal decoding keeps
  // the rest readable and the cut-off record is dropped by the parser anyway.
  let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const hadBom = text.charCodeAt(0) === 0xfeff;
  if (hadBom) text = text.slice(1);
  const replacementCount = (text.match(/�/g) ?? []).length;
  const { rows, cutShort } = parseCsv(text, maxRows, complete);
  const headers = (rows[0] ?? []).map((h) => h.trim());
  return {
    headers,
    rows: rows.slice(1, maxRows + 1),
    truncated: cutShort || !complete,
    bytesRead: buf.byteLength,
    hadBom,
    encodingSuspect: replacementCount > 3,
  };
}
