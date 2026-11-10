import { test } from "node:test";
import assert from "node:assert/strict";
import { TextDecoder, inspect } from "node:util";
import { MAX_RETRIES, MAX_RETRY_AFTER_MS, RequestEngine, assertHeaderValue, parseRetryAfter, sanitizeServerText, validateBaseUrl } from "../src/engine.js";
import { BundeswahlApiError, BundeswahlNetworkError, BundeswahlValidationError, BundeswahlParseError, TextBuilder, credentialsIn, cutForMessage, cutText, echoedCredentialForms, redactUrl, redactUrlUserinfo, toWellFormed, typedUrlCredentials } from "../src/errors.js";
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
    (err) => err instanceof BundeswahlParseError && /^GET https:\/\/www\.bundeswahlleiterin\.de\/x\.csv: empty response body \(expected a CSV file\)\.$/.test(err.message),
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
      // ...and so are whole escape sequences (no `[31m` or `2J` left behind), while the
      // printable text survives.
      assert.equal(err.detail, "boomred");
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
      (err) =>
        err instanceof BundeswahlValidationError &&
        err.message === "Invalid baseUrl: Only http: and https: base URLs are supported.",
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
        err instanceof BundeswahlValidationError &&
        err.message === "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#).",
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
    (err: unknown) =>
      err instanceof BundeswahlValidationError &&
      !/pw/.test(err.message) &&
      err.message === "Invalid baseUrl: Only http: and https: base URLs are supported.",
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

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const latin1 = Buffer.from("Gruppenschluessel;GruppennameKurz\n200;Wählende\n", "latin1");
  const warnings: string[] = [];
  const engine = new RequestEngine({ transport: makeMockTransport(() => rawResponse(latin1, "text/csv")).transport, onWarning: (m) => warnings.push(m) });
  assert.equal(await engine.getText("/p.csv", { y: "1" }), "Gruppenschluessel;GruppennameKurz\n200;W\ufffdhlende\n");
  assert.deepEqual(warnings, [
    "GET https://www.bundeswahlleiterin.de/p.csv?y=1: 1 character of the answer was not valid text (invalid bytes in its character set) and replaced with U+FFFD.",
  ]);
  // Counted exactly: a U+FFFD the server sent is not counted; two bad bytes are two.
  const mixed = Buffer.concat([Buffer.from("a;\ufffd;"), Buffer.from([0xff, 0xfe]), Buffer.from(";b\n")]);
  const seen: string[] = [];
  const e2 = new RequestEngine({ transport: makeMockTransport(() => rawResponse(mixed, "text/csv; charset=utf-8")).transport, onWarning: (m) => seen.push(m) });
  assert.equal(await e2.getText("/p.csv"), "a;\ufffd;\ufffd\ufffd;b\n");
  assert.match(seen[0] ?? "", /: 2 characters of the answer were not valid text/);
  // Valid text: no warning. A throwing hook never breaks the request; no hook, no warning.
  const quiet: string[] = [];
  const e3 = new RequestEngine({ transport: makeMockTransport(() => csvResponse("a;ü\n")).transport, onWarning: (m) => quiet.push(m) });
  assert.equal(await e3.getText("/p.csv"), "a;ü\n");
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ transport: makeMockTransport(() => rawResponse(latin1, "text/csv")).transport, onWarning: () => { throw new Error("x"); } });
  assert.match(await throwing.getText("/p.csv"), /W\ufffdhlende/);
  assert.throws(() => new RequestEngine({ onWarning: "log" as never }), BundeswahlValidationError);
  // A Latin-1 HTML page is still reported as an HTML page.
  const html = Buffer.from("<!doctype html><title>Ü</title>", "latin1");
  const e4 = new RequestEngine({ transport: makeMockTransport(() => rawResponse(html, "text/html")).transport });
  await assert.rejects(() => e4.getText("/p.csv"), (err: unknown) => err instanceof BundeswahlParseError && /HTML page/.test(err.message));
  // UTF-8 with a BOM decodes, BOM dropped.
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a;ü\n", "utf8")]);
  const e5 = new RequestEngine({ transport: makeMockTransport(() => rawResponse(bom, "text/csv")).transport });
  assert.equal(await e5.getText("/p.csv"), "a;ü\n");
});

