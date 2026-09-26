import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeswahlClient, BTW2025 } from "../src/client/client.js";
import { BundeswahlValidationError, BundeswahlParseError } from "../src/client/errors.js";
import { makeMockTransport, csvResponse } from "./helpers.js";
import * as fx from "./fixtures.js";

function pathOf(url: string): string {
  return new URL(url).pathname;
}

test("results() hits the kerg2 path and parses typed rows", async () => {
  const mt = makeMockTransport(() => csvResponse(fx.kerg2Csv));
  const c = new BundeswahlClient({ transport: mt.transport });
  const rows = await c.results();
  assert.equal(pathOf(mt.last().url), BTW2025.results);
  assert.equal(rows.length, 4);
  const gruene = rows.find((r) => r.gebietsart === "Bund" && r.gruppenname === "GRÜNE")!;
  assert.equal(gruene.stimme, 2);
  assert.equal(gruene.anzahl, 5762380);
  assert.equal(gruene.prozent, 11.606116);
  assert.equal(gruene.diffProzentPkt, -3.112341);
  const wb = rows.find((r) => r.gruppenname === "Wahlberechtigte")!;
  assert.equal(wb.stimme, null); // system group has no ballot
  assert.equal(wb.anzahl, 60510631);
});

test("results() filters by area-type, area (number+name), party, vote and group-type", async () => {
  const c = () => new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(fx.kerg2Csv)).transport });
  assert.equal((await c().results({ areaType: "Bund" })).length, 2);
  assert.equal((await c().results({ areaType: "Wahlkreis" })).length, 2);
  assert.equal((await c().results({ area: "005" })).length, 2); // Kiel by number
  assert.equal((await c().results({ area: "5" })).length, 2); // ...and leading-zero-insensitive
  assert.equal((await c().results({ area: "kiel" })).length, 2); // Kiel by name (ci)
  assert.equal((await c().results({ party: "grüne" })).length, 2); // ci substring
  assert.equal((await c().results({ vote: 1 })).length, 2);
  assert.equal((await c().results({ vote: 2 })).length, 1);
  assert.equal((await c().results({ groupType: "System" })).length, 1);
  assert.equal((await c().results({ areaType: "Wahlkreis", vote: 1, party: "SPD" })).length, 1);
  assert.equal((await c().results({ party: "nonesuch" })).length, 0);
});

test("a truncated or ragged data row is a parse error, not a half-parsed row", async () => {
  for (const [csv, cells] of [
    [fx.kerg2Csv + "BT;23.02.2025;Wahlkreis;006;Ragged\n", 5], // cut before the group
    [fx.kerg2Csv + "BT;23.02.2025;Bund;99;Bundesgebiet;;;Partei;GRÜNE;3;2;451510;12,609074;521411;15,", 15], // cut at a decimal comma
    [fx.kerg2Csv + "BT;23.02.2025;Bund;99;Bundesgebiet;;;Partei;SPD;1;2;1;1;1;1;1;1;;;extra\n", 20],
  ] as const) {
    const c = new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(csv)).transport });
    await assert.rejects(
      () => c.results(),
      (err) =>
        err instanceof BundeswahlParseError &&
        err.message.includes(`data row 5 of ${BTW2025.results} has ${cells} cells, the header has 19`),
      String(cells),
    );
  }
});

test("results() carries the Gewählt winner name on Wahlkreis rows", async () => {
  const mt = makeMockTransport(() => csvResponse(fx.kerg2Csv));
  const c = new BundeswahlClient({ transport: mt.transport });
  const kiel = (await c.results({ areaType: "Wahlkreis" }));
  assert.ok(kiel.every((r) => r.gewaehlt === "GRÜNE"));
});

test("a 200 body without the expected header throws, rather than returning []", async () => {
  const mt = makeMockTransport(() => csvResponse("# only comments\nFoo;Bar\n1;2\n"));
  const c = new BundeswahlClient({ transport: mt.transport });
  await assert.rejects(
    () => c.parties(),
    (err) => err instanceof BundeswahlParseError && /expected header/i.test(err.message),
  );
});

test("parties() hits its path and maps the columns", async () => {
  const mt = makeMockTransport(() => csvResponse(fx.partiesCsv));
  const c = new BundeswahlClient({ transport: mt.transport });
  const parties = await c.parties();
  assert.equal(pathOf(mt.last().url), BTW2025.parties);
  assert.equal(parties.length, 3);
  const spd = parties.find((p) => p.kurz === "SPD")!;
  assert.equal(spd.gruppenschluessel, "2");
  assert.equal(spd.gruppenartCsv, "Partei");
  assert.equal(spd.name, "Sozialdemokratische Partei Deutschlands");
});

