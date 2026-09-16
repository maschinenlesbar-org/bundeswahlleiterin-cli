// BundeswahlClient — a typed client over the Bundeswahlleiterin open-data CSV
// files for the Bundestagswahl 2025. No auth. Each dataset is one CSV fetched
// from www.bundeswahlleiterin.de, parsed and mapped to typed rows. Filters are
// applied client-side (the files are whole datasets).
//
//   const c = new BundeswahlClient();
//   await c.results({ areaType: "Wahlkreis", area: "Flensburg", vote: 2 });
//   await c.parties();
//   await c.wahlkreise({ land: "Bayern" });

import { RequestEngine, type EngineOptions } from "./engine.js";
import { parseCsv, parseGermanNumber, rowsToObjects, type ParsedCsv } from "./csv.js";
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

/**
 * `parseCsv`, but fail loudly if the expected header row is not found. Without
 * this, a `200` response that isn't the expected file (a replaced/moved dataset,
 * or an upstream column rename) would yield an empty header and the command would
 * silently return `[]` — indistinguishable from "no matches".
 */
function parseDataset(text: string, headerFirstCell: string, path: string): ParsedCsv {
  const parsed = parseCsv(text, { headerFirstCell });
  if (parsed.header.length === 0) {
    throw new BundeswahlParseError(
      `Could not find the expected header ("${headerFirstCell}") in ${path} — ` +
        "the open-data file format may have changed.",
    );
  }
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
    const parsed = parseDataset(text, "Wahlart", BTW2025.results);
    const at = indexMap(parsed.header);
    let rows = parsed.rows.map<ResultRow>((r) => {
      const stimmeRaw = cell(r, at("Stimme"));
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
        anzahl: parseGermanNumber(cell(r, at("Anzahl"))),
        prozent: parseGermanNumber(cell(r, at("Prozent"))),
        vorpAnzahl: parseGermanNumber(cell(r, at("VorpAnzahl"))),
        vorpProzent: parseGermanNumber(cell(r, at("VorpProzent"))),
        diffProzent: parseGermanNumber(cell(r, at("DiffProzent"))),
        diffProzentPkt: parseGermanNumber(cell(r, at("DiffProzentPkt"))),
        bemerkung: cell(r, at("Bemerkung")),
        gewaehlt: cell(r, at("Gewählt")),
      };
    });

    // Drop malformed/truncated lines: a real result row always names a group, so a
    // row with no `gruppenname` is not a data row (a ghost from a short line — which
    // also lacks the columns before it, so this one check is enough).
    rows = rows.filter((r) => r.gruppenname !== "");

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
    const parsed = parseDataset(text, "Gruppenschluessel", BTW2025.parties);
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
    const parsed = parseDataset(text, "WKR_NR", BTW2025.wahlkreise);
    const at = indexMap(parsed.header);
    let rows = parsed.rows.map<Wahlkreis>((r) => ({
      nr: cell(r, at("WKR_NR")),
      name: cell(r, at("WKR_NAME")),
      landNr: cell(r, at("LAND_NR")),
      landName: cell(r, at("LAND_NAME")),
      landAbk: cell(r, at("LAND_ABK")),
    }));
    if (opts.land !== undefined) {
      // A bare number matches the Land number ignoring leading zeros ("9" == "09");
      // anything else matches the Land name (substring) or its abbreviation.
      const l = opts.land.trim();
      rows = rows.filter((w) =>
        isNumeric(l)
          ? sameNumber(w.landNr, l)
          : includesCi(w.landName, l) || w.landAbk.toLowerCase() === l.toLowerCase(),
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
    const parsed = parseDataset(text, "Land", BTW2025.structure);
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
