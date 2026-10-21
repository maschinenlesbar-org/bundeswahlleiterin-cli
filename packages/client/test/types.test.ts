// Compile-time checks of the exported library types: a consumer compiled with the strictest
// settings can pass `undefined` for any option, as the runtime already reads it as omitted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BundeswahlClient } from "../src/index.js";
import { csvResponse, makeMockTransport } from "./helpers.js";
import * as fx from "./fixtures.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "bundeswahlleiterin-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { BundeswahlClient, type EngineOptions, type BundeswahlClientOptions, type ResultsQuery } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "type WahlkreiseOptions = NonNullable<Parameters<BundeswahlClient[\"wahlkreise\"]>[0]>;",
        "type StructureOptions = NonNullable<Parameters<BundeswahlClient[\"structure\"]>[0]>;",
        "export const engine: EngineOptions = allUndefined<EngineOptions>();",
        "export const options: BundeswahlClientOptions = allUndefined<BundeswahlClientOptions>();",
        "export const query: ResultsQuery = allUndefined<ResultsQuery>();",
        "export const land: WahlkreiseOptions = allUndefined<WahlkreiseOptions>();",
        "export const structure: StructureOptions = allUndefined<StructureOptions>();",
        "export const client = new BundeswahlClient({ baseUrl: process.env.BUNDESWAHL_BASE_URL, timeoutMs: 15_000 });",
        "export const rows = (): Promise<unknown> => client.wahlkreise({ land: process.env.LAND });",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const datasets: Record<string, string> = {
    kerg2: fx.kerg2Csv,
    parteien: fx.partiesCsv,
    wahlkreisnamen: fx.wahlkreiseCsv,
    strukturdaten: fx.structureCsv,
  };
  const mt = makeMockTransport((req) => {
    const name = Object.keys(datasets).find((key) => req.url.includes(key));
    return csvResponse(datasets[name ?? ""] ?? "");
  });
  const client = new BundeswahlClient({
    baseUrl: undefined,
    userAgent: undefined,
    defaultHeaders: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  const plain = new BundeswahlClient({ transport: mt.transport });
  assert.deepEqual(
    await client.results({ areaType: undefined, area: undefined, party: undefined, vote: undefined, groupType: undefined }),
    await plain.results(),
  );
  assert.deepEqual(await client.wahlkreise({ land: undefined }), await plain.wahlkreise());
  assert.deepEqual(
    await client.structure({ wahlkreis: undefined, includeAggregates: undefined }),
    await plain.structure(),
  );
  assert.ok(mt.calls.every((r) => r.url.startsWith("https://www.bundeswahlleiterin.de/")));
  assert.equal(mt.calls[0]?.headers?.["User-Agent"], mt.calls[1]?.headers?.["User-Agent"]);
});
