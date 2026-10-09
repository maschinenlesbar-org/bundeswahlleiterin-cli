import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, baseUrlProblem, headerNameProblem, headerValueProblem, type Problem } from "../src/client/validate.js";
import { BundeswahlError, BundeswahlValidationError } from "../src/client/errors.js";
import * as lib from "../src/index.js";
import { run } from "../src/cli/run.js";
import { defaultDeps } from "../src/cli/program.js";
import type { CliDeps } from "../src/cli/io.js";
import { csvResponse, parity, requestShapes, untimed } from "./helpers.js";
import * as fx from "./fixtures.js";

const evenProblem: Problem<number> = (n) => (n % 2 === 0 ? undefined : "Expected an even number.");

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("count", 4, evenProblem), 4);
});

test("assertValid throws BundeswahlValidationError 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("count", 3, evenProblem),
    (err: unknown) =>
      err instanceof BundeswahlValidationError &&
      err instanceof BundeswahlError &&
      err.message === "Invalid count: Expected an even number.",
  );
});

test("assertValid inside an async method rejects instead of throwing synchronously", async () => {
  const method = async (n: number): Promise<number> => assertValid("count", n, evenProblem);
  const pending = method(3);
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, BundeswahlValidationError);
});

test("the package root exports assertValid and BundeswahlValidationError", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.BundeswahlValidationError, BundeswahlValidationError);
});

test("run() maps a BundeswahlValidationError raised during an action to exit 2 and an ERROR record", async () => {
  const err: string[] = [];
  const deps: CliDeps = {
    ...defaultDeps,
    io: { out: () => {}, err: (s) => err.push(s), writeFile: () => {} },
    createClient: () => {
      throw new BundeswahlValidationError("Invalid thing: Expected something else.");
    },
  };
  assert.equal(await run(["parties"], deps), 2);
  assert.deepEqual(err.map(untimed), ["ERROR [bundeswahl.cli] Invalid thing: Expected something else."]);
});

test("parity(): an input both sides reject sends no request on either side", async () => {
  const { cli, lib: l } = await parity(["results", "--vote", "3"], (transport) =>
    new lib.BundeswahlClient({ transport }).results({ vote: 3 as 1 }),
  );
  assert.equal(cli.code, 2);
  assert.equal(cli.requests.length, 0);
  assert.equal(l.ok, false);
  assert.ok(!l.ok && l.error instanceof BundeswahlValidationError);
  assert.equal(l.requests.length, 0);
});

test("parity(): an input both sides accept sends the identical request", async () => {
  const { cli, lib: l } = await parity(
    ["--compact", "parties"],
    (transport) => new lib.BundeswahlClient({ transport }).parties(),
    () => csvResponse(fx.partiesCsv),
  );
  assert.equal(cli.code, 0);
  assert.ok(l.ok);
  assert.deepEqual(requestShapes(cli.requests), requestShapes(l.requests));
  assert.equal(cli.out, JSON.stringify(l.ok ? l.value : null));
});

test("headerValueProblem: blank, C0 controls other than tab, DEL, above U+00FF", () => {
  assert.equal(headerValueProblem(""), "Expected a non-empty value.");
  assert.equal(headerValueProblem(" \t "), "Expected a non-empty value.");
  assert.equal(headerValueProblem("a\nb"), "Value contains control characters.");
  assert.equal(headerValueProblem("a\u001fb"), "Value contains control characters.");
  assert.equal(headerValueProblem("a\u007fb"), "Value contains control characters.");
  assert.equal(headerValueProblem("aĀ"), "Value contains characters outside Latin-1 (above U+00FF).");
  assert.equal(headerValueProblem(42), "Expected a string.");
  for (const ok of ["ua/1", " ua ", "a\tb", "café", "ÿ"]) assert.equal(headerValueProblem(ok), undefined, ok);
});

test("headerNameProblem: an RFC 9110 token", () => {
  for (const ok of ["X-A", "User-Agent", "x_y.z~1!"]) assert.equal(headerNameProblem(ok), undefined, ok);
  for (const bad of ["", "Bad Name", "a:b", "ä", "a\nb"]) assert.match(headerNameProblem(bad) ?? "", /token/, bad);
});

test("baseUrlProblem: blank, surrounding whitespace, unparsable, non-http(s), query or fragment", () => {
  assert.equal(baseUrlProblem(""), "Expected a non-empty URL.");
  assert.equal(baseUrlProblem("   "), "Expected a non-empty URL.");
  assert.equal(baseUrlProblem("https://h.test "), "A base URL cannot have surrounding whitespace.");
  assert.equal(baseUrlProblem(" https://h.test"), "A base URL cannot have surrounding whitespace.");
  assert.equal(baseUrlProblem("https://h.test/\n"), "A base URL cannot have surrounding whitespace.");
  assert.equal(baseUrlProblem("not a url"), "Expected a valid URL.");
  assert.equal(baseUrlProblem("ftp://h.test"), "Only http: and https: base URLs are supported.");
  assert.equal(baseUrlProblem("https://h.test/?x=1"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(baseUrlProblem("https://h.test#f"), "A base URL cannot have a query (?) or fragment (#).");
  assert.equal(baseUrlProblem(42), "Expected a string.");
  for (const ok of ["https://h.test", "http://h.test/m/", "https://u:p@h.test/m"]) {
    assert.equal(baseUrlProblem(ok), undefined, ok);
  }
});
