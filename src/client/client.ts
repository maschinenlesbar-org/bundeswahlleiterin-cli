// BundeswahlClient — a typed client over the Bundeswahlleiterin open-data CSV
// files for the Bundestagswahl 2025. No auth. Each dataset is one CSV fetched
// from www.bundeswahlleiterin.de, parsed and mapped to typed rows. Filters are
// applied client-side (the files are whole datasets).
//
//   const c = new BundeswahlClient();
//   await c.results({ areaType: "Wahlkreis", area: "Flensburg", vote: 2 });
//   await c.parties();
//   await c.wahlkreise({ land: "Bayern" });

import { RequestEngine, sanitizeServerText, type EngineOptions } from "./engine.js";
import { assertUniqueHeader, parseCsv, parseGermanNumber, rowsToObjects, type ParsedCsv } from "./csv.js";
import { BundeswahlParseError, BundeswahlValidationError, cutForMessage, describeValue } from "./errors.js";
import { assertValid, knownKeysProblem } from "./validate.js";
import type {
  AreaType,
  Party,
  ResultRow,
  ResultsQuery,
  StructureRow,
  Vote,
  Wahlkreis,
} from "./types.js";

/**
 * The open-data file paths for the Bundestagswahl 2025. The results (kerg2) live
 * at a stable directory path; the reference datasets are behind opaque `dam/jcr`
 * UUIDs that are fixed for this (completed) election, so they are pinned here.
 * Source: https://www.bundeswahlleiterin.de/bundestagswahlen/2025/ergebnisse/opendata.html
 *
 * MAINTENANCE: if the Bundeswahlleiterin reorganises the open-data section these
 * `dam/jcr` paths can 404 (surfaced as exit 4) or, worse, resolve to a *different*
 * 200 file — in which case `parseDataset`'s header check raises a clear error rather
 * than returning empty data. Re-pin the UUIDs from the opendata page if that happens.
 */
export const BTW2025 = {
  results: "/bundestagswahlen/2025/ergebnisse/opendata/btw25/csv/kerg2.csv",
  parties: "/dam/jcr/925d6e98-3616-465a-835a-cec1ea73abc2/btw25_parteien.csv",
  wahlkreise: "/dam/jcr/17e066f6-a0af-42df-a5d2-365dc87769ab/btw25_wahlkreisnamen_utf8.csv",
  structure: "/dam/jcr/181f9e38-38db-4f64-991c-8141dfa0f2cb/btw2025_strukturdaten.csv",
} as const;

/** Options for the client (engine options only — the open data needs no auth). */
export type BundeswahlClientOptions = EngineOptions;

/**
 * Comparison form of a name or filter value: NFC-normalised (a decomposed umlaut,
 * as macOS file names and some input methods produce, matches the files' composed
 * one), lower-cased, and with every dash variant (hyphen, en/em dash, minus sign…)
 * folded to "-" — 93 Wahlkreis names use " – " (U+2013) where users type "-".
 */
function fold(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/[\u2010-\u2015\u2212]/g, "-");
}

/** Case-, normalisation- and dash-insensitive substring test (see {@link fold}). */
function includesCi(haystack: string, needle: string): boolean {
  return fold(haystack).includes(fold(needle.trim()));
}

const AREA_TYPES: readonly AreaType[] = ["Bund", "Land", "Wahlkreis"];

/** The keys each method's filter object takes; any other key is a validation error. */
const RESULTS_KEYS = ["areaType", "area", "party", "vote", "groupType"] as const;
const WAHLKREISE_KEYS = ["land"] as const;
const STRUCTURE_KEYS = ["wahlkreis", "includeAggregates"] as const;

/**
 * Library-side validation of a text filter, matching the CLI's parse-time rule: a
 * blank value would match every row (an empty substring), so it is refused rather
 * than read as "no filter". Throws BundeswahlValidationError; no request is made.
 */
function textFilter(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new BundeswahlValidationError(
      `Invalid ${name}: expected a non-empty string, got ${describeValue(value)}.`,
    );
  }
  return value;
}

