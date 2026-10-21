// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and JSON rendering.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { OutputError, isDirectoryMessage, logOf, nodeFiles, refuseOverwrite, type CliDeps } from "./io.js";
import type { BundeswahlClientOptions } from "@maschinenlesbar.org/bundeswahlleiterin-client/internal/client";
import { BundeswahlValidationError, quoteValue } from "@maschinenlesbar.org/bundeswahlleiterin-client/internal/errors";
import { cleartextProblem, DEFAULT_BASE_URL, isBidiControl, type RetryEvent } from "@maschinenlesbar.org/bundeswahlleiterin-client/internal/engine";
import { baseUrlProblem, headerValueProblem, textProblem } from "@maschinenlesbar.org/bundeswahlleiterin-client/internal/validate";

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
 * Make giving a single-value option twice a usage error, on `command` and every subcommand:
 * commander keeps the last value silently, so `--party SPD --party CDU` returned only CDU and
 * `--timeout 1000 --timeout 0` switched the timeout off, with nothing telling the user a value
 * was dropped. The message is `--x may be given only once.` (exit 2, before any request). A
 * repeatable option, declared the commander way with an array default (`.option("--tag <t>", …,
 * collect, [])`; this CLI has none), is left alone; so is a plain flag (`--compact --compact`
 * means the same).
 *
 * A boolean that can be switched both ways is guarded too: an optional-value option
 * (`--is-open [bool]`) and a negatable pair (`--x` / `--no-x`); this CLI has none today. commander
 * calls no value parser for a bare `--is-open`, so `--is-open false --is-open` turned into true
 * silently. Those are counted per attribute from commander's `option:<name>` events, which fire
 * for every occurrence. Call it once on a freshly built program: the check counts per program.
 */
export function forbidRepeatedOptions(command: Command): void {
  const switches = new Set(command.options.filter((o) => o.negate || o.optional).map((o) => o.attributeName()));
  const seen = new Set<string>();
  for (const option of command.options) {
    const attribute = option.attributeName();
    if (switches.has(attribute)) {
      const names = command.options.filter((o) => o.attributeName() === attribute).map((o) => o.long ?? o.short);
      command.on(`option:${option.name()}`, () => {
        if (seen.has(attribute)) command.error(`error: ${names.join(" / ")} may be given only once.`, { code: "commander.optionRepeated" });
        seen.add(attribute);
      });
      continue;
    }
    if (!option.required || option.variadic || Array.isArray(option.defaultValue)) continue;
    const parse = option.parseArg;
    let given = false;
    const guarded = (value: string, previous: unknown): unknown => {
      if (given) throw new InvalidArgumentError(`${option.long ?? option.short} may be given only once.`);
      given = true;
      return parse === undefined ? value : parse(value, previous);
    };
    option.parseArg = guarded as typeof option.parseArg;
  }
  for (const child of command.commands) forbidRepeatedOptions(child);
}

/**
 * commander value-parser for a free-text filter.
 *
 * The library's `textProblem` (not blank, not only invisible characters, no control, format
 * or half character), and — the point of it — rejects a value that is really the *next
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
 *
 * The message quotes the value as the library does (`quoteValue`: JSON-quoted, invisible
 * characters escaped, cut at `MAX_MESSAGE_VALUE_LENGTH`), so a huge value can't make the
 * record huge twice and a zero-width space can't hide.
 */
