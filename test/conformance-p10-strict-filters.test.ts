// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never goes out.
// An unknown, misspelled or `__proto__` key, an unknown filter name, an array or NaN where
// the API takes one value are the library's validation error before any data request; a
// filter name that is only spelled differently (NFD, padding, case) is normalised or
// rejected, never sent as typed; a repeated filter flag is combined or rejected, never
// "last one wins". The API answers all of these with the whole unfiltered set or a wrong
// count and HTTP 200. Shared across the *-cli repos with filters; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { BTW2025, BundeswahlClient as Client } from "../src/client/client.js";
import { BundeswahlValidationError as ValidationError } from "../src/client/errors.js";
import { kerg2Csv } from "./fixtures.js";
/** The library's filtered call, with its query/parameter object passed through as is. */
const call = (client: Client, query: Record<string, unknown>): Promise<unknown> =>
  client.results(query as never);
/**
 * A valid query, and what goes out for it. bundeswahl filters client-side (each dataset is
 * one CSV file), so a request carries no filter: what must go out is the one fetch of the
 * results file, which `sentFilter` reads back as the request path.
 */
const GOOD = { query: { areaType: "Wahlkreis", area: "Kiel", party: "SPD", vote: 1, groupType: "Partei" } };
const GOOD_SENT = BTW2025.results;
/** What a data request carries as its filter (to compare with GOOD_SENT). */
const sentFilter = (req: HttpRequest): string | null => new URL(req.url).pathname;
/** Queries with a key the call doesn't take: unknown, misspelled, `__proto__` (from JSON). */
const BAD_KEYS: Array<[string, Record<string, unknown>]> = [
  ["unknown key", { wahlkreis: "Kiel" }],
  ["misspelled key", { partei: "SPD" }],
  ["wrong-case key", { Party: "SPD" }],
  ["__proto__ key", JSON.parse('{"__proto__": {"party": "SPD"}}') as Record<string, unknown>],
];
/** Queries whose filter names the data doesn't have (area levels and ballots). */
const BAD_FILTER_NAMES: Array<[string, Record<string, unknown>]> = [
  ["unknown area type", { areaType: "Gemeinde" }],
  ["misspelled area type", { areaType: "Wahlkries" }],
  ["__proto__ area type", { areaType: "__proto__" }],
  ["constructor area type", { areaType: "constructor" }],
  ["a ballot that doesn't exist", { vote: 3 }],
];
/** Values of the wrong type: arrays where the API takes one value, NaN, objects. */
const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ["array area", { area: ["Kiel", "Flensburg"] }],
  ["object party", { party: { SPD: true } }],
  ["NaN vote", { vote: Number.NaN }],
  ["array group type", { groupType: ["Partei"] }],
  ["array vote", { vote: [1, 2] }],
];
/**
 * Queries that differ from GOOD only in how the area level is spelled (padding, case): the
 * level is matched case-insensitively after trimming, like --area-type, so they are
 * normalised and fetch the same file.
 */
const UNNORMALISED: Array<[string, Record<string, unknown>]> = [
  ["padded level", { ...GOOD.query, areaType: " Wahlkreis " }],
  ["upper case", { ...GOOD.query, areaType: "WAHLKREIS" }],
  ["lower case", { ...GOOD.query, areaType: "wahlkreis" }],
];
const UNNORMALISED_POLICY = "normalise" as "normalise" | "reject";
/** The CLI's filter flag given twice, and what the repo does with it (one party per query). */
const REPEATED_FLAG_ARGV = ["results", "--party", "SPD", "--party", "CDU"];
const REPEATED_POLICY = "reject" as "combine" | "reject";
/** A single-value option given twice, which must be a usage error. */
const REPEATED_SINGLE_ARGV = ["results", "--vote", "1", "--vote", "2"];
const USAGE_EXIT = 2;
/** True for a request that fetches data (every request here does). */
const isDataRequest = (_req: HttpRequest): boolean => true;
/** The answer to any request. */
const respond = (_req: HttpRequest): HttpResponse => ({
  status: 200,
  headers: { "content-type": "text/csv" },
  body: Buffer.from(kerg2Csv),
});
/** CliDeps for this repo. */
const makeDeps = (io: Pick<CliDeps["io"], "out" | "err">, transport: (req: HttpRequest) => Promise<HttpResponse>): CliDeps => ({
  io: { ...io, writeFile: () => {} },
  createClient: (opts) => new Client({ ...opts, transport }),
});
// --------------------------------------------------------------------------------------

function recorder() {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return respond(req);
  };
  return { transport, data: () => requests.filter(isDataRequest) };
}

async function rejectsBeforeData(label: string, query: Record<string, unknown>): Promise<void> {
  const r = recorder();
  await assert.rejects(call(new Client({ transport: r.transport }), query), ValidationError, label);
  assert.equal(r.data().length, 0, `${label}: a data request went out`);
}

test("P10: the valid query goes out as given", async () => {
  const r = recorder();
  await call(new Client({ transport: r.transport }), GOOD.query);
  assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
});

test("P10: an unknown, misspelled or __proto__ key is a validation error before any data request", async () => {
  for (const [label, query] of BAD_KEYS) await rejectsBeforeData(label, query);
});

test("P10: a filter name the API doesn't have is a validation error before any data request", async () => {
  for (const [label, query] of BAD_FILTER_NAMES) await rejectsBeforeData(label, query);
});

test("P10: an array, object or NaN where the API takes one value is a validation error", async () => {
  for (const [label, query] of BAD_VALUES) await rejectsBeforeData(label, query);
});

test("P10: a filter name spelled differently is normalised or rejected, never sent as typed", async () => {
  for (const [label, query] of UNNORMALISED) {
    if (UNNORMALISED_POLICY === "reject") {
      await rejectsBeforeData(label, query);
      continue;
    }
    const r = recorder();
    await call(new Client({ transport: r.transport }), query);
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT], label);
  }
});

test("P10: a repeated filter flag is combined or rejected, never last-one-wins", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_FLAG_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  if (REPEATED_POLICY === "combine") {
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
  } else {
    assert.equal(code, USAGE_EXIT);
    assert.equal(r.data().length, 0);
  }
});

test("P10: a repeated single-value option is a usage error", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_SINGLE_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  assert.equal(code, USAGE_EXIT, err.join("\n"));
  assert.equal(r.data().length, 0);
});