test("getText decodes a body by its declared charset (P8)", async () => {
  const text = "Gruppenschluessel;Gruppenname\n2;Müller µ\n";
  for (const [contentType, encoding] of [
    ["text/csv; charset=iso-8859-1", "latin1"],
    ["text/csv; charset=windows-1252", "latin1"],
    ['text/csv; charset="UTF-8"', "utf8"],
    ["text/csv", "utf8"],
  ] as const) {
    const engine = new RequestEngine({
      transport: makeMockTransport(() => rawResponse(Buffer.from(text, encoding), contentType)).transport,
    });
    assert.equal(await engine.getText("/p.csv"), text, contentType);
  }
  // An unknown label is a parse error naming it.
  const unknown = new RequestEngine({
    transport: makeMockTransport(() => rawResponse(Buffer.from(text), "text/csv; charset=x-klingon")).transport,
  });
  await assert.rejects(() => unknown.getText("/p.csv"), (err: unknown) => err instanceof BundeswahlParseError && /x-klingon/.test(err.message));
  // A UTF-8 body labelled Latin-1 (AddDefaultCharset) would turn "ü" into "Ã¼": refused.
  const mislabelled = new RequestEngine({
    transport: makeMockTransport(() => rawResponse(Buffer.from(text, "utf8"), "text/csv; charset=ISO-8859-1")).transport,
  });
  await assert.rejects(() => mislabelled.getText("/p.csv"), (err: unknown) => err instanceof BundeswahlParseError && /declares charset "ISO-8859-1" but is UTF-8/.test(err.message));
  // A pure-ASCII body is the same in both, so the label is harmless.
  const ascii = new RequestEngine({
    transport: makeMockTransport(() => rawResponse(Buffer.from("a;b\n1;2\n"), "text/csv; charset=iso-8859-1")).transport,
  });
  assert.equal(await ascii.getText("/p.csv"), "a;b\n1;2\n");
});

test("numeric engine options outside their range are rejected at construction", () => {
  for (const [name, value] of [
    ["timeoutMs", -1],
    ["timeoutMs", Number.NaN],
    ["timeoutMs", 1.5],
    ["timeoutMs", 2 ** 31],
    ["maxRetries", Number.POSITIVE_INFINITY],
    ["maxRetries", 11],
    ["retryDelayMs", -5],
    ["retryDelayMs", 30_001],
    ["maxResponseBytes", -1],
  ] as const) {
    assert.throws(
      () => new RequestEngine({ [name]: value }),
      (err: unknown) =>
        err instanceof BundeswahlValidationError &&
        err.message.startsWith(`Invalid option ${name}: expected an integer from 0 to `),
      `${name}=${value}`,
    );
  }
  assert.doesNotThrow(() => new RequestEngine({ timeoutMs: 0, maxRetries: 10, retryDelayMs: 0, maxResponseBytes: 0 }));
  assert.equal(MAX_RETRIES, 10);
});

// ---- header values (parity report 2026-10-03, finding #1) ----

test("a bad userAgent is rejected at construction with the CLI's reason, before any request", () => {
  for (const [ua, reason] of [
    ["", "Expected a non-empty value."],
    ["  ", "Expected a non-empty value."],
    ["a\r\nX-Evil: 1", "Value contains control characters."],
    ["a\u0000b", "Value contains control characters."],
    ["a\u007fb", "Value contains control characters."],
    ["€", "Value contains characters outside Latin-1 (above U+00FF)."],
  ] as const) {
    const mt = makeMockTransport(() => csvResponse("a;b\n1;2\n"));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, userAgent: ua }),
      (err: unknown) => err instanceof BundeswahlValidationError && err.message === `Invalid userAgent: ${reason}`,
      JSON.stringify(ua),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("defaultHeaders are checked like the User-Agent: value rules plus a token name", () => {
  const mt = makeMockTransport(() => csvResponse("a;b\n1;2\n"));
  assert.throws(
    () => new RequestEngine({ transport: mt.transport, defaultHeaders: { "X-A": "a\r\nb" } }),
    (err: unknown) =>
      err instanceof BundeswahlValidationError &&
      err.message === 'Invalid defaultHeaders["X-A"]: Value contains control characters.',
  );
  assert.throws(
    () => new RequestEngine({ transport: mt.transport, defaultHeaders: { "Bad Name": "x" } }),
    (err: unknown) => err instanceof BundeswahlValidationError && /^Invalid defaultHeaders name:/.test(err.message),
  );
  assert.equal(mt.calls.length, 0);
});

test("valid header values pass: tab and Latin-1 are allowed", async () => {
  const mt = makeMockTransport(() => csvResponse("a;b\n1;2\n"));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "bot\tmüller/1.0", defaultHeaders: { "X-A": "é" } });
  await e.getText("/x.csv");
  assert.equal(mt.last().headers?.["User-Agent"], "bot\tmüller/1.0");
  assert.equal(mt.last().headers?.["X-A"], "é");
  assert.equal(assertHeaderValue("User-Agent", "ok/1"), "ok/1");
});

