// Test helpers of the CLI: the log helpers and the CLI <-> library parity harness. The
// transport helpers (canned responses, the recording mock transport) live with the client,
// in packages/client/test/helpers.ts, and are re-exported here so every CLI test imports its
// helpers from one place.

import type { Transport, HttpRequest, HttpResponse } from "@maschinenlesbar.org/bundeswahlleiterin-client/internal/http";
import { run } from "../src/cli/run.js";
import { defaultDeps } from "../src/cli/program.js";
import type { CliDeps } from "../src/cli/io.js";
import { csvResponse, makeMockTransport } from "@maschinenlesbar.org/bundeswahlleiterin-client/test/helpers";

export * from "@maschinenlesbar.org/bundeswahlleiterin-client/test/helpers";

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [bundeswahl.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
}

// ---- CLI ↔ library parity ----

/** What the CLI did with one argv: exit code, captured output, requests sent. */
export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  requests: HttpRequest[];
}

/** What the library call did: its value or error, and the requests it sent. */
export type LibOutcome =
  | { ok: true; value: unknown; requests: HttpRequest[] }
  | { ok: false; error: unknown; requests: HttpRequest[] };

/**
 * Drive one input through the CLI (`run(argv)` with the real `defaultDeps`, only the
 * transport and the I/O swapped) and through a library call, on ONE recording mock
 * transport, and return both outcomes. A synchronous throw in `call` (a constructor
 * rejecting an option) is captured like a rejected promise. Parity means: both
 * reject and neither sent a request, or both sent the identical requests.
 *
 *   const { cli, lib } = await parity(["--user-agent", "", "parties"],
 *     (transport) => new BundeswahlClient({ userAgent: "", transport }).parties());
 */
export async function parity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => csvResponse("a;b\n1;2\n"),
): Promise<{ cli: CliOutcome; lib: LibOutcome }> {
  const mt = makeMockTransport(responder);
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    ...defaultDeps,
    io: {
      ...defaultDeps.io,
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    files: {
      state: () => "absent",
      write: () => {
        throw new Error("parity(): the CLI must not write files here");
      },
    },
    createClient: (opts) => defaultDeps.createClient({ ...opts, transport: mt.transport }),
  };
  const code = await run(argv, deps);
  const cli: CliOutcome = { code, out: out.join("\n"), err: untimed(err.join("\n")), requests: mt.calls.slice() };

  const before = mt.calls.length;
  let lib: LibOutcome;
  try {
    const value: unknown = await call(mt.transport);
    lib = { ok: true, value, requests: mt.calls.slice(before) };
  } catch (error) {
    lib = { ok: false, error, requests: mt.calls.slice(before) };
  }
  return { cli, lib };
}

/**
 * `parity` in the shape the kit's conformance tests (P24, P25) read: the library's outcome as
 * one object, `{ ok, value?, error?: { name, message }, requests }`, rather than this repo's
 * union, whose `error` keeps the thrown value for `instanceof` checks.
 */
export async function kitParity(
  ...args: Parameters<typeof parity>
): Promise<{ cli: CliOutcome; lib: { ok: boolean; value?: unknown; error?: { name: string; message: string }; requests: HttpRequest[] } }> {
  const { cli, lib } = await parity(...args);
  return {
    cli,
    lib: lib.ok
      ? { ok: true, value: lib.value, requests: lib.requests }
      : { ok: false, error: lib.error as { name: string; message: string }, requests: lib.requests },
  };
}

/** The method + URL + headers of each request, for comparing the two sides. */
export function requestShapes(requests: HttpRequest[]): { method: string; url: string; headers: unknown }[] {
  return requests.map((r) => ({ method: r.method, url: r.url, headers: r.headers }));
}
