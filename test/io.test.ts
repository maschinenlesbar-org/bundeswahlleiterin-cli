import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { handleOutputErrors } from "../src/cli/io.js";

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