// ---- base URL (parity report 2026-10-03, finding #2) ----

test("a base URL with surrounding whitespace is rejected at construction, before the slash strip", () => {
  for (const baseUrl of ["https://example.test ", " https://example.test", "https://example.test/ ", "https://x.test\n"]) {
    const mt = makeMockTransport(() => csvResponse("a;b\n1;2\n"));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err: unknown) =>
        err instanceof BundeswahlValidationError &&
        err.message === "Invalid baseUrl: A base URL cannot have surrounding whitespace.",
      JSON.stringify(baseUrl),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("validateBaseUrl returns the base URL without trailing slashes, or throws", () => {
  assert.equal(validateBaseUrl("https://h.test/m//"), "https://h.test/m");
  assert.equal(validateBaseUrl("https://h.test"), "https://h.test");
  assert.throws(() => validateBaseUrl(""), /^BundeswahlValidationError: Invalid baseUrl: Expected a non-empty URL\.$/);
});

test("a compressed body is reported as compressed, not as a character-set problem", async () => {
  const { gzipSync } = await import("node:zlib");
  const gz = gzipSync(Buffer.from("Gruppenschluessel;Gruppenname\n2;SPD\n"));
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ "content-type": "text/csv", "content-encoding": "gzip" }, /is compressed \(Content-Encoding: gzip\)/],
    [{ "Content-Encoding": "br" }, /is compressed \(Content-Encoding: br\)/],
    [{ "content-type": "text/csv" }, /is compressed \(gzip data without a Content-Encoding\)/],
  ];
  for (const [headers, message] of cases) {
    const engine = new RequestEngine({ transport: async () => ({ status: 200, headers, body: gz }) });
    await assert.rejects(() => engine.getText("/p.csv"), (e: unknown) => e instanceof BundeswahlParseError && message.test(e.message));
  }
  // `identity` is no compression.
  const plain = new RequestEngine({
    transport: async () => ({ status: 200, headers: { "content-encoding": "identity" }, body: Buffer.from("a;b\n") }),
  });
  assert.equal(await plain.getText("/p.csv"), "a;b\n");
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a� b� \u{1f600}");
  // cutForMessage (500) uses it too.
  assert.equal(toWellFormed(cutForMessage("a" + "\u{1f600}".repeat(400))), cutForMessage("a" + "\u{1f600}".repeat(400)));
});

test("a server detail cut at 200 characters keeps the message well-formed", async () => {
  for (const detail of ["\u{1f600}".repeat(300), "a" + "\u{1f600}".repeat(300)]) {
    const e = new RequestEngine({ maxRetries: 0, transport: async () => rawResponse(detail, "text/plain", 500) });
    await assert.rejects(e.getText("/x"), (err: Error) => {
      assert.equal(toWellFormed(err.message), err.message);
      return true;
    });
  }
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // Node sends the pair UTF-8 encoded (the Authorization header it builds from the URL), so that is the form a server echoes.
  const basic = Buffer.from("alice:pa ss-pw", "utf8").toString("base64");
  const engine = new RequestEngine({
    baseUrl: "https://alice:pa%20ss-pw@mirror.example",
    maxRetries: 0,
    transport: makeMockTransport(() => rawResponse(`no: Basic ${basic} / alice:pa ss-pw / pa ss-pw`, "text/plain", 401)).transport,
  });
  await assert.rejects(engine.getText("/x"), (err: BundeswahlApiError) => {
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.body.includes(form), err.body);
    return true;
  });
});

