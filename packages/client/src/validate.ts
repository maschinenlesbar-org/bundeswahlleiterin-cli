// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage error,
// so a rule is written once and the CLI and the library cannot drift apart.

import { BundeswahlValidationError, quoteValue } from "./errors.js";

/** A rule: the reason `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Throw a {@link BundeswahlValidationError} with the message
 * `Invalid <name>: <reason>` when `problem(value)` finds a reason; otherwise return
 * `value` unchanged. Call it before any request, so a rejected input sends nothing.
 * Async methods call it inside their body, so the rejection arrives as a rejected
 * promise rather than a synchronous throw.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new BundeswahlValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/**
 * An options object must be a plain object (or `undefined`, for "none") whose own keys
 * are all in `known`. A misspelled or unknown key (`areatype`, `timeout`), or a
 * `__proto__` key from `JSON.parse`, used to be ignored without a word, so
 * `results({ Party: "SPD" })` returned every party and `results(5)` every row. Returns
 * a `Problem` naming the first unknown key (cut, JSON-quoted) and the known ones.
 */
export function knownKeysProblem(known: readonly string[]): Problem<unknown> {
  return (value) => {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "Expected an object.";
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) {
        return `Unknown key ${JSON.stringify(key.slice(0, 60))}; expected one of ${known.join(", ")}.`;
      }
    }
    return undefined;
  };
}

/**
 * A value that goes into an HTTP header (the User-Agent, a default header). Node's
 * HTTP layer throws an opaque "Invalid character in header content" at request time
 * for a CR/LF (or any other C0 control, or DEL) and for any character above U+00FF,
 * and a custom transport might pass a CR/LF on as a header injection. A blank value
 * is refused too: it used to be sent as an empty header. Tab (0x09) and Latin-1 are
 * allowed. Checked by char code so the source stays free of control bytes.
 */
export const headerValueProblem: Problem = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/** An HTTP header name: an RFC 9110 token (letters, digits and !#$%&'*+-.^_`|~). */
export const headerNameProblem: Problem = (value) =>
  typeof value === "string" && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)
    ? undefined
    : "Expected a header name made of token characters (letters, digits and !#$%&'*+-.^_`|~).";

/**
 * A base URL. Data paths are appended to it as a string, so its exact text matters:
 *
 * - blank is refused (only an omitted base URL selects the default host);
 * - surrounding whitespace is refused: `new URL()` trims it silently, but the
 *   engine uses the raw value, so `"https://h/ "` would request `/%20/dam/...`;
 * - only `http:`/`https:` are accepted: a `file:`/`ftp:` value fails here, as a
 *   configuration mistake, rather than deep in a (possibly custom) transport;
 * - a `?` or `#` would swallow every path (`http://h/?x` requests `/?x/dam/...`,
 *   `http://h/#f` requests `/`).
 *
 * - a control character is refused: `new URL()` drops tab/CR/LF silently;
 * - userinfo (`user:pass@`) is allowed, but it must decode: Node decodes it into the
 *   Authorization header and fails at request time ("URI malformed", reported as a
 *   network error) on a `%` that isn't an escape, so that is a usage error here
 *   (write a literal `%` as `%25`).
 *
 * The reasons never echo the URL, so a credential in it cannot leak; error messages
 * redact the userinfo.
 */
export const baseUrlProblem: Problem = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected a non-empty URL.";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "A base URL cannot contain control characters.";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected a valid URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Only http: and https: base URLs are supported.";
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value
 * matches nothing, so it is refused as blank.
 */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be used as a text filter (`area`, `party`, `groupType`, `land`,
 * `wahlkreis`), or undefined when it can. The filters match the downloaded rows as
 * substrings, so each of these could only match nothing — or, blank, every row — and is
 * refused before any request:
 * - a value that is blank once trimmed (Unicode whitespace, U+00A0 included), or that holds only
 *   invisible characters and combining marks (`isBlank`);
 * - a lone surrogate (half of a character);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the match fail.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}
