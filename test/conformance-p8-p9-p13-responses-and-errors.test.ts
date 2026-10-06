// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { BundeswahlClient as Client } from "../src/client/client.js";
import {
  BundeswahlError as BaseError,
  BundeswahlParseError as ParseError,
  BundeswahlValidationError as ValidationError,
} from "../src/client/errors.js";
import type { Party } from "../src/client/types.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.parties();
const PARTIES_HEADER = "Gruppenschluessel;Gruppenart_XML;Gruppenart_CSV;GruppennameKurz;Gruppenname";
const textBody = (text: string): unknown => `${PARTIES_HEADER}\n2;PARTEI;Partei;X;${text}\n`;
const readText = (result: unknown): string => (result as Party[])[0]!.name;
/** How a body goes on the wire: the datasets are CSV files, so the text as it is. */
const serialize = (body: unknown): string => String(body);
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [
  "null",
  "{}",
  "[]",
  "text",
  "42",
  "<error>boom</error>",
  // the right file with a column renamed, a ragged row, a duplicate column
  "Gruppenschluessel;Gruppenart_XML;Gruppenart_CSV;Kurzname;Gruppenname\n2;PARTEI;Partei;SPD;SPD\n",
  `${PARTIES_HEADER}\n2;PARTEI;Partei;SPD\n`,
  `${PARTIES_HEADER};Gruppenname\n2;PARTEI;Partei;SPD;SPD;SPD\n`,
];
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["results(5)", () => new Client().results(5 as never)],
  ["results(null)", () => new Client().results(null as never)],
  ["results('Bund')", () => new Client().results("Bund" as never)],
  ["results([])", () => new Client().results([] as never)],
  ["results({ areaType: 5 })", () => new Client().results({ areaType: 5 as never })],
  ["results({ vote: '2' })", () => new Client().results({ vote: "2" as never })],
  ["results({ area: 5 })", () => new Client().results({ area: 5 as never })],
  ["results({ party: 10n })", () => new Client().results({ party: 10n as never })],
  ["wahlkreise({ land: 9 })", () => new Client().wahlkreise({ land: 9 as never })],
  ["wahlkreise(null)", () => new Client().wahlkreise(null as never)],
  ["structure({ wahlkreis: [] })", () => new Client().structure({ wahlkreis: [] as never })],
  ["new Client(null)", () => new Client(null as never)],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["transport: 'x'", () => new Client({ transport: "x" as never })],
  ["sleep: 5", () => new Client({ sleep: 5 as never })],
  ["defaultHeaders: 'x'", () => new Client({ defaultHeaders: "x" as never })],
  ["defaultHeaders: { a: 5 }", () => new Client({ defaultHeaders: { a: 5 } as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(serialize(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(serialize(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
