#!/usr/bin/env node
// Bin shim: parse argv, run the CLI, and set the process exit code.

import { handleOutputErrors } from "./io.js";
import { installWarningLog } from "./log.js";
import { processLogger, run } from "./run.js";

const argv = process.argv.slice(2);
// What happens outside run() is logged too, in the format argv asks for.
const log = processLogger(argv);
// Node's own process warnings are records too, not plain lines.
installWarningLog(process, log);
// A closed pipe (`bundeswahl results | head`) is ordinary use: exit quietly instead of
// an unhandled-EPIPE stack trace.
handleOutputErrors(process, undefined, log);

run(argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // run() constructs the program (buildProgram/configureTree) before its own
    // try/catch, so a synchronous throw there would otherwise become an unhandled
    // rejection. Fail secure: report it and exit non-zero rather than 0.
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
