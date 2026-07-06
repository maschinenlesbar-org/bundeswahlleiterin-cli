#!/usr/bin/env node
// Bin shim: parse argv, run the CLI, and set the process exit code.

import { run } from "./run.js";

run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
