import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
import { BundeswahlError, BundeswahlValidationError } from "../src/client/errors.js";
import * as lib from "../src/index.js";
import { run } from "../src/cli/run.js";
import { defaultDeps } from "../src/cli/program.js";
import type { CliDeps } from "../src/cli/io.js";
import { csvResponse, parity, requestShapes } from "./helpers.js";
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

test("run() maps a BundeswahlValidationError raised during an action to exit 2, 'Error: <message>'", async () => {
  const err: string[] = [];
  const deps: CliDeps = {
    ...defaultDeps,
    io: { out: () => {}, err: (s) => err.push(s), writeFile: () => {} },
    createClient: () => {
      throw new BundeswahlValidationError("Invalid thing: Expected something else.");
    },
  };
  assert.equal(await run(["parties"], deps), 2);
  assert.deepEqual(err, ["Error: Invalid thing: Expected something else."]);
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
