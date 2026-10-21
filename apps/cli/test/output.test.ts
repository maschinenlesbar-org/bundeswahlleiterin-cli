// The output sink (renderJson in src/cli/shared.ts, the file seam in io.ts): rendering, `-o`
// and `--force`. The `-o` cases run through run() against real files in a temp dir; a write cut
// short is conformance test P26's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli/run.js";
import { renderJson } from "../src/cli/shared.js";
import { OutputError, defaultIO, stdoutWriter, type CliDeps } from "../src/cli/io.js";
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

test("--force to a new path creates the file; through a dangling link it creates the file the link names (D1)", async () => {
  await inTempDir(async (dir) => {
    const fresh = join(dir, "fresh.json");
    assert.equal(await run(["--compact", "-o", fresh, "--force", "parties"], makeCli().deps), 0);
    assert.equal((JSON.parse(readFileSync(fresh, "utf8")) as unknown[]).length, 4);
    // "--force writes through a symlink", also when the file it points at doesn't exist yet; a
    // relative link is resolved from the link's directory, through a chain of links.
    mkdirSync(join(dir, "sub"));
    symlinkSync("sub/nowhere.json", join(dir, "hop.json"));
    const dangling = join(dir, "dangling.json");
    symlinkSync("hop.json", dangling);
    assert.equal(await run(["--compact", "-o", dangling, "--force", "parties"], makeCli().deps), 0);
    assert.ok(lstatSync(dangling).isSymbolicLink(), "the link stays a link");
    assert.equal((JSON.parse(readFileSync(join(dir, "sub", "nowhere.json"), "utf8")) as unknown[]).length, 4);
    assert.deepEqual(readdirSync(dir).sort(), ["dangling.json", "fresh.json", "hop.json", "sub"]);
    assert.deepEqual(readdirSync(join(dir, "sub")), ["nowhere.json"], "no temporary file is left");
  });
});

test("a target whose directory can't take the file is a usage error before any request (D5)", async () => {
  await inTempDir(async (dir) => {
    const file = join(dir, "file.json");
    writeFileSync(file, "x");
    const readOnly = join(dir, "ro");
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o555);
    const loop = join(dir, "loop.json");
    symlinkSync("loop.json", loop);
    const danglingIntoMissing = join(dir, "away.json");
    symlinkSync("missing/x.json", danglingIntoMissing);
    const cases: Array<[string[], RegExp]> = [
      [["-o", join(dir, "missing", "x.json")], /the directory ".*missing" does not exist\./],
      [["-o", join(file, "x.json")], /".*file\.json" is not a directory\./],
      [["-o", join(readOnly, "x.json")], /no permission to create files in ".*ro"\./],
      [["-o", danglingIntoMissing, "--force"], /the directory ".*missing" does not exist\./],
      [["-o", loop, "--force"], /too many levels of symbolic links/],
    ];
    try {
      for (const [argv, message] of cases) {
        const cli = makeCli();
        assert.equal(await run([...argv, "parties"], cli.deps), 2, argv.join(" "));
        assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
        assert.match(cli.err.join("\n"), /^ERROR \[bundeswahl\.cli\] Cannot write to "/, argv.join(" "));
        assert.match(cli.err.join("\n"), message, argv.join(" "));
      }
    } finally {
      chmodSync(readOnly, 0o755);
    }
  });
});

test("a file name of up to 255 bytes is written: the temporary name stays within NAME_MAX (D5)", async () => {
  await inTempDir(async (dir) => {
    for (const name of [`${"x".repeat(250)}.json`, `${"ü".repeat(125)}.json`, `${"😀".repeat(62)}.json`]) {
      assert.ok(Buffer.byteLength(name) <= 255, name);
      const path = join(dir, name);
      const cli = makeCli();
      assert.equal(await run(["--compact", "-o", path, "parties"], cli.deps), 0, cli.err.join("\n"));
      assert.equal((JSON.parse(readFileSync(path, "utf8")) as unknown[]).length, 4);
      assert.equal(await run(["--compact", "-o", path, "--force", "parties"], makeCli().deps), 0);
    }
    assert.equal(readdirSync(dir).length, 3, "no temporary file is left");
  });
});

