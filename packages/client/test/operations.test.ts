// The use cases of the skills against generated open-data files, with the skills' traps as cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeswahlClient, BundeswahlValidationError, findWahlkreise, getElectionResult, getStructureData } from "../src/index.js";
import { election, smallElection, structureCsv, wahlkreiseCsv, wahlkreiseWith } from "./fixtures.js";
import { csvResponse, makeMockTransport } from "./helpers.js";

const client = (body: string) => new BundeswahlClient({ transport: makeMockTransport(() => csvResponse(body)).transport });
const results = client(smallElection);

test("getElectionResult: second votes by default, parties by votes, totals by their exact names, turnout", async () => {
  const r = await getElectionResult(results, { area: "Flensburg" });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.deepEqual(r.parties.map((p) => p.party), ["GRÜNE", "CDU", "SPD"]);
  assert.deepEqual(r.turnout, { eligible: 200, voters: 160, percent: 80, valid: 158, invalid: 2 }, "Gültige is not Ungültige, which a substring match finds first");
  assert.equal(r.parties[0]?.changePoints !== undefined, true);
});

test("getElectionResult: a Wahlkreis winner whose seat isn't covered elects no one; the most first votes are still named", async () => {
  const r = await getElectionResult(results, { area: "1", areaType: "Wahlkreis", vote: 1 });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.deepEqual(r.constituency, { mostFirstVotes: "CDU", elected: null });
  assert.deepEqual(r.parties.map((p) => p.party), ["CDU", "SPD", "GRÜNE"]);
});

test("getElectionResult: a party without a list there (no votes) is left out, not sorted as a null", async () => {
  const r = await getElectionResult(results, { area: "München-Nord", vote: 1 });
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.parties.some((p) => p.party === "BSW"), false);
});

test("getElectionResult: a number without areaType that names several areas is ambiguous, never one picked", async () => {
  const r = await getElectionResult(results, { area: "1" });
  assert.equal(r.status, "ambiguous");
  if (r.status === "ambiguous") assert.deepEqual(r.candidates.map((c) => `${c.type} ${c.number}`).sort(), ["Land 01", "Wahlkreis 001"]);
  const none = await getElectionResult(results, { area: "Atlantis" });
  assert.equal(none.status, "empty");
});

test("findWahlkreise by name, number (leading zeros ignored) and Land abbreviation", async () => {
  const c = client(wahlkreiseCsv);
  assert.deepEqual((await findWahlkreise(c, { name: "kiel" })).wahlkreise.map((w) => w.nr), ["005"]);
  assert.deepEqual((await findWahlkreise(c, { number: "5" })).wahlkreise.map((w) => w.name), ["Kiel"]);
  assert.equal((await findWahlkreise(c, { land: "SH" })).total, 2);
});

test("getStructureData: the values as published, the footnote apart; an unknown number is undefined", async () => {
  const c = client(structureCsv);
  const data = await getStructureData(c, { wahlkreis: "212" });
  assert.equal(data?.name, "München-Nord");
  assert.equal(data?.values["Fläche (km²)"], "100,0");
  assert.equal(await getStructureData(c, { wahlkreis: "300" }), undefined);
});

test("findWahlkreise matches a name as every other filter does: dash variants, upper-case SS for ß, NFD", async () => {
  const c = client(wahlkreiseWith(["001;Flensburg – Schleswig;01;Schleswig-Holstein;SH", "173;Gießen;06;Hessen;HE", "093;Köln II;05;Nordrhein-Westfalen;NW"]));
  for (const [name, nr] of [["Flensburg - Schleswig", "001"], ["GIESSEN", "173"], ["giessen", "173"], ["Köln", "093"], ["KÖLN", "093"]] as const) {
    assert.deepEqual((await findWahlkreise(c, { name })).wahlkreise.map((w) => w.nr), [nr], name);
  }
});

test("findWahlkreise refuses a blank name or number, and one with only invisible or control characters, before any request", async () => {
  const mt = makeMockTransport(() => csvResponse(wahlkreiseCsv));
  const c = new BundeswahlClient({ transport: mt.transport });
  for (const input of [{ name: " " }, { name: "​" }, { name: "Köln\u0000" }, { number: " " }, { name: 5 as unknown as string }]) {
    await assert.rejects(() => findWahlkreise(c, input), (e: unknown) => e instanceof BundeswahlValidationError && /^Invalid (name|number): /.test(e.message), JSON.stringify(input));
  }
  assert.equal(mt.calls.length, 0);
});

test("getElectionResult: a name exact but for its form (NFD, case, a dash) picks that area out of the ones it is part of", async () => {
  const party = [{ name: "SPD", first: 10, second: 10 }];
  const koeln = (nr: string, name: string) => ({ nr, name, land: { nr: "05", name: "Nordrhein-Westfalen" }, eligible: 20, voters: 10, parties: party, elected: "SPD" });
  const c = client(election([koeln("093", "Köln I"), koeln("094", "Köln II"), koeln("095", "Köln III"), koeln("101", "Leverkusen – Köln IV")]));
  for (const area of ["Köln I", "Köln I", "KÖLN I", "Leverkusen - Köln IV"]) {
    const r = await getElectionResult(c, { area });
    assert.equal(r.status, "ok", area);
    if (r.status === "ok") assert.equal(r.area.number, area.startsWith("Lev") ? "101" : "093", area);
  }
});

test("getElectionResult: with areaType Bund the one Bund answers, whatever the area says", async () => {
  for (const area of ["Deutschland", "Germany", "Bund", "99"]) {
    const r = await getElectionResult(results, { area, areaType: "Bund" });
    assert.equal(r.status, "ok", area);
    if (r.status === "ok") assert.deepEqual(r.area, { type: "Bund", number: "99", name: "Bundesgebiet" }, area);
  }
});

test("getStructureData: a Land's (901-916) and the Bund's (999) summary rows by their numbers, with their level", async () => {
  const c = client(structureCsv);
  const land = await getStructureData(c, { wahlkreis: "901" });
  assert.equal(land?.level, "Land");
  assert.equal(land?.values["Land"], "Schleswig-Holstein");
  assert.equal(land?.values["Fläche (km²)"], "15804,3");
  const bund = await getStructureData(c, { wahlkreis: "999" });
  assert.equal(bund?.level, "Bund");
  assert.equal(bund?.name, "Insgesamt");
  assert.equal((await getStructureData(c, { wahlkreis: "212" }))?.level, "Wahlkreis");
  for (const none of ["902", "950", "300"]) assert.equal(await getStructureData(c, { wahlkreis: none }), undefined, none);
});
