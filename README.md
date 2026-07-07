# bundeswahlleiterin-cli

[![CI](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/bundeswahlleiterin-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/bundeswahlleiterin-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/bundeswahlleiterin-cli)

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
> with zero dependencies? See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/bundeswahlleiterin-cli
```

This installs the **`bundeswahl`** command. Requires **Node.js 20+**. No API key.

Check it works:

```bash
bundeswahl results --area-type Bund --vote 2 --group-type Partei | jq '.[] | {party: .gruppenname, pct: .prozent}'
```

## Quickstart

```bash
# National second-vote (Zweitstimme) result for one party
bundeswahl results --area-type Bund --vote 2 --party SPD

# Who won the direct mandate (Erststimme) in Kiel, and by how much?
bundeswahl results --area Kiel --vote 1 --group-type Partei \
  | jq -r 'sort_by(-.anzahl)[] | "\(.gruppenname)\t\(.anzahl)\t\(.prozent)%"'

# The 299 constituencies in Bavaria
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
| `structure` | Structural data (Strukturdaten) per Wahlkreis (`--wahlkreis <nr\|name>`) |

New to terms like *Wahlkreis*, *Erststimme/Zweitstimme*, *kerg2*, *Gebietsart* or
*Gruppenart*? The **[Glossary](GLOSSARY.md)** decodes every one.

### `results` filters

| Option | Meaning |
| --- | --- |
| `--area-type <level>` | `Bund` \| `Land` \| `Wahlkreis` |
| `--area <nr-or-name>` | an area by exact number (`005`, `09`) or name substring (`Kiel`) |
| `--party <name>` | a party/group by name substring (`SPD`, `GRÜNE`), case-insensitive |
| `--vote <1\|2>` | `1`/`erst` = Erststimme, `2`/`zweit` = Zweitstimme |
| `--group-type <type>` | a `Gruppenart` — `Partei`, `System-Gruppe`, `Einzelbewerber/Wählergruppe` |

Filters apply client-side (each command fetches the whole dataset), so they compose
and an unmatched filter yields `[]`.

## Output & scripting

Every command prints **JSON to stdout**; diagnostics go to stderr, so piping into
`jq` stays clean. Counts (`anzahl`) are integers and shares (`prozent`) are numbers;
empty/placeholder cells are `null`.

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
| `0` | Success (also `--help` / `--version`) |
| `2` | Bad usage / invalid argument (nothing was sent) |
| `4` | Not found (`404` — a data file moved) |
| `6` | Network / transport failure (DNS, connection, timeout, size cap) |
| `1` | Any other error — including a non-CSV response (an HTML page instead of the file) |

## Troubleshooting

- **`command not found: bundeswahl`** — the global npm bin directory isn't on your
  `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/bundeswahlleiterin-cli …`.
- **Exit `4` / "not found"** — a data file moved. The Bundeswahlleiterin open-data
  URLs (some behind `dam/jcr` identifiers) are pinned in the client; if the section
  is reorganised, a path needs updating.
- **Exit `1` / "received an HTML page"** — the request returned an HTML page instead
  of a CSV (a moved file, or a custom `--base-url`).
- **Empty `[]`** — the filter matched nothing; broaden `--area`/`--party`, or check
  the value against `parties` / `wahlkreise`.

## Global options

Given **before or after** the command, e.g. `bundeswahl --compact results`:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-o, --output <file>` | Write output to this file instead of stdout. Refuses to overwrite an existing file unless `--force` is given |
| `-f, --force` | With `--output`, overwrite the target file if it already exists |
| `--base-url <url>` | Data host base URL (default `https://www.bundeswahlleiterin.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (0..10, default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills that drive this CLI.
- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every domain term explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, the CSV parser, architecture, testing, CI.

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