/** True when the value is a plain run of digits (a bare area/Land number). */
function isNumeric(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

/** Compare two area/Land numbers ignoring leading zeros, so "005" == "5". */
function sameNumber(a: string, b: string): boolean {
  return a.trim().replace(/^0+/, "") === b.trim().replace(/^0+/, "");
}

/** Build a header-name → column-index lookup so mapping survives column reordering. */
function indexMap(header: string[]): (name: string) => number {
  const map = new Map(header.map((h, i) => [h, i]));
  return (name) => map.get(name) ?? -1;
}

/** Read a cell by header name (empty string if the column is absent). */
function cell(row: string[], at: number): string {
  return at >= 0 ? (row[at] ?? "").trim() : "";
}

/** The columns each dataset's mapper reads; all must be present in the header. */
const RESULT_COLUMNS = [
  "Wahlart", "Wahltag", "Gebietsart", "Gebietsnummer", "Gebietsname", "UegGebietsart",
  "UegGebietsnummer", "Gruppenart", "Gruppenname", "Gruppenreihenfolge", "Stimme", "Anzahl",
  "Prozent", "VorpAnzahl", "VorpProzent", "DiffProzent", "DiffProzentPkt", "Bemerkung", "Gewählt",
] as const;
const PARTY_COLUMNS = ["Gruppenschluessel", "Gruppenart_XML", "Gruppenart_CSV", "GruppennameKurz", "Gruppenname"] as const;
const WAHLKREIS_COLUMNS = ["WKR_NR", "WKR_NAME", "LAND_NR", "LAND_NAME", "LAND_ABK"] as const;
const STRUCTURE_COLUMNS = ["Land", "Wahlkreis-Nr.", "Wahlkreis-Name"] as const;

/** The kerg2 columns parsed as numbers. */
const RESULT_NUMBER_COLUMNS = ["Anzahl", "Prozent", "VorpAnzahl", "VorpProzent", "DiffProzent", "DiffProzentPkt"] as const;

/** One dot and three digits: `16.413` — 16413 with a thousands dot, or 16.413 with a decimal point. */
const AMBIGUOUS_DOT = /^-?\d{1,3}\.\d{3}$/;
/** Thousands dots that can't be a decimal point: with a decimal comma, or two or more of them. */
const CLEARLY_GROUPED = /^-?\d{1,3}(?:\.\d{3})+,\d+$|^-?\d{1,3}(?:\.\d{3}){2,}(?:,\d+)?$/;
/** A number of 1000 or more written without thousands dots. */
const UNGROUPED_LARGE = /^-?\d{4,}(?:,\d+)?$/;

/**
 * Refuse a number whose format the file leaves ambiguous. The German format allows
 * thousands dots (`8.149.124`), so `parseGermanNumber` reads `16.413` as 16413; but in a
 * file written with decimal points (an English-locale re-export) the same cell means
 * 16.413 — SPD's 16.413 % came out as 16413 %, exit 0. The convention is read per column:
 * a column that shows thousands dots elsewhere (a grouped value that can't be a decimal,
 * and no large value without them) keeps the German reading; in any other column — the
 * published kerg2 has no dot in any number — a one-dot, three-digit value is a
 * BundeswahlParseError naming the cell.
 */
function assertUnambiguousNumbers(
  parsed: ParsedCsv,
  at: (name: string) => number,
  columns: readonly string[],
  path: string,
): void {
  for (const column of columns) {
    const index = at(column);
    let grouped = false;
    let ungroupedLarge = false;
    for (const row of parsed.rows) {
      const value = cell(row, index);
      if (CLEARLY_GROUPED.test(value)) grouped = true;
      else if (UNGROUPED_LARGE.test(value)) ungroupedLarge = true;
    }
    if (grouped && !ungroupedLarge) continue;
    parsed.rows.forEach((row, i) => {
      const value = cell(row, index);
      if (!AMBIGUOUS_DOT.test(value)) return;
      throw new BundeswahlParseError(
        `Malformed CSV: column "${column}" in data row ${i + 1} of ${path} has "${value}", which reads as ` +
          `${value.replace(".", "")} with a thousands dot or ${value} with a decimal point — the column uses ` +
          "no thousands dots elsewhere, so the file's number format is ambiguous.",
      );
    });
  }
}

/**
 * `parseCsv`, but fail loudly if the file is not the expected one. Without this,
 * a `200` response that isn't the expected file (a replaced/moved dataset, or an
 * upstream column rename) would yield an empty header — or, for a renamed column,
 * a field that is `""`/`null` in every row, or a filter that matches nothing — and
 * the command would silently return data indistinguishable from a real answer.
 * So: the header row must be found, and every column in `columns` (all the ones
 * the mapper reads) must be in it.
 */
function parseDataset(text: string, path: string, columns: readonly string[]): ParsedCsv {
  // The header is found by its column names, wherever they stand: finding it by its first
  // cell broke on a reorder that moved the first column, which the by-name mapping
  // below is meant to survive.
  const parsed = parseCsv(text, { headerColumns: columns });
  if (parsed.header.length === 0) {
    const shown = columns.slice(0, 5).map((c) => `"${c}"`).join(", ") + (columns.length > 5 ? ", …" : "");
    throw new BundeswahlParseError(
      `Could not find the expected header (columns ${shown}) in ${path} — ` +
        "the open-data file format may have changed.",
    );
  }
  // Columns are looked up by name, so a repeated name would silently pick one of
  // the two (the last) — refuse it for every dataset, not only `structure`.
  assertUniqueHeader(parsed.header);
  const missing = columns.filter((c) => !parsed.header.includes(c));
  if (missing.length > 0) {
    throw new BundeswahlParseError(
      `Missing column${missing.length > 1 ? "s" : ""} ${missing.map((c) => `"${c}"`).join(", ")} ` +
        `in the header of ${path} — the open-data file format may have changed.`,
    );
  }
  // The published files are rectangular: every data row has exactly as many cells
  // as the header. A shorter row is a body cut off mid-row (a proxy or CDN ending a
  // chunked response early, a partial upload upstream) whose last number may be cut
  // at its decimal comma ("15," read as 15); a longer one is not the format we map.
  // Either way the file is not usable, like an unterminated quote in parseCsvRows.
  parsed.rows.forEach((row, i) => {
    if (row.length !== parsed.header.length) {
      throw new BundeswahlParseError(
        `Malformed CSV: data row ${i + 1} of ${path} has ${row.length} cells, the header has ` +
          `${parsed.header.length} — the file is truncated or not rectangular.`,
      );
    }
  });
  return parsed;
}

export class BundeswahlClient {
  private readonly engine: RequestEngine;

  constructor(options: BundeswahlClientOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /**
   * The Bundestagswahl 2025 results (kerg2), one row per area × group × ballot.
   * `query` filters client-side by area level/name, party/group, and ballot.
   */
  async results(query: ResultsQuery = {}): Promise<ResultRow[]> {
    // Validate before fetching, as the CLI does at parse time: for a library caller a
    // lower-case "bund", a string "2" or a blank party used to match nothing (or
    // everything) silently. areaType is case-insensitive, like --area-type. A misspelled
    // key (`Party`, `areatype`) or a non-object query used to be ignored: every row back.
    assertValid("query", query, knownKeysProblem(RESULTS_KEYS));
    const q = query as Record<string, unknown>;
    let areaType: AreaType | undefined;
    if (q["areaType"] !== undefined) {
      const raw = q["areaType"];
      areaType = AREA_TYPES.find((a) => typeof raw === "string" && a.toLowerCase() === raw.trim().toLowerCase());
      if (areaType === undefined) {
        throw new BundeswahlValidationError(
          `Invalid areaType: expected one of ${AREA_TYPES.join(", ")}, got ${describeValue(raw)}.`,
        );
      }
    }
    if (q["vote"] !== undefined && q["vote"] !== 1 && q["vote"] !== 2) {
      throw new BundeswahlValidationError(
        `Invalid vote: expected 1 (Erststimme) or 2 (Zweitstimme), got ${describeValue(q["vote"])}.`,
      );
    }
    const area = textFilter("area", q["area"]);
    const party = textFilter("party", q["party"]);
    const groupType = textFilter("groupType", q["groupType"]);

    const text = await this.engine.getText(BTW2025.results);
    const parsed = parseDataset(text, BTW2025.results, RESULT_COLUMNS);
    const at = indexMap(parsed.header);
    assertUnambiguousNumbers(parsed, at, RESULT_NUMBER_COLUMNS, BTW2025.results);
    // A malformed number or ballot is a parse error naming the cell, never a
    // `null` (which means "no candidate/list here") or a row that drops out of a
    // --vote filter.
    const num = (r: string[], row: number, column: string): number | null => {
      const raw = cell(r, at(column));
      try {
        return parseGermanNumber(raw);
      } catch {
        throw new BundeswahlParseError(
          `Malformed CSV: column "${column}" in data row ${row} of ${BTW2025.results} is not a number: ` +
            `"${cutForMessage(sanitizeServerText(raw))}".`,
        );
      }
    };
    let rows = parsed.rows.map<ResultRow>((r, i) => {
      const stimmeRaw = cell(r, at("Stimme"));
      if (stimmeRaw !== "" && stimmeRaw !== "1" && stimmeRaw !== "2") {
        throw new BundeswahlParseError(
          `Malformed CSV: column "Stimme" in data row ${i + 1} of ${BTW2025.results} must be 1, 2 or empty, ` +
            `got "${cutForMessage(sanitizeServerText(stimmeRaw))}".`,
        );
      }
      // The area level is the key of the --area-type filter and typed AreaType: a value
      // outside the three (an upstream relabel to "WK" or "Bundesland") used to pass as
      // is, so `--area-type Wahlkreis` matched nothing and answered `[]` with exit 0. A
      // case variant ("BUND") is read as its level; anything else is a parse error.
      const gebietsartRaw = cell(r, at("Gebietsart"));
      const gebietsart = AREA_TYPES.find((a) => a.toLowerCase() === gebietsartRaw.toLowerCase());
      if (gebietsart === undefined) {
        throw new BundeswahlParseError(
          `Malformed CSV: column "Gebietsart" in data row ${i + 1} of ${BTW2025.results} must be ` +
            `${AREA_TYPES.join(", ")}, got "${cutForMessage(sanitizeServerText(gebietsartRaw))}".`,
        );
      }
      return {
        wahlart: cell(r, at("Wahlart")),
        wahltag: cell(r, at("Wahltag")),
        gebietsart,
        gebietsnummer: cell(r, at("Gebietsnummer")),
        gebietsname: cell(r, at("Gebietsname")),
        ueGebietsart: cell(r, at("UegGebietsart")),
        ueGebietsnummer: cell(r, at("UegGebietsnummer")),
        gruppenart: cell(r, at("Gruppenart")),
        gruppenname: cell(r, at("Gruppenname")),
        gruppenreihenfolge: cell(r, at("Gruppenreihenfolge")),
        stimme: stimmeRaw === "1" ? 1 : stimmeRaw === "2" ? 2 : null,
        anzahl: num(r, i + 1, "Anzahl"),
        prozent: num(r, i + 1, "Prozent"),
        vorpAnzahl: num(r, i + 1, "VorpAnzahl"),
        vorpProzent: num(r, i + 1, "VorpProzent"),
        diffProzent: num(r, i + 1, "DiffProzent"),
        diffProzentPkt: num(r, i + 1, "DiffProzentPkt"),
        bemerkung: cell(r, at("Bemerkung")),
        gewaehlt: cell(r, at("Gewählt")),
      };
    });

    if (areaType !== undefined) rows = rows.filter((r) => r.gebietsart === areaType);
    if (area !== undefined) {
      // A bare number matches the area number ignoring leading zeros ("5" == "005");
      // anything else is a case-insensitive name substring.
      const a = area.trim();
      rows = isNumeric(a)
        ? rows.filter((r) => sameNumber(r.gebietsnummer, a))
        : rows.filter((r) => includesCi(r.gebietsname, a));
    }
    if (party !== undefined) rows = rows.filter((r) => includesCi(r.gruppenname, party));
    if (query.vote !== undefined) rows = rows.filter((r) => r.stimme === (query.vote as Vote));
    if (groupType !== undefined) rows = rows.filter((r) => includesCi(r.gruppenart, groupType));
    return rows;
  }

  /** The parties / groups reference list (btw25_parteien). */
  async parties(): Promise<Party[]> {
    const text = await this.engine.getText(BTW2025.parties);
    const parsed = parseDataset(text, BTW2025.parties, PARTY_COLUMNS);
    const at = indexMap(parsed.header);
    return parsed.rows.map<Party>((r) => ({
      gruppenschluessel: cell(r, at("Gruppenschluessel")),
      gruppenartXml: cell(r, at("Gruppenart_XML")),
      gruppenartCsv: cell(r, at("Gruppenart_CSV")),
      kurz: cell(r, at("GruppennameKurz")),
      name: cell(r, at("Gruppenname")),
    }));
  }

  /** The constituencies (Wahlkreise), optionally filtered by Land (name/abbr/number). */
  async wahlkreise(opts: { land?: string } = {}): Promise<Wahlkreis[]> {
    assertValid("options", opts, knownKeysProblem(WAHLKREISE_KEYS));
    const land = textFilter("land", opts.land);
    const text = await this.engine.getText(BTW2025.wahlkreise);
    const parsed = parseDataset(text, BTW2025.wahlkreise, WAHLKREIS_COLUMNS);
    const at = indexMap(parsed.header);
    let rows = parsed.rows.map<Wahlkreis>((r) => ({
      nr: cell(r, at("WKR_NR")),
      name: cell(r, at("WKR_NAME")),
      landNr: cell(r, at("LAND_NR")),
      landName: cell(r, at("LAND_NAME")),
      landAbk: cell(r, at("LAND_ABK")),
    }));
    if (land !== undefined) {
      // A bare number matches the Land number ignoring leading zeros ("9" == "09").
      // A value that is exactly a Land abbreviation (case-insensitive) matches only
      // that Land: "HE" is also a substring of "Rheinland-Pfalz" and
      // "Nordrhein-Westfalen", "ST" of "Holstein"/"Westfalen" and "BE" of
      // "Baden-Württemberg", and the abbreviation is the documented way out of name
      // ambiguity. Anything else is a Land name substring.
      const l = land.trim();
      const abk = fold(l);
      const isAbbreviation = rows.some((w) => fold(w.landAbk) === abk);
      rows = rows.filter((w) =>
        isNumeric(l)
          ? sameNumber(w.landNr, l)
          : isAbbreviation
            ? fold(w.landAbk) === abk
            : includesCi(w.landName, l),
      );
    }
    return rows;
  }

  /**
   * The structural data (Strukturdaten) per Wahlkreis — ~50 demographic/economic
   * columns exposed as a key→value map, for the **299 constituencies**. The file
   * also carries the official summary rows — 16 "Land insgesamt" (numbered 901–916)
   * and one national "Insgesamt" (999). They are dropped by default, since this
   * command is per-Wahlkreis, but `includeAggregates` keeps them: they are the
   * authoritative Land/Bund figures, and they cannot be reconstructed by summing
   * Wahlkreise (for the city states several columns repeat one city-wide value, so
   * a sum double-counts — see the rows' own `Fußnoten`). Optionally filtered by
   * Wahlkreis number (leading zeros ignored) or name substring.
   */
  async structure(opts: { wahlkreis?: string; includeAggregates?: boolean } = {}): Promise<StructureRow[]> {
    assertValid("options", opts, knownKeysProblem(STRUCTURE_KEYS));
    const wahlkreis = textFilter("wahlkreis", opts.wahlkreis);
    // Checked like every other option: a string "false" (from an env variable or a query
    // string) is truthy and used to include the 17 aggregate rows, so a caller summing a
    // column double-counted — the mistake this option exists to prevent.
    const includeAggregates: unknown = opts.includeAggregates;
    if (includeAggregates !== undefined && typeof includeAggregates !== "boolean") {
      throw new BundeswahlValidationError(
        `Invalid includeAggregates: expected true or false, got ${describeValue(includeAggregates)}.`,
      );
    }
    const text = await this.engine.getText(BTW2025.structure);
    const parsed = parseDataset(text, BTW2025.structure, STRUCTURE_COLUMNS);
    // Cells are trimmed, as every other dataset's mapper does: the upstream file has one
    // Wahlkreis name with a trailing space (16, "…Vorpommern-Greifswald II "), so a join
    // of `wahlkreise` names to these found nothing for it.
    let rows = rowsToObjects(parsed);
    for (const row of rows) {
      for (const key of Object.keys(row)) row[key] = row[key]!.trim();
    }
    if (includeAggregates !== true) {
      rows = rows.filter((r) => {
        const nr = (r["Wahlkreis-Nr."] ?? "").trim();
        return /^\d+$/.test(nr) && Number(nr) >= 1 && Number(nr) <= 299;
      });
    }
    if (wahlkreis !== undefined) {
      const w = wahlkreis.trim();
      const wNum = w.replace(/^0+/, "");
      rows = rows.filter((row) => {
        const nr = (row["Wahlkreis-Nr."] ?? "").replace(/^0+/, "");
        const name = row["Wahlkreis-Name"] ?? "";
        return nr === wNum || includesCi(name, w);
      });
    }
    return rows;
  }
}
