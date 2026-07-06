import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeswahlClient, BTW2025 } from "../src/client/client.js";
import { BundeswahlParseError } from "../src/client/errors.js";
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

test("results() drops truncated rows that name no group (F4)", async () => {
  const mt = makeMockTransport(() => csvResponse(fx.kerg2Csv));
  const c = new BundeswahlClient({ transport: mt.transport });
  const rows = await c.results();
  assert.ok(rows.every((r) => r.gruppenname !== ""));
  assert.ok(!rows.some((r) => r.gebietsname === "Ragged"));
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