test("a network failure names the request: GET <url> failed: <reason>, userinfo redacted, the original as cause (K3)", async () => {
  const base = "https://user:secret@example.test";
  const prefix = "GET https://***@example.test/x.csv failed: ";
  const failures: Array<[string, () => unknown]> = [
    ["a timeout of the transport", () => new BundeswahlNetworkError("Request timed out after 300ms")],
    ["a refused connection", () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" })],
    ["a DNS failure", () => Object.assign(new Error("getaddrinfo ENOTFOUND example.test"), { code: "ENOTFOUND" })],
    ["a reset", () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
  ];
  for (const [what, make] of failures) {
    const thrown = make();
    const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => { throw thrown; } });
    await assert.rejects(
      () => e.getText("/x.csv"),
      (err: unknown) => {
        assert.ok(err instanceof BundeswahlNetworkError, what);
        assert.ok(err.message.startsWith(prefix), `${what}: ${err.message}`);
        assert.ok(!err.message.includes("secret"), what);
        assert.match(err.message, new RegExp(`failed: ${(thrown as Error).message}$`), what);
        assert.equal(err.cause, thrown, `${what}: the original is the cause`);
        return true;
      },
    );
  }
  // The engine's own deadline, for a transport that never answers.
  const slow = new RequestEngine({ baseUrl: base, timeoutMs: 5, transport: () => new Promise(() => {}) });
  await assert.rejects(() => slow.getText("/x.csv"), (err: unknown) => {
    assert.ok(err instanceof BundeswahlNetworkError);
    assert.equal(err.message, `${prefix}Request exceeded the 5ms deadline`);
    assert.ok(err.cause instanceof BundeswahlNetworkError);
    return true;
  });
  // The size cap, for a transport that read the whole body.
  const big = new RequestEngine({ baseUrl: base, maxResponseBytes: 4, transport: async () => csvResponse("a;b\n1;2\n") });
  await assert.rejects(() => big.getText("/x.csv"), (err: unknown) => {
    assert.ok(err instanceof BundeswahlNetworkError);
    assert.match(err.message, /^GET https:\/\/\*\*\*@example\.test\/x\.csv failed: Response exceeded the size limit of 4 bytes/);
    return true;
  });
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"text/csv; charset=iso-8859-1"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from("a;ü\n") }) });
  // With the prototype set, the charset was read from it: "declares charset iso-8859-1 but is UTF-8".
  assert.equal(await e.getText("/x.csv"), "a;ü\n");
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "text/csv; charset=utf-8"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from("a;ü\n") }) });
  assert.equal(await f.getText("/x.csv"), "a;ü\n");
});

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const { gzipSync } = await import("node:zlib");
  const request = "GET https://***@h.test/m/x.csv?y=1: ";
  const cases: Array<[string, () => { status: number; headers: Record<string, string>; body: Buffer }]> = [
    ["HTML page", () => ({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(fx.htmlShell) })],
    ["empty", () => ({ status: 200, headers: {}, body: Buffer.from("  \n") })],
    ["compressed", () => ({ status: 200, headers: { "content-encoding": "gzip" }, body: gzipSync(Buffer.from("a;b\n")) })],
    ["unknown charset", () => ({ status: 200, headers: { "content-type": "text/csv; charset=x-klingon" }, body: Buffer.from("a;b\n") })],
    ["mislabelled", () => ({ status: 200, headers: { "content-type": "text/csv; charset=iso-8859-1" }, body: Buffer.from("a;ü\n") })],
  ];
  for (const [name, respond] of cases) {
    const e = new RequestEngine({ baseUrl: "https://alice:s3cret@h.test/m", transport: async () => respond() });
    await assert.rejects(
      () => e.getText("/x.csv", { y: "1" }),
      (err: Error) => err instanceof BundeswahlParseError && err.message.startsWith(request) && !err.message.includes("s3cret"),
      name,
    );
  }
});

test("an answer longer than V8's longest string is a BundeswahlParseError naming the request, not a plain Error (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length. `fatalToo` false: the strict
  // decode fails as for an invalid byte, and only the replacing one after it is too long.
  // Longer than the head read to tell an HTML page (64 KiB), which must not be the whole body.
  const huge = Buffer.from(`Gebiet;Stimmen\n1;2\n${" ".repeat(70_000)}`);
  const tooLong = (): Error => Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  let fatalToo = true;
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) {
      if (this.fatal && !fatalToo) throw Object.assign(new TypeError("The encoded data was not valid"), { code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
      throw tooLong();
    }
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && (args[0] === "utf8" || args[0] === "latin1")) throw tooLong();
    return toString.apply(this, args);
  });
  const message = `GET https://www.bundeswahlleiterin.de/x.csv?y=1: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`;
  for (const [contentType, strictToo] of [["text/csv", true], ["text/csv", false], ["text/csv; charset=iso-8859-1", true], ["text/csv; charset=iso-8859-1", false]] as const) {
    fatalToo = strictToo;
    const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, contentType)).transport });
    await assert.rejects(e.getText("/x.csv", { y: "1" }), (err: unknown) => {
      assert.ok(err instanceof BundeswahlParseError, `${contentType} ${strictToo}: ${String(err)}`);
      assert.equal(err.message, message);
      return true;
    });
  }
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, maxRetries: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getText("/x.csv"), (err: unknown) => err instanceof BundeswahlApiError && err.status === 500 && err.body === "");
});

