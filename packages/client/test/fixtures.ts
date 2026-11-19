// Canned Bundeswahlleiterin open-data CSVs, trimmed to what the tests assert but
// structurally faithful to the live files: semicolon-delimited, a multi-line
// preamble before the header, German decimals, and (for kerg) a UTF-8 BOM.

/**
 * Results (kerg2): preamble, header, then a structurally complete mini election — the
 * Bund, one Land and one Wahlkreis, each with its Wahlberechtigte row (the Land's equal
 * to the Bund's, the Wahlkreis' to the Land's), a few party rows, and the closing
 * "Übrige" Zweitstimme row at the end of the file, which the client's completeness check
 * requires.
 */
export const kerg2Csv =
  "﻿(c) Die Bundeswahlleiterin, Wiesbaden 2025;;;;;;;;;;;;;;;;;;\n" +
  "Datenlizenz Deutschland – Namensnennung – Version 2.0;;;;;;;;;;;;;;;;;;\n" +
  ";;;;;;;;;;;;;;;;;;\n" +
  "Ergebnisse nach Wahlkreisen;;;;;;;;;;;;;;;;;;\n" +
  ";;;;;;;;;;;;;;;;;;\n" +
  "Wahlart;Wahltag;Gebietsart;Gebietsnummer;Gebietsname;UegGebietsart;UegGebietsnummer;Gruppenart;Gruppenname;Gruppenreihenfolge;Stimme;Anzahl;Prozent;VorpAnzahl;VorpProzent;DiffProzent;DiffProzentPkt;Bemerkung;Gewählt\n" +
  "BT;23.02.2025;Bund;99;Bundesgebiet;;;System-Gruppe;Wahlberechtigte;-4;;60510631;;61172771;;-1,08241;;;\n" +
  "BT;23.02.2025;Bund;99;Bundesgebiet;;;Partei;GRÜNE;3;2;5762380;11,606116;6814408;14,718457;-15,438289;-3,112341;;\n" +
  "BT;23.02.2025;Land;01;Schleswig-Holstein;BUND;99;System-Gruppe;Wahlberechtigte;-4;;60510631;;61172771;;-1,08241;;;\n" +
  "BT;23.02.2025;Wahlkreis;005;Kiel;LAND;01;System-Gruppe;Wahlberechtigte;-4;;60510631;;61172771;;-1,08241;;;GRÜNE\n" +
  "BT;23.02.2025;Wahlkreis;005;Kiel;LAND;01;Partei;SPD;1;1;36690;22,076344;40000;25,0;-8,3;-2,9;;GRÜNE\n" +
  "BT;23.02.2025;Wahlkreis;005;Kiel;LAND;01;Partei;GRÜNE;3;1;43281;26,042143;38000;24,0;13,9;2,0;;GRÜNE\n" +
  "BT;23.02.2025;Wahlkreis;005;Kiel;LAND;01;System-Gruppe;Übrige;1000;2;;;;;;;;GRÜNE\n";

/** Parties reference (btw25_parteien): `#`-commented preamble, header, rows, the closing "Übrige" group. */
export const partiesCsv =
  "# (c) Die Bundeswahlleiterin, Wiesbaden 2025;;;;\n" +
  "# Datenlizenz Deutschland – Namensnennung – Version 2.0;;;;\n" +
  "Gruppenschluessel;Gruppenart_XML;Gruppenart_CSV;GruppennameKurz;Gruppenname\n" +
  "100;SYSTEM_GRUPPE;System-Gruppe;Wahlberechtigte;Wahlberechtigte\n" +
  "2;PARTEI;Partei;SPD;Sozialdemokratische Partei Deutschlands\n" +
  "3;PARTEI;Partei;GRÜNE;BÜNDNIS 90/DIE GRÜNEN\n" +
  "28;UEBRIGE;System-Gruppe;Übrige;Übrige\n";

