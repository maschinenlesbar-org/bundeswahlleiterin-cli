import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIO, handleOutputErrors, stderrAfterStdout } from "../src/cli/io.js";
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

test("defaultIO.writeFile onto an existing directory fails with EISDIR, with or without --force, never EEXIST", () => {
  const dir = mkdtempSync(join(tmpdir(), "bundeswahl-io-"));
  try {
    for (const exclusive of [true, false]) {
      assert.throws(
        () => defaultIO.writeFile(dir, Buffer.from("x"), exclusive),
        (err: NodeJS.ErrnoException) => err.code === "EISDIR" && /^EISDIR: illegal operation on a directory/.test(err.message),
        `exclusive: ${exclusive}`,
      );
    }
    // An existing file is still EEXIST without --force (the "pass --force" refusal).
    const file = join(dir, "x.json");
    defaultIO.writeFile(file, Buffer.from("1"), true);
    assert.throws(() => defaultIO.writeFile(file, Buffer.from("2"), true), (err: NodeJS.ErrnoException) => err.code === "EEXIST");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A stdout as far as the hold needs one: a backlog, and the events that end it. */
class FakeStdout extends EventEmitter {
  writableLength = 0;
}

test("stderr waits for stdout: a record is held while stdout has a backlog, and flushed in order (L11)", () => {
  const stdout = new FakeStdout();
  const written: string[] = [];
  const err = stderrAfterStdout(stdout, (text: string) => written.push(text));
  err("first");
  assert.deepEqual(written, ["first"], "no backlog: written at once");
  stdout.writableLength = 65536;
  err("second");
  err("third");
  assert.deepEqual(written, ["first"], "held while stdout has a backlog");
  stdout.writableLength = 0;
  stdout.emit("drain");
  assert.deepEqual(written, ["first", "second", "third"]);
  // Flushed on close and on error too, never lost.
  stdout.writableLength = 10;
  err("fourth");
  stdout.emit("close");
  stdout.writableLength = 10;
  err("fifth");
  stdout.emit("error", new Error("EPIPE"));
  assert.deepEqual(written, ["first", "second", "third", "fourth", "fifth"]);
});
