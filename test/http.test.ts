import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeHttpTransport } from "../src/client/http.js";
import { BundeswahlNetworkError } from "../src/client/errors.js";

/** Start a throwaway loopback server for one test and return its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("performs a real GET and returns status, headers and body", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/xml");
      res.end(`<r><path>${req.url}</path></r>`);
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/iOS/x.xml?view=renderXml` });
      assert.equal(resp.status, 200);
      assert.match(resp.body.toString("utf8"), /view=renderXml/);
    },
  );
});

test("rejects an unsupported protocol with BundeswahlNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.test/x" }),
    BundeswahlNetworkError,
  );
});

test("timeoutMs bounds the whole response, not just idle gaps", async () => {
  // A server that trickles a byte every 50 ms for 2 s never goes idle for the timeout.
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/csv" });
      res.write("a;b");
      const drip = setInterval(() => res.write(" "), 50);
      const finish = setTimeout(() => res.end("\n"), 2000);
      res.on("close", () => {
        clearInterval(drip);
        clearTimeout(finish);
      });
    },
    async (baseUrl) => {
      const started = Date.now();
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 300 }),
        (err) => err instanceof BundeswahlNetworkError && /timed out after 300ms/.test(err.message),
      );
      assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
    },
  );
});

test("a timeoutMs beyond Node's timer range is capped, not fired after 1 ms", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => void warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    await withServer(
      (_req, res) => void setTimeout(() => res.end("a;b\n"), 50),
      async (baseUrl) => {
        const resp = await nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 3_000_000_000 });
        assert.equal(resp.body.toString("utf8"), "a;b\n");
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings.filter((name) => name === "TimeoutOverflowWarning"), []);
  } finally {
    process.off("warning", onWarning);
  }
});

test("enforces maxResponseBytes", async () => {
  await withServer(
    (_req, res) => res.end("x".repeat(1000)),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: 10 }),
        BundeswahlNetworkError,
      );
    },
  );
});

test("a header value Node cannot send rejects with a typed BundeswahlNetworkError", async () => {
  for (const ua of ["a\r\nX-Evil: 1", "€-agent"]) {
    await assert.rejects(
      nodeHttpTransport({ method: "GET", url: "http://127.0.0.1:9/x", headers: { "User-Agent": ua } }),
      (err: unknown) => err instanceof BundeswahlNetworkError && /^Invalid request: /.test(err.message),
      JSON.stringify(ua),
    );
  }
});
