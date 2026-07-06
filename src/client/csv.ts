// A tiny, dependency-free CSV parser tuned for the Bundeswahlleiterin open-data
// files: semicolon-delimited, UTF-8 with BOM, German decimals (comma), and a
// multi-line human-readable preamble before the header row.
//
// The tokenizer is RFC-4180-ish: it understands double-quoted fields, `""`
// escapes, and delimiters/newlines inside quotes. That is more than these files
// need today, but keeps the parser correct if a field ever contains a `;`.

/** Strip a leading UTF-8 byte-order mark, if present. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Tokenise CSV text into rows of raw string fields. Handles quoted fields
 * (delimiters, newlines and `""` escapes inside quotes). A trailing newline does
 * not produce a spurious empty final row.
 */
export function parseCsvRows(text: string, delimiter = ";"): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = stripBom(text);

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
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
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else if (ch === "\r") {
      // swallow — the following \n (or EOF) ends the row
    } else {
      field += ch;
    }
  }
  // Flush the last field/row unless the input ended exactly on a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface ParsedCsv {
  /** The column names from the header row. */
  header: string[];
  /** Data rows after the header, aligned to `header` by index. */
  rows: string[][];
}

export interface ParseCsvOptions {
  delimiter?: string;
  /**
   * Skip preamble rows until the header is found. If given, the header is the
   * first row whose first cell (trimmed) equals this value; otherwise the header
   * is the first non-empty row.
   */
  headerFirstCell?: string;
}

/**
 * Parse CSV text into `{ header, rows }`, skipping the human-readable preamble.
 * Fully-empty rows (all cells blank) are dropped from the data rows.
 */
export function parseCsv(text: string, options: ParseCsvOptions = {}): ParsedCsv {
  const all = parseCsvRows(text, options.delimiter ?? ";");
  const want = options.headerFirstCell;

  let headerIdx = -1;
  for (let i = 0; i < all.length; i++) {
    const first = (all[i]![0] ?? "").trim();
    if (want !== undefined ? first === want : all[i]!.some((c) => c.trim() !== "")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return { header: [], rows: [] };

  const header = all[headerIdx]!.map((c) => c.trim());
  const rows = all.slice(headerIdx + 1).filter((r) => r.some((c) => c.trim() !== ""));
  return { header, rows };
}

/** Map data rows to objects keyed by the header column names. */
export function rowsToObjects(parsed: ParsedCsv): Record<string, string>[] {
  return parsed.rows.map((row) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < parsed.header.length; i++) obj[parsed.header[i]!] = row[i] ?? "";
    return obj;
  });
}

/**
 * Parse a German-formatted number (comma decimal separator, optional thousands
 * dots) into a JS number. Returns `null` for empty / placeholder (`-`, `–`) cells
 * so callers can distinguish "no value" from `0`.
 */
export function parseGermanNumber(value: string): number | null {
  const s = value.trim();
  if (s === "" || s === "-" || s === "–") return null;
  const normalized = s.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
