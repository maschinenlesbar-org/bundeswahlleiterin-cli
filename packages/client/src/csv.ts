// A tiny, dependency-free CSV parser tuned for the Bundeswahlleiterin open-data
// files: semicolon-delimited, UTF-8 with BOM, German decimals (comma), and a
// multi-line human-readable preamble before the header row.
//
// The tokenizer is RFC-4180-ish: it understands double-quoted fields, `""`
// escapes, and delimiters/newlines inside quotes. That is more than these files
// need today, but keeps the parser correct if a field ever contains a `;`.

import { BundeswahlParseError, cutForMessage } from "./errors.js";
import { sanitizeServerText } from "./engine.js";

/** Strip a leading UTF-8 byte-order mark, if present. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;

/**
 * Tokenise CSV text into rows of raw string fields. Handles quoted fields
 * (delimiters, newlines and `""` escapes inside quotes). A trailing newline does
 * not produce a spurious empty final row.
 *
 * A field is cut out of the text as slices between the characters that matter (a quote,
 * the delimiter, CR, LF) and joined once, never built one character at a time: `field += ch`
 * made a rope of one piece per character, and a 20 MB cell (a hostile or broken answer under
 * the size cap) took the process past a 512 MB heap and crashed it before anything was printed.
 */
export function parseCsvRows(text: string, delimiter = ";"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let parts: string[] = [];
  let inQuotes = false;
  const src = stripBom(text);
  // The delimiter is one character; a longer one never matched a single character before either.
  const delim = delimiter.length === 1 ? delimiter.charCodeAt(0) : -1;
  // `from` is where the text not yet taken into `parts` starts.
  let from = 0;
  const endField = (at: number): string => {
    parts.push(src.slice(from, at));
    const field = parts.length === 1 ? (parts[0] as string) : parts.join("");
    parts = [];
    return field;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (inQuotes) {
      if (c === QUOTE) {
        if (src.charCodeAt(i + 1) === QUOTE) {
          parts.push(src.slice(from, i + 1)); // up to and with one quote
          i++;
        } else {
          parts.push(src.slice(from, i));
          inQuotes = false;
        }
        from = i + 1;
      }
      continue;
    }
    if (c === QUOTE) {
      parts.push(src.slice(from, i));
      inQuotes = true;
      from = i + 1;
    } else if (c === delim) {
      row.push(endField(i));
      from = i + 1;
    } else if (c === LF) {
      row.push(endField(i));
      rows.push(row);
      row = [];
      from = i + 1;
    } else if (c === CR) {
      // swallow — the following \n (or EOF) ends the row
      parts.push(src.slice(from, i));
      from = i + 1;
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
  const field = endField(src.length);
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
  delimiter?: string | undefined;
  /**
   * Skip preamble rows until the header is found. If given, the header is the
   * first row whose first cell (trimmed) equals this value; otherwise the header
   * is the first non-empty row. Superseded by `headerColumns`, which finds the
   * header wherever its columns stand.
   */
  headerFirstCell?: string | undefined;
  /**
   * Find the header by its column names, in any position: the header is the first row
   * whose cells (trimmed) include at least {@link headerMatchThreshold} of these names.
   * A row that misses a few (a renamed column) is still found, so the caller can name
   * the missing ones. Takes precedence over `headerFirstCell`.
   */
  headerColumns?: readonly string[] | undefined;
}

/**
 * How many of `n` expected column names a row must contain to count as the header: half
 * of them, and at least two (one, if only one is expected). Two exact column names in a
 * preamble or data row are not a coincidence these files produce.
 */
export function headerMatchThreshold(n: number): number {
  return Math.min(n, Math.max(2, Math.ceil(n / 2)));
}

/**
 * Parse CSV text into `{ header, rows }`, skipping the human-readable preamble.
 * Fully-empty rows (all cells blank) are dropped from the data rows.
 */
export function parseCsv(text: string, options: ParseCsvOptions = {}): ParsedCsv {
  const all = parseCsvRows(text, options.delimiter ?? ";");
  const want = options.headerFirstCell;
  const columns = options.headerColumns;
  const threshold = columns === undefined ? 0 : headerMatchThreshold(columns.length);
  const isHeader = (row: string[]): boolean => {
    if (columns !== undefined) {
      const cells = new Set(row.map((c) => c.trim()));
      return columns.filter((c) => cells.has(c)).length >= threshold;
    }
    if (want !== undefined) return (row[0] ?? "").trim() === want;
    return row.some((c) => c.trim() !== "");
  };

  let headerIdx = -1;
  for (let i = 0; i < all.length; i++) {
    if (isHeader(all[i]!)) {
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
        `Malformed CSV: duplicate column name "${cutForMessage(sanitizeServerText(name))}" in the header — ` +
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
 * The most significant digits a German number may have: a double carries 15 decimal
 * digits exactly, so up to 15 the JS number reads back as the cell's value.
 */
export const MAX_SIGNIFICANT_DIGITS = 15;

/** Why a German number is refused for its length, for a message; the caller checked the format. */
export const TOO_MANY_DIGITS = `has more than ${MAX_SIGNIFICANT_DIGITS} significant digits, more than a JS number holds exactly`;

/**
 * The digits of a well-formed German number that count against MAX_SIGNIFICANT_DIGITS:
 * all of them but the integer part's leading zeros and the fraction's trailing zeros.
 * The fraction's leading zeros count (`0,0001` has four), so a tiny value can't
 * underflow to 0 either.
 */
function significantDigits(s: string): number {
  const [integer = "", fraction = ""] = s.replace(/[-.]/g, "").split(",");
  return integer.replace(/^0+/, "").length + fraction.replace(/0+$/, "").length;
}

/** True for a well-formed German number with more than MAX_SIGNIFICANT_DIGITS digits. */
export function hasTooManyDigits(value: string): boolean {
  const s = value.trim();
  return GERMAN_NUMBER.test(s) && significantDigits(s) > MAX_SIGNIFICANT_DIGITS;
}

/**
 * Parse a German-formatted number (comma decimal separator, optional thousands
 * dots) into a JS number. Returns `null` for empty / placeholder (`-`, `–`) cells
 * so callers can distinguish "no value" from `0`.
 *
 * Anything else throws a BundeswahlParseError. `Number()` alone accepted JS
 * literal syntax (`0x10` → 16, `1e3` → 1000), and turning an unparseable cell into
 * `null` made it read as "no candidate/list here" — a wrong answer with exit 0.
 * So does a number with more than MAX_SIGNIFICANT_DIGITS digits: a double would
 * round it (a 20-digit count came back as …567000), never the value in the file.
 */
export function parseGermanNumber(value: string): number | null {
  const s = value.trim();
  if (s === "" || s === "-" || s === "–") return null;
  if (!GERMAN_NUMBER.test(s)) {
    throw new BundeswahlParseError(
      `Malformed CSV: "${cutForMessage(sanitizeServerText(s))}" is not a German-formatted number.`,
    );
  }
  if (significantDigits(s) > MAX_SIGNIFICANT_DIGITS) {
    throw new BundeswahlParseError(`Malformed CSV: "${cutForMessage(s)}" ${TOO_MANY_DIGITS}.`);
  }
  return Number(s.replace(/\./g, "").replace(",", "."));
}
