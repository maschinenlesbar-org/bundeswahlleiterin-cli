// The request engine: turns logical (path, query) calls into HTTP GET requests via
// a Transport, applies retry/backoff for transient statuses (429, 503), and decodes
// text (CSV) responses. The Bundeswahlleiterin "API" is an open-data file
// distribution: unauthenticated GETs against www.bundeswahlleiterin.de returning
// CSV files (Datenlizenz Deutschland – Namensnennung 2.0).

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { BundeswahlApiError, BundeswahlNetworkError, BundeswahlParseError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://www.bundeswahlleiterin.de";
const DEFAULT_USER_AGENT = "bundeswahlleiterin-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /** Base URL of the data host. Defaults to https://www.bundeswahlleiterin.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent on every request. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; capped at `MAX_TIMEOUT_MS`, 2^31 - 1 ms).
   */
  timeoutMs?: number;
  /** Number of automatic retries for transient (429/503) responses. */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly). */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

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

/**
 * Reject a base URL whose scheme is not http(s), or that has a query or fragment.
 * The default transport already gates the scheme per hop, but the engine is
 * exported as a library and may be handed a custom transport that does no such
 * check, so gate the configured base URL here too (a `file:`/`ftp:` base URL fails
 * fast with a typed error). Data paths are appended to the base URL as a string,
 * so a `?` or `#` in it would swallow every path: `http://h/?x` requests
 * `/?x/dam/...` and `http://h/#f` requests `/`.
 */
function assertHttpScheme(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new BundeswahlNetworkError(`Invalid base URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BundeswahlNetworkError(
      `Unsupported protocol "${url.protocol}" in base URL: ${baseUrl}`,
    );
  }
  if (/[?#]/.test(baseUrl)) {
    throw new BundeswahlNetworkError(`Base URL must not contain a query or fragment: ${baseUrl}`);
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    assertHttpScheme(this.baseUrl);
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /** Build a fully-qualified URL from a path and optional query parameters. */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
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
      const response = await this.transport({
        method: "GET",
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(this.retryDelayMs * attempt);
        continue;
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
  }

  /**
   * GET a path and return the decoded text (a CSV file). Guards against the two
   * common non-CSV replies: an HTML error page (wrong path / the file moved) and
   * an empty body — both surface as a clear BundeswahlParseError rather than
   * reaching the CSV parser.
   *
   * NOTE: the response Content-Type is intentionally *ignored*. The site/CDN serves
   * the CSVs with varying types (text/csv, text/plain, application/octet-stream), so
   * we sniff the body — an `<!doctype html>` / `<html>` prefix is the HTML guard —
   * rather than trust the header. Don't "harden" this into Content-Type validation;
   * it would reject valid files.
   */
  async getText(path: string, query?: QueryParams): Promise<string> {
    const res = await this.request(path, query);
    const text = res.data.toString("utf8");
    const head = text.replace(/^﻿/, "").trimStart().slice(0, 200).toLowerCase();
    if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
      throw new BundeswahlParseError(
        `Expected a CSV file from ${path} but received an HTML page — the file may ` +
          "have moved, or --base-url points somewhere unexpected.",
      );
    }
    if (text.trim().length === 0) {
      throw new BundeswahlParseError(`Empty response from ${path} — no content (expected a CSV file).`);
    }
    return text;
  }

  private toApiError(url: string, status: number, body: Buffer): BundeswahlApiError {
    const text = body.toString("utf8");
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
    return new BundeswahlApiError({ status, url, method: "GET", body: text, detail });
  }
}
