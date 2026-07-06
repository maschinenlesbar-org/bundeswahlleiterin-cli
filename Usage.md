# Usage

`bundeswahl` — a CLI for the Bundeswahlleiterin open data (Bundestagswahl 2025).
This is the use-case-driven cookbook; for the option reference see the
**[README](README.md)**, and for domain terms the **[Glossary](GLOSSARY.md)**.
No API key is required.

```bash
bundeswahl [global options] <command> [command options]
```

## Global options

| Option | Description |
|---|---|
| `--base-url <url>` | data host base URL (only `http:`/`https:` accepted) |
| `--timeout <ms>` | per-request timeout in ms (0 = no timeout) |
| `--user-agent <ua>` | User-Agent header value |
| `--max-retries <n>` | retries for transient 429/503 responses (0..10) |
| `--max-response-bytes <n>` | cap the response body size in bytes (0 = unlimited; default 100 MiB) |
| `--compact` | print JSON on a single line (for piping to `jq`) |
| `-o, --output <file>` | write output to a file instead of stdout |
| `-V, --version` / `-h, --help` | version / help |

## `results` — the election result

```bash
bundeswahl results [--area-type <Bund|Land|Wahlkreis>] [--area <nr-or-name>] \
                   [--party <name>] [--vote <1|2>] [--group-type <type>]
```

Each row is one **area × group × ballot**:

```json
{
  "gebietsart": "Bund", "gebietsnummer": "99", "gebietsname": "Bundesgebiet",
  "gruppenart": "Partei", "gruppenname": "GRÜNE", "stimme": 2,
  "anzahl": 5762380, "prozent": 11.606116, "diffProzentPkt": -3.112341,
  "gewaehlt": ""
}
```

```bash
# National second-vote shares, sorted (the headline result)
bundeswahl results --area-type Bund --vote 2 --group-type Partei \
  | jq -r 'sort_by(-.prozent)[] | "\(.gruppenname)\t\(.prozent)%"'

# One party across all Länder (second vote)
bundeswahl results --area-type Land --vote 2 --party CDU \
  | jq -r '.[] | "\(.gebietsname)\t\(.prozent)%"'

# Who won the direct mandate in a constituency?
bundeswahl results --area "Flensburg" --vote 1 --group-type Partei \
  | jq -r 'sort_by(-.anzahl)[0] | "\(.gebietsname): \(.gruppenname)"'

# Turnout (Wählende) nationally
bundeswahl results --area-type Bund --group-type System-Gruppe \
  | jq -r '.[] | select(.gruppenname=="Wählende") | "\(.prozent)%"'
```

> `--area` matches an area by **exact number** (`005`, `09`) **or name substring**
> (`Kiel`). `--party` / `--group-type` are case-insensitive substrings. `--vote`
> accepts `1`/`erst` and `2`/`zweit`.

## `parties` — the parties / groups

```bash
bundeswahl parties
```

Returns every group in the results (parties, independents, and the System-Gruppe
totals) with `gruppenschluessel`, `kurz` (short name) and full `name`.

```bash
# Just the real parties (drop the System-Gruppe totals)
bundeswahl parties | jq -r '.[] | select(.gruppenartCsv=="Partei") | "\(.kurz)\t\(.name)"'
```

## `wahlkreise` — the 299 constituencies

```bash
bundeswahl wahlkreise                 # all 299
bundeswahl wahlkreise --land Bayern   # by Land name…
bundeswahl wahlkreise --land BY       # …abbreviation…
bundeswahl wahlkreise --land 09       # …or number
```

Each carries `nr`, `name`, and the Land (`landNr`, `landName`, `landAbk`).

## `structure` — structural data per Wahlkreis

```bash
bundeswahl structure                       # all 299 Wahlkreise
bundeswahl structure --wahlkreis 5         # one, by number (leading zeros ignored)
bundeswahl structure --wahlkreis "Kiel"    # or by name substring
```

Each row is a **column→value map** of ~50 demographic/economic indicators (the
Strukturdaten column names are long and German — inspect the keys):

```bash
bundeswahl structure --wahlkreis 1 | jq 'keys'
```

## Scripting recipes

```bash
# CSV of national second-vote shares
bundeswahl results --area-type Bund --vote 2 --group-type Partei \
  | jq -r '.[] | [.gruppenname, .anzahl, .prozent] | @csv'

# Save the full result set to disk (stdout stays clean; a note goes to stderr)
bundeswahl --output btw2025.json results

# All direct-mandate winners, one per Wahlkreis
bundeswahl results --area-type Wahlkreis --vote 1 --group-type Partei \
  | jq -r 'group_by(.gebietsnummer)[] | .[0] | "\(.gebietsname)\t\(.gewaehlt)"'
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (help/version included); an empty filter also exits 0 |
| `1` | a runtime error — including a non-CSV response (an HTML page instead of the file) |
| `2` | usage error (bad flag, unknown command, bad `--base-url`, bad `--area-type`/`--vote`) |
| `4` | HTTP 404 (a data file moved) |
| `6` | network / transport failure (DNS, connection, timeout, response size-cap) |

## Notes

- **Cite the source.** The data is Datenlizenz Deutschland – Namensnennung 2.0:
  free to reuse (incl. commercially) **with attribution** — "Quelle: Die
  Bundeswahlleiterin, Wiesbaden 2025". See [DATA_LICENSE.md](DATA_LICENSE.md).
- **`stimme` is `null` for System-Gruppe rows** (turnout totals) — they aren't a
  ballot; guard for it when filtering by vote in `jq`.
- **Numbers are numbers, gaps are `null`.** `anzahl`/`prozent` parse from the German
  format; empty or `–` cells become `null`, distinct from `0`.
