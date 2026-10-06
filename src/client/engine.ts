// The request engine: turns logical (path, query) calls into HTTP GET requests via
// a Transport, applies retry/backoff for transient statuses (429, 503), and decodes
// text (CSV) responses. The Bundeswahlleiterin "API" is an open-data file
// distribution: unauthenticated GETs against www.bundeswahlleiterin.de returning
// CSV files (Datenlizenz Deutschland – Namensnennung 2.0).

import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  BundeswahlApiError,
  BundeswahlError,
  BundeswahlNetworkError,
  BundeswahlParseError,
  BundeswahlValidationError,
  credentialsIn,
  cutForMessage,
  describeValue,
  redactCredentials,
} from "./errors.js";
import { assertValid, baseUrlProblem, headerNameProblem, headerValueProblem, knownKeysProblem } from "./validate.js";

/** The keys {@link EngineOptions} has; any other key is a BundeswahlValidationError. */
export const ENGINE_OPTION_KEYS = [
  "baseUrl",
  "transport",
  "userAgent",
  "defaultHeaders",
  "timeoutMs",
  "maxRetries",
  "retryDelayMs",
  "maxResponseBytes",
  "sleep",
] as const;

export const DEFAULT_BASE_URL = "https://www.bundeswahlleiterin.de";
const DEFAULT_USER_AGENT = "bundeswahlleiterin-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw a BundeswahlValidationError,
 * as does a base URL that is blank, padded with whitespace, or not an http(s) URL
 * without query or fragment, and an unsafe header value.
 */