test("sanitizeServerText drops whole escape sequences, not just their control bytes", () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const CSI8 = String.fromCharCode(0x9b);
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  for (const [input, expected] of [
    [`line1 ${ESC}]0;title${BEL}rest`, "line1 rest"],
    [`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`, "click"],
    [`${ESC}[31mred${ESC}[0m plain`, "red plain"],
    [`${ESC}[1;31;4mbold`, "bold"],
    [`${CSI8}2Jcleared`, "cleared"],
    [`${OSC8}0;t${ST8}ok`, "ok"],
    [`a${ESC}7b${ESC}(Bc`, "abc"],
    // Unterminated: only ESC and its introducer go, the text stays.
    [`keep ${ESC}]0;no terminator here`, "keep 0;no terminator here"],
  ] as const) {
    assert.equal(sanitizeServerText(input), expected, JSON.stringify(input));
  }
});

test("sanitizeServerText drops invisible format characters (zero-width, soft hyphen, BOM)", () => {
  const text = "real\u200b error\u2028Error: forged\u2066x\u2069 \ufeffend\u00ad\u200d\u2060!";
  assert.equal(sanitizeServerText(text), "real error Error: forgedx end!");
});

test("sanitizeServerText keeps ordinary text, umlauts and single spaces", () => {
  assert.equal(sanitizeServerText("  Wahlkreis  Größe  Flensburg – Schleswig  "), "Wahlkreis Größe Flensburg – Schleswig");
});

