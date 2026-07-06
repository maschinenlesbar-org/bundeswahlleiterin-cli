// The request engine: turns logical (path, query) calls into HTTP GET requests via
// a Transport, applies retry/backoff for transient statuses (429, 503), and decodes
// text (CSV) responses. The Bundeswahlleiterin "API" is an open-data file
// distribution: unauthenticated GETs against www.bundeswahlleiterin.de returning
// CSV files (Datenlizenz Deutschland – Namensnennung 2.0).

import { nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { BundeswahlApiError, BundeswahlParseError } from "./errors.js";

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
  /** Per-request timeout in milliseconds (0 disables). */
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
    const detail =
      trimmed && !/^<!doctype html|^<html/i.test(trimmed)
        ? trimmed.replace(/\s+/g, " ").slice(0, 200)
        : undefined;
    return new BundeswahlApiError({ status, url, method: "GET", body: text, detail });
  }
}
