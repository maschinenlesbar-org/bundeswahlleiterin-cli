// Hostile 2xx answers (security audit 2026-10-27): a big or odd CSV answer is parsed or refused
// in one clean ERROR record, within memory; never a heap crash, which no caller can catch.
// The cases run the built bin in a child process with --max-old-space-size, as P27 does.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { kerg2Csv, partiesCsv } from "@maschinenlesbar.org/bundeswahlleiterin-client/test/fixtures";

/** The built bin, relative to this compiled test file (dist/test/…). */
const BIN = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));

// These tests start the built CLI as a process: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Serve `body` as a CSV file (status `status`) to one run of `bundeswahl <command>` with a heap of `heapMb`, then stop. */
async function runWithAnswer(command: string, body: string, heapMb: number, status = 200): Promise<Run> {
  const server = http.createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await new Promise<Run>((resolve) => {
      const child = spawn(
        process.execPath,
        [`--max-old-space-size=${heapMb}`, BIN, "--base-url", base, "--max-retries", "0", command],
        { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** No crash, and exactly one ERROR record of bundeswahl.api, matching `message`, cut short. */
function oneApiError(run: Run, label: string, message: RegExp): void {
  assert.notEqual(run.signal, "SIGABRT", `${label}: aborted`);
  assert.doesNotMatch(run.stderr, /FATAL ERROR|heap out of memory|Allocation failed|\n\s+at /, `${label}: ${run.stderr.slice(0, 500)}`);
  assert.equal(run.code, 1, `${label}: exit ${run.code} ${run.signal}: ${run.stderr.slice(0, 500)}`);
  assert.equal(run.stdout, "", label);
  const records = run.stderr.trim().split("\n");
  assert.equal(records.length, 1, `${label}: ${run.stderr.slice(0, 500)}`);
  assert.match(records[0] ?? "", /ERROR \[bundeswahl\.api\] /, label);
  assert.match(records[0] ?? "", message, label);
  assert.ok((records[0] ?? "").length < 5000, `${label}: the record is cut`);
}

test("a huge invalid cell on an error path ends in one ERROR record within a small heap", STARTS_A_PROCESS, async () => {
  // 20 M characters: the success path prints such a cell at 512 MB; the error path, cleaning
  // the whole cell one string node per character before cutting it, aborted the process.
  const huge = "A".repeat(20_000_000);
  const cases: Array<[string, string, string, RegExp]> = [
    ["Gebietsart", "results", kerg2Csv.replace("BT;23.02.2025;Bund;99;Bundesgebiet;;;System-Gruppe", `BT;23.02.2025;${huge};99;Bundesgebiet;;;System-Gruppe`), /Gebietsart/],
    ["Anzahl", "results", kerg2Csv.replace(";;60510631;;61172771;;-1,08241;;;\nBT;23.02.2025;Bund", `;;${huge};;61172771;;-1,08241;;;\nBT;23.02.2025;Bund`), /AAAA/],
    ["duplicate header", "parties", partiesCsv.replace("GruppennameKurz;Gruppenname\n", `GruppennameKurz;Gruppenname;${huge};${huge}\n`), /duplicate column name/],
  ];
  for (const [label, command, body, message] of cases) {
    assert.notEqual(body, command === "results" ? kerg2Csv : partiesCsv, `${label}: the fixture changed`);
    oneApiError(await runWithAnswer(command, body, 512), label, message);
  }
});

test("an answer of millions of line breaks ends in one ERROR record within a small heap", STARTS_A_PROCESS, async () => {
  // 4 000 001 bytes: one row array per line break aborted a 512 MB heap; the tokenizer now
  // stops at its row budget.
  const body = `${"\n".repeat(4_000_000)}x`;
  for (const command of ["parties", "results"]) {
    oneApiError(await runWithAnswer(command, body, 512), command, /Malformed CSV: more than 200000 rows/);
  }
});

test("a 16 MB error answer ends in one ERROR record within a small heap (security audit, class C)", STARTS_A_PROCESS, async () => {
  // The snippet collapsed the whitespace of the whole body before cutting it to 200 characters:
  // a regex replace over 8 million runs exhausted a 128 MB heap. The body is cut first now.
  const run = await runWithAnswer("parties", "x ".repeat(8_000_000), 128, 500);
  oneApiError(run, "16 MB error body", /HTTP 500 for GET \S+: x x x/);
});
