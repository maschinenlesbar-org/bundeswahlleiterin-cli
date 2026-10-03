// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage error,
// so a rule is written once and the CLI and the library cannot drift apart.

import { BundeswahlValidationError } from "./errors.js";

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