test("sanitizeServerText reads a bounded prefix and drops what the per-character filter dropped", () => {
  // The filter it replaces, one character at a time: C0 but TAB to CR, DEL, C1 and Cf go.
  const perCharacter = (text: string): string =>
    [...text]
      .filter((ch) => {
        const n = ch.codePointAt(0) ?? 0;
        return (n >= 0x09 && n <= 0x0d) || !(n <= 0x1f || (n >= 0x7f && n <= 0x9f) || /\p{Cf}/u.test(ch));
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const every = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join("") + "\u{1f600}\u{e0001}\ud800x";
  for (let at = 0; at < every.length; at += 512) {
    const piece = every.slice(at, at + 512).replace(/[\u001b\u0090\u0098\u009b-\u009f]/g, "");
    assert.equal(sanitizeServerText(piece), perCharacter(piece), `from U+${at.toString(16)}`);
  }
  // At most 16 384 units of the text are read, never half a surrogate pair: a huge CSV cell
  // quoted in a parse error costs neither the heap nor seconds.
  assert.equal(sanitizeServerText("x".repeat(100_000)).length, 16_384);
  assert.equal(sanitizeServerText(`${"x".repeat(16_383)}\u{1f600}`), "x".repeat(16_383));
  // A control string ends at another introducer: the first is dropped by the filter, the second
  // string as a whole.
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  assert.equal(sanitizeServerText(`a${OSC8}0;x${OSC8}0;t${ST8}b`), "a0;xb");
  assert.equal(sanitizeServerText(`a${ESC}]0;x${ESC}]0;t${BEL}b`), "a0;xb");
});

test("echoedCredentialForms treats a userinfo without a password as a token (Basic `TOKEN:`)", () => {
  const basic = (pair: string): string => Buffer.from(pair, "utf8").toString("base64");
  assert.deepEqual(echoedCredentialForms("alice:s3cret"), [basic("alice:s3cret"), "alice:s3cret", "s3cret"]);
  assert.deepEqual(echoedCredentialForms("T0ken"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T0ken:"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T%C3%B6k"), [basic("Tök:"), "Tök:"]); // short: not alone
  assert.deepEqual(echoedCredentialForms(":pw12"), [basic(":pw12"), ":pw12", "pw12"]);
  assert.deepEqual(echoedCredentialForms(""), []);
  assert.deepEqual(echoedCredentialForms(":"), []);
});

test("a userinfo without a password is a token: scrubbed from library errors in every echoed form", async () => {
  const TOKEN = "T0kenS3cret";
  const basicValue = Buffer.from(`${TOKEN}:`, "utf8").toString("base64");
  for (const baseUrl of [`https://${TOKEN}@mirror.example`, `https://${TOKEN}:@mirror.example`]) {
    for (const echo of [`bad token ${TOKEN}`, `Authorization: Basic ${basicValue}`, `user ${TOKEN}: unknown`]) {
      const mt = makeMockTransport(() => rawResponse(echo, "text/plain", 401));
      const e = new RequestEngine({ baseUrl, transport: mt.transport, maxRetries: 0 });
      await assert.rejects(
        () => e.getText("/x.csv"),
        (err) => {
          assert.ok(err instanceof BundeswahlApiError && /^HTTP 401 /.test(err.message), String(err));
          const seen = [inspect(err, { depth: 10, showHidden: true }), err.message, err.detail, err.body, err.url].map(String).join("\n");
          assert.ok(!seen.includes(TOKEN) && !seen.includes(basicValue), `${baseUrl} ${echo}: ${seen.slice(0, 2000)}`);
          return true;
        },
      );
    }
  }
});

/** Milliseconds `work` takes. */
function elapsed(work: () => unknown): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

test("redactUrlUserinfo hides every URL's userinfo in one linear pass, however many URLs (T15b)", () => {
  // The URL regex this replaces (a scheme tried at every word start) takes about 3 s on this.
  assert.ok(elapsed(() => redactUrlUserinfo("a.".repeat(30_000))) < 1000);
  assert.equal(redactUrlUserinfo("a -https://u:p@h/x and x-ftp://v@w?q, mail@example.org"), "a -https://***@h/x and x-ftp://***@w?q, mail@example.org");
  assert.equal(redactUrlUserinfo("1://u:p@h ://u:p@h"), "1://u:p@h ://u:p@h");
  assert.equal(redactUrlUserinfo("https://h/p?u=a@b"), "https://h/p?u=a@b");
  for (const text of ["a".repeat(1_000_000), "a.".repeat(500_000), "://".repeat(100_000), `https://${"u".repeat(1_000_000)}`]) {
    assert.equal(redactUrlUserinfo(text), text);
  }
  const many = redactUrlUserinfo("https://u:p@h ".repeat(100_000));
  assert.equal(many, "https://***@h ".repeat(100_000));
});

test("redactUrlUserinfo hides the userinfo of a URL glued onto the one before it, still linear (B2)", () => {
  // The authority read for the first `://` ends at the `/` of the second; the second URL starts
  // inside it (its scheme is the first one's host, or follows a redacted `@`), so the search goes
  // on after each `://`, not after the authority. The regex this replaces redacted both; the
  // first linear pass missed them.
  assert.equal(redactUrlUserinfo("https://host://u:p@h"), "https://host://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@x://v:q@w"), "https://***@x://***@w");
  assert.equal(redactUrlUserinfo("see https://h.example:/x://u:p@h"), "see https://h.example:/x://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@1://v:q@w"), "https://***@1://v:q@w");
  // Many glued URLs, unredacted and redacted, and long scheme-character runs: one pass each.
  const n = 100_000;
  for (const [text, want] of [
    [`${"a://".repeat(n)}u:p@h`, `${"a://".repeat(n)}***@h`],
    ["x://u:p@".repeat(n), "x://***@".repeat(n)],
    [`${"a.".repeat(500_000)}://u:p@h`, `${"a.".repeat(500_000)}://***@h`],
    [`https://${"a.".repeat(500_000)}://u:p@h`, `https://${"a.".repeat(500_000)}://***@h`],
    ["a:".repeat(500_000), "a:".repeat(500_000)],
  ] as const) {
    let got = "";
    const ms = elapsed(() => (got = redactUrlUserinfo(text)));
    assert.ok(got === want, `${text.slice(0, 40)}…`);
    assert.ok(ms < 1000, `${Math.round(ms)} ms on ${text.slice(0, 40)}…`);
  }
});

test("a TextBuilder joins its pieces in order across batches", () => {
  const b = new TextBuilder();
  const expected: string[] = [];
  for (let i = 0; i < 40_000; i++) {
    b.push(String(i), ",");
    expected.push(String(i), ",");
  }
  assert.equal(b.toString(), expected.join(""));
  assert.equal(new TextBuilder().toString(), "");
});

