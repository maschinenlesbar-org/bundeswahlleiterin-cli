import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { BundeswahlApiError, BundeswahlParseError } from "../src/client/errors.js";
import { makeMockTransport, csvResponse, rawResponse } from "./helpers.js";
import * as fx from "./fixtures.js";

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("a/b.csv"), "https://example.test/a/b.csv");
  assert.equal(e.buildUrl("/a.csv", { x: "1" }), "https://example.test/a.csv?x=1");
});

test("getText returns the decoded CSV body and sends UA + Accept", async () => {
  const mt = makeMockTransport(() => csvResponse("a;b\n1;2\n"));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  assert.equal(await e.getText("/x.csv"), "a;b\n1;2\n");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.match(String(mt.last().headers?.["Accept"]), /csv/);
});

test("getText rejects an HTML error page with a helpful BundeswahlParseError", async () => {
  const mt = makeMockTransport(() => rawResponse(fx.htmlShell, "text/html"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getText("/x.csv"),
    (err) => err instanceof BundeswahlParseError && /HTML page/.test(err.message),
  );
});

test("getText reports an empty body clearly, not as a parse failure", async () => {
  const mt = makeMockTransport(() => csvResponse("   "));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getText("/x.csv"),
    (err) => err instanceof BundeswahlParseError && /Empty response/.test(err.message),
  );
});

test("a non-2xx status maps to BundeswahlApiError with the status", async () => {
  const mt = makeMockTransport(() => rawResponse("nope", "text/plain", 404));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getText("/x.csv"),
    (err) => err instanceof BundeswahlApiError && err.status === 404 && err.isNotFound,
  );
});

test("a 503 is retried up to maxRetries then surfaces", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return rawResponse("busy", "text/plain", 503);
  });
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 2, sleep: async () => {} });
  await assert.rejects(() => e.getText("/x.csv"), (err) => err instanceof BundeswahlApiError && err.status === 503);
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? rawResponse("busy", "text/plain", 503) : csvResponse("a;b\n1;2\n");
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.equal(await e.getText("/x.csv"), "a;b\n1;2\n");
  assert.equal(calls, 2);
});
