// A tiny, dependency-free CSV parser tuned for the Bundeswahlleiterin open-data
// files: semicolon-delimited, UTF-8 with BOM, German decimals (comma), and a
// multi-line human-readable preamble before the header row.
//
// The tokenizer is RFC-4180-ish: it understands double-quoted fields, `""`
// escapes, and delimiters/newlines inside quotes. That is more than these files
// need today, but keeps the parser correct if a field ever contains a `;`.

import { BundeswahlParseError } from "./errors.js";
import { sanitizeServerText } from "./engine.js";

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
  // A quote opened but never closed means the input ended mid-field. Left
  // unchecked, the tokenizer would have swallowed the entire remainder of the
  // file into one field and silently dropped every following row, returning
  // truncated data with a success exit code. Fail loudly instead — for election
  // data, "exit 0 with a truncated result" is the worst failure mode this tool
  // has.
  if (inQuotes) {
    throw new BundeswahlParseError(
      "Malformed CSV: unterminated quoted field (a '\"' was opened but never closed) — the input is truncated or not valid CSV.",
    );
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

/**
 * Throw a BundeswahlParseError if a (non-empty) column name occurs twice in the
 * header. A repeated name would silently resolve to one of the two columns — in
 * kerg2 a second "Anzahl"/"Prozent" pair (the VorpAnzahl/VorpProzent position)
 * reported the 2021 result as the 2025 one — or, in a key→value map, overwrite the
 * earlier value: a wrong row that still exits 0. None of the published files does
 * this, so treat it as the format having changed under us.
 */
export function assertUniqueHeader(header: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of header) {
    if (name === "") continue; // padding cells are expected and carry no data
    if (seen.has(name)) {
      throw new BundeswahlParseError(
        // The name comes from the (possibly hostile) response: sanitise it, it is
        // printed to stderr.
        `Malformed CSV: duplicate column name "${sanitizeServerText(name)}" in the header — ` +
          "values would silently overwrite each other, so the file is not usable as a key→value map.",
      );
    }
    seen.add(name);
  }
}

/**
 * Map data rows to objects keyed by the header column names.
 *
 * The keys are attacker-controllable (they come from the CSV header row of a
 * possibly-hostile or MITM'd response). Building on a `null` prototype
 * (`Object.create(null)`) so a `__proto__`/`constructor`/`prototype` header
 * cannot reach an inherited accessor or shadow an inherited method: it becomes
 * an ordinary own data property. This closes the prototype-pollution class as
 * defence-in-depth. Consumers only read fixed string keys and `JSON.stringify`
 * the result, both of which work identically on a null-prototype object.
 */
export function rowsToObjects(parsed: ParsedCsv): Record<string, string>[] {
  assertUniqueHeader(parsed.header);
  return parsed.rows.map((row) => {
    const obj = Object.create(null) as Record<string, string>;
    for (let i = 0; i < parsed.header.length; i++) obj[parsed.header[i]!] = row[i] ?? "";
    return obj;
  });
}

/**
 * A German-formatted number: optional minus, digits (optionally grouped by
 * thousands dots, `1.234.567`), optional decimal comma (`12,609074`).
 */
const GERMAN_NUMBER = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/;

/**
 * Parse a German-formatted number (comma decimal separator, optional thousands
 * dots) into a JS number. Returns `null` for empty / placeholder (`-`, `–`) cells
 * so callers can distinguish "no value" from `0`.
 *
 * Anything else throws a BundeswahlParseError. `Number()` alone accepted JS
 * literal syntax (`0x10` → 16, `1e3` → 1000), and turning an unparseable cell into
 * `null` made it read as "no candidate/list here" — a wrong answer with exit 0.
 */
export function parseGermanNumber(value: string): number | null {
  const s = value.trim();
  if (s === "" || s === "-" || s === "–") return null;
  if (!GERMAN_NUMBER.test(s)) {
    throw new BundeswahlParseError(
      `Malformed CSV: "${sanitizeServerText(s)}" is not a German-formatted number.`,
    );
  }
  return Number(s.replace(/\./g, "").replace(",", "."));
}
