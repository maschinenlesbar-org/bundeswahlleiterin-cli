// The output sink (renderJson in src/cli/shared.ts, the file seam in io.ts): rendering, `-o`
// and `--force`. The `-o` cases run through run() against real files in a temp dir; a write cut
// short is conformance test P26's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli/run.js";
import { renderJson } from "../src/cli/shared.js";
import { OutputError, defaultIO, type CliDeps } from "../src/cli/io.js";
import { BundeswahlClient } from "@maschinenlesbar.org/bundeswahlleiterin-client/internal/client";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/bundeswahlleiterin-client/internal/http";
import * as fx from "@maschinenlesbar.org/bundeswahlleiterin-client/test/fixtures";
import { csvResponse, makeMockTransport, untimed } from "./helpers.js";

/** Each dataset request answered with its fixture, by the file name in the URL. */
function routeFixture(req: HttpRequest): HttpResponse {
  if (req.url.includes("parteien")) return csvResponse(fx.partiesCsv.replace("Sozialdemokratische", "Ein \u001b[31mrotes\u009b ‮"));
  if (req.url.includes("wahlkreisnamen")) return csvResponse(fx.wahlkreiseCsv);
  return csvResponse(fx.kerg2Csv);
}

/** The CLI on the real file system (deps without a file seam), with captured stdout and stderr. */
function makeCli(responder: (req: HttpRequest) => HttpResponse = routeFixture) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { ...defaultIO, out: (s) => out.push(s), err: (s) => err.push(untimed(s)) },
    createClient: (opts) => new BundeswahlClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

/** Run `body` with a fresh temp directory that is always removed. */
async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bundeswahl-output-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("-o writes what stdout would show, plus a newline, and says so in an INFO record", async () => {
  await inTempDir(async (dir) => {
    const shown = makeCli();
    assert.equal(await run(["parties"], shown.deps), 0);
    const path = join(dir, "parties.json");
    const cli = makeCli();
    assert.equal(await run(["-o", path, "parties"], cli.deps), 0);
    const written = readFileSync(path, "utf8");
    assert.equal(written, `${shown.out.join("\n")}\n`);
    assert.doesNotMatch(written, /[\u001b\u009b‮]/, "control characters are escaped in the file too");
    assert.deepEqual(cli.out, []);
    assert.deepEqual(cli.err, [`INFO  [bundeswahl.output] Wrote ${Buffer.byteLength(written)} bytes to ${path}`]);
    assert.deepEqual(readdirSync(dir), ["parties.json"], "no temporary file is left");
  });
});

test("-o - prints to stdout and creates no file", async () => {
  await inTempDir(async (dir) => {
    const cli = makeCli();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(await run(["--compact", "-o", "-", "parties"], cli.deps), 0);
      assert.equal(await run(["--compact", "-o", "-", "--force", "parties"], cli.deps), 0);
    } finally {
      process.chdir(cwd);
    }
    assert.equal(cli.out.length, 2);
    assert.deepEqual(cli.err, []);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("a refused -o target is a usage error before any request (K7)", async () => {
  await inTempDir(async (dir) => {
    const existing = join(dir, "existing.json");
    writeFileSync(existing, "keep");
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere"), dangling);
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const cases: Array<[string[], string]> = [
      [["-o", "", "parties"], "Expected a non-empty value."],
      [["-o", "  ", "parties"], "Expected a non-empty value."],
      [["--force", "parties"], "--force needs --output (it only allows overwriting the -o file)."],
      [["-f", "parties"], "--force needs --output (it only allows overwriting the -o file)."],
      [["-o", existing, "parties"], `Refusing to overwrite existing file "${existing}" — pass --force to overwrite.`],
      [["-o", dangling, "parties"], `Refusing to overwrite existing file "${dangling}" — pass --force to overwrite.`],
      [["-o", sub, "parties"], `"${sub}" is a directory; give a file path to --output.`],
      [["-o", sub, "--force", "parties"], `"${sub}" is a directory; give a file path to --output.`],
    ];
    for (const [argv, message] of cases) {
      const cli = makeCli();
      assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
      assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
      assert.ok(cli.err.some((line) => line.startsWith("ERROR [bundeswahl.cli]") && line.includes(message)), `${argv.join(" ")}: ${cli.err.join(" | ")}`);
    }
    assert.equal(readFileSync(existing, "utf8"), "keep");
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "existing.json", "sub"]);
  });
});

test("--force replaces an existing file, keeps its mode, and writes through a symlink (K7)", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "out.json");
    writeFileSync(path, "old");
    chmodSync(path, 0o600);
    assert.equal(await run(["--compact", "-o", path, "--force", "parties"], makeCli().deps), 0);
    assert.equal((JSON.parse(readFileSync(path, "utf8")) as unknown[]).length, 4);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const link = join(dir, "latest.json");
    symlinkSync(path, link);
    assert.equal(await run(["--compact", "-o", link, "-f", "wahlkreise", "--land", "SH"], makeCli().deps), 0);
    assert.equal((JSON.parse(readFileSync(path, "utf8")) as Array<{ landAbk: string }>)[0]?.landAbk, "SH");
    assert.deepEqual(readdirSync(dir).sort(), ["latest.json", "out.json"]);
  });
});

