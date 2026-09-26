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
      writeFile: (p, d, exclusive) => {
        // Model the real "wx" semantics: an exclusive write fails with EEXIST if
        // the path already holds bytes, so tests can exercise --force.
        if (exclusive && files[p] !== undefined) {
          const e: NodeJS.ErrnoException = new Error(`EEXIST: file already exists, open '${p}'`);
          e.code = "EEXIST";
          throw e;
        }
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

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const esc = String.fromCharCode(0x1b) + "[31m";
  const csv = `Gruppenschluessel;Gruppenart_XML;Gruppenart_CSV;GruppennameKurz;Gruppenname\n4;PARTEI;Partei;Rat${controls};${esc}\n`;
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => csvResponse(csv));
    assert.equal(await run([...format, "parties"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Rat\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), [
      { gruppenschluessel: "4", gruppenartXml: "PARTEI", gruppenartCsv: "Partei", kurz: `Rat${controls}`, name: esc },
    ]);
  }
});

test("--output writes to a file and keeps stdout clean", async () => {
  const cli = makeCli();
  await run(["--output", "/tmp/br_out.json", "parties"], cli.deps);
  assert.equal(cli.out.length, 0);
  assert.ok(cli.files["/tmp/br_out.json"]);
  assert.match(cli.err.join("\n"), /Wrote \d+ bytes/);
});

