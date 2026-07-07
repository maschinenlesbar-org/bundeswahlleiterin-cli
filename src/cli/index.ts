#!/usr/bin/env node
// Bin shim: parse argv, run the CLI, and set the process exit code.

import { run } from "./run.js";

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // run() constructs the program (buildProgram/configureTree) before its own
    // try/catch, so a synchronous throw there would otherwise become an unhandled
    // rejection. Fail secure: report it and exit non-zero rather than 0.
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
