// Public entry point for the API client library.

export { BundeswahlClient, BTW2025 } from "./client.js";
export type { BundeswahlClientOptions } from "./client.js";
export { RequestEngine, DEFAULT_BASE_URL } from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export { parseCsv, parseCsvRows, rowsToObjects, parseGermanNumber } from "./csv.js";
export type { ParsedCsv, ParseCsvOptions } from "./csv.js";
export {
  BundeswahlError,
  BundeswahlApiError,
  BundeswahlNetworkError,
  BundeswahlValidationError,
  BundeswahlParseError,
} from "./errors.js";

export * from "./types.js";