test("--force to a new path creates the file; over a dangling link it replaces the link with the file (K7)", async () => {
  await inTempDir(async (dir) => {
    const fresh = join(dir, "fresh.json");
    assert.equal(await run(["--compact", "-o", fresh, "--force", "parties"], makeCli().deps), 0);
    assert.equal((JSON.parse(readFileSync(fresh, "utf8")) as unknown[]).length, 4);
    const dangling = join(dir, "dangling.json");
    symlinkSync(join(dir, "nowhere"), dangling);
    assert.equal(await run(["--compact", "-o", dangling, "--force", "parties"], makeCli().deps), 0);
    assert.equal((JSON.parse(readFileSync(dangling, "utf8")) as unknown[]).length, 4);
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "fresh.json"]);
  });
});

test("a file that appears during the request is not overwritten: exit 1, an ERROR of the output area (K7)", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "race.json");
    const cli = makeCli((req) => {
      writeFileSync(path, "theirs");
      return routeFixture(req);
    });
    assert.equal(await run(["-o", path, "parties"], cli.deps), 1);
    assert.equal(readFileSync(path, "utf8"), "theirs");
    assert.deepEqual(cli.err, [`ERROR [bundeswahl.output] Refusing to overwrite existing file "${path}" — pass --force to overwrite.`]);
    assert.deepEqual(readdirSync(dir), ["race.json"]);
  });
});

test("a write the file system refuses is an ERROR of the output area naming the file, exit 1 (K7)", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, "missing-dir", "out.json");
    const cli = makeCli();
    assert.equal(await run(["-o", path, "parties"], cli.deps), 1);
    assert.equal(cli.err.length, 1);
    assert.match(cli.err[0]!, new RegExp(`^ERROR \\[bundeswahl\\.output\\] Could not write to ".*out\\.json": ENOENT: no such file or directory$`));
    assert.deepEqual(readdirSync(dir), []);
  });
});

function makeDeps(): { deps: CliDeps; out: string[] } {
  const out: string[] = [];
  const deps: CliDeps = {
    io: { ...defaultIO, out: (s) => out.push(s), err: () => {} },
    createClient: (opts) => new BundeswahlClient(opts),
  };
  return { deps, out };
}

test("pretty-printing an answer nested too deeply is a clean error that suggests --compact (K4)", () => {
  // The CSV datasets are flat rows; this guards the renderer itself, as every *-cli does.
  let deep: unknown = [];
  for (let i = 0; i < 200_000; i++) deep = [deep];
  const { deps, out } = makeDeps();
  assert.throws(
    () => renderJson(deps, {}, deep),
    (err: unknown) => err instanceof OutputError && err.message === "The answer is nested too deeply to pretty-print; try --compact.",
  );
  assert.deepEqual(out, []);
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeDeps();
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Rede"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});