test("an error body keeps its spelling unless a credential hides behind an escape (security audit, D)", async () => {
  const base = "https://alice:s3cret-pw@mirror.example";
  const errorOf = async (body: string): Promise<BundeswahlApiError> => {
    const e = new RequestEngine({ baseUrl: base, transport: async () => rawResponse(body, "application/json", 500), maxRetries: 0 });
    const err = await e.getText("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof BundeswahlApiError, String(err));
    return err;
  };
  // No credential, or one spelled as sent: the body as sent (scrubbed), escapes kept.
  assert.equal((await errorOf('{"m":"caf\\u00e9 \\"x\\""}')).body, '{"m":"caf\\u00e9 \\"x\\""}');
  assert.equal((await errorOf('{"m":"pw s3cret-pw \\u00e9"}')).body, '{"m":"pw *** \\u00e9"}');
  // Escaped: written again decoded, scrubbed in that spelling; the snippet quotes that body.
  const escaped = await errorOf('{"m":"pw s3cret\\u002dpw \\u00e9"}');
  assert.equal(escaped.body, '{"m":"pw *** é"}');
  assert.ok(!escaped.message.includes("s3cret") && escaped.detail === '{"m":"pw *** é"}', escaped.message);
  // A JSON string whose every character is escaped, and a `\"` inside a user:password.
  const pw = 'pä"s-W0rd';
  const typed = new RequestEngine({
    baseUrl: `https://alice:${encodeURIComponent(pw)}@mirror.example`,
    maxRetries: 0,
    transport: async () => rawResponse(JSON.stringify(`bad login alice:${pw}`), "text/plain", 401),
  });
  const login = await typed.getText("/x").catch((caught: unknown) => caught);
  assert.ok(login instanceof BundeswahlApiError);
  for (const text of [login.message, login.detail ?? "", login.body]) assert.ok(!text.includes('s-W0rd'), text);
  // Not JSON: nobody decodes it, it stays as sent.
  assert.equal((await errorOf("pw s3cret\\u002dpw")).body, "pw s3cret\\u002dpw");
});

test("a value quoted from an answer is scrubbed before it is cut, so no part of a credential stays (security audit, D)", () => {
  const pw = "s3cret-Pw-long";
  const e = new RequestEngine({ baseUrl: `https://alice:${pw}@mirror.example` });
  for (const at of [0, 490, 495, 499]) {
    const quoted = e.quoteServerValue(`${"x".repeat(at)}${pw}${"y".repeat(600)}`);
    assert.ok(!quoted.includes("s3cret"), `${at}: ${quoted}`);
  }
  assert.equal(new RequestEngine().quoteServerValue('a"b'), '"a\\"b"');
});

test("an echo of the request URL as sent is scrubbed, a short password too (security audit, D)", async () => {
  // Typed raw; WHATWG writes `p%22%C3%A4` in the URL, which a server echoes.
  const e = new RequestEngine({
    baseUrl: 'https://alice:p"ä@mirror.example',
    maxRetries: 0,
    transport: async () => rawResponse("no access: https://alice:p%22%C3%A4@mirror.example/x", "text/plain", 403),
  });
  const err = await e.getText("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof BundeswahlApiError, String(err));
  for (const text of [err.message, err.detail ?? "", err.body]) {
    assert.ok(!text.includes("p%22%C3%A4@") && !text.includes('p"ä@'), text);
  }
});

test("a base URL with a backslash, or whose scheme is not followed by // and the host, is rejected at construction, never echoing the password (security audit, F/F4)", () => {
  // WHATWG ends an http(s) authority at "\\" and repairs `http:host`, `http:/host`, `http:///host`
  // silently into `http://host`: the host requested would not be the one typed.
  for (const [baseUrl, reason] of [
    ["http:alice:s3cret@h.example", 'Expected an absolute http(s) URL ("https://" and the host).'],
    ["https:/alice:s3cret@h.example", 'Expected an absolute http(s) URL ("https://" and the host).'],
    ["http:///alice:s3cret@h.example", 'Expected an absolute http(s) URL ("https://" and the host).'],
    ["HTTPS:h.example/v1", 'Expected an absolute http(s) URL ("https://" and the host).'],
    ["https:\\\\alice:s3cret@h.example", 'A base URL cannot contain a backslash (\\); write "/" instead.'],
    ["https://alice:s3cret@a.example\\@b.example", 'A base URL cannot contain a backslash (\\); write "/" instead.'],
  ] as const) {
    const mt = makeMockTransport(() => csvResponse("a;b\n1;2\n"));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, baseUrl }),
      (err: unknown) => err instanceof BundeswahlValidationError && err.message === `Invalid baseUrl: ${reason}` && !err.message.includes("s3cret"),
      baseUrl,
    );
    assert.equal(mt.calls.length, 0, baseUrl);
  }
});

