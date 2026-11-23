// This server's tools against generated open-data files, with the skills' traps as cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { bundeswahl } from "./helpers.js";

const world = bundeswahl();

test("four tools: the result first, then the reference data", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["getElectionResult", "findWahlkreise", "getStructureData", "listParties"]);
});

test("getElectionResult: a Wahlkreis by name, second votes, the constituency's winner and who was elected", async () => {
  const connection = await connect({ transport: world });
  const result = await connection.call("getElectionResult", { area: "Kiel" });
  const answer = result.structuredContent as Record<string, unknown>;
  assert.equal(answer["status"], "ok", result.content[0]?.text);
  assert.deepEqual((answer["parties"] as { party: string }[])[0]?.party, "GRÜNE");
  assert.deepEqual(answer["constituency"], { mostFirstVotes: "GRÜNE", elected: "GRÜNE" });
  assert.match(String(answer["licence"]), /Quelle: Die Bundeswahlleiterin, Wiesbaden 2025/);
  await connection.close();
});

test("getElectionResult: an ambiguous area lists the candidates", async () => {
  const connection = await connect({ transport: world });
  const result = await connection.call("getElectionResult", { area: "1" });
  assert.equal(result.structuredContent?.["status"], "ambiguous");
  assert.equal((result.structuredContent?.["candidates"] as unknown[]).length, 2);
  await connection.close();
});

test("findWahlkreise, getStructureData (an unknown number is empty with a reason) and listParties (no totals rows)", async () => {
  const connection = await connect({ transport: world });
  const found = await connection.call("findWahlkreise", { name: "münchen" });
  assert.deepEqual((found.structuredContent?.["wahlkreise"] as { nr: string }[]).map((w) => w.nr), ["212"]);
  const data = await connection.call("getStructureData", { wahlkreis: "1" });
  assert.equal(data.structuredContent?.["name"], "Flensburg – Schleswig");
  const none = await connection.call("getStructureData", { wahlkreis: "298" });
  assert.equal(none.structuredContent?.["status"], "empty");
  const parties = await connection.call("listParties", {});
  assert.deepEqual((parties.structuredContent?.["parties"] as { short: string }[]).map((p) => p.short), ["SPD", "GRÜNE"]);
  await connection.close();
});

test("findWahlkreise: a blank name is refused like a blank land, never a list of every Wahlkreis", async () => {
  const connection = await connect({ transport: world });
  const result = await connection.call("findWahlkreise", { name: " " });
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  assert.match(result.content[0]?.text ?? "", /Invalid name: /);
  await connection.close();
});
