# bundeswahlleiterin-cli

[![CI](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/bundeswahlleiterin-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/bundeswahlleiterin-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/bundeswahlleiterin-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/bundeswahlleiterin-cli/de/) — command reference, guides and API docs

Query the **official German federal election results** from your terminal.
`bundeswahl` is a command-line tool over the
[Bundeswahlleiterin](https://www.bundeswahlleiterin.de) open data for the
**Bundestagswahl 2025**: first- and second-vote results by Bund, Land and
Wahlkreis, the parties, the 299 constituencies, and per-constituency structural
data — as clean JSON you can pipe straight into [`jq`](https://jqlang.github.io/jq/).

- **The official result** — the *Amtliches Endergebnis* (kerg2), one row per area ×
  party × ballot, filterable by area, party and Erst-/Zweitstimme.
- **Reference data** — parties, the 299 Wahlkreise (by Land), and Strukturdaten
  (demographics) per constituency.
- **Open data** — Datenlizenz Deutschland – Namensnennung 2.0. No API key; free to
  reuse (incl. commercially) **with attribution** — see [DATA_LICENSE.md](DATA_LICENSE.md).
- **Clean JSON output** — pretty by default, `--compact` for scripting, `-o <file>`
  to write to disk; counts and percentages come back as numbers.

> Want to use this as a TypeScript library, or curious how it parses the CSV files
> with zero dependencies? See **[DEVELOPING.md](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/blob/main/DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/bundeswahlleiterin-cli
```

This installs the **`bundeswahl`** command. Requires **Node.js 22.12+**. No API key.

Check it works:

```bash
bundeswahl results --area-type Bund --vote 2 --group-type Partei | jq '.[] | {party: .gruppenname, pct: .prozent}'
```

## Quickstart

```bash
# National second-vote (Zweitstimme) result for one party
bundeswahl results --area-type Bund --vote 2 --party SPD

# Who won the direct mandate (Erststimme) in Kiel, and by how much?
bundeswahl results --area-type Wahlkreis --area Kiel --vote 1 --group-type Partei \
  | jq -r 'map(select(.anzahl != null)) | sort_by(-.anzahl)[] | "\(.gruppenname)\t\(.anzahl)\t\(.prozent)%"'

# The 47 constituencies in Bavaria
bundeswahl wahlkreise --land Bayern | jq -r '.[].name'

# Structural data for one Wahlkreis
bundeswahl structure --wahlkreis Kiel
```

## Commands

| Command | What it shows |
| --- | --- |
| `results` | Bundestagswahl 2025 results — one row per area × party × ballot (`--area-type`, `--area`, `--party`, `--vote`, `--group-type`) |
| `parties` | The parties / groups reference list |
| `wahlkreise` | The 299 constituencies (`--land <name\|abbr\|number>`) |
| `structure` | Structural data (Strukturdaten) per Wahlkreis (`--wahlkreis <nr\|name>`, `--include-aggregates`) |

New to terms like *Wahlkreis*, *Erststimme/Zweitstimme*, *kerg2*, *Gebietsart* or
*Gruppenart*? The **[Glossary](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/blob/main/GLOSSARY.md)** decodes every one.

### `results` filters

| Option | Meaning |
| --- | --- |
| `--area-type <level>` | `Bund` \| `Land` \| `Wahlkreis` |
| `--area <nr-or-name>` | an area by number, leading zeros ignored (`005`, `09`), or name substring (`Kiel`); Land and Wahlkreis numbers overlap, so pair it with `--area-type` |
| `--party <name>` | a party/group by name substring (`SPD`, `GRÜNE`), case-insensitive |
| `--vote <1\|2>` | `1`/`erst` = Erststimme, `2`/`zweit` = Zweitstimme |
| `--group-type <type>` | a `Gruppenart` — `Partei`, `System-Gruppe`, `Einzelbewerber/Wählergruppe` |

Filters apply client-side (each command fetches the whole dataset), so they compose
and an unmatched filter yields `[]`.

## Output & scripting

Every command prints **JSON to stdout**; diagnostics go to stderr, so piping into
`jq` stays clean. Counts (`anzahl`) are integers and shares (`prozent`) are numbers;
empty/placeholder cells are `null`.

Each line on stderr is a **log record**: a timestamp (UTC), a level (`ERROR`, `WARN`,
`INFO`) and a topic, the program and the area it comes from (`bundeswahl.cli` for usage
errors, `bundeswahl.api` for the data host's answers, a malformed one included, `bundeswahl.http` for the connection,
`bundeswahl.output` for `-o` and a failed write to stdout). By default it is written log4j style; `--log-format jsonl`
writes one JSON object per line instead. A record is always one line: a line break, a
control character or a bidi control in a message (a server's text, a value you typed) is
written as an escape (`\n`, `\u001b`, `\u202e`), so it can neither split a record nor forge
another one, nor steer the terminal; a message longer than 4000 characters is cut and ends
in `… (N more characters)`:

```text
2026-10-09T14:03:12.481Z WARN  [bundeswahl.http] requests to mirror.example are sent unencrypted (http:, not https:)
2026-10-09T14:03:12.902Z ERROR [bundeswahl.api] HTTP 404 for GET http://mirror.example/dam/jcr/925d6e98-3616-465a-835a-cec1ea73abc2/btw25_parteien.csv
```

```bash
bundeswahl --log-format jsonl parties 2>log.jsonl   # {"ts":"…","level":"ERROR","topic":"bundeswahl.api","msg":"HTTP 404 …"}
```

```bash
# Second-vote national shares, sorted
bundeswahl results --area-type Bund --vote 2 --group-type Partei \
  | jq -r 'sort_by(-.prozent)[] | "\(.gruppenname)\t\(.prozent)%"'

# Turnout (Wahlbeteiligung) nationally
bundeswahl results --area-type Bund --group-type System-Gruppe \
  | jq -r '.[] | select(.gruppenname=="Wählende") | .prozent'
```

Use `--compact` for single-line JSON and `-o <file>` to write to a file — both are
**global options** that work before or after the command.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | Success (also `--help` / `--version`, and a reader that stops early, as `bundeswahl results \| head` does) |
| `2` | Bad usage / invalid argument (nothing was sent) |
| `4` | Not found (`404` — a data file moved) |
| `6` | Network / transport failure (DNS, connection, timeout, size cap) |
| `1` | Any other error — including a non-CSV response (an HTML page instead of the file) |

A closed stderr (`2>&1 | true`) doesn't change these codes: a failed run keeps its own.

## Troubleshooting

- **`command not found: bundeswahl`** — the global npm bin directory isn't on your
  `PATH`. Add `$(npm prefix -g)/bin` to it (`npm bin` was removed in npm 9), or run via
  `npx @maschinenlesbar.org/bundeswahlleiterin-cli …`.
- **Exit `4` / "not found"** — a data file moved. The Bundeswahlleiterin open-data
  URLs (some behind `dam/jcr` identifiers) are pinned in the client; if the section
  is reorganised, a path needs updating.
- **Exit `1` / "received an HTML page"** — the request returned an HTML page instead
  of a CSV (a moved file, or a custom `--base-url`).
- **Exit `1` / "is incomplete" or "no data rows"** — the downloaded file is cut short
  (each dataset is checked against its own structure, e.g. kerg2's totals must add up).
  Try again later; the CLI never answers with part of a file.
- **Empty `[]`** — the filter matched nothing; broaden `--area`/`--party`, or check
  the value against `parties` / `wahlkreise`.

## Global options

Given **before or after** the command, e.g. `bundeswahl --compact results`:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--log-format <format>` | How errors, warnings and notes are written to stderr: `text` (default; log4j style, `2026-10-09T14:03:12.481Z WARN  [bundeswahl.http] …`) or `jsonl` (one JSON object per line: `ts`, `level`, `topic`, `msg`). stdout is not affected |
| `-o, --output <file>` | Write output to this file instead of stdout (`-` = stdout). Refuses to overwrite an existing file unless `--force` is given; a directory is refused as one (`EISDIR`), with or without `--force` |
| `-f, --force` | With `--output`, overwrite the target file if it already exists |
| `--base-url <url>` | Data host base URL (default `https://www.bundeswahlleiterin.de`; `http:`/`https:` only, no query or fragment, no surrounding whitespace; a literal `%` in a password is written `%25`). A `user:password@` in it is sent as Basic auth and shown as `***@` in every message; echoed back by a server (the `Basic` value, `user:password`, the password), it is shown as `***` |
| `--timeout <ms>` | Time limit per request, reading the whole response included (default `30000`; `0` = none; at most `2147483647`). It bounds each attempt; the waits between retries come on top |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses and reset connections (0..10, default `2`); a refused connection, a DNS failure and a timeout are not retried. Each retry waits 200 ms × attempt, or the server's `Retry-After` (seconds or HTTP-date) when that is longer; a `Retry-After` above 30 s is not retried, and the error names the requested wait |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

A base URL on plain `http:` to a host other than loopback (`localhost`, `127.0.0.0/8`,
`::1`) works, but the CLI writes one `WARN` record of `bundeswahl.http` to stderr before the
first request, e.g. `… WARN  [bundeswahl.http] requests to mirror.example are sent unencrypted (http:, not https:)`,
or `… WARN  [bundeswahl.http] the base URL's credentials are sent unencrypted to mirror.example (http:, not https:)`
when it carries a `user:password@` (never printed). stdout, `-o` files and the exit code
are unchanged.

## Learn more

- **[SKILLS.md](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/blob/main/SKILLS.md)** — Claude Code Agent Skills that drive this CLI.
- **[Usage.md](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/blob/main/Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/blob/main/GLOSSARY.md)** — every domain term explained.
- **[DEVELOPING.md](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/blob/main/DEVELOPING.md)** — TypeScript library usage, the CSV parser, architecture, testing, CI.

## Data license

This CLI is a **client** — it accesses data it does not own or redistribute. The
upstream data is © the Bundeswahlleiterin and licensed **separately from this
tool's code**. See **[DATA_LICENSE.md](DATA_LICENSE.md)**.

> **Bundeswahlleiterin** — the open data is **Datenlizenz Deutschland –
> Namensnennung 2.0**: freely reusable, including commercially, **with
> attribution**. Cite "Quelle: Die Bundeswahlleiterin, Wiesbaden 2025".

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
