// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A URL without userinfo, or one that does not parse, is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A value that doesn't parse (a port typo, an unencoded "#" in the password) can still
    // carry credentials: cut them out by text.
    return redactCredentials(url, credentialsIn(url));
  }
  // `user:pw@host` without a scheme parses as a URL with the scheme "user:": no userinfo.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * The userinfo a URL-like value carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. It works on values that don't
 * parse as a URL too, and on values with a prefix (`--base-url=https://u:p@h`): the userinfo
 * is everything between `://` and the last `@` before the host. A value without a scheme
 * counts when it reads `user:password@host`. Used to redact those exact strings from text
 * that echoes the value (usage errors, help), whatever characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  const schemeAt = value.indexOf("://");
  const rest = schemeAt >= 0 ? value.slice(schemeAt + 3) : value;
  // Without a scheme only the unmistakable `user:password@host` form counts.
  if (schemeAt < 0 && !/^[^\s/@:]+:[^@]*@[^@\s/]/.test(rest)) return [];
  // The URL itself starts at its scheme (`--base-url=https://…` has a prefix).
  const scheme = schemeAt >= 0 ? /[a-z][a-z0-9+.-]*$/i.exec(value.slice(0, schemeAt)) : null;
  let parses = false;
  try {
    new URL(schemeAt >= 0 ? value.slice(scheme?.index ?? schemeAt) : `http://${rest}`);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them) that is
 * followed by `@` replaced by `***`. Matching the exact strings, not a pattern, covers
 * passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern can delimit. The CLI also
 * passes the escaped forms of each credential, as its messages escape values.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/**
 * Longest echoed value or server text (in characters) an error message shows. A huge
 * value or a hostile body would otherwise put kilobytes on one stderr line; the error's
 * own properties (`url`, `body`) keep the full value.
 */
export const MAX_MESSAGE_VALUE_LENGTH = 500;

/** `text` cut to MAX_MESSAGE_VALUE_LENGTH characters, ending in "…" when cut. */
export function cutForMessage(text: string): string {
  return text.length > MAX_MESSAGE_VALUE_LENGTH ? `${text.slice(0, MAX_MESSAGE_VALUE_LENGTH)}…` : text;
}

/**
 * A rejected input value as a message shows it: JSON-quoted (so `"2"` doesn't read like
 * the number 2), `String()` for what JSON can't show (`undefined`, a symbol, a bigint, a
 * function), and cut to MAX_MESSAGE_VALUE_LENGTH.
 */
export function describeValue(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined; // a bigint or a circular object
  }
  if (text === undefined) {
    try {
      text = typeof value === "function" ? "a function" : String(value);
    } catch {
      text = typeof value; // an object whose toString throws
    }
  }
  return cutForMessage(text);
}

/** Base class for every error originating from this client. */
export class BundeswahlError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The server responded with a non-2xx HTTP status. `detail` holds a short snippet
 * of the response body when a useful textual one is present.
 */
export class BundeswahlApiError extends BundeswahlError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;
  /**
   * For a 429/503 that was not retried because its `Retry-After` asked for longer than the
   * client waits (`MAX_RETRY_AFTER_MS`, 30 s): the requested wait in milliseconds.
   */
  readonly retryAfterMs: number | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    retryAfterMs?: number;
  }) {
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.retryAfterMs !== undefined) {
      parts.push(
        `the server asks to retry after ${Math.ceil(args.retryAfterMs / 1000)} s, longer than ` +
          `the 30 s this client waits, so it was not retried (more retries won't help; try again later)`,
      );
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    super(`HTTP ${args.status} for ${args.method} ${cutForMessage(url)}${detailPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.retryAfterMs = args.retryAfterMs;
  }

  /** True for HTTP statuses treated as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }

  /** True for a transport-level HTTP 404. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class BundeswahlNetworkError extends BundeswahlError {}

/** A client-side validation error (e.g. an unknown dataset name) — no request made. */
export class BundeswahlValidationError extends BundeswahlError {}

/**
 * The response body could not be parsed as the expected CSV. Most often this means
 * the endpoint returned an HTML error page instead of the open-data CSV file (e.g.
 * the file moved, or a `--base-url` pointed somewhere else).
 */
export class BundeswahlParseError extends BundeswahlError {}
