// The use cases of the skills as library functions, built on the client: each carries the
// traps the skills document, so no caller (the CLI, the MCP server's tools, a library user) has
// to know them.
// - getElectionResult: one area's Bundestagswahl 2025 result (bundeswahl-results);
// - findWahlkreise: constituencies by name, Land or number (bundeswahl-reference);
// - getStructureData: one Wahlkreis' structural data, with its footnote (bundeswahl-reference).

import type { BundeswahlClient } from "./client.js";
import type { AreaType, ResultRow, StructureRow, Vote, Wahlkreis } from "./types.js";

/** One party's result in an area, for one ballot. */
export interface PartyResult {
  party: string;
  votes: number;
  percent: number | null;
  /** The share at the previous Bundestagswahl (2021), and the change in points. */
  previousPercent?: number;
  changePoints?: number;
}

/** An area the search matched. */
export interface Area {
  type: AreaType;
  number: string;
  name: string;
}

/** The answer of {@link getElectionResult}. */
export type ElectionResult =
  | { status: "empty"; searched: { area: string; areaType?: AreaType }; reason: string }
  | { status: "ambiguous"; candidates: Area[]; reason: string }
  | {
      status: "ok";
      area: Area;
      vote: Vote;
      /** Wahlberechtigte, Wählende, turnout in percent; valid and invalid votes of this ballot. */
      turnout: { eligible: number | null; voters: number | null; percent: number | null; valid: number | null; invalid: number | null };
      /** The parties of this ballot with votes, most votes first (parties without a candidate or list left out). */
      parties: PartyResult[];
      /**
       * In a Wahlkreis: the party with the most first votes, and the party whose candidate was
       * elected; under the 2025 law the winner gets the seat only if the party's second votes
       * cover it, so `elected` can be none.
       */
      constituency?: { mostFirstVotes?: string; elected: string | null };
    };

const SYSTEM = "System-Gruppe";

/**
 * One area's result: the Bund (area "99" or "Bund"), a Land or a Wahlkreis by number or name.
 * Second votes unless `vote` is 1. A name that matches several areas is ambiguous, with the
 * candidates, never one picked; the totals are matched by their exact name (Gültige, not
 * Ungültige), parties without votes are dropped before sorting.
 */
export async function getElectionResult(
  client: BundeswahlClient,
  input: { area: string; areaType?: AreaType | undefined; vote?: Vote | undefined },
): Promise<ElectionResult> {
  const vote: Vote = input.vote ?? 2;
  const area = input.area.trim();
  const rows = await client.results({ ...(input.areaType === undefined ? {} : { areaType: input.areaType }), area });
  const areas = new Map<string, Area>();
  for (const row of rows) areas.set(`${row.gebietsart}/${row.gebietsnummer}`, { type: row.gebietsart, number: row.gebietsnummer, name: row.gebietsname });
  if (areas.size === 0) {
    return { status: "empty", searched: { area, ...(input.areaType === undefined ? {} : { areaType: input.areaType }) }, reason: "No area matches; try a Wahlkreis number (1-299), a Land name or 'Bund'." };
  }
  let chosen = [...areas.values()];
  if (chosen.length > 1) {
    const exact = chosen.filter((a) => a.name.toLowerCase() === area.toLowerCase());
    if (exact.length === 1) chosen = exact;
    else return { status: "ambiguous", candidates: chosen.slice(0, 25), reason: `${chosen.length} areas match; ask which one and call again with its number and areaType.` };
  }
  const one = chosen[0] as Area;
  const mine = rows.filter((r) => r.gebietsart === one.type && r.gebietsnummer === one.number);
  const total = (name: string, stimme: Vote | null): number | null => mine.find((r) => r.gruppenart === SYSTEM && r.gruppenname === name && r.stimme === stimme)?.anzahl ?? null;
  const eligible = total("Wahlberechtigte", null);
  const voters = total("Wählende", null);
  const parties = (ballot: Vote): ResultRow[] =>
    mine.filter((r) => r.gruppenart !== SYSTEM && r.stimme === ballot && r.anzahl !== null).sort((a, b) => (b.anzahl as number) - (a.anzahl as number));
  const elected = mine.find((r) => r.gewaehlt !== "")?.gewaehlt;
  return {
    status: "ok",
    area: one,
    vote,
    turnout: {
      eligible,
      voters,
      percent: eligible && voters !== null ? Math.round((voters / eligible) * 1000) / 10 : null,
      valid: total("Gültige", vote),
      invalid: total("Ungültige", vote),
    },
    parties: parties(vote).map((r) => ({
      party: r.gruppenname,
      votes: r.anzahl as number,
      percent: r.prozent,
      ...(r.vorpProzent !== null ? { previousPercent: r.vorpProzent } : {}),
      ...(r.diffProzentPkt !== null ? { changePoints: r.diffProzentPkt } : {}),
    })),
    ...(one.type === "Wahlkreis"
      ? { constituency: { ...(parties(1)[0] ? { mostFirstVotes: (parties(1)[0] as ResultRow).gruppenname } : {}), elected: elected === undefined || elected === "–" ? null : elected } }
      : {}),
  };
}

/**
 * Wahlkreise by name (contains, any case), Land (a name contains it, or its abbreviation or
 * number: "Sachsen" also matches Niedersachsen and Sachsen-Anhalt, "SN" only Sachsen) or number
 * (leading zeros ignored).
 */
export async function findWahlkreise(
  client: BundeswahlClient,
  input: { name?: string | undefined; land?: string | undefined; number?: string | undefined } = {},
): Promise<{ total: number; wahlkreise: Wahlkreis[] }> {
  const all = await client.wahlkreise(input.land === undefined ? {} : { land: input.land });
  const name = input.name?.trim().toLowerCase();
  const number = input.number?.trim().replace(/^0+(?=\d)/, "");
  const found = all.filter((w) => (name === undefined || w.name.toLowerCase().includes(name)) && (number === undefined || w.nr.replace(/^0+(?=\d)/, "") === number));
  return { total: found.length, wahlkreise: found };
}

/** The answer of {@link getStructureData}. */
export interface StructureData {
  wahlkreis: string;
  name: string;
  /** Column name -> value, as the file has them (German decimal comma kept: "128,0"). */
  values: Record<string, string>;
  /**
   * The file's footnote: where a city or Kreis forms several Wahlkreise, many columns hold the
   * value for the whole city, so those Wahlkreise can't be ranked against each other.
   */
  footnote?: string;
}

/** One Wahlkreis' structural data (Strukturdaten), number with or without leading zeros. */
export async function getStructureData(client: BundeswahlClient, input: { wahlkreis: string }): Promise<StructureData | undefined> {
  const rows: StructureRow[] = await client.structure({ wahlkreis: input.wahlkreis });
  const row = rows[0];
  if (row === undefined) return undefined;
  const values = { ...row } as Record<string, string>;
  const footnote = values["Fußnoten"];
  delete values["Fußnoten"];
  return {
    wahlkreis: values["Wahlkreis-Nr."] ?? input.wahlkreis.trim(),
    name: values["Wahlkreis-Name"] ?? "",
    values,
    ...(footnote ? { footnote } : {}),
  };
}
