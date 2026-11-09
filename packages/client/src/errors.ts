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
  // A URL without userinfo, or `user:pw@host` without a scheme (it parses as a URL with
  // the scheme "user:"), which is no URL with credentials at all.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * A scheme WHATWG parses as special (`ftp`, `file`, `http(s)`, `ws(s)`) at the start of a value,
 * with the slashes and backslashes it skips after it (`http:`, `http:///`, `https:\\` all start
 * the authority): a special scheme's authority starts after them, and also ends at a backslash.
 */
const SPECIAL_SCHEME = /^(?:ftp|file|https?|wss?):[/\\]*/i;

/**
 * The userinfo a URL carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. Only a value that starts
 * with a scheme (`^[A-Za-z][A-Za-z0-9+.-]*://`, or a special one such as `http:` with any
 * slashes or backslashes after it, as WHATWG reads `http:///alice:pw@host` and
 * `http:alice:pw@host`) counts: a bare `a:b@c` is a file name
 * (`-o run:2026-10-09@x.json`), a party name or a User-Agent as often as a credential,
 * and the base URL always has a scheme. It works on URLs that don't parse too: the
 * userinfo is everything between `://` and the last `@` before the host. Used to redact
 * those exact strings from text that echoes the value (usage errors, help), whatever
 * characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  // WHATWG skips any number of "/" and "\" after a special scheme, so its userinfo starts after them.
  const special = SPECIAL_SCHEME.exec(value);
  const scheme = special ?? /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  if (scheme === null) return [];
  const rest = value.slice(scheme[0].length);
  let parses = false;
  try {
    new URL(value);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#", and for a special scheme such as http(s) a "\", where WHATWG ends
  // it too: `https://u:pw@a.example\@b.example` sends `u:pw` to a.example); in one that doesn't,
  // at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(special !== null ? /[/?#\\]|$/ : /[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/** A scheme character (RFC 3986: letters, digits, `+`, `.`, `-`). */
function isSchemeChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2e || code === 0x2d;
}

/** An ASCII letter, with which a scheme starts. */
function isLetter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

/**
 * Where the scheme of the `://` at `at` starts: the first letter of the run of scheme characters
 * before it, looking back no further than `from`; -1 when there is none (`1://`, ` ://`). A run
 * led by other scheme characters (`-https://`) starts at its first letter.
 */
function schemeStart(text: string, at: number, from: number): number {
  let start = at;
  while (start > from && isSchemeChar(text.charCodeAt(start - 1))) start--;
  while (start < at && !isLetter(text.charCodeAt(start))) start++;
  return start < at ? start : -1;
}

/**
 * `text` with the userinfo of every URL in it replaced by `***` (`https://user:secret@host`
 * becomes `https://***@host`): the pattern backstop for text no exact secret matches. Text-based,
 * so it also covers a URL that does not parse; the userinfo ends at the last `@` before the first
 * whitespace, `/`, `?`, `#` or `'` after `://`. Linear in `text`, however many URLs it holds: each
 * `://` is found with `indexOf`, its scheme by walking back no further than the previous `://`,
 * and the search goes on right after each `://`, not after the authority it read: a URL glued
 * onto the one before it (`https://host://u:p@h`, `https://u:p@x://v:q@w`) starts inside that
 * authority, which ends at its `/`. An authority holds no `/`, so no `://` lies wholly inside one,
 * and every character is read a bounded number of times: by the authority loop and `indexOf`
 * forwards, by `schemeStart` backwards. The scheme regex this replaces
 * (`/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi`) was quadratic on a run of scheme characters
 * (`a.a.a.…`) in an answer: 200 000 characters held a run for seconds.
 */
export function redactUrlUserinfo(text: string): string {
  const parts = new TextBuilder();
  let copied = 0;
  let from = 0;
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", from)) {
    const begin = at + 3;
    let end = begin;
    let lastAt = -1;
    for (; end < text.length; end++) {
      const c = text.charCodeAt(end);
      if (c === 0x2f || c === 0x3f || c === 0x23 || c === 0x27 || /\s/.test(text[end] as string)) break;
      if (c === 0x40) lastAt = end;
    }
    if (lastAt !== -1 && schemeStart(text, at, from) !== -1) {
      parts.push(text.slice(copied, begin), "***");
      copied = lastAt;
    }
    from = begin;
  }
  if (copied === 0) return text;
  parts.push(text.slice(copied));
  return parts.toString();
}

/** How many pieces a TextBuilder joins at a time. */
const BUILDER_BATCH = 16_384;