/** The three Wahlkreise the tests look at; the other 296 are filler in a made-up Land. */
const namedWahlkreise: Record<string, string> = {
  "001": "001;Flensburg – Schleswig;01;Schleswig-Holstein;SH",
  "005": "005;Kiel;01;Schleswig-Holstein;SH",
  "212": "212;München-Nord;09;Bayern;BY",
};

/**
 * Wahlkreis names reference: `#`-commented preamble, header, and all 299 Wahlkreise (the
 * client refuses a list that isn't 1–299): three real ones across two Länder, the rest
 * "Wahlkreis NNN" in Land 17 "Testland" (TL), which no test's --land filter matches.
 */
export const wahlkreiseCsv = wahlkreiseWith(Object.values(namedWahlkreise));

/**
 * A complete Wahlkreis names file (1–299) holding the given rows (`"088;Aachen I;05;…"`)
 * at their numbers and "Wahlkreis NNN" in Land 17 "Testland" (TL) everywhere else.
 */
export function wahlkreiseWith(rows: readonly string[]): string {
  const byNumber = new Map(rows.map((r) => [r.slice(0, 3), r]));
  return (
    "# Wahlkreisnamen;;;;\n" +
    "WKR_NR;WKR_NAME;LAND_NR;LAND_NAME;LAND_ABK\n" +
    Array.from({ length: 299 }, (_, i) => {
      const nr = String(i + 1).padStart(3, "0");
      return `${byNumber.get(nr) ?? `${nr};Wahlkreis ${nr};17;Testland;TL`}\n`;
    }).join("")
  );
}

/** Strukturdaten: `#` preamble, a `Spalten-Nr.` row, then the real header (starts "Land") + rows. */
export const structureCsv =
  "# Strukturdaten für die Wahlkreise;;;;\n" +
  "Spalten-Nr.;;;1;2\n" +
  "Land;Wahlkreis-Nr.;Wahlkreis-Name;Fläche (km²);Bevölkerung\n" +
  "Schleswig-Holstein;1;Flensburg – Schleswig;2128,1;301,2\n" +
  "Bayern;212;München-Nord;100,0;250,0\n" +
  "Schleswig-Holstein;901;Land insgesamt;15804,3;2953,3\n" + // an aggregate row (dropped)
  "Deutschland;999;Insgesamt;357684,2;83456,0\n"; // the national one, which closes the file

/** A minimal HTML error page (what the site returns for an unknown path). */
export const htmlShell = "<!doctype html>\n<html><head><title>404</title></head><body>Not found</body></html>";

/** A Wahlkreis of a generated election: its Land, eligible voters, voters and the parties' votes. */
export interface GenWahlkreis {
  nr: string;
  name: string;
  land: { nr: string; name: string };
  eligible: number;
  voters: number;
  invalid?: number;
  /** Per party: first votes, second votes (null: no candidate or list here), the 2021 share. */
  parties: { name: string; first: number | null; second: number | null; previous?: number }[];
  /** The party whose candidate was elected, or "–" (none), as the file's Gewählt column. */
  elected: string;
}

/**
 * A complete kerg2 results file for `kreise`: the Bund, each Land and each Wahlkreis with its
 * Wahlberechtigte, Wählende, Gültige and Ungültige rows and the parties' rows, Länder and Bund
 * summed from their Wahlkreise (the client checks the sums), the closing Übrige row last.
 */
