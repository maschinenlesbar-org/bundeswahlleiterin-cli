// Test helpers of this server's own tests and the adapters of the conformance tests: a mock of
// the Bundeswahlleiterin's open-data files (generated results, the reference lists), and the
// client's transport helpers. The generic harness (a connection, a config, a log recorder, the
// HTTP server) is harness.ts.

import type { HttpResponse } from "@maschinenlesbar.org/bundeswahlleiterin-client";
import { partiesCsv, smallElection, structureCsv, wahlkreiseCsv } from "@maschinenlesbar.org/bundeswahlleiterin-client/test/fixtures";
import { csvResponse, makeMockTransport, type MockTransport } from "@maschinenlesbar.org/bundeswahlleiterin-client/test/helpers";

export * from "@maschinenlesbar.org/bundeswahlleiterin-client/test/helpers";
export { election, smallElection } from "@maschinenlesbar.org/bundeswahlleiterin-client/test/fixtures";

/** A JSON answer (an error page). */
export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) };
}

/** The four files: the results (`results`, default a small election), parties, Wahlkreise, structural data. */
export function bundeswahl(results: string = smallElection, files: { parties?: string; wahlkreise?: string; structure?: string } = {}): MockTransport {
  return makeMockTransport((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("kerg2.csv")) return csvResponse(results);
    if (path.endsWith("btw25_parteien.csv")) return csvResponse(files.parties ?? partiesCsv);
    if (path.endsWith("btw25_wahlkreisnamen_utf8.csv")) return csvResponse(files.wahlkreise ?? wahlkreiseCsv);
    if (path.endsWith("btw2025_strukturdaten.csv")) return csvResponse(files.structure ?? structureCsv);
    return jsonResponse({ error: "not found" }, 404);
  });
}
