// The use cases of the skills against generated open-data files, with the skills' traps as cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeswahlClient, BundeswahlValidationError, findWahlkreise, getElectionResult, getStructureData } from "../src/index.js";
import { smallElection, structureCsv, wahlkreiseCsv, wahlkreiseWith } from "./fixtures.js";
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
  assert.equal(await getStructureData(c, { wahlkreis: "298" }), undefined);
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
