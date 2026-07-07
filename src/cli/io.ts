// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { writeFileSync } from "node:fs";
import type { BundeswahlClient, BundeswahlClientOptions } from "../client/client.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Persist bytes to a file (for --output). When `exclusive` is true the write
   * must fail (throw, typically an `EEXIST`-coded error) rather than overwrite an
   * existing file, so `--output` never silently clobbers the user's data.
   */
  writeFile(path: string, data: Buffer, exclusive: boolean): void;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: BundeswahlClientOptions): BundeswahlClient;
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  // "wx" opens for exclusive write: it fails with EEXIST if the file already
  // exists, so an accidental --output never clobbers an existing file. Plain "w"
  // (the default) truncates, used only when the caller opted into --force.
  writeFile: (path, data, exclusive) => writeFileSync(path, data, { flag: exclusive ? "wx" : "w" }),
};
