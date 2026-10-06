// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and JSON rendering.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { BundeswahlClientOptions } from "../client/client.js";
import { BundeswahlError } from "../client/errors.js";
import { cleartextProblem, DEFAULT_BASE_URL } from "../client/engine.js";
import { baseUrlProblem, headerValueProblem } from "../client/validate.js";

/**
 * commander value-parser: a plain base-10 non-negative integer.
 *
 * Uses a strict regex rather than `Number()` coercion, which would otherwise
 * accept empty/whitespace strings (`Number("") === 0`), hex/binary/scientific
 * literals, signs, padding and decimals.
 */
export function parseIntArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/** Build a commander value-parser for an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

/** commander value-parser: a non-empty (after trimming) string. */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/**
 * Wrap a commander value-parser for a single-valued option: a second occurrence is
 * a usage error instead of silently replacing the first (`--party SPD --party CDU`
 * used to return only CDU). Only for options without a default, since commander
 * passes the default as `previous` on the first call.
 */
export function once<T>(parse: (value: string) => T): (value: string, previous: T | undefined) => T {
  return (value, previous) => {
    if (previous !== undefined) {
      throw new InvalidArgumentError("Given more than once; this option takes a single value.");
    }
    return parse(value);
  };
}

/**
 * commander value-parser for a free-text filter.
 *
 * Non-empty, and — the point of it — rejects a value that is really the *next
 * option*. Without this, `--party --group-type` makes commander hand "--group-type"
 * to `--party` as its value; the starved option is never applied and the filter
 * matches nothing, so the user gets `[]` and exit 0. For election data an empty
 * result must never be confusable with a real answer, which is the same reason
 * parseCsvRows refuses to return a truncated file.
 *
 * Every dash-leading value is refused, with no escape hatch: commander hands the
 * parser the same string for `--party -x` and `--party=-x`, so the two cannot be
 * told apart here — and no Land, Wahlkreis, party or Gruppenart in this dataset
 * begins with a dash, so nothing legitimate is lost.
 */
export function parseTextArg(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  if (/^--?[^\s]/.test(value)) {
    throw new InvalidArgumentError(
      `looks like a missing value — "${value}" is the next option, consumed because ` +
        "this one was left without a value. No name or number in this dataset starts " +
        "with a dash; supply the intended value.",
    );
  }
  return value;
}

/**
 * commander value-parser for `-o, --output <file>`. A blank or whitespace-only path
 * is a usage error: `-o ""` used to print to stdout silently and `-o " "` created a
 * file named " ". `-` is kept as is and means stdout (see {@link renderJson}), the
 * usual convention, rather than a file named "-".
 */
export function parseOutputPath(value: string): string {
  return parseNonEmpty(value);
}

/**
 * commander value-parser for --base-url. The base URL is trusted input, but the
 * library's rules apply (baseUrlProblem: non-blank, no surrounding whitespace,
 * http:/https: only, no query or fragment), which the engine enforces for library
 * callers too; here a rejected value fails at parse time as a usage error (exit 2).
 */
export function parseBaseUrl(value: string): string {
  const reason = baseUrlProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (User-Agent).
 * The rules are the library's (headerValueProblem: blank, C0 controls other than
 * tab incl. CR/LF, DEL, characters above U+00FF), which the engine enforces for
 * library callers too; here a rejected value becomes a usage error (exit 2).
 */
export function parseHeaderValue(value: string): string {
  const reason = headerValueProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
  output?: string;
  force?: boolean;
}

/** Translate resolved global CLI options into client options. */
export function toEngineOptions(global: GlobalOptions): BundeswahlClientOptions {
  const options: BundeswahlClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * Render a JSON value, pretty by default and compact with --compact. Writes to the
 * file given by --output (with a short stderr confirmation so stdout stays clean
 * for piping), or to stdout otherwise — also for `--output -`.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  if (global.output !== undefined && global.output !== "-") {
    const data = Buffer.from(text + "\n", "utf8");
    try {
      // Refuse to overwrite an existing file unless --force: the exclusive ("wx")
      // write throws EEXIST, which we turn into a clear, actionable message so a
      // stray --output never silently clobbers the user's own data.
      deps.io.writeFile(global.output, data, !global.force);
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new BundeswahlError(
          `Refusing to overwrite existing file ${global.output} — pass --force to overwrite.`,
        );
      }
      // A bad --output path (missing directory, a directory, no permission) is a
      // user error, not an internal fault — surface it as a clean BundeswahlError
      // instead of letting the raw fs exception hit the "Unexpected error" path.
      // Drop the `, open '<path>'` tail since we already name the path ourselves.
      const reason = err instanceof Error ? err.message.replace(/,\s*open\s+'.*'$/, "") : String(err);
      throw new BundeswahlError(`Could not write to ${global.output}: ${reason}`);
    }
    deps.io.err(`Wrote ${data.length} bytes to ${global.output}`);
  } else {
    deps.io.out(text);
  }
}

/**
 * Write one `warning: …` line to stderr when the effective base URL is plain `http:` to
 * a host other than loopback (cleartextProblem): requests, and any credentials in the
 * URL, travel unencrypted. Called once per run, after the options are parsed and before
 * the first request; stdout and the exit code are untouched.
 */
export function warnOnCleartext(deps: CliDeps, global: GlobalOptions): void {
  const problem = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
  if (problem !== undefined) deps.io.err(`warning: ${problem}`);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    warnOnCleartext(deps, global);
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