export function election(kreise: readonly GenWahlkreis[]): string {
  const de = (n: number): string => String(Math.round(n * 1e6) / 1e6).replace(".", ",");
  const lines: string[] = [];
  const area = (type: string, nr: string, name: string, parentType: string, parentNr: string, ks: readonly GenWahlkreis[], elected: string): void => {
    const sum = (f: (k: GenWahlkreis) => number): number => ks.reduce((n, k) => n + f(k), 0);
    const row = (group: string, gname: string, order: string, stimme: string, anzahl: number | null, prozent: number | null, prev?: number): void => {
      const diff = prozent !== null && prev !== undefined ? de(prozent - prev) : "";
      lines.push(`BT;23.02.2025;${type};${nr};${name};${parentType};${parentNr};${group};${gname};${order};${stimme};${anzahl ?? ""};${prozent === null ? "" : de(prozent)};;${prev === undefined ? "" : de(prev)};;${diff};;${elected}`);
    };
    const eligible = sum((k) => k.eligible);
    const voters = sum((k) => k.voters);
    const invalid = sum((k) => k.invalid ?? 0);
    row("System-Gruppe", "Wahlberechtigte", "-4", "", eligible, null);
    row("System-Gruppe", "Wählende", "-3", "", voters, null);
    const names = [...new Set(ks.flatMap((k) => k.parties.map((p) => p.name)))];
    for (const stimme of [1, 2] as const) {
      const valid = voters - invalid;
      row("System-Gruppe", "Ungültige", "-2", String(stimme), invalid, null);
      row("System-Gruppe", "Gültige", "-1", String(stimme), valid, null);
      names.forEach((party, i) => {
        const votes = ks.map((k) => k.parties.find((p) => p.name === party)?.[stimme === 1 ? "first" : "second"] ?? null);
        const total = votes.every((v) => v === null) ? null : votes.reduce<number>((n, v) => n + (v ?? 0), 0);
        const prev = ks[0]?.parties.find((p) => p.name === party)?.previous;
        row("Partei", party, String(i + 1), String(stimme), total, total === null || valid === 0 ? null : (total / valid) * 100, stimme === 2 ? prev : undefined);
      });
    }
  };
  area("Bund", "99", "Bundesgebiet", "", "", kreise, "");
  const laender = [...new Map(kreise.map((k) => [k.land.nr, k.land])).values()];
  for (const land of laender) {
    const ks = kreise.filter((k) => k.land.nr === land.nr);
    area("Land", land.nr, land.name, "BUND", "99", ks, "");
    for (const k of ks) area("Wahlkreis", k.nr, k.name, "LAND", land.nr, [k], k.elected);
  }
  const last = kreise[kreise.length - 1] as GenWahlkreis;
  lines.push(`BT;23.02.2025;Wahlkreis;${last.nr};${last.name};LAND;${last.land.nr};System-Gruppe;Übrige;1000;2;;;;;;;;${last.elected}`);
  return (
    "﻿(c) Die Bundeswahlleiterin, Wiesbaden 2025;;;;;;;;;;;;;;;;;;\n;;;;;;;;;;;;;;;;;;\n" +
    "Wahlart;Wahltag;Gebietsart;Gebietsnummer;Gebietsname;UegGebietsart;UegGebietsnummer;Gruppenart;Gruppenname;Gruppenreihenfolge;Stimme;Anzahl;Prozent;VorpAnzahl;VorpProzent;DiffProzent;DiffProzentPkt;Bemerkung;Gewählt\n" +
    lines.join("\n") +
    "\n"
  );
}

/** A small election: Kiel and Flensburg (Schleswig-Holstein), München-Nord (Bayern). */
export const smallElection = election([
  {
    nr: "001", name: "Flensburg – Schleswig", land: { nr: "01", name: "Schleswig-Holstein" }, eligible: 200, voters: 160, invalid: 2,
    parties: [{ name: "CDU", first: 70, second: 50, previous: 25 }, { name: "SPD", first: 60, second: 40, previous: 30 }, { name: "GRÜNE", first: 28, second: 68, previous: 20 }],
    elected: "–",
  },
  {
    nr: "005", name: "Kiel", land: { nr: "01", name: "Schleswig-Holstein" }, eligible: 100, voters: 80,
    parties: [{ name: "CDU", first: 20, second: 25 }, { name: "SPD", first: 25, second: 20 }, { name: "GRÜNE", first: 35, second: 35 }],
    elected: "GRÜNE",
  },
  {
    nr: "212", name: "München-Nord", land: { nr: "09", name: "Bayern" }, eligible: 300, voters: 240,
    parties: [{ name: "CSU", first: 100, second: 90 }, { name: "SPD", first: 40, second: 50 }, { name: "GRÜNE", first: 100, second: 100 }, { name: "BSW", first: null, second: 0 }],
    elected: "CSU",
  },
]);
