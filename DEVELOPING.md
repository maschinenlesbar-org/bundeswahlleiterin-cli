# Developing & integrating

This document covers `bundeswahlleiterin-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the command-line
tool, start with the **[README](README.md)** and **[Usage.md](Usage.md)** instead.

The package ships both a CLI (`bundeswahl`) and a typed API client
(`BundeswahlClient`) for the Bundeswahlleiterin open-data files (Bundestagswahl
2025), served as CSV by `www.bundeswahlleiterin.de`.

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https`
  (no axios, no fetch polyfill) and a **hand-rolled, dependency-free CSV parser**
  (no `csv-parse`, no `papaparse`).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Typed & parsed** — `ResultRow` / `Party` / `Wahlkreis` shapes over the CSV, with
  counts and percentages parsed to numbers (`null` for empty/`–` cells).
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every
  HTTP response mocked. The CSV parser has its own edge-case suite.

## The one thing to know: it's CSV files, not a REST API

The Bundeswahlleiterin publishes each election's results and reference data as
**CSV files** under an open-data page. There is no JSON API. The files are:
semicolon-delimited, UTF-8 **with a BOM**, German decimals (comma), with a
multi-line human-readable **preamble** before the header row. The results (`kerg2`)
sit at a stable directory path; the reference files (parties, Wahlkreise,
Strukturdaten) are behind opaque `dam/jcr/<uuid>` paths that are fixed for a
completed election, so they are **pinned** in `client.ts` (`BTW2025`).

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
bundeswahl --help
```

## Library usage

```ts
import { BundeswahlClient, BundeswahlParseError } from "@maschinenlesbar.org/bundeswahlleiterin-cli";

const client = new BundeswahlClient();

// Results are filtered client-side (the CSV is a whole dataset)
const zweitstimme = await client.results({ areaType: "Bund", vote: 2, groupType: "Partei" });
zweitstimme.sort((a, b) => (b.prozent ?? 0) - (a.prozent ?? 0));
for (const r of zweitstimme) console.log(r.gruppenname, r.prozent);

const wahlkreise = await client.wahlkreise({ land: "Bayern" });   // 47 rows
const structure = await client.structure({ wahlkreis: "Kiel" });  // one column→value map

