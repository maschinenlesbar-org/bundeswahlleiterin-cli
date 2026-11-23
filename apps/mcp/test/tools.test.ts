// This server's tools against generated open-data files, with the skills' traps as cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { SIZE_HINT, TOOLS } from "../src/mcp/tools.js";
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
  const none = await connection.call("getStructureData", { wahlkreis: "300" });
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

test("the deadline's and the size cap's advice fit every tool: one whole file per call, an option only with the tools that take it", async () => {
  const hanging = { transport: (): Promise<never> => new Promise<never>(() => {}) };
  const args: Record<string, Record<string, unknown>> = { getElectionResult: { area: "Kiel" }, findWahlkreise: { land: "SH" }, getStructureData: { wahlkreis: "1" }, listParties: {} };
  const schemas = new Map(TOOLS.map((tool) => [tool.name, Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)]));
  for (const tool of TOOLS) {
    const connection = await connect({ transport: hanging, config: { callTimeoutMs: 30 } });
    const text = (await connection.call(tool.name, args[tool.name] ?? {})).content[0]?.text ?? "";
    await connection.close();
    assert.match(text, /took longer than .* and was stopped/, tool.name);
    assert.match(text, /whole file .* whatever its arguments/, tool.name);
    assert.match(text, /try again/, tool.name);
    assert.doesNotMatch(text, /results file|one area at a time/, `${tool.name}: ${text}`);
  }
  for (const advice of [SIZE_HINT]) {
    assert.doesNotMatch(advice, /Narrow the Wahlkreise/);
    const pairs = [...advice.matchAll(/(\w+) \((\w+(?:, \w+)*)\)/g)];
    assert.ok(pairs.length >= 1, advice);
    for (const [, option, tools] of pairs) for (const tool of (tools as string).split(", ")) assert.ok(schemas.get(tool)?.includes(option as string), `${tool} takes no ${option}`);
  }
});

test("getStructureData: a Land's and Germany's summary rows by their numbers, with their level", async () => {
  const connection = await connect({ transport: world });
  const land = await connection.call("getStructureData", { wahlkreis: "901" });
  assert.equal(land.structuredContent?.["status"], "ok", land.content[0]?.text);
  assert.equal(land.structuredContent?.["level"], "Land");
  assert.equal((land.structuredContent?.["values"] as Record<string, string>)["Land"], "Schleswig-Holstein");
  const bund = await connection.call("getStructureData", { wahlkreis: "999" });
  assert.equal(bund.structuredContent?.["level"], "Bund");
  const none = await connection.call("getStructureData", { wahlkreis: "950" });
  assert.match(String(none.structuredContent?.["reason"]), /901 to 916, Germany's is 999/);
  await connection.close();
});
