// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import {
  BundeswahlApiError,
  BundeswahlError,
  BundeswahlNetworkError,
  BundeswahlValidationError,
  credentialsIn,
  redactCredentials,
} from "../client/errors.js";

/**
 * Process exit codes. Distinct codes let scripts tell apart a usage error, a
 * missing resource, a transport failure, and a catch-all.
 */
const EXIT = {
  /** Usage / parse / client-side validation error. */
  USAGE: 2,
  /** HTTP 404 — file not found. */
  NOT_FOUND: 4,
  /** Network / transport failure (DNS, connection, timeout, size-cap). */
  NETWORK: 6,
  /** Any other error (incl. a non-CSV/HTML response). */
  OTHER: 1,
} as const;

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

/**
 * Replace the userinfo of every URL in `text` with `***`, the form `redactUrl` gives
 * (`https://user:secret@host` becomes `https://***@host`). Text-based, so it also
 * covers a URL that does not parse; a backstop behind the exact-string redaction.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/**
 * `deps` with an `io` that redacts the credentials of every argument from everything it
 * prints on stdout and stderr. Commander echoes rejected values in its errors
 * (`option '--base-url <url>' argument '…' is invalid`, `unknown command '…'`, `too many
 * arguments … got 1: …`): whatever path a credential takes, the exact userinfo (as
 * `credentialsIn` finds it, plus its JSON-escaped form) is replaced by `***`. A pattern
 * alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the exact strings
 * can. Files written with `-o` hold server data and pass unchanged, as does all output
 * when no argument carries credentials.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  for (const source of [...argv, ...values]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  if (secrets.size === 0) return deps;
  const list = [...secrets];
  const redact = (text: string): string => redactUserinfo(redactCredentials(text, list));
  return {
    ...deps,
    io: { ...deps.io, out: (text) => deps.io.out(redact(text)), err: (text) => deps.io.err(redact(text)) },
  };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps);

  // A bare invocation (no command) is a help request, not an error: print help
  // to stdout and exit 0, matching `--help`.
  if (argv.length === 0) {
    deps.io.out(program.helpInformation().replace(/\n$/, ""));
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; every genuine usage/parse error maps to a
      // single USAGE code (commander's own exitCode is 1, indistinguishable from
      // the catch-all).
      return err.exitCode === 0 ? 0 : EXIT.USAGE;
    }
    if (err instanceof BundeswahlValidationError) {
      deps.io.err(`Error: ${err.message}`);
      return EXIT.USAGE;
    }
    if (err instanceof BundeswahlApiError) {
      deps.io.err(`Error: ${err.message}`);
      if (err.status === 404) return EXIT.NOT_FOUND;
      // A 3xx means the host redirected; usually --base-url points somewhere that
      // redirects. It is a server/runtime condition, not CLI misuse, so it exits
      // OTHER (1) with a hint rather than USAGE (2).
      if (err.status >= 300 && err.status < 400) {
        deps.io.err(
          "Hint: the host redirected (3xx) — check --base-url points at the canonical " +
            "host (https://www.bundeswahlleiterin.de).",
        );
        return EXIT.OTHER;
      }
      return EXIT.OTHER;
    }
    if (err instanceof BundeswahlNetworkError) {
      deps.io.err(`Error: ${err.message}`);
      if (/maxResponseBytes/.test(err.message)) {
        deps.io.err(
          "Hint: the response exceeded the size cap. Raise --max-response-bytes <n> (0 = unlimited).",
        );
      }
      return EXIT.NETWORK;
    }
    if (err instanceof BundeswahlError) {
      // Includes BundeswahlParseError (e.g. an HTML page instead of a CSV file).
      deps.io.err(`Error: ${err.message}`);
      return EXIT.OTHER;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.OTHER;
  }
}
