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
import { BundeswahlParseError } from "./errors.js";
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

/** Case-insensitive substring test that tolerates empty needles/haystacks. */
function includesCi(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
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

/**
 * `parseCsv`, but fail loudly if the file is not the expected one. Without this,
 * a `200` response that isn't the expected file (a replaced/moved dataset, or an
 * upstream column rename) would yield an empty header — or, for a renamed column,
 * a field that is `""`/`null` in every row, or a filter that matches nothing — and
 * the command would silently return data indistinguishable from a real answer.
 * So: the header row must be found, and every column in `columns` (all the ones
 * the mapper reads) must be in it.
 */
function parseDataset(
  text: string,
  headerFirstCell: string,
  path: string,
  columns: readonly string[],
): ParsedCsv {
  const parsed = parseCsv(text, { headerFirstCell });
  if (parsed.header.length === 0) {
    throw new BundeswahlParseError(
      `Could not find the expected header ("${headerFirstCell}") in ${path} — ` +
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
    const text = await this.engine.getText(BTW2025.results);
    const parsed = parseDataset(text, "Wahlart", BTW2025.results, RESULT_COLUMNS);
    const at = indexMap(parsed.header);
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
            `"${sanitizeServerText(raw)}".`,
        );
      }
    };
    let rows = parsed.rows.map<ResultRow>((r, i) => {
      const stimmeRaw = cell(r, at("Stimme"));
      if (stimmeRaw !== "" && stimmeRaw !== "1" && stimmeRaw !== "2") {
        throw new BundeswahlParseError(
          `Malformed CSV: column "Stimme" in data row ${i + 1} of ${BTW2025.results} must be 1, 2 or empty, ` +
            `got "${sanitizeServerText(stimmeRaw)}".`,
        );
      }
      return {
        wahlart: cell(r, at("Wahlart")),
        wahltag: cell(r, at("Wahltag")),
        gebietsart: cell(r, at("Gebietsart")) as AreaType,
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

    if (query.areaType) rows = rows.filter((r) => r.gebietsart === query.areaType);
    if (query.area !== undefined) {
      // A bare number matches the area number ignoring leading zeros ("5" == "005");
      // anything else is a case-insensitive name substring.
      const a = query.area.trim();
      rows = isNumeric(a)
        ? rows.filter((r) => sameNumber(r.gebietsnummer, a))
        : rows.filter((r) => includesCi(r.gebietsname, a));
    }
    if (query.party !== undefined) rows = rows.filter((r) => includesCi(r.gruppenname, query.party!));
    if (query.vote !== undefined) rows = rows.filter((r) => r.stimme === (query.vote as Vote));
    if (query.groupType !== undefined) rows = rows.filter((r) => includesCi(r.gruppenart, query.groupType!));
    return rows;
  }

  /** The parties / groups reference list (btw25_parteien). */
  async parties(): Promise<Party[]> {
    const text = await this.engine.getText(BTW2025.parties);
    const parsed = parseDataset(text, "Gruppenschluessel", BTW2025.parties, PARTY_COLUMNS);
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
    const text = await this.engine.getText(BTW2025.wahlkreise);
    const parsed = parseDataset(text, "WKR_NR", BTW2025.wahlkreise, WAHLKREIS_COLUMNS);
    const at = indexMap(parsed.header);
    let rows = parsed.rows.map<Wahlkreis>((r) => ({
      nr: cell(r, at("WKR_NR")),
      name: cell(r, at("WKR_NAME")),
      landNr: cell(r, at("LAND_NR")),
      landName: cell(r, at("LAND_NAME")),
      landAbk: cell(r, at("LAND_ABK")),
    }));
    if (opts.land !== undefined) {
      // A bare number matches the Land number ignoring leading zeros ("9" == "09").
      // A value that is exactly a Land abbreviation (case-insensitive) matches only
      // that Land: "HE" is also a substring of "Rheinland-Pfalz" and
      // "Nordrhein-Westfalen", "ST" of "Holstein"/"Westfalen" and "BE" of
      // "Baden-Württemberg", and the abbreviation is the documented way out of name
      // ambiguity. Anything else is a Land name substring.
      const l = opts.land.trim();
      const abk = l.toLowerCase();
      const isAbbreviation = rows.some((w) => w.landAbk.toLowerCase() === abk);
      rows = rows.filter((w) =>
        isNumeric(l)
          ? sameNumber(w.landNr, l)
          : isAbbreviation
            ? w.landAbk.toLowerCase() === abk
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
    const text = await this.engine.getText(BTW2025.structure);
    const parsed = parseDataset(text, "Land", BTW2025.structure, STRUCTURE_COLUMNS);
    let rows = rowsToObjects(parsed);
    if (!opts.includeAggregates) {
      rows = rows.filter((r) => {
        const nr = (r["Wahlkreis-Nr."] ?? "").trim();
        return /^\d+$/.test(nr) && Number(nr) >= 1 && Number(nr) <= 299;
      });
    }
    if (opts.wahlkreis !== undefined) {
      const w = opts.wahlkreis.trim();
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
