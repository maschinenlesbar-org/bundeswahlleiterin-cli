// CLI ↔ library parity: the same input through run() and through the library, on
// one recording mock transport, must give the same outcome (2026-10-03 parity report).

import { test } from "node:test";
import assert from "node:assert/strict";
import { BundeswahlClient } from "@maschinenlesbar.org/bundeswahlleiterin-client/internal/client";
import { BundeswahlValidationError } from "@maschinenlesbar.org/bundeswahlleiterin-client/internal/errors";
import { csvResponse, parity, requestShapes } from "./helpers.js";
import * as fx from "@maschinenlesbar.org/bundeswahlleiterin-client/test/fixtures";

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

// ---- finding #2 (PAT-1): base-URL shape rules ----

test("parity: a base URL the CLI rejects is rejected by the library too, before any request", async () => {
  for (const baseUrl of [
    "https://example.org ",
    " https://example.org",
    "https://x.test\n",
    "\thttps://x.test",
    "https://example.org/ ",
    "",
    "not a url",
    "ftp://example.org",
    "https://example.org/?x=1",
    "https://example.org/#f",
  ]) {
    const { cli, lib } = await parity(
      ["--compact", "--base-url", baseUrl, "parties"],
      (transport) => new BundeswahlClient({ baseUrl, transport }).parties(),
      parties,
    );
    assert.equal(cli.code, 2, JSON.stringify(baseUrl));
    assert.equal(cli.requests.length, 0, JSON.stringify(baseUrl));
    assert.ok(!lib.ok && lib.error instanceof BundeswahlValidationError, JSON.stringify(baseUrl));
    assert.equal(lib.requests.length, 0, JSON.stringify(baseUrl));
  }
});

test("parity: a base URL both sides accept builds the identical request", async () => {
  for (const baseUrl of ["https://mirror.example/bwl/", "https://mirror.example/bwl", "http://127.0.0.1:8080"]) {
    const { cli, lib } = await parity(
      ["--compact", "--base-url", baseUrl, "parties"],
      (transport) => new BundeswahlClient({ baseUrl, transport }).parties(),
      parties,
    );
    assert.equal(cli.code, 0, baseUrl);
    assert.ok(lib.ok, baseUrl);
    assert.deepEqual(requestShapes(cli.requests), requestShapes(lib.requests));
  }
});

// ---- D8 (fix plan 2026-10-21): text filters refuse what can only match nothing ----

/** Every text filter, on both sides. They match the downloaded rows client-side; nothing is sent. */
const TEXT_FILTERS: Array<{ name: string; argv: (v: string) => string[]; lib: (c: BundeswahlClient, v: string) => Promise<unknown> }> = [
  { name: "results --area", argv: (v) => ["results", "--area", v], lib: (c, v) => c.results({ area: v }) },
  { name: "results --party", argv: (v) => ["results", "--party", v], lib: (c, v) => c.results({ party: v }) },
  { name: "results --group-type", argv: (v) => ["results", "--group-type", v], lib: (c, v) => c.results({ groupType: v }) },
  { name: "wahlkreise --land", argv: (v) => ["wahlkreise", "--land", v], lib: (c, v) => c.wahlkreise({ land: v }) },
  { name: "structure --wahlkreis", argv: (v) => ["structure", "--wahlkreis", v], lib: (c, v) => c.structure({ wahlkreis: v }) },
];

/** P24's REFUSED corpus: blank, only invisible characters or combining marks, a lone surrogate, a control or format character. */
const REFUSED = [
  "", " ", " ", "\n\t", "　", "​", "­", "‍", "﻿", "́̈", " ​ ",
  "a​b", "Mül­ler", "‮abc", "a\u0000b", "a\u001bb", "a\u0085b", "\ud800", "a\udc00b", "x\ud83d",
];

test("parity: every text filter refuses a blank, invisible, control or half character before any request, showing it escaped (D8, D10)", async () => {
  const invisible = /[\p{Cc}\p{Cf}]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
  for (const input of TEXT_FILTERS) {
    for (const value of REFUSED) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const { cli, lib } = await parity(input.argv(value), (transport) => input.lib(new BundeswahlClient({ transport }), value));
      assert.equal(cli.code, 2, `${label}: CLI exit ${cli.code}`);
      assert.equal(cli.requests.length, 0, label);
      assert.ok(!lib.ok && lib.error instanceof BundeswahlValidationError, `${label}: ${lib.ok ? "resolved" : String(lib.error)}`);
      assert.equal(lib.requests.length, 0, label);
      const blank = value.replace(/[\s\p{Cc}\p{Cf}\p{M}]/gu, "") === "";
      const ch = invisible.exec(value.trim())?.[0];
      if (blank || ch === undefined) continue;
      const escape = `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
      assert.ok(cli.err.toLowerCase().includes(escape), `${label}: ${cli.err}`);
      assert.ok(!cli.err.includes(ch), `${label}: raw in ${cli.err}`);
      assert.ok((lib.error as Error).message.toLowerCase().includes(escape), `${label}: ${(lib.error as Error).message}`);
    }
  }
});

test("parity: a text filter with ZWJ, an emoji, inner whitespace or a decomposed letter is accepted on both sides", async () => {
  for (const input of TEXT_FILTERS) {
    for (const value of ["a‍b", "😀 smile", "a  b", "Müller", "\tKiel\n"]) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const { cli, lib } = await parity(input.argv(value), (transport) => input.lib(new BundeswahlClient({ transport }), value), (req) =>
        csvResponse(req.url.includes("kerg2") ? fx.kerg2Csv : req.url.includes("wahlkreisnamen") ? fx.wahlkreiseCsv : fx.structureCsv),
      );
      assert.equal(cli.code, 0, `${label}: ${cli.err}`);
      assert.ok(lib.ok, label);
      assert.deepEqual(requestShapes(cli.requests), requestShapes(lib.requests), label);
    }
  }
});
