// Typed shapes for the Bundeswahlleiterin open-data CSVs (Bundestagswahl 2025).
// Field names follow the source columns (camelCased); counts and percentages are
// parsed to numbers, with `null` for empty / placeholder cells so "no value" is
// distinct from `0`. Area/group codes stay strings to preserve leading zeros.

/** The kind of electoral area a result row is for. */
export type AreaType = "Bund" | "Land" | "Wahlkreis";

/** Which ballot a count refers to: 1 = Erststimme, 2 = Zweitstimme (null on the Wahlberechtigte/Wählende rows). */
export type Vote = 1 | 2;

/**
 * One row of the "Ergebnisse nach Wahlkreisen" results (kerg2). The table is long/
 * tidy: one row per (area × group × ballot), so each party has separate first- and
 * second-vote rows, and "System-Gruppe" rows carry turnout totals (Wahlberechtigte,
 * Wählende, Gültige, …).
 */
export interface ResultRow {
  /** Election type, e.g. "BT" (Bundestag). */
  wahlart: string;
  /** Polling day, e.g. "23.02.2025". */
  wahltag: string;
  gebietsart: AreaType;
  /** Area number (Bund 99, Land 01–16, Wahlkreis 001–299) — kept as a string. */
  gebietsnummer: string;
  gebietsname: string;
  /** Parent area type, e.g. "LAND" for a Wahlkreis ("" for Bund). */
  ueGebietsart: string;
  ueGebietsnummer: string;
  /** "Partei" | "Einzelbewerber/Wählergruppe" | "System-Gruppe". */
  gruppenart: string;
  /** Party / group name, e.g. "SPD", "CDU", "Wahlberechtigte". */
  gruppenname: string;
  gruppenreihenfolge: string;
  /** 1 = Erststimme, 2 = Zweitstimme; null for the Wahlberechtigte and Wählende totals. */
  stimme: Vote | null;
  /** Count for this row; null when the group had no candidate/list in this area. */
  anzahl: number | null;
  /** Share in percent. */
  prozent: number | null;
  /** Count at the previous comparable election. */
  vorpAnzahl: number | null;
  vorpProzent: number | null;
  diffProzent: number | null;
  diffProzentPkt: number | null;
  bemerkung: string;
  /**
   * Name of the group whose Wahlkreis candidate was elected — the same value
   * repeats on every row of a Wahlkreis (e.g. "GRÜNE"). "–" where the Erststimme
   * winner's seat was not covered by the party's Zweitstimmen (no one elected
   * directly); empty for Bund/Land rows.
   */
  gewaehlt: string;
}

/** A party / group from the parties reference list (btw25_parteien). */
export interface Party {
  gruppenschluessel: string;
  gruppenartXml: string;
  gruppenartCsv: string;
  kurz: string;
  name: string;
}

/** A constituency (Wahlkreis) from the Wahlkreis names reference list. */
export interface Wahlkreis {
  nr: string;
  name: string;
  landNr: string;
  landName: string;
  landAbk: string;
}

/**
 * A structural-data row (Strukturdaten) for one Wahlkreis. The file has ~50
 * demographic/economic columns whose names vary, so it is exposed as an open
 * key→value map (column name → cell), preserving whatever the file provides.
 * Values stay strings in German number format (e.g. "128,0"); the `Fußnoten`
 * column notes where a column holds a city- or Kreis-wide value.
 */
export type StructureRow = Record<string, string>;

/** Filters for a results query (all optional; applied client-side after the fetch). */
export interface ResultsQuery {
  /** Restrict to one area level. */
  areaType?: AreaType;
  /**
   * Match an area by number (leading zeros ignored) or case-insensitive name
   * substring. Land and Wahlkreis numbers overlap, so combine with `areaType`.
   */
  area?: string;
  /** Match a group/party by case-insensitive name substring. */
  party?: string;
  /** Restrict to first (1) or second (2) votes. */
  vote?: Vote;
  /** Restrict to a `gruppenart` (e.g. "Partei"). */
  groupType?: string;
}
