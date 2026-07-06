// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { writeFileSync } from "node:fs";
import type { BundeswahlClient, BundeswahlClientOptions } from "../client/client.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /** Persist bytes to a file (for --output). */
  writeFile(path: string, data: Buffer): void;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: BundeswahlClientOptions): BundeswahlClient;
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  writeFile: (path, data) => writeFileSync(path, data),
};
