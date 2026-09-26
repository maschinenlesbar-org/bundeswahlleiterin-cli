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
  maxRetries: 3,
  maxResponseBytes: 50 << 20,
  userAgent: "my-app/1.0",
  transport: customTransport,
});
```

### Methods (one per dataset)

| Method | Dataset | Returns |
|---|---|---|
| `results(query?)` | kerg2 | `ResultRow[]` — filter by `areaType`/`area`/`party`/`vote`/`groupType` |
| `parties()` | btw25_parteien | `Party[]` |
| `wahlkreise({ land? })` | btw25_wahlkreisnamen | `Wahlkreis[]` |
| `structure({ wahlkreis? })` | btw2025_strukturdaten | `StructureRow[]` (column→value map) |

The dataset paths are exported as `BTW2025` for reference.

## The CSV parser

[`csv.ts`](src/client/csv.ts) is a small, dependency-free parser:

- **`parseCsvRows(text, delimiter=';')`** — an RFC-4180-ish tokenizer: it strips the
  UTF-8 BOM and understands double-quoted fields, `""` escapes, and delimiters/
  newlines inside quotes (more than these files need, but correct if a field ever
  contains a `;`). A trailing newline does not produce a spurious empty row.
- **`parseCsv(text, { headerFirstCell })`** — skips the human-readable preamble to
  the header row (the first row whose first cell equals `headerFirstCell`, e.g.
  `"Wahlart"`), then returns `{ header, rows }` with fully-empty rows dropped.
- **`rowsToObjects(parsed)`** — keys cells by header name (used for the
  dynamic-columned Strukturdaten).
- **`parseGermanNumber(s)`** — comma-decimal → JS number, `null` for empty/`-`/`–`.

The client maps each dataset by header name (not fixed position), so the parsing
survives a column being added or reordered. A header that repeats a column name is
rejected with a `BundeswahlParseError` in every dataset, since a lookup by name would
silently pick one of the two, and so is a header that lacks a column the mapper reads
(a renamed `Anzahl` would otherwise make that field `null` in every row, and a renamed
`LAND_ABK` would make `--land BY` return `[]`).

## Architecture

```
src/
  client/
    csv.ts       # dependency-free CSV tokenizer + parser + German-number helper
    types.ts     # ResultRow / Party / Wahlkreis / StructureRow + ResultsQuery
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, getText (HTML/empty guards), errors
    errors.ts    # BundeswahlError / …ApiError / …NetworkError / …ValidationError / …ParseError
    client.ts    # BundeswahlClient — results/parties/wahlkreise/structure (+ BTW2025 paths)
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file)
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # datasets.ts — one command per dataset
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Two seams make the whole thing testable in-process (no subprocesses):**
`Transport` (the single HTTP function; tests inject a mock returning canned CSV) and
`CliDeps` (a client factory + I/O object; `run.ts` returns an exit code instead of
calling `process.exit`).

### Error types

[`errors.ts`](src/client/errors.ts): `BundeswahlApiError` (non-2xx, carries
`status`/`detail`, with `isRetryable`/`isNotFound`), `BundeswahlNetworkError`
(transport failure/timeout), `BundeswahlParseError` (the body was not CSV — usually
an HTML page), and `BundeswahlValidationError` (a client-side usage error), all
extending `BundeswahlError`.

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

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test,
  `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing**
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