export function parseTextArg(value: string): string {
  // The library's rule (blank, invisible-only, a control, format or half character).
  const problem = textProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  if (/^--?[^\s]/.test(value)) {
    throw new InvalidArgumentError(
      `looks like a missing value — ${quoteValue(value)} is the next option, consumed because ` +
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
 *
 * Any other dash-leading value is refused as the next option, as the filters refuse it
 * (`parseTextArg`): `bundeswahl parties -o --compact` wrote a pretty-printed file named
 * "--compact" with exit 0. commander hands the parser the same string for `-o -x` and
 * `--output=-x`, so a file whose name starts with a dash is written as `./-x`.
 */
export function parseOutputPath(value: string): string {
  parseNonEmpty(value);
  if (value !== "-" && value.startsWith("-")) {
    throw new InvalidArgumentError(
      `looks like a missing value — ${quoteValue(value)} is the next option, consumed because ` +
        "this one was left without a value. For a file whose name starts with a dash, write ./-name.",
    );
  }
  return value;
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
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them. It
 * escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is the 8-bit
 * form of CSI) or the bidi formatting characters (isBidiControl), which reorder the text that
 * follows. The output is server data, so escape them; the result is equivalent, valid JSON
 * (these characters only occur inside strings). Checked by char code so the source stays
 * free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if ((c >= 0x7f && c <= 0x9f) || isBidiControl(c)) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. An answer nested too deeply (the CSV datasets are flat
 * rows, but the renderer guards itself) overflows the stack: an OutputError rather than
 * "Unexpected error: Maximum call stack size exceeded".
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB, while the gap path (an empty gap, the same text) prints it. The
 * fast path stays the default because on Node 26 only it is iterative and prints nesting the gap
 * path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    if (!compact) return JSON.stringify(value, null, 2);
    return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    throw new OutputError(
      compact ? "The answer is nested too deeply to print." : "The answer is nested too deeply to pretty-print; try --compact.",
      { cause: err },
    );
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/** Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting costs no stack. */
function holdsHugeString(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") {
      if (item.length >= HUGE_STRING_LENGTH) return true;
    } else if (typeof item === "object" && item !== null) {
      for (const [key, element] of Object.entries(item)) {
        if (key.length >= HUGE_STRING_LENGTH) return true;
        if (typeof element === "string" || (typeof element === "object" && element !== null)) stack.push(element);
      }
    }
  }
  return false;
}

/**
 * Check `-o` before any request, so a refused target costs none: `--force` without `-o`, a
 * directory, and an existing path (a dangling link too) without `--force` are usage errors
 * (exit 2). `-o -` is stdout. The write checks again: a file that appears during the request
 * is not overwritten either (an OutputError then).
 */
export function checkOutputTarget(deps: CliDeps, global: GlobalOptions): void {
  if (global.force === true && global.output === undefined) {
    throw new BundeswahlValidationError("--force needs --output (it only allows overwriting the -o file).");
  }
  const path = fileOf(global);
  if (path === undefined) return;
  const state = (deps.files ?? nodeFiles).state(path);
  if (state === "directory") throw new BundeswahlValidationError(isDirectoryMessage(path));
  if (state === "exists" && global.force !== true) throw new BundeswahlValidationError(refuseOverwrite(path));
}

/** The `-o` file, or undefined for stdout (no `-o`, or `-o -`). */
function fileOf(global: GlobalOptions): string | undefined {
  return global.output === undefined || global.output === "-" ? undefined : global.output;
}

/**
 * Render a JSON value, pretty by default and compact with --compact, to stdout or to the
 * `-o` file (with an INFO record of `bundeswahl.output` saying how many bytes went where, so
 * stdout stays clean for a pipe; `-o -` is stdout). The file holds exactly what stdout would
 * show, plus a newline, and is written atomically (`nodeFiles`): a write that fails part-way
 * leaves the old file as it was and no half-written or temporary file behind. Without
 * `--force` an existing file is never overwritten, not even one that appeared during the
 * request. Every failure is an OutputError naming the file.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  const path = fileOf(global);
  if (path === undefined) return deps.io.out(text);
  const data = Buffer.from(`${text}\n`, "utf8");
  try {
    (deps.files ?? nodeFiles).write(path, data, global.force === true);
  } catch (cause) {
    throw new OutputError(cause instanceof Error ? cause.message : String(cause), { cause });
  }
  logOf(deps).info("output", `Wrote ${data.length} bytes to ${path}`);
}

/**
 * Log a warning (`bundeswahl.http`) when the effective base URL is plain `http:` to
 * a host other than loopback (cleartextProblem): requests, and any credentials in the
 * URL, travel unencrypted. Called once per run, after the options are parsed and before
 * the first request; stdout and the exit code are untouched.
 */
export function warnOnCleartext(deps: CliDeps, global: GlobalOptions): void {
  const problem = cleartextProblem(global.baseUrl ?? DEFAULT_BASE_URL);
  if (problem !== undefined) logOf(deps).warn("http", problem);
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
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
    // A refused -o target is a usage error before anything else happens.
    checkOutputTarget(deps, global);
    warnOnCleartext(deps, global);
    const options = toEngineOptions(global);
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    const client = deps.createClient(options);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