test("--output refuses to overwrite an existing file (exit 1), unless --force", async () => {
  const cli = makeCli();
  // First write creates the file.
  assert.equal(await run(["--output", "/tmp/br_dup.json", "parties"], cli.deps), 0);
  const original = cli.files["/tmp/br_dup.json"];
  assert.ok(original);

  // A second write to the same path is refused with a clear message, exit 1, and
  // the existing bytes are left untouched.
  const code = await run(["--output", "/tmp/br_dup.json", "wahlkreise"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Refusing to overwrite/);
  assert.equal(cli.files["/tmp/br_dup.json"], original);

  // With --force the overwrite goes through.
  assert.equal(await run(["--output", "/tmp/br_dup.json", "--force", "wahlkreise"], cli.deps), 0);
  assert.notEqual(cli.files["/tmp/br_dup.json"], original);
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

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli();
  assert.equal(await run(["--timeout", "2147483647", "parties"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli();
  assert.equal(await run(["--timeout", "2147483648", "parties"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
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

// --- A starved filter option must not look like "nothing matched" -------------
// `--party --group-type` makes commander hand "--group-type" to --party as its
// value; the starved option is never applied. Before this was caught, the run
// printed `[]` and exited 0 — indistinguishable from a real empty result.

for (const [name, argv] of [
  ["results --party", ["results", "--area-type", "Bund", "--vote", "2", "--party", "--group-type"]],
  ["results --area", ["results", "--area", "--vote", "2"]],
  ["results --group-type", ["results", "--group-type", "--vote", "2"]],
  ["wahlkreise --land", ["wahlkreise", "--land", "--wahlkreis"]],
  ["structure --wahlkreis", ["structure", "--wahlkreis", "--land"]],
] as const) {
  test(`a starved ${name} is a usage error, not an empty result`, async () => {
    const cli = makeCli();
    const code = await run(["--compact", ...argv], cli.deps);
    assert.equal(code, 2);
    assert.deepEqual(cli.out, []);
    // Either diagnostic is fine — commander reports "argument missing" when the
    // swallowed token is a known option of that command, and hands it to the
    // parser (which rejects it) when it is not. Both are loud; neither is `[]`.
    assert.match(cli.err.join("\n"), /looks like a missing value|argument missing/);
  });
}

test("an empty filter value is a usage error", async () => {
  const cli = makeCli();
  assert.equal(await run(["--compact", "results", "--party", ""], cli.deps), 2);
  assert.deepEqual(cli.out, []);
});

test("ordinary filter values still work", async () => {
  const cli = makeCli();
  assert.equal(await run(["--compact", "results", "--party", "SPD"], cli.deps), 0);
  assert.ok(cli.out.join("").includes("SPD"));
});

// --- The official Land/Bund summary rows ------------------------------------

test("structure excludes the aggregate rows by default", async () => {
  const cli = makeCli();
  assert.equal(await run(["--compact", "structure"], cli.deps), 0);
  const rows = JSON.parse(cli.out.join("")) as Record<string, string>[];
  assert.ok(rows.every((r) => Number(r["Wahlkreis-Nr."]) <= 299));
  assert.ok(!rows.some((r) => r["Wahlkreis-Name"] === "Land insgesamt"));
});

test("structure --include-aggregates returns the official summary rows", async () => {
  const cli = makeCli();
  assert.equal(await run(["--compact", "structure", "--include-aggregates"], cli.deps), 0);
  const rows = JSON.parse(cli.out.join("")) as Record<string, string>[];
  const agg = rows.filter((r) => Number(r["Wahlkreis-Nr."]) > 299);
  assert.equal(agg.length, 1);
  assert.equal(agg[0]!["Wahlkreis-Name"], "Land insgesamt");
  assert.equal(agg[0]!["Wahlkreis-Nr."], "901");
});

test("--include-aggregates makes an aggregate reachable by its number", async () => {
  const cli = makeCli();
  assert.equal(await run(["--compact", "structure", "--include-aggregates", "--wahlkreis", "901"], cli.deps), 0);
  const rows = JSON.parse(cli.out.join("")) as Record<string, string>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["Land"], "Schleswig-Holstein");
});

test("a --base-url with a query, a fragment or surrounding whitespace is a usage error", async () => {
  for (const [baseUrl, message] of [
    ["http://127.0.0.1:18106/m/s404?x=1", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18106/m/s404#frag", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18106?", /cannot have a query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:18106/m/s404 ", /cannot have surrounding whitespace/],
    [" https://www.bundeswahlleiterin.de", /cannot have surrounding whitespace/],
  ] as const) {
    const cli = makeCli();
    assert.equal(await run(["--base-url", baseUrl, "parties"], cli.deps), 2, baseUrl);
    assert.equal(cli.mt.calls.length, 0, baseUrl);
    assert.match(cli.err.join("\n"), message, baseUrl);
  }
});

test("a --base-url with a path prefix still works", async () => {
  const cli = makeCli();
  assert.equal(await run(["--base-url", "https://mirror.example/bwl/", "parties"], cli.deps), 0);
  assert.match(cli.mt.last().url, /^https:\/\/mirror\.example\/bwl\/dam\/jcr\/.*btw25_parteien\.csv$/);
});

test("credentials in --base-url are redacted in error messages but still sent", async () => {
  const cli = makeCli(() => rawResponse("not here", "text/plain", 404));
  assert.equal(await run(["--base-url", "http://user:s3cret@127.0.0.1:18106/m", "parties"], cli.deps), 4);
  const err = cli.err.join("\n");
  assert.doesNotMatch(err, /s3cret|user:/);
  assert.match(err, /HTTP 404 for GET http:\/\/\*\*\*@127\.0\.0\.1:18106\/m\/dam\/jcr\//);
  assert.match(cli.mt.last().url, /^http:\/\/user:s3cret@127\.0\.0\.1:18106\//);
});

test("repeating a filter option is a usage error, not a silent last-one-wins", async () => {
  for (const args of [
    ["results", "--party", "SPD", "--party", "CDU"],
    ["results", "--area", "Kiel", "--area", "001"],
    ["results", "--area-type", "Bund", "--area-type", "Land"],
    ["results", "--vote", "1", "--vote", "2"],
    ["results", "--group-type", "Partei", "--group-type", "System-Gruppe"],
    ["wahlkreise", "--land", "BY", "--land", "SN"],
    ["structure", "--wahlkreis", "1", "--wahlkreis", "2"],
  ]) {
    const cli = makeCli();
    assert.equal(await run(args, cli.deps), 2, args.join(" "));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /Given more than once; this option takes a single value\./);
  }
});

test("a blank --user-agent is a usage error, not a silent fallback to the default", async () => {
  for (const ua of ["", "   "]) {
    const cli = makeCli();
    assert.equal(await run(["--user-agent", ua, "parties"], cli.deps), 2, JSON.stringify(ua));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /Expected a non-empty value/);
  }
});

test("-o with a blank path is a usage error; -o - writes to stdout, not a file named '-'", async () => {
  for (const path of ["", " "]) {
    const cli = makeCli();
    assert.equal(await run(["-o", path, "parties"], cli.deps), 2, JSON.stringify(path));
    assert.equal(cli.mt.calls.length, 0);
    assert.deepEqual(cli.files, {});
    assert.match(cli.err.join("\n"), /Expected a non-empty value/);
  }
  const cli = makeCli();
  assert.equal(await run(["--compact", "-o", "-", "parties"], cli.deps), 0);
  assert.deepEqual(cli.files, {});
  assert.equal((JSON.parse(cli.out.join("\n")) as unknown[]).length, 3);
  assert.doesNotMatch(cli.err.join("\n"), /Wrote/);
});

test("a --user-agent with control or non-Latin-1 characters is a usage error, no request", async () => {
  for (const [ua, message] of [
    ["€-agent", /outside Latin-1/],
    ["a\r\nX-Evil: 1", /control characters/],
  ] as const) {
    const cli = makeCli();
    assert.equal(await run(["--user-agent", ua, "parties"], cli.deps), 2, ua);
    assert.equal(cli.mt.calls.length, 0, ua);
    assert.match(cli.err.join("\n"), message, ua);
  }
  const ok = makeCli();
  assert.equal(await run(["--user-agent", "bot\tmüller/1.0", "parties"], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "bot\tmüller/1.0");
});
