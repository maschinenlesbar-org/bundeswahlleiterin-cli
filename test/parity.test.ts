// CLI ↔ library parity: the same input through run() and through the library, on
// one recording mock transport, must give the same outcome (2026-10-03 parity report).

import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeswahlClient } from "../src/client/client.js";
import { BundeswahlValidationError } from "../src/client/errors.js";
import { csvResponse, parity, requestShapes } from "./helpers.js";
import * as fx from "./fixtures.js";

const parties = () => csvResponse(fx.partiesCsv);

// ---- finding #1 (PAT-5): User-Agent value rules ----

test("parity: a User-Agent the CLI rejects is rejected by the library too, before any request", async () => {
  for (const ua of ["", "   ", "\t", "a\r\nX-Evil: 1", "a\nb", "\u0007", "\u007f", "€", "bot☃"]) {
    const { cli, lib } = await parity(
      ["--compact", "--user-agent", ua, "parties"],
      (transport) => new BundeswahlClient({ userAgent: ua, transport }).parties(),
      parties,
    );
    assert.equal(cli.code, 2, JSON.stringify(ua));
    assert.equal(cli.requests.length, 0, JSON.stringify(ua));
    assert.ok(!lib.ok && lib.error instanceof BundeswahlValidationError, JSON.stringify(ua));
    assert.equal(lib.requests.length, 0, JSON.stringify(ua));
  }
});

test("parity: a User-Agent both sides accept is sent unchanged by both", async () => {
  for (const ua of [" ua ", "café", "bot\tmüller/1.0"]) {
    const { cli, lib } = await parity(
      ["--compact", "--user-agent", ua, "parties"],
      (transport) => new BundeswahlClient({ userAgent: ua, transport }).parties(),
      parties,
    );
    assert.equal(cli.code, 0, JSON.stringify(ua));
    assert.ok(lib.ok, JSON.stringify(ua));
    assert.deepEqual(requestShapes(cli.requests), requestShapes(lib.requests));
    assert.equal(lib.requests[0]?.headers?.["User-Agent"], ua);
  }
});
