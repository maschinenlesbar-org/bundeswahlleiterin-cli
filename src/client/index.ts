// Public entry point for the API client library.

export { BundeswahlClient, BTW2025, BTW2025_WAHLKREISE } from "./client.js";
export type { BundeswahlClientOptions } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  ENGINE_OPTION_KEYS,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  assertHeaderValue,
  parseRetryAfter,
  validateBaseUrl,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export { parseCsv, parseCsvRows, rowsToObjects, parseGermanNumber, headerMatchThreshold } from "./csv.js";
export type { ParsedCsv, ParseCsvOptions } from "./csv.js";
export {
  BundeswahlError,
  BundeswahlApiError,
  BundeswahlNetworkError,
  BundeswahlValidationError,
  BundeswahlParseError,
  redactUrl,
  cutForMessage,
  describeValue,
  MAX_MESSAGE_VALUE_LENGTH,
  credentialsIn,
  redactCredentials,
} from "./errors.js";

export { assertValid, baseUrlProblem, headerNameProblem, headerValueProblem, knownKeysProblem } from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./types.js";