/**
 * A text put together from many pieces (slices of a server answer and their replacements),
 * joined in batches of BUILDER_BATCH into flat strings, so memory stays proportional to the text,
 * not to the number of pieces. One `+=` per piece made a rope node each, and one array of every
 * piece a slot each: millions of pieces in a large answer exhausted a small heap either way.
 */
export class TextBuilder {
  readonly #done: string[] = [];
  #batch: string[] = [];

  push(...pieces: string[]): void {
    for (const piece of pieces) this.#batch.push(piece);
    if (this.#batch.length >= BUILDER_BATCH) {
      this.#done.push(this.#batch.join(""));
      this.#batch = [];
    }
  }

  toString(): string {
    this.#done.push(this.#batch.join(""));
    this.#batch = [];
    return this.#done.join("");
  }
}

/**
 * The forms in which a server may echo the credentials of a userinfo (`user:password`,
 * as {@link credentialsIn} returns it) back in an error body, in this order: the
 * `Authorization: Basic` value (base64 of the decoded `user:password`, UTF-8 as Node sends it
 * for a URL with userinfo), the decoded `user:password` itself, and the secret alone when it
 * is at least 4 characters long. The secret is the password; in a userinfo without one
 * (`TOKEN@host`, `TOKEN:@host`) it is the user name, a token, which Node sends as Basic
 * `TOKEN:`. `[]` for an empty userinfo. None of them has an `@` to anchor on, so they are
 * replaced as exact strings ({@link redactSecrets}).
 */
export function echoedCredentialForms(userinfo: string): string[] {
  const colon = userinfo.indexOf(":");
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const user = decode(colon < 0 ? userinfo : userinfo.slice(0, colon));
  const password = colon < 0 ? "" : decode(userinfo.slice(colon + 1));
  const secret = password === "" ? user : password;
  if (secret === "") return [];
  const pair = `${user}:${password}`;
  const forms = [Buffer.from(pair, "utf8").toString("base64"), pair];
  if (secret.length >= 4) forms.push(secret);
  return forms;
}

/**
 * `text` with every occurrence of each secret (a form a server echoes a credential in,
 * which has no `@` to anchor on) replaced by `***`. Secrets shorter than 4 characters are
 * skipped: they are not credentials, and replacing them would garble the rest of the text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim().length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
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

/** `text` cut to MAX_MESSAGE_VALUE_LENGTH characters (never inside a surrogate pair), ending in "…" when cut. */
export function cutForMessage(text: string): string {
  return text.length > MAX_MESSAGE_VALUE_LENGTH ? `${cutText(text, MAX_MESSAGE_VALUE_LENGTH)}…` : text;
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/** Unicode General Category Cf (format): bidi controls, zero-width characters, U+00AD, U+FEFF, … */
const FORMAT_CHAR = /\p{Cf}/u;

/**
 * Quote a value for an error message, as `JSON.stringify` does, and also escape what it
 * leaves raw although a terminal acts on it: DEL, the C1 controls, every Unicode
 * format character (bidi overrides, zero-width characters) and the line and paragraph
 * separators U+2028/U+2029, which a viewer may break the line at. A filter value is echoed
 * in messages; a zero-width space in it made the refused value look valid, and an override
 * would reorder the rest of the line ("Trojan Source"). A value longer than
 * MAX_MESSAGE_VALUE_LENGTH characters is cut, and the "…" goes after the closing quote
 * (`"AAAA"…`), so it does not read as part of the value. The quoted part stays a valid JSON
 * string, and a lone surrogate is escaped by `JSON.stringify` itself.
 */
export function quoteValue(value: string): string {
  const cut = value.length > MAX_MESSAGE_VALUE_LENGTH;
  let out = "";
  for (const ch of JSON.stringify(cut ? cutText(value, MAX_MESSAGE_VALUE_LENGTH) : value)) {
    const n = ch.codePointAt(0) ?? 0;
    if ((n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || FORMAT_CHAR.test(ch)) {
      // One escape per UTF-16 unit, so a character above U+FFFF stays valid JSON.
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return cut ? `${out}…` : out;
}

/**
 * A rejected input value as a message shows it: a string as {@link quoteValue} quotes it
 * (JSON-quoted, so `"2"` doesn't read like the number 2, invisible characters escaped), other
 * values JSON-encoded, `String()` for what JSON can't show (`undefined`, a symbol, a bigint, a
 * function), and cut to MAX_MESSAGE_VALUE_LENGTH.
 */
export function describeValue(value: unknown): string {
  if (typeof value === "string") return quoteValue(value);
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
  /**
   * The body as the server sent it, the base URL's credentials scrubbed. A JSON body that spells
   * one with escapes (`\"`, `\u00e4`) is kept as its decoded JSON written again, scrubbed; a body
   * too large to be a string, or too deeply nested to write again, is left out ("").
   */
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
