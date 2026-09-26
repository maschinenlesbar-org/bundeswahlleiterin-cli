import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRY_AFTER_MS, RequestEngine, parseRetryAfter } from "../src/client/engine.js";
import { BundeswahlApiError, BundeswahlNetworkError, BundeswahlParseError, redactUrl } from "../src/client/errors.js";
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

test("the error detail is stripped of terminal control characters", async () => {
  // Built via char codes so no raw control bytes ever appear in this source file.
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const CSI = String.fromCharCode(0x9b); // a C1 control
  const evil = `boom${ESC}[31mred${BEL}${CSI}2J`;

  const mt = makeMockTransport(() => rawResponse(evil, "text/plain", 500));
  const e = new RequestEngine({ transport: mt.transport });

  await assert.rejects(
    () => e.getText("/x.csv"),
    (err) => {
      assert.ok(err instanceof BundeswahlApiError);
      const hasControls = (s: string): boolean =>
        [...s].some((c) => {
          const n = c.charCodeAt(0);
          return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
        });
      // The control bytes are gone from both the structured detail and the
      // human-readable message that run.ts prints to stderr...
      assert.ok(!hasControls(err.detail ?? ""));
      assert.ok(!hasControls(err.message));
      // ...while the printable characters survive.
      assert.equal(err.detail, "boom[31mred2J");
      // The raw body is preserved untouched for programmatic access.
      assert.equal(err.body, evil);
      return true;
    },
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

test("a non-http(s) base URL is rejected at construction, before any request", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => csvResponse("a;b\n1;2\n"));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) => err instanceof BundeswahlNetworkError && /Unsupported protocol/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("a base URL with a query or fragment is rejected at construction", () => {
  for (const baseUrl of ["https://example.test/?x=1", "https://example.test/#frag", "https://example.test?"]) {
    const mt = makeMockTransport(() => csvResponse(fx.partiesCsv));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, baseUrl }),
      (err: unknown) =>
        err instanceof BundeswahlNetworkError && /Base URL must not contain a query or fragment/.test(err.message),
      baseUrl,
    );
  }
});

test("redactUrl hides userinfo; base-URL errors never show the password", () => {
  assert.equal(redactUrl("https://u:pw@h.test/x?y=1"), "https://***@h.test/x?y=1");
  assert.equal(redactUrl("https://h.test/x"), "https://h.test/x");
  assert.equal(redactUrl("not a url"), "not a url");
  assert.throws(
    () => new RequestEngine({ baseUrl: "ftp://u:pw@h.test" }),
    (err: unknown) => err instanceof BundeswahlNetworkError && !/pw/.test(err.message) && /\*\*\*@h\.test/.test(err.message),
  );
  const api = new BundeswahlApiError({ status: 500, url: "https://u:pw@h.test/x", method: "GET", body: "" });
  assert.equal(api.url, "https://***@h.test/x");
  assert.doesNotMatch(api.message, /pw/);
});

// ---- Retry-After (exploratory test 2026-09-26, finding 8) ----

function retryingEngine(retryAfter: string | undefined, maxRetries = 2) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: {
      "content-type": "text/plain",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
    body: Buffer.from("slow down"),
  }));
  const engine = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, mt, delays };
}

test("a 429 with Retry-After in seconds waits that long before each retry", async () => {
  const { engine, mt, delays } = retryingEngine("1");
  await assert.rejects(() => engine.getText("/x.csv"), (e: unknown) => e instanceof BundeswahlApiError && e.status === 429);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("without a usable Retry-After the retries back off linearly", async () => {
  for (const header of [undefined, "", "-1", "1.5", "soon", "1e3", "2026-09-26T10:00:00Z"]) {
    const { engine, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getText("/x.csv"));
    assert.deepEqual(delays, [200, 400], String(header));
  }
});

test("a Retry-After above MAX_RETRY_AFTER_MS is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "99999999", "Fri, 31 Dec 9999 23:59:59 GMT"]) {
    const { engine, mt, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getText("/x.csv"), (e: unknown) => e instanceof BundeswahlApiError && e.status === 429);
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0); // past date: retry now
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

test("getText rejects a body that is not valid UTF-8 instead of decoding it to U+FFFD", async () => {
  const latin1 = Buffer.from("Gruppenschluessel;GruppennameKurz\n200;Wählende\n", "latin1");
  const engine = new RequestEngine({ transport: makeMockTransport(() => rawResponse(latin1, "text/csv")).transport });
  await assert.rejects(
    () => engine.getText("/p.csv"),
    (err: unknown) => err instanceof BundeswahlParseError && /from \/p\.csv is not valid UTF-8/.test(err.message),
  );
  // A Latin-1 HTML page is still reported as an HTML page.
  const html = Buffer.from("<!doctype html><title>Ü</title>", "latin1");
  const e2 = new RequestEngine({ transport: makeMockTransport(() => rawResponse(html, "text/html")).transport });
  await assert.rejects(() => e2.getText("/p.csv"), (err: unknown) => err instanceof BundeswahlParseError && /HTML page/.test(err.message));
  // UTF-8 with a BOM decodes, BOM dropped.
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a;ü\n", "utf8")]);
  const e3 = new RequestEngine({ transport: makeMockTransport(() => rawResponse(bom, "text/csv")).transport });
  assert.equal(await e3.getText("/p.csv"), "a;ü\n");
});
