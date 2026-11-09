// `-o --force` and links (security audit 2026-10-27, class G): the one test of the kit's
// conformance test P30 that P30 skips here, since it reads the answer back as `[{ "id": "a1" }]`
// and every command of this CLI writes the API's rows; this copy reads the parties written.
// `--force` still follows the caller's own links, the directory owner's, and any link in a
// directory only its owner writes. Owners are injected (`nodeFilesFor`). In process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpRequest } from "@maschinenlesbar.org/bundeswahlleiterin-client/internal/http";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { nodeFilesFor, type LinkOwners } from "../src/cli/io.js";
import { BundeswahlClient as Client } from "@maschinenlesbar.org/bundeswahlleiterin-client/internal/client";
import { partiesCsv } from "@maschinenlesbar.org/bundeswahlleiterin-client/test/fixtures";
import { csvResponse, makeMockTransport, untimed } from "./helpers.js";
/** argv that writes the answer of one GET to `file`. */
const outputArgv = (file: string, force: boolean): string[] => ["--max-retries", "0", "-o", file, ...(force ? ["--force"] : []), "parties"];
/** A 2xx answer for that GET. */
const answer = () => csvResponse(partiesCsv);
/** What the file holds after a written answer: the parties, as JSON. */
const written = (text: string): unknown => (JSON.parse(text) as Array<{ name: unknown }>)[0]?.name;
const WRITTEN = "Wahlberechtigte";
// --------------------------------------------------------------------------------------

/** The caller, and another user who planted links. */
const ME = 1000;
const OTHER = 1001;
/** /tmp: owned by root, sticky and world-writable. */
const SHARED = { uid: 0, mode: 0o41777 };

/**
 * Owners as a test says: `links` maps a link's path to its owner (the caller otherwise), `dirs` a
 * directory's path to its owner and mode (the caller's, 0o40755, otherwise).
 */
function owners(links: Record<string, number>, dirs: Record<string, { uid: number; mode: number }>): LinkOwners {
  return {
    uid: ME,
    ownerOf: (path, follow) => (follow ? (dirs[path] ?? { uid: ME, mode: 0o40755 }) : { uid: links[path] ?? ME, mode: 0o120777 }),
  };
}

async function runWith(files: ReturnType<typeof nodeFilesFor>, argv: string[]): Promise<{ code: number; err: string; requests: HttpRequest[] }> {
  const mock = makeMockTransport(answer);
  const err: string[] = [];
  const code = await run(argv, {
    io: { out: () => {}, err: (s) => err.push(s) },
    createClient: (options) => new Client({ ...options, transport: mock.transport }),
    files,
  });
  return { code, err: untimed(err.join("\n")), requests: mock.calls };
}

/** A temporary directory with a victim file and a link `out.json` to it. */
function planted(): { dir: string; victim: string; link: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "p30-"));
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "keep me\n");
  const link = join(dir, "out.json");
  symlinkSync(victim, link);
  return { dir, victim, link, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("--force still follows the caller's own links, the directory owner's, and any link in a directory only its owner writes", async () => {
  const cases: Array<[string, (t: ReturnType<typeof planted>) => LinkOwners]> = [
    ["the caller's own link in a shared directory", (t) => owners({}, { [t.dir]: SHARED })],
    ["a link of the shared directory's owner", (t) => owners({ [t.link]: 0 }, { [t.dir]: SHARED })],
    ["another user's link in a directory only its owner writes", (t) => owners({ [t.link]: OTHER }, { [t.dir]: { uid: OTHER, mode: 0o40755 } })],
    ["another user's link where no caller id exists", (t) => ({ ...owners({ [t.link]: OTHER }, { [t.dir]: SHARED }), uid: undefined })],
  ];
  for (const [label, who] of cases) {
    const t = planted();
    try {
      const o = await runWith(nodeFilesFor(who(t)), outputArgv(t.link, true));
      assert.equal(o.code, 0, `${label}: ${o.err}`);
      assert.equal(written(readFileSync(t.victim, "utf8")), WRITTEN, label);
      assert.ok(lstatSync(t.link).isSymbolicLink(), label);
    } finally {
      t.done();
    }
  }
});