test("wahlkreise() hits its path and filters by Land (name, abbreviation, number)", async () => {
  const c = () => new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(fx.wahlkreiseCsv)).transport });
  assert.equal((await c().wahlkreise()).length, 3);
  assert.equal((await c().wahlkreise({ land: "Bayern" })).length, 1);
  assert.equal((await c().wahlkreise({ land: "BY" })).length, 1); // abbreviation
  assert.equal((await c().wahlkreise({ land: "01" })).length, 2); // Land number
  assert.equal((await c().wahlkreise({ land: "9" })).length, 1); // ...leading-zero-insensitive (09)
  assert.equal((await c().wahlkreise({ land: "schleswig" })).length, 2); // name substring (ci)
});

test("structure() hits its path and filters by Wahlkreis (leading zeros ignored, name substring)", async () => {
  const mt = makeMockTransport(() => csvResponse(fx.structureCsv));
  const c = new BundeswahlClient({ transport: mt.transport });
  const all = await c.structure();
  assert.equal(pathOf(mt.last().url), BTW2025.structure);
  assert.equal(all.length, 2); // the "Land insgesamt" (901) aggregate row is dropped
  assert.ok(all.every((r) => r["Wahlkreis-Nr."] !== "901"));
  assert.equal(all[0]!["Wahlkreis-Name"], "Flensburg – Schleswig");

  const c2 = new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(fx.structureCsv)).transport });
  assert.equal((await c2.structure({ wahlkreis: "001" })).length, 1); // 001 -> 1
  const c3 = new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(fx.structureCsv)).transport });
  assert.equal((await c3.structure({ wahlkreis: "münchen" }))[0]!["Wahlkreis-Nr."], "212");
});

test("a non-http(s) base URL is rejected by the client, never reaching a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => csvResponse(fx.structureCsv));
    assert.throws(
      () => new BundeswahlClient({ baseUrl, transport: mt.transport }),
      (err) => err instanceof BundeswahlValidationError && /Unsupported protocol/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("wahlkreise() --land with an exact abbreviation matches only that Land, not name substrings", async () => {
  const csv =
    "WKR_NR;WKR_NAME;LAND_NR;LAND_NAME;LAND_ABK\n" +
    "001;Flensburg – Schleswig;01;Schleswig-Holstein;SH\n" +
    "088;Aachen I;05;Nordrhein-Westfalen;NW\n" +
    "168;Kassel;06;Hessen;HE\n" +
    "198;Mainz;07;Rheinland-Pfalz;RP\n" +
    "258;Stuttgart I;08;Baden-Württemberg;BW\n" +
    "075;Berlin-Mitte;11;Berlin;BE\n" +
    "069;Magdeburg;15;Sachsen-Anhalt;ST\n";
  const land = async (l: string) =>
    (await new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(csv)).transport }).wahlkreise({ land: l }))
      .map((w) => w.landAbk);
  assert.deepEqual(await land("HE"), ["HE"]);
  assert.deepEqual(await land("he"), ["HE"]);
  assert.deepEqual(await land("ST"), ["ST"]);
  assert.deepEqual(await land("BE"), ["BE"]);
  assert.deepEqual(await land("rhein"), ["NW", "RP"]); // a non-abbreviation is still a name substring
});

test("a duplicate column name is rejected in every dataset, not resolved last-wins", async () => {
  const dupKerg = fx.kerg2Csv.replace(
    ";Stimme;Anzahl;Prozent;VorpAnzahl;VorpProzent;",
    ";Stimme;Anzahl;Prozent;Anzahl;Prozent;",
  );
  const dupWk = fx.wahlkreiseCsv.replace("LAND_NAME;LAND_ABK", "LAND_NAME;LAND_NAME");
  const dupParties = fx.partiesCsv.replace("GruppennameKurz;Gruppenname", "Gruppenname;Gruppenname");
  for (const [csv, call] of [
    [dupKerg, (c: BundeswahlClient) => c.results()],
    [dupWk, (c: BundeswahlClient) => c.wahlkreise()],
    [dupParties, (c: BundeswahlClient) => c.parties()],
  ] as const) {
    const c = new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(csv)).transport });
    await assert.rejects(
      () => call(c),
      (err) => err instanceof BundeswahlParseError && /duplicate column name/.test(err.message),
    );
  }
});