export interface EngineOptions {
  /**
   * Base URL of the data host. Defaults to https://www.bundeswahlleiterin.de when
   * omitted; checked by {@link validateBaseUrl}.
   */
  baseUrl?: string;
  /**
   * Swappable transport. Defaults to the built-in node http/https transport. The engine
   * enforces `timeoutMs` and `maxResponseBytes` for any transport, reads its headers in any
   * case (a fetch `Headers` or a `Map` too) and its body as any ArrayBuffer view, and turns
   * whatever it throws into a `BundeswahlNetworkError`.
   */
  transport?: Transport;
  /**
   * Value of the User-Agent header. Only `undefined` selects the default; a blank
   * value, a C0 control other than tab (CR/LF included), DEL or a character above
   * U+00FF throws a BundeswahlValidationError (see {@link assertHeaderValue}).
   */
  userAgent?: string;
  /**
   * Extra headers sent on every request. Each name must be an HTTP token and each
   * value obeys the same rules as `userAgent`.
   */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms). Enforced by the
   * engine for every transport: the request's `signal` aborts at the deadline and the
   * call rejects with a BundeswahlNetworkError.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and reset connections
   * (`ECONNRESET`, `EPIPE`, `ECONNABORTED`, undici's `UND_ERR_SOCKET`), 0..`MAX_RETRIES`
   * (10). A refused connection, a DNS failure and a timeout are not retried. Each retry
   * waits `retryDelayMs * attempt`, or the response's `Retry-After` when that is longer (up
   * to `MAX_RETRY_AFTER_MS`; a longer one is not retried, and the error names the requested
   * wait).
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly; default 200). A
   * `Retry-After` can make a wait longer, never shorter. At most `MAX_RETRY_AFTER_MS`.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit. The
   * default transport aborts early; for any transport the engine checks the body it
   * gets back.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws. Without this a negative or NaN `timeoutMs` silently
 * disabled the timeout, and `maxRetries: Infinity` retried for ever.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new BundeswahlValidationError(
      // A string is quoted, so `"5000"` doesn't read like the number 5000.
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${describeValue(value)}.`,
    );
  }
  return value;
}

/**
 * Read a function option: `undefined` gives the default; anything else that is not a
 * function throws a BundeswahlValidationError. A string `transport` used to fail only at
 * the first request, and a bad `sleep` as a raw TypeError on the first retry.
 */
function functionOption<F extends (...args: never[]) => unknown>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new BundeswahlValidationError(
      `Invalid option ${name}: expected a function, got ${value === null ? "null" : typeof value}.`,
    );
  }
  return value;
}

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Make a string that originates in an attacker-controlled response safe to put in
 * an error message, which run.ts prints raw to stderr — the non-2xx error `detail`
 * snippet, and CSV header names quoted in a parse error:
 *
 * - C0 and C1 controls and DEL are dropped, so a hostile or MITM'd endpoint cannot
 *   drive ANSI/OSC escape sequences (retitle the window, clear the screen, spoof
 *   output) into the user's terminal.
 * - Bidi formatting characters (isBidiControl) are dropped, so server text cannot
 *   reorder the visible message.
 * - Every run of whitespace — newlines, tabs, U+2028/U+2029 included — becomes one
 *   space and the ends are trimmed, so the text stays on one line.
 *
 * The CLI's JSON output is escaped separately (escapeControlChars in
 * cli/shared.ts): JSON.stringify alone leaves DEL and the C1 range raw. Written as
 * a code-point filter so the source file stays free of raw control bytes.
 */
export function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    const whitespaceControl = n >= 0x09 && n <= 0x0d;
    if (!whitespaceControl && (n <= 0x1f || (n >= 0x7f && n <= 0x9f) || isBidiControl(n))) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by internal
 * slot, not `instanceof`, so a value from another realm (a vm context, a Jest test) counts.
 * Undefined for anything else. (A Uint8Array error body used to be shown with
 * `Uint8Array#toString`, as byte values: "87,97,114,116,117,110,103" for "Wartung".)
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` naturally returns its `Headers` object, which has no plain properties, and a
 * custom one may write `Retry-After` in any case: the engine then saw no Retry-After and
 * retried after its own short backoff, inside the server's window (or retried a
 * `Retry-After: 3600` that must not be retried at all). Such an object (anything with
 * `get` and `forEach`, a `Headers` or a `Map`) is copied into a record; a plain record
 * gets its names lower-cased.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  const record: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * Decode a CSV body by the `charset` its Content-Type declares (P8), strictly.
 *
 * - No charset, or a UTF-8 one: strict UTF-8 — the pinned files are UTF-8 (the Wahlkreis
 *   file is the `…_utf8.csv` variant of one also published in another charset) and the
 *   host declares no charset. Buffer#toString would turn every non-UTF-8 byte into U+FFFD,
 *   so a re-pin to the wrong variant would pass unnoticed and every umlaut filter would
 *   silently match nothing; a body that isn't UTF-8 is a BundeswahlParseError instead.
 * - Another known label (`iso-8859-1`, `windows-1252`, …): decoded with it, so a file in
 *   another character set that says so reads correctly. One guard: a body declared as a
 *   single-byte charset that is valid UTF-8 with non-ASCII bytes is a mislabelled UTF-8 file
 *   (Apache's AddDefaultCharset does this); decoding it as declared would turn every umlaut
 *   into mojibake ("Ã¼") with exit 0, so it is a BundeswahlParseError.
 * - An unknown label: a BundeswahlParseError naming it.
 *
 * A leading byte-order mark is dropped (TextDecoder's default).
 */
function decodeCsvBody(body: Buffer, contentType: string, path: string): string {
  const declared = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(declared ?? "utf-8", { fatal: true });
  } catch {
    throw new BundeswahlParseError(
      `Unsupported response charset "${sanitizeServerText(declared ?? "")}" from ${path}.`,
    );
  }
  if (decoder.encoding !== "utf-8") {
    const nonAscii = body.some((b) => b >= 0x80);
    let utf8 = false;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(body);
      utf8 = true;
    } catch {
      // not UTF-8: the declared charset is plausible
    }
    if (nonAscii && utf8) {
      throw new BundeswahlParseError(
        `The response from ${path} declares charset "${sanitizeServerText(declared ?? "")}" but is ` +
          "UTF-8 — decoding it as declared would garble every umlaut.",
      );
    }
  }
  try {
    return decoder.decode(body);
  } catch {
    const declaredPart = declared === undefined ? "" : ` (declared charset "${sanitizeServerText(declared)}")`;
    throw new BundeswahlParseError(
      `The response from ${path} is not valid UTF-8${declaredPart} — the file may have been ` +
        "replaced by a variant in another character set (e.g. Latin-1).",
    );
  }
}

/**
 * Check a base URL and return it without trailing slashes. Throws a
 * BundeswahlValidationError (`Invalid baseUrl: <reason>`) for a blank value, one with
 * surrounding whitespace, one that does not parse, a scheme other than http(s), or a
 * query or fragment — the rules of {@link baseUrlProblem}, which the CLI's --base-url
 * parser shares. The default transport still gates the scheme per hop; this check
 * covers a custom transport too.
 */
export function validateBaseUrl(raw: string): string {
  return assertValid("baseUrl", raw, baseUrlProblem).replace(/\/+$/, "");
}

/**
 * Check a value bound for an HTTP header and return it unchanged. Throws a
 * BundeswahlValidationError (`Invalid <name>: <reason>`) for a blank value, a C0
 * control other than tab (CR/LF included), DEL, or a character above U+00FF — the
 * rules of {@link headerValueProblem}, which the CLI's --user-agent parser shares.
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // A misspelled option (`timeout`, `maxRetry`) was ignored and its default used.
    assertValid("options", options, knownKeysProblem(ENGINE_OPTION_KEYS));
    // Validate the raw value, before any slash strip, so "https://h/ " is caught too.
    this.#baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
    this.userAgent =
      options.userAgent === undefined ? DEFAULT_USER_AGENT : assertHeaderValue("userAgent", options.userAgent);
    const defaultHeaders: Record<string, string> = {};
    // A string or an array used to pass: Object.entries("x") is [["0", "x"]].
    const given: unknown = options.defaultHeaders;
    if (given !== undefined && (typeof given !== "object" || given === null || Array.isArray(given))) {
      throw new BundeswahlValidationError("Invalid option defaultHeaders: expected an object of header names and values.");
    }
    for (const [name, value] of Object.entries(options.defaultHeaders ?? {})) {
      assertValid("defaultHeaders name", name, headerNameProblem);
      defaultHeaders[name] = assertHeaderValue(`defaultHeaders[${JSON.stringify(name)}]`, value);
    }
    this.defaultHeaders = defaultHeaders;
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = functionOption("sleep", options.sleep, realSleep);
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Failed to fetch <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * What the transport threw, as the error the engine raises. The default transport
   * rejects with `BundeswahlNetworkError` only; an injected one may throw anything (a
   * string, a `TypeError` from fetch). Every failure becomes a `BundeswahlNetworkError` —
   * a `BundeswahlError` a caller and the CLI can rely on — with the base URL's credentials
   * scrubbed from its message and cause chain; any other `BundeswahlError` passes through,
   * and a clean network error stays as it is.
   */
  private transportError(cause: unknown): BundeswahlError {
    if (cause instanceof BundeswahlError && !(cause instanceof BundeswahlNetworkError)) return cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const message = cutForMessage(sanitizeServerText(this.scrub(reason)));
    const scrubbed = this.scrubCause(cause);
    if (cause instanceof BundeswahlNetworkError && message === cause.message && scrubbed === cause) return cause;
    return new BundeswahlNetworkError(message, { cause: scrubbed });
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the transport
   * stops or not — a custom transport (fetch, a node:http wrapper) that ignores `timeoutMs`
   * can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new BundeswahlNetworkError(`Request exceeded the ${this.timeoutMs}ms deadline`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * Perform a GET with Accept negotiation and transient-error retries. Redirects
   * are NOT followed — a 3xx surfaces as an error.
   */
  async request(path: string, query?: QueryParams, accept = "text/csv, text/plain, */*"): Promise<RawResponse> {
    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      Accept: accept,
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method: "GET",
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is retried like a 503, whichever
        // transport reported it (Node's ECONNRESET, fetch's UND_ERR_SOCKET, anywhere in the
        // cause chain). A refused connection, a DNS failure and a timeout are not: a slow
        // or absent upstream should not be asked again at once.
        if (hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        throw this.transportError(cause);
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the error contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new BundeswahlNetworkError(`The transport returned an invalid response (${invalid}).`);
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      // fetch gives a Uint8Array; view it as a Buffer (no copy), which the decoder expects.
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a custom
      // one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new BundeswahlNetworkError(sizeLimitMessage(this.maxResponseBytes));
      }
      const retryable = status === 429 || status === 503;
      const retryAfter = retryable ? parseRetryAfter(responseHeaders["retry-after"]) : undefined;
      if (retryable && attempt < this.maxRetries) {
        // Back off linearly (retryDelayMs * attempt). A Retry-After can make the wait longer,
        // never shorter: `Retry-After: 0` or a date in the past turned the retries into a
        // zero-delay burst (11 requests in 20 ms with --max-retries 10) against a server that
        // had just asked for less load. A Retry-After beyond MAX_RETRY_AFTER_MS is not
        // retried: the error below surfaces at once and names the wait the server asked for.
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          const backoff = this.retryDelayMs * attempt;
          await this.sleep(retryAfter === undefined ? backoff : Math.max(retryAfter, backoff));
          continue;
        }
      }

      const contentType = String(responseHeaders["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        const tooLong = retryable && retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS;
        throw this.toApiError(url, status, body, tooLong ? retryAfter : undefined);
      }

      return { data: body, contentType, status };
    }
  }

  /**
   * GET a path and return the decoded text (a CSV file). Guards against the two
   * common non-CSV replies: an HTML error page (wrong path / the file moved) and
   * an empty body — both surface as a clear BundeswahlParseError rather than
   * reaching the CSV parser.
   *
   * NOTE: the response's media type is intentionally *ignored*. The site/CDN serves
   * the CSVs with varying types (text/csv, text/plain, application/octet-stream), so
   * we sniff the body — an `<!doctype html>` / `<html>` prefix is the HTML guard —
   * rather than trust the header. Don't "harden" this into Content-Type validation;
   * it would reject valid files. Only its `charset` parameter is read (see
   * {@link decodeCsvBody}).
   */
  async getText(path: string, query?: QueryParams): Promise<string> {
    const res = await this.request(path, query);
    const htmlPage = (): BundeswahlParseError =>
      new BundeswahlParseError(
        `Expected a CSV file from ${path} but received an HTML page — the file may ` +
          "have moved, or --base-url points somewhere unexpected.",
      );
    const looksLikeHtml = (t: string): boolean => {
      const head = t.replace(/^\uFEFF/, "").trimStart().slice(0, 200).toLowerCase();
      return head.startsWith("<!doctype html") || head.startsWith("<html");
    };
    let text: string;
    try {
      text = decodeCsvBody(res.data, res.contentType, path);
    } catch (err) {
      if (looksLikeHtml(res.data.toString("latin1"))) throw htmlPage();
      throw err;
    }
    if (looksLikeHtml(text)) throw htmlPage();
    if (text.trim().length === 0) {
      throw new BundeswahlParseError(`Empty response from ${path} — no content (expected a CSV file).`);
    }
    return text;
  }

  private toApiError(url: string, status: number, body: Buffer, retryAfterMs?: number): BundeswahlApiError {
    // The body is kept on the error (`body`) and may echo the request URL: scrub it.
    const text = this.scrub(body.toString("utf8"));
    // The site serves HTML error pages, not a structured envelope; include a short,
    // whitespace-collapsed snippet only when the body is plain (non-HTML) text.
    const trimmed = text.trim();
    // `detail` is a snippet of the attacker-controlled response body that flows
    // into the error message printed to stderr. Whitespace-collapse handles
    // tab/newline, but ESC (0x1b) and other non-\s control bytes are not covered
    // by `\s+`; sanitizeServerText strips them so no terminal escape sequence
    // reaches the user's terminal.
    const detail =
      trimmed && !/^<!doctype html|^<html/i.test(trimmed)
        ? sanitizeServerText(trimmed.replace(/\s+/g, " ").slice(0, 200))
        : undefined;
    return new BundeswahlApiError({ status, url, method: "GET", body: text, detail, retryAfterMs });
  }
}