test("requests go to the base URL as WHATWG parses it: the host every check names (security audit, F)", async () => {
  for (const [baseUrl, want] of [
    ["https://API.Example:443/v1/", "https://api.example/v1/x.csv"],
    ["https://alice:pw@api.example/v1/@evil.example", "https://alice:pw@api.example/v1/@evil.example/x.csv"],
    ["https://h.example/a b", "https://h.example/a%20b/x.csv"],
  ] as const) {
    const mt = makeMockTransport(() => csvResponse("a;b\n1;2\n"));
    await new RequestEngine({ transport: mt.transport, baseUrl }).getText("/x.csv");
    assert.equal(mt.calls[0]?.url, want, baseUrl);
  }
});

test("credentialsIn ends the authority of a special scheme at a backslash, as WHATWG does (security audit, F)", () => {
  for (const scheme of ["http", "https", "HTTPS", "ws", "wss", "ftp"]) {
    assert.deepEqual(credentialsIn(`${scheme}://u:p@a.example\\@b.example/x`), ["u:p"], scheme);
    assert.equal(new URL(`${scheme}://u:p@a.example\\@b.example/x`).password, "p", scheme);
  }
  // Another scheme's authority runs on to "/", "?" or "#".
  assert.deepEqual(credentialsIn("foo://u:p@a.example\\@b.example/x"), ["u:p@a.example\\"]);
  assert.deepEqual(credentialsIn("https://u:p@a.example/x\\@y"), ["u:p"]);
});

test("credentialsIn skips the slashes and backslashes WHATWG skips after a special scheme (security audit, F3)", () => {
  // `http:///u:pw@h`, `https:\\u:pw@h` and `http:u:pw@h` all carry `u:pw` for WHATWG; read
  // after "://", the userinfo was missed, so a refused --base-url echoed the password in clear.
  for (const value of [
    "http:alice:pw@h.example",
    "http:/alice:pw@h.example",
    "http:///alice:pw@h.example/x",
    "https:////alice:pw@h.example",
    "HTTPS:\\\\alice:pw@h.example",
    "wss:\\/alice:pw@h.example",
    "ftp:alice:pw@h.example",
  ]) {
    assert.deepEqual(credentialsIn(value), ["alice:pw"], value);
    assert.equal(new URL(value).password, "pw", value);
  }
  // Another scheme needs "//" before an authority: `foo:u:p@h` and `foo:///u:p@h` carry none.
  assert.deepEqual(credentialsIn("foo:u:p@h.example"), []);
  assert.deepEqual(credentialsIn("foo:///u:p@h.example"), []);
  assert.equal(new URL("foo:///u:p@h.example").password, "");
});

test("typedUrlCredentials reads a value meant as a URL whatever its scheme: missing, special without //, mistyped (F7)", () => {
  for (const [value, userinfo] of [
    ["https://alice:pw@h.example/x", "alice:pw"],
    ["http:///alice:pw@h.example", "alice:pw"],
    ["alice:pw@h.example/x", "alice:pw"],
    ["my_user:pw@h.example", "my_user:pw"],
    ["T0ken:@h.example", "T0ken:"],
    ["http//alice:pw@h.example", "alice:pw"],
    ["https//alice:pw@h.example/v1", "alice:pw"],
    ["http/alice:pw@h.example", "alice:pw"],
    ["htp:/alice:pw@h.example", "alice:pw"],
    ["http\\\\alice:pw@h.example", "alice:pw"],
    ["http//alice:p/w@h.example", "alice:p/w"],
  ] as const) {
    assert.deepEqual(typedUrlCredentials(value), [userinfo], value);
  }
  // No "@" after the slashes, or a scheme spelled with "//" and no userinfo: none.
  for (const value of ["", "h.example/x", "http//h.example/x", "@h.example/x", "http//@h.example", "https://h.example/a@b"]) {
    assert.deepEqual(typedUrlCredentials(value), [], value);
  }
});