test("a renamed or missing column is a parse error, not an all-null field or an empty filter", async () => {
  for (const [csv, call, column] of [
    [fx.kerg2Csv.replace(";Anzahl;", ";Stimmen;"), (c: BundeswahlClient) => c.results(), "Anzahl"],
    [fx.wahlkreiseCsv.replace("LAND_ABK", "LAND_KZ"), (c: BundeswahlClient) => c.wahlkreise({ land: "BY" }), "LAND_ABK"],
    [fx.partiesCsv.replace("GruppennameKurz", "Kurzname"), (c: BundeswahlClient) => c.parties(), "GruppennameKurz"],
    [fx.structureCsv.replace("Wahlkreis-Nr.", "WKR"), (c: BundeswahlClient) => c.structure(), "Wahlkreis-Nr."],
  ] as const) {
    const c = new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(csv)).transport });
    await assert.rejects(
      () => call(c),
      (err) => err instanceof BundeswahlParseError && err.message.includes(`Missing column "${column}"`),
      column,
    );
  }
});

test("a malformed number or Stimme in kerg2 is a parse error naming the cell, not a guess or null", async () => {
  const row = (stimme: string, anzahl: string) =>
    `BT;23.02.2025;Bund;99;Bundesgebiet;;;Partei;SPD;1;${stimme};${anzahl};16,4;1;1;1;1;;\n`;
  for (const [extra, message] of [
    [row("2", "0x10"), /column "Anzahl" in data row 5 of .*kerg2\.csv is not a number: "0x10"/],
    [row("2", "1e3"), /column "Anzahl" in data row 5 .* is not a number: "1e3"/],
    [row("02", "1"), /column "Stimme" in data row 5 .* must be 1, 2 or empty, got "02"/],
  ] as const) {
    const c = new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(fx.kerg2Csv + extra)).transport });
    await assert.rejects(() => c.results(), (err) => err instanceof BundeswahlParseError && message.test(err.message));
  }
});

test("name filters match across NFD umlauts and hyphen vs en dash", async () => {
  const kerg = () => new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(fx.kerg2Csv)).transport });
  assert.equal((await kerg().results({ party: "GRU\u0308NE", areaType: "Bund" })).length, 1); // NFD Ü
  const wk = () => new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(fx.wahlkreiseCsv)).transport });
  const st = () => new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(fx.structureCsv)).transport });
  assert.equal((await st().structure({ wahlkreis: "Flensburg - Schleswig" }))[0]!["Wahlkreis-Nr."], "1"); // "-" vs "–"
  assert.equal((await st().structure({ wahlkreis: "Flensburg — Schleswig" })).length, 1); // em dash
  assert.equal((await st().structure({ wahlkreis: "Mu\u0308nchen" }))[0]!["Wahlkreis-Nr."], "212"); // NFD ü
  assert.equal((await wk().wahlkreise({ land: "Schleswig\u2010Holstein" })).length, 2); // U+2010 hyphen
});

test("the library validates its filters before any request, like the CLI", async () => {
  const bad: Array<[string, (c: BundeswahlClient) => Promise<unknown>, RegExp]> = [
    ["areaType", (c) => c.results({ areaType: "Kreis" as never }), /Invalid areaType: expected one of Bund, Land, Wahlkreis, got "Kreis"/],
    ["vote", (c) => c.results({ vote: "2" as never }), /Invalid vote: expected 1 \(Erststimme\) or 2 \(Zweitstimme\), got "2"/],
    ["vote", (c) => c.results({ vote: 3 as never }), /Invalid vote: .* got 3/],
    ["area", (c) => c.results({ area: "" }), /Invalid area: expected a non-empty string, got ""/],
    ["party", (c) => c.results({ party: "  " }), /Invalid party: expected a non-empty string/],
    ["groupType", (c) => c.results({ groupType: "" }), /Invalid groupType/],
    ["land", (c) => c.wahlkreise({ land: "" }), /Invalid land/],
    ["wahlkreis", (c) => c.structure({ wahlkreis: " " }), /Invalid wahlkreis/],
  ];
  for (const [name, call, message] of bad) {
    const mt = makeMockTransport(() => csvResponse(fx.kerg2Csv));
    const c = new BundeswahlClient({ transport: mt.transport });
    await assert.rejects(() => call(c), (err) => err instanceof BundeswahlValidationError && message.test(err.message), name);
    assert.equal(mt.calls.length, 0, name);
  }
  // areaType is case-insensitive, like --area-type.
  const c = new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(fx.kerg2Csv)).transport });
  assert.equal((await c.results({ areaType: "bund" as never })).length, 2);
});
