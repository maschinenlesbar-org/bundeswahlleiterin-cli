import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { BundeswahlClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, csvResponse, rawResponse } from "./helpers.js";
import * as fx from "./fixtures.js";

/** Route each dataset request to its fixture by the file name in the URL. */
function routeFixture(req: HttpRequest): HttpResponse {
  const u = req.url;
  if (u.includes("kerg2")) return csvResponse(fx.kerg2Csv);
  if (u.includes("parteien")) return csvResponse(fx.partiesCsv);
  if (u.includes("wahlkreisnamen")) return csvResponse(fx.wahlkreiseCsv);
  if (u.includes("strukturdaten")) return csvResponse(fx.structureCsv);
  return csvResponse("a;b\n1;2\n");
}

function makeCli(responder: (req: HttpRequest) => HttpResponse = routeFixture) {
  const out: string[] = [];
  const err: string[] = [];
  const files: Record<string, Buffer> = {};
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: (p, d) => {
        files[p] = d;
      },
    },
    createClient: (opts) => new BundeswahlClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt, files };
}

test("results renders JSON and hits the kerg2 path", async () => {
  const cli = makeCli();
  const code = await run(["results"], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.mt.last().url, /kerg2\.csv/);
  assert.equal((JSON.parse(cli.out.join("\n")) as unknown[]).length, 4);
});

test("results --vote erst maps to Erststimme (2 rows)", async () => {
  const cli = makeCli();
  await run(["results", "--vote", "erst"], cli.deps);
  assert.equal((JSON.parse(cli.out.join("\n")) as unknown[]).length, 2);
});

test("results --area-type + --party filter compose", async () => {
  const cli = makeCli();
  await run(["results", "--area-type", "Wahlkreis", "--party", "SPD", "--vote", "1"], cli.deps);
  const rows = JSON.parse(cli.out.join("\n")) as Array<{ gruppenname: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.gruppenname, "SPD");
});

test("an invalid --area-type is rejected (exit 2)", async () => {
  const cli = makeCli();
  assert.equal(await run(["results", "--area-type", "Kreis"], cli.deps), 2);
});

test("an invalid --vote is rejected (exit 2)", async () => {
  const cli = makeCli();
  assert.equal(await run(["results", "--vote", "3"], cli.deps), 2);
});

test("parties lists the reference groups", async () => {
  const cli = makeCli();
  await run(["parties"], cli.deps);
  assert.equal((JSON.parse(cli.out.join("\n")) as unknown[]).length, 3);
});

test("wahlkreise --land filters by Land", async () => {
  const cli = makeCli();
  await run(["wahlkreise", "--land", "Bayern"], cli.deps);
  assert.equal((JSON.parse(cli.out.join("\n")) as unknown[]).length, 1);
});

test("structure --wahlkreis matches ignoring leading zeros", async () => {
  const cli = makeCli();
  await run(["structure", "--wahlkreis", "001"], cli.deps);
  const rows = JSON.parse(cli.out.join("\n")) as Array<Record<string, string>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["Wahlkreis-Name"], "Flensburg – Schleswig");
});

test("a 404 exits 4", async () => {
  const cli = makeCli(() => rawResponse(fx.htmlShell, "text/html", 404));
  assert.equal(await run(["parties"], cli.deps), 4);
});

test("an HTML page instead of CSV exits 1 with a helpful message", async () => {
  const cli = makeCli(() => rawResponse(fx.htmlShell, "text/html"));
  const code = await run(["results"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /HTML page/);
});

test("--compact prints single-line JSON", async () => {
  const cli = makeCli();
  await run(["results", "--compact"], cli.deps);
  assert.equal(cli.out.length, 1);
});

test("--output writes to a file and keeps stdout clean", async () => {
  const cli = makeCli();
  await run(["--output", "/tmp/br_out.json", "parties"], cli.deps);
  assert.equal(cli.out.length, 0);
  assert.ok(cli.files["/tmp/br_out.json"]);
  assert.match(cli.err.join("\n"), /Wrote \d+ bytes/);
});

test("a --output write failure reports a clean error (exit 1)", async () => {
  const mt = makeMockTransport(routeFixture);
  const deps: CliDeps = {
    io: {
      out: () => {},
      err: () => {},
      writeFile: () => {
        throw new Error("EISDIR: illegal operation on a directory, open '/tmp'");
      },
    },
    createClient: (opts) => new BundeswahlClient({ ...opts, transport: mt.transport }),
  };
  const code = await run(["--output", "/tmp", "parties"], deps);
  assert.equal(code, 1);
});

test("a control character in --user-agent is rejected (exit 2), no request", async () => {
  const cli = makeCli();
  const code = await run(["results", "--user-agent", "bad\r\nX: 1"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
});

test("a non-http --base-url is rejected (exit 2)", async () => {
  const cli = makeCli();
  assert.equal(await run(["--base-url", "ftp://x/y", "parties"], cli.deps), 2);
});

test("--max-retries above the sane maximum is rejected (exit 2)", async () => {
  const cli = makeCli();
  assert.equal(await run(["--max-retries", "1000", "parties"], cli.deps), 2);
});

test("a bare invocation prints help and exits 0", async () => {
  const cli = makeCli();
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.out.join("\n"), /Usage: bundeswahl/);
});

test("an unknown command exits 2", async () => {
  const cli = makeCli();
  assert.equal(await run(["boguscmd"], cli.deps), 2);
});
