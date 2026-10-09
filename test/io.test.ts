import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleOutputErrors } from "../src/cli/io.js";
import { createLogger } from "../src/cli/log.js";

function streams() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const exits: number[] = [];
  handleOutputErrors(
    { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream },
    (code) => void exits.push(code),
  );
  const fail = (code: string) => Object.assign(new Error(`write ${code}`), { code });
  return { stdout, stderr, exits, fail };
}

test("a reader that has gone (EPIPE, or ENOTCONN on a socket) ends the run quietly with 0", () => {
  for (const code of ["EPIPE", "ENOTCONN"]) {
    const s = streams();
    s.stdout.emit("error", s.fail(code));
    assert.deepEqual(s.exits, [0], code);
  }
});

test("on stderr a gone reader is ignored, so the run keeps its own exit code", () => {
  for (const code of ["EPIPE", "ENOTCONN"]) {
    const s = streams();
    s.stderr.emit("error", s.fail(code));
    assert.deepEqual(s.exits, [], code);
  }
  const s = streams();
  s.stderr.emit("error", s.fail("EIO"));
  assert.deepEqual(s.exits, [1]);
});

test("another stdout write error is an ERROR record of bundeswahl.output, in the run's format, and exits 1", () => {
  const stdout = new EventEmitter();
  const written: string[] = [];
  const stderr = Object.assign(new EventEmitter(), { write: (text: string) => written.push(text) > 0 });
  const exits: number[] = [];
  const records: string[] = [];
  const log = createLogger({ format: "jsonl", write: (line) => records.push(line), now: () => new Date("2026-01-02T03:04:05.678Z") });
  handleOutputErrors({ stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream }, (code) => void exits.push(code), log);
  stdout.emit("error", Object.assign(new Error("EBADF: bad file descriptor, write"), { code: "EBADF" }));
  assert.deepEqual(exits, [1]);
  assert.deepEqual(records.map((line) => JSON.parse(line) as unknown), [
    { ts: "2026-01-02T03:04:05.678Z", level: "ERROR", topic: "bundeswahl.output", msg: "Could not write to stdout: EBADF: bad file descriptor, write" },
  ]);
  assert.deepEqual(written, []);
});

test("without a logger, a stdout write error is a text ERROR record on the streams' stderr", () => {
  const stdout = new EventEmitter();
  const written: string[] = [];
  const stderr = Object.assign(new EventEmitter(), { write: (text: string) => written.push(text) > 0 });
  const exits: number[] = [];
  handleOutputErrors({ stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream }, (code) => void exits.push(code));
  stdout.emit("error", Object.assign(new Error("write EBADF"), { code: "EBADF" }));
  assert.deepEqual(exits, [1]);
  assert.equal(written.length, 1);
  assert.match(written[0] ?? "", /^\S+Z ERROR \[bundeswahl\.output\] Could not write to stdout: write EBADF\n$/);
});