test("a stream target (/dev/null) needs no --force and is written in place (D5)", async () => {
  for (const argv of [["-o", "/dev/null"], ["-o", "/dev/null", "--force"]]) {
    const cli = makeCli();
    assert.equal(await run([...argv, "parties"], cli.deps), 0, cli.err.join("\n"));
    assert.equal(cli.mt.calls.length, 1);
    assert.match(cli.err.join("\n"), /^INFO  \[bundeswahl\.output\] Wrote \d+ bytes to \/dev\/null$/);
  }
  assert.ok(statSync("/dev/null").isCharacterDevice(), "/dev/null is still the device");
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

test("a write the file system refuses is an ERROR of the output area naming the file, not the temporary one; exit 1", async () => {
  await inTempDir(async (dir) => {
    const sub = join(dir, "gone");
    mkdirSync(sub);
    const path = join(sub, "out.json");
    // The directory is there when -o is checked, and gone when the answer is written.
    const cli = makeCli((req) => {
      rmSync(sub, { recursive: true });
      return routeFixture(req);
    });
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

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7)", () => {
  // The CSV datasets are flat rows; this guards the renderer itself, as every *-cli does. Whether
  // the compact printer survives the depth depends on the Node version (iterative from Node 26)
  // and the stack: probed here, never assumed.
  let deep: unknown = [];
  for (let i = 0; i < 200_000; i++) deep = [deep];
  let compactPrints = true;
  try {
    JSON.stringify(deep);
  } catch {
    compactPrints = false;
  }
  const { deps, out } = makeDeps();
  assert.throws(
    () => renderJson(deps, {}, deep),
    (err: unknown) =>
      err instanceof OutputError && err.message === `The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  );
  assert.deepEqual(out, []);
  if (compactPrints) renderJson(deps, { compact: true }, deep);
  else assert.throws(() => renderJson(deps, { compact: true }, deep), (err: Error) => err.message === "The answer is nested too deeply to print.");
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeDeps();
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
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

test("terminal controls are escaped in chunks: the same text as one pass, across chunk edges (D7)", () => {
  const DEL = String.fromCharCode(0x7f);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  // Controls right before, at and after the 64 Ki edges, and a run of them.
  const text = ["a".repeat(65535), DEL, C1, "b".repeat(65534), RLO, DEL.repeat(70000), "ü😀", C1].join("");
  const { deps, out } = makeDeps();
  renderJson(deps, { compact: true }, { text });
  const expected = JSON.stringify({ text }).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  assert.equal(out[0], expected);
  assert.deepEqual(JSON.parse(out[0]!), { text });
});

test("an answer that escaped would pass V8's longest string is an OutputError naming its size, built nothing (D7)", () => {
  const { deps, out } = makeDeps();
  // 90 M DEL characters escape to 540 M, past V8's longest string (2^29 - 24).
  const text = String.fromCharCode(0x7f).repeat(90_000_000);
  assert.throws(
    () => renderJson(deps, { compact: true }, text),
    (err: unknown) => err instanceof OutputError && /^The answer is too large to print \(540000002 characters once its control characters are escaped\)\.$/.test(err.message),
  );
  assert.deepEqual(out, []);
});

test("stdout to a regular file gets every byte or an error: a short write is never exit 0 (D6)", async () => {
  await inTempDir(async (dir) => {
    const { openSync, closeSync } = await import("node:fs");
    const path = join(dir, "stdout.txt");
    const fd = openSync(path, "w");
    try {
      const errors: Error[] = [];
      const streamed: string[] = [];
      const fake = { fd, write: (text: string) => streamed.push(text), emit: (_event: "error", err: Error) => errors.push(err) };
      // The real writer: every byte reaches the file, none goes through the stream.
      stdoutWriter(fake)("x".repeat(100_000));
      assert.equal(readFileSync(path, "utf8").length, 100_000);
      assert.deepEqual(streamed, []);
      // A write the file system cuts short: the error reaches stdout's "error" event (exit 1 there).
      const efbig = Object.assign(new Error("EFBIG: file too large, write"), { code: "EFBIG" });
      stdoutWriter(fake, () => { throw efbig; })("more");
      assert.deepEqual(errors, [efbig]);
    } finally {
      closeSync(fd);
    }
    // Not a file (a pipe, a terminal): the stream writes it, as before.
    const piped: string[] = [];
    stdoutWriter({ write: (text: string) => piped.push(text), emit: () => true })("data");
    assert.deepEqual(piped, ["data"]);
  });
});
