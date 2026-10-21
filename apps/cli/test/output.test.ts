// The output sink (renderJson in src/cli/shared.ts): rendering an answer, pretty or --compact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderJson } from "../src/cli/shared.js";
import { OutputError, type CliDeps } from "../src/cli/io.js";
import { BundeswahlClient } from "@maschinenlesbar.org/bundeswahlleiterin-client/internal/client";

function makeDeps(): { deps: CliDeps; out: string[] } {
  const out: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: () => {}, writeFile: () => {} },
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