try {
  await client.parties();
} catch (err) {
  if (err instanceof BundeswahlParseError) console.error(err.message);
}
```

### Client options

```ts
new BundeswahlClient({
  baseUrl: "https://www.bundeswahlleiterin.de",
  timeoutMs: 15_000,
  maxRetries: 3,               // 429 / 503 and resets are retried (Retry-After, else linear backoff)
  maxResponseBytes: 50 << 20,
  userAgent: "my-app/1.0",
  transport: customTransport,
});
```

`baseUrl` is checked in the constructor with `validateBaseUrl` (exported; the rules are
`baseUrlProblem` in `validate.ts`, the same function the CLI's `--base-url` parser calls)
on the raw value, before trailing slashes are stripped: a blank value, surrounding
whitespace (which `new URL()` would trim silently while the engine concatenated the raw
string into a `/%20/…` path), a control character, a scheme other than http(s), a query
or fragment, or a `%` in the userinfo that isn't an escape (Node would fail to decode it
for the Authorization header at request time; write `%25`) throws
`BundeswahlValidationError` (`Invalid baseUrl: <reason>`). Only an omitted `baseUrl`
selects the default host.

A `user:password@` in the base URL (a mirror behind a login) never reaches the CLI's
output. `credentialsIn(value)` finds the exact userinfo of a URL-like value, parseable
or not, with a prefix (`--base-url=…`) or without a scheme (`user:pw@host`), and
`redactCredentials(text, list)` replaces each `secret@` with `***@`; `redactUrl` falls
back to them for a value that doesn't parse. `run()` starts with
`withRedactedOutput(deps, argv)`, which collects the credentials of every argument (and
of the value part of `--opt=value`, `redactionFor`) and redacts every line printed on
stdout and every log record on stderr. The log replaces them in each record's *message*,
before the record is cut and escaped, and writes it to the raw stderr: the frame (time,
level, topic) is never touched, and a password with DEL, C1 or bidi characters is
matched in its raw form — commander's usage errors echo rejected values (`argument '…' is invalid`, `unknown
command '…'`, `too many arguments … got 1: …`). `test/conformance-p1-cli-redaction.test.ts`
checks ten passwords in seven URL shapes at nine argv positions.

A plain-`http:` base URL gets a warning, not a refusal. `cleartextProblem(baseUrl,
secrets)` (engine, exported) returns one sentence naming the host (`url.host`, never the
userinfo) and what travels unencrypted — the base URL's credentials when it carries
userinfo — or `undefined` for `https:`, an unparseable URL and loopback hosts
(`localhost`, `127.0.0.0/8`, `::1`). The CLI's `action()` wrapper (`shared.ts`,
`warnOnCleartext`) logs it once per run as a `WARN` record of `bundeswahl.http` on stderr, after the
options are parsed and before the first request; `--help`, `--version` and usage errors
never get there. `test/conformance-p20-cleartext-warning.test.ts` checks it.

The library keeps them out of what a caller logs, too. The engine holds the base URL in
a real `#private` field (so `console.log(client)`, `util.inspect` and `JSON.stringify`
never show it) next to its userinfo, raw and percent-decoded, and scrubs that from
error bodies (`BundeswahlApiError.body`/`detail`), transport error text and the `cause`
chain. `BundeswahlApiError.url` is the request URL with its userinfo redacted. Whatever
a custom transport throws (a string, fetch's `TypeError` naming the URL) reaches the
caller as a `BundeswahlNetworkError` with the original, scrubbed, as its `cause`.
`test/conformance-p2-library-redaction.test.ts` checks the client, nine failing
transports and five rejected base URLs.

`userAgent` and every `defaultHeaders` value are checked in the constructor with
`assertHeaderValue` (exported; the rules are `headerValueProblem` in `validate.ts`, the
same function the CLI's `--user-agent` parser calls). Only an omitted `userAgent` selects
the default; `""` is an error, as `--user-agent ""` is in the CLI.

`429`/`503` are retried up to `maxRetries` (`0`–`10` in the CLI). Each retry waits
`retryDelayMs * attempt` (200 ms by default), or the response's `Retry-After` —
delay-seconds or an IMF-fixdate HTTP-date, parsed by `parseRetryAfter` — when that is
longer. **Retries never burst**: a `Retry-After` can make a wait longer, never shorter, so
`Retry-After: 0` or a date in the past no longer sends the retries back to back. A
`Retry-After` longer than `MAX_RETRY_AFTER_MS` (30 s) is not retried: the
`BundeswahlApiError` surfaces at once, says so, names the requested wait and carries it as
`retryAfterMs`. `test/conformance-p6-retry-policy.test.ts` checks both. A reset connection (`ECONNRESET`, `EPIPE`, `ECONNABORTED`, undici's
`UND_ERR_SOCKET`, anywhere in the `cause` chain) is retried like a 503, after
`retryDelayMs * attempt`; a refused connection, a DNS failure and a timeout are not.

**Custom transports.** `timeoutMs` and `maxResponseBytes` hold for every transport, not
only the built-in one: the engine races the call against its own deadline and passes an
`AbortSignal` in `HttpRequest.signal` (hand it to `fetch(url, { signal })`), and it checks
the size of the body it gets back. A transport may return its headers as a fetch `Headers`
object, a `Map` or a record with names in any case (`Retry-After` is read from all of
them), and its body as a `Buffer`, any ArrayBuffer view (fetch's `Uint8Array`) or an
`ArrayBuffer`, from any realm. Whatever a transport throws or returns that isn't a
response (a string body, no status) becomes a `BundeswahlNetworkError`.
`test/conformance-p5-transport-contract.test.ts` checks this with a never-answering
transport, `fetch` against a silent server, a 2 MiB body and every body and header shape.

### Methods (one per dataset)

| Method | Dataset | Returns |
|---|---|---|
| `results(query?)` | kerg2 | `ResultRow[]` — filter by `areaType`/`area`/`party`/`vote`/`groupType` |
| `parties()` | btw25_parteien | `Party[]` |
| `wahlkreise({ land? })` | btw25_wahlkreisnamen | `Wahlkreis[]` |
| `structure({ wahlkreis?, includeAggregates? })` | btw2025_strukturdaten | `StructureRow[]` (column→value map; `includeAggregates: true` keeps the 17 Land/Bund summary rows; anything but a boolean is a `BundeswahlValidationError`) |

The dataset paths are exported as `BTW2025` for reference.

**Character set.** `getText` decodes a body by the `charset` its Content-Type declares,
strictly; without one (the host declares none) as strict UTF-8, the pinned files' encoding.
A body that isn't valid in that charset, an unknown label, and a UTF-8 body labelled as a
single-byte charset (which would garble every umlaut) are each a `BundeswahlParseError`,
never text with U+FFFD or mojibake in it. The media type itself is ignored: the host serves
the CSVs as `text/csv`, `text/plain` or `application/octet-stream`. The client asks for no
compression (it sends no `Accept-Encoding`), so a compressed body — a `Content-Encoding`
other than `identity`, or gzip data without one — is a server or proxy compressing anyway:
a `BundeswahlParseError` that says so, rather than a misleading charset diagnosis.

## The CSV parser

[`csv.ts`](src/client/csv.ts) is a small, dependency-free parser:

- **`parseCsvRows(text, delimiter=';')`** — an RFC-4180-ish tokenizer: it strips the
  UTF-8 BOM and understands double-quoted fields, `""` escapes, and delimiters/
  newlines inside quotes (more than these files need, but correct if a field ever
  contains a `;`). A trailing newline does not produce a spurious empty row.
- **`parseCsv(text, { headerColumns })`** — skips the human-readable preamble to
  the header row, the first row that contains at least half (and at least two) of the
  expected column names in any position (`headerMatchThreshold`), then returns
  `{ header, rows }` with fully-empty rows dropped. The older `headerFirstCell` option
  (the first row whose first cell equals a name, e.g. `"Wahlart"`) is still there, but
  the client no longer uses it: it broke on a reorder that moved the first column.
- **`rowsToObjects(parsed)`** — keys cells by header name (used for the
  dynamic-columned Strukturdaten).
- **`parseGermanNumber(s)`** — comma-decimal → JS number, `null` for empty/`-`/`–`;
  anything else (`0x10`, `1e3`, `1,2,3`) throws a `BundeswahlParseError` rather than
  guessing or reading as `null`. It reads `16.413` as 16413 (a thousands dot), so
  `results()` first checks each number column's convention: unless the column shows
  thousands dots elsewhere (a grouped value that can't be a decimal, and no value of 1000
  or more without them), a one-dot, three-digit value is ambiguous — 16.413 in an
  English-locale re-export — and a `BundeswahlParseError` naming the cell.

The client finds each dataset's header and maps its columns by name (not fixed
position), so the parsing survives a column being added or reordered — the first column
included. A header that repeats a column name is
rejected with a `BundeswahlParseError` in every dataset, since a lookup by name would
silently pick one of the two, and so is a header that lacks a column the mapper reads
(a renamed `Anzahl` would otherwise make that field `null` in every row, and a renamed
`LAND_ABK` would make `--land BY` return `[]`). The published files are rectangular, so
a data row with more or fewer cells than the header is rejected too: that is a body cut
off mid-row, whose last number may be cut at its decimal comma. A `Gebietsart` outside `Bund`/`Land`/`Wahlkreis` (a case variant
such as `BUND` is read as its level) and a `Stimme` other than `1`, `2` or empty are parse
errors naming the cell: a relabelled level would otherwise make `--area-type` match nothing
and answer `[]` with exit 0.

**Completeness.** A body cut inside a row fails the rectangular check; a body cut at a row
boundary, or a file that is only its header, is caught by each dataset's own structure,
so it is a `BundeswahlParseError` instead of partial data or `[]` with exit 0:

- `results` (kerg2): every area ends with its two "Übrige" rows, so the file's last row is
  an "Übrige" Zweitstimme row; every area has exactly one "Wahlberechtigte" row, and they
  add up — the Bund's is the sum of the 16 Länder's, each Land's the sum of its
  Wahlkreise' (`UegGebietsnummer`). A cut at an area boundary breaks a sum.
- `parties`: the list ends with the "Übrige" group (`Gruppenart_XML` `UEBRIGE`).
- `wahlkreise`: the file has no closing row, so the election's own size is the check:
  Wahlkreise 1–299 (`BTW2025_WAHLKREISE`), each once.
- `structure`: the file ends with the national "Insgesamt" row (`Wahlkreis-Nr.` 999).

The test fixtures are complete in this sense (`test/fixtures.ts`).

## Architecture

```
src/
  client/
    csv.ts       # dependency-free CSV tokenizer + parser + German-number helper
    types.ts     # ResultRow / Party / Wahlkreis / StructureRow + ResultsQuery
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, getText (declared charset, else strict UTF-8; HTML/empty guards), errors
    errors.ts    # BundeswahlError / …ApiError / …NetworkError / …ValidationError / …ParseError
    validate.ts  # input rules as pure `…Problem` functions + assertValid (shared with the CLI)
    client.ts    # BundeswahlClient — results/parties/wahlkreise/structure (+ BTW2025 paths)
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file), the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # datasets.ts — one command per dataset
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Closed pipes.** The bin shim installs `handleOutputErrors()` (`io.ts`) before `run()`:
an EPIPE on stdout (`| head`, a `jq` that exits early) exits 0 quietly — it used to print
an unhandled-EPIPE stack trace and exit 1; an EPIPE on stderr is ignored, so a failed run
keeps its own exit code; any other output error exits 1.
`test/conformance-p7-pipes-exit-codes.test.ts` runs the built bin for both.

**Two seams make the whole thing testable in-process (no subprocesses):**
`Transport` (the single HTTP function; tests inject a mock returning canned CSV) and
`CliDeps` (a client factory + I/O object; `run.ts` returns an exit code instead of
calling `process.exit`).

### Error types

[`errors.ts`](src/client/errors.ts): `BundeswahlApiError` (non-2xx, carries
`status`/`detail`, with `isRetryable`/`isNotFound`), `BundeswahlNetworkError`
(transport failure/timeout), `BundeswahlParseError` (the body was not CSV — usually
an HTML page), and `BundeswahlValidationError` (a client-side usage error, raised
before any request: a base URL that is blank, has surrounding whitespace, is not http(s)
or has a query/fragment, a numeric
option outside its range, a `userAgent` or `defaultHeaders` value that is blank or holds
a control character (CR/LF included), DEL or a character above U+00FF (and a
`defaultHeaders` name that is not an HTTP token), an unknown `areaType`, a `vote` other than `1`/`2`, a
blank text filter, or a query, options object or client options with a key the method
doesn't take (`results({ Party: "SPD" })` used to return every party; `ENGINE_OPTION_KEYS`
lists the client's) — the library applies the same rules as the CLI's parsers), all
extending `BundeswahlError`.

### Input validation

The library owns every input rule. [`validate.ts`](src/client/validate.ts) holds them as
pure, exported functions: a `Problem` returns the reason a value is invalid, or
`undefined`. `assertValid(name, value, problem)` throws `BundeswahlValidationError` with
`Invalid <name>: <reason>` before any request is made (async methods reject rather than
throw). The CLI's commander parsers call the same `…Problem` functions and turn the
reason into a usage error, and `run.ts` maps a `BundeswahlValidationError` raised during
an action to exit 2, logged as an `ERROR` record of `bundeswahl.cli`, so the CLI and the library cannot
drift apart.
Every rejected input is a `BundeswahlValidationError`, never a raw `TypeError`: a
non-function `transport` or `sleep`, a `defaultHeaders` that isn't an object and a
non-object query all fail in the constructor or before any request. An echoed value (JSON-
quoted, so `"2"` doesn't read like `2`) and server text in a message are cut at
`MAX_MESSAGE_VALUE_LENGTH` (500) characters, a server's error text at 200, never inside a
surrogate pair (`cutText`), so the message stays well-formed and bounded for a library
caller too; the error's own properties keep the full value. The CLI's own parse-time
message for a dash-leading filter value (`parseTextArg`) quotes it the same way
(`describeValue`). `test/conformance-p8-p9-p13-responses-and-errors.test.ts` checks the declared
charset (P8), malformed 2xx bodies (P9) and twenty wrong-typed calls (P13).
`test/conformance-p10-strict-filters.test.ts` checks unknown, misspelled and `__proto__`
keys, unknown area levels and ballots, wrong-typed values and repeated CLI flags.

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`csv.test.ts`** — the CSV parser: quotes/escapes/newlines, BOM, preamble skip,
  empty-row dropping, German numbers.
- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback server.
- **`engine.test.ts`** — `getText`, the HTML-page and empty-body guards, `429`/`503`
  retry, error mapping — mocked transport.
- **`client.test.ts`** — per-dataset paths, CSV→typed mapping, and every filter —
  mocked transport.
- **`cli.test.ts`** — command parsing, the `results` filters, `--output`, and exit
  codes — mocked client.
- **`log.test.ts`** — the record helpers of `src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`); the CLI-level checks are P23's.
- **`validate.test.ts`** — `assertValid`, the `run.ts` mapping of
  `BundeswahlValidationError`, and the `parity()` helper (`test/helpers.ts`), which sends
  one input through `run()` and through the library on one recording mock transport so a
  test can assert both give the same outcome.
- **`io.test.ts`** — `handleOutputErrors()`: a reader that has gone (EPIPE, ENOTCONN).
- **`conformance-p*.test.ts`** — the shared conformance tests of the 2026-10-05 fix plan,
  copied from the sibling repos with only their adapter block changed: P1 CLI redaction,
  P2 library redaction, P4/P19 base-URL validation (the P19 case is skipped: no environment
  variable here), P5 the transport contract, P6 the retry policy, P7 pipes and exit codes
  (runs the built bin), P8/P9/P13 charset, malformed bodies and wrong-typed input, P10 strict
  filters, P12 `-o -`, P20 the stderr warning for a plain-`http:` base URL (the env-variable
  and other-secret cases are skipped: no environment variable, no key), P21 the README's
  relative links (README.md ships to npmjs.com, so a link to a document the `files`
  allowlist leaves out must be an absolute GitHub URL), P23 the log on stderr (record
  format, `--log-format jsonl`, no secret in either format). The test fixtures (`fixtures.ts`) are complete datasets in the sense
  of the client's completeness checks.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test,
  `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): publish to npm via OIDC **Trusted Publishing**
  (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/bundeswahlleiterin-cli/> in
English and <https://maschinenlesbar-org.github.io/bundeswahlleiterin-cli/de/> in German — is
built from `site/` with [Jekyll](https://jekyllrb.com/),
[banira](https://sebs.github.io/banira/) web components and [Fylgja](https://fylgja.dev/) CSS,
and deployed by `docs.yml` together with the TypeDoc API reference under `/api/`. Its content
comes from this repository: the README intro and quick start, the command tree of the built CLI
(`site/scripts/cli-reference.mjs`), `Usage.md`, `GLOSSARY.md` and its German version
`GLOSSARY.de.md`, the skills, and the skill examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The
only repo-specific files are `site/_config.yml` and `site/_data/project.yml` (the German intro
and the access requirements); the rest of `site/` is identical in every maschinenlesbar.org
CLI, so change it in all of them together. When the README intro changes, update the German
intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/bundeswahlleiterin-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license —
see **[LICENSING.md](LICENSING.md)**. This project does **not** accept external
code contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## The log on stderr

Every diagnostic line on stderr is a log record (`src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `bundeswahl.<area>`. `--log-format text` (the default)
writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`),
and a message longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a
code point and ends in `… (N more characters)`. The areas are `cli` (usage errors, commander's messages, unexpected errors, a
file that does not parse as the expected CSV), `api` (the data host's answers, and the hint
after a 3xx), `http` (the connection, the size-cap hint, the cleartext warning) and
`output` (`Wrote N bytes` after `-o`). Code logs through `logOf(deps)` and never writes
diagnostics with `io.err` directly. `run()` builds the logger from argv before commander
parses it, so commander's own usage errors are records too, and with the run's
redaction (`withRedactedOutput`), which replaces a secret in the message only, before it
is escaped: the frame is never touched, and a secret is kept out of the log in either
format. `CliDeps.now` makes the
timestamps testable. stdout carries data only. Two lines are left raw, both written
straight to `process.stderr` outside `run()`: the bin shim's `Output error: …`
(`handleOutputErrors`, when stdout itself fails) and its last-resort `Unexpected error: …`
when `run()` itself rejects. Conformance test P23 checks all of this, and its body is
shared across the *-cli repos.
