---
name: bundeswahl-results
description: >
  Look up official German federal election (Bundestagswahl 2025) results using the
  bundeswahlleiterin-cli. Trigger when the user asks "who won the Bundestagswahl
  2025?", "what was the SPD/CDU/GRÜNE second-vote share?", "which party won the
  direct mandate in a constituency?", "election result for Bavaria / a Wahlkreis", "how
  high was turnout?", or wants first- or second-vote counts and percentages by
  Bund, Land or Wahlkreis, optionally filtered by party.
compatibility: >
  Requires the `bundeswahl` CLI (npm package
  @maschinenlesbar.org/bundeswahlleiterin-cli) on PATH, installed by the user;
  the skill never installs it. Uses jq for JSON filtering. Network access to
  www.bundeswahlleiterin.de.
---

# Bundeswahl Results

The Bundeswahlleiterin (Federal Returning Officer) publishes the official final
result of the 2025 Bundestagswahl as open data. This skill queries it by area,
party and ballot.

## Tooling

This skill drives the `bundeswahl` command. **Before anything else, validate it is available** — run `command -v bundeswahl` (or `bundeswahl --version`). If it is not on your PATH, STOP and inform the user that the `bundeswahl` CLI (`@maschinenlesbar.org/bundeswahlleiterin-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

**No API key is required** — the data is public open data, licensed **Datenlizenz Deutschland – Namensnennung 2.0**: free to reuse (including commercially) with attribution — cite "Quelle: Die Bundeswahlleiterin, Wiesbaden 2025". Use `--compact` when piping to `jq`.

## Command

```bash
bundeswahl results [--area-type Bund|Land|Wahlkreis] [--area <nr-or-name>] \
                   [--party <name>] [--vote 1|2] [--group-type <type>]
```

Each row is one **area × group × ballot** with `anzahl` (count, an integer),
`prozent` (share, a number), the previous-election comparison, and `gewaehlt` (the
party whose Wahlkreis candidate was elected, or `–`). `stimme` is `1` (Erststimme)
or `2` (Zweitstimme); `null` only for the `Wahlberechtigte` and `Wählende` rows.

## Filters

- `--area-type` — `Bund` (national), `Land` (a state), `Wahlkreis` (a constituency).
- `--area` — an area by **number** (leading zeros ignored) or **name substring**
  (`Kiel`). **Always pair it with `--area-type`:** Land and Wahlkreis numbers overlap
  (`--area 14` returns Land 14 Sachsen *and* Wahlkreis 014; `001` returns Land 01 and
  Wahlkreis 001), and names match as substrings (`Sachsen` also matches Niedersachsen
  and Sachsen-Anhalt; `Frankfurt am Main I` also matches `… II`). Check `gebietsname`
  in the output, and prefer the number for a Wahlkreis.
- `--party` — party/group **name substring**, case-insensitive (`SPD`, `grüne`).
- `--vote` — `1`/`erst` = Erststimme (candidate), `2`/`zweit` = Zweitstimme (list).
- `--group-type` — `Partei`, `System-Gruppe` (totals), `Einzelbewerber/Wählergruppe`.

## Recipes

```bash
# National second-vote result, sorted (the headline "who won")
bundeswahl results --area-type Bund --vote 2 --group-type Partei \
  | jq -r 'sort_by(-.prozent)[] | "\(.gruppenname)\t\(.prozent)%"'

# One party across the Länder (second vote)
bundeswahl results --area-type Land --vote 2 --party CDU \
  | jq -r '.[] | "\(.gebietsname)\t\(.prozent)%"'

# Erststimme winner of a constituency, and whether that seat was allocated
bundeswahl results --area-type Wahlkreis --area 005 --vote 1 \
  | jq -r 'map(select(.gruppenart != "System-Gruppe" and .anzahl != null)) | sort_by(-.anzahl)[0]
      | "\(.gebietsname): \(.gruppenname) \(.prozent)% · gewaehlt: \(.gewaehlt)"'

# Wahlkreise whose Erststimme winner got no seat (gewaehlt is "–")
bundeswahl results --area-type Wahlkreis --vote 1 \
  | jq -r 'group_by(.gebietsnummer)[] | select(.[0].gewaehlt == "–")
      | (map(select(.gruppenart != "System-Gruppe" and .anzahl != null)) | sort_by(-.anzahl)[0])
      | "\(.gebietsnummer) \(.gebietsname)\t\(.gruppenname)"'

# Turnout (Wählende) nationally
bundeswahl results --area-type Bund --group-type System-Gruppe \
  | jq -r '.[] | select(.gruppenname=="Wählende") | "\(.prozent)%"'
```

## Traps

- **Erststimme (1) vs Zweitstimme (2).** The "result" people usually mean is the
  **Zweitstimme** (party-list share). The Erststimme decides the direct mandate.
  Always set `--vote` (or expect both).
- **System-Gruppe rows are totals, not parties**: `Wahlberechtigte` and `Wählende`
  (`stimme: null`), and `Gültige`, `Ungültige` and `Übrige`, which come per ballot
  (`stimme` 1 and 2; `Übrige` has only previous-election values). Exclude them with
  `--group-type Partei` unless you want turnout numbers — a `--vote` filter alone
  keeps `Gültige`/`Ungültige`/`Übrige`.
- **`anzahl` and `prozent` can be `null`** — an area lists parties that had no
  candidate (Erststimme) or no list (Zweitstimme) there, with `anzahl: null`; every
  Wahlkreis has such rows. `sort_by(-.anzahl)` then fails (`null (null) cannot be
  negated`): drop nulls first (`map(select(.anzahl != null))`) before sorting or
  arithmetic.
- **`gewaehlt` is not simply the Erststimme winner.** It names the *party* whose
  Wahlkreis candidate was elected, repeated on every row of that constituency (empty
  on Bund/Land rows). Under the 2025 electoral law a Wahlkreis winner only gets the
  seat if the party's Zweitstimmen cover it; where they don't, `gewaehlt` is `–` and
  no one was elected directly (23 Wahlkreise, e.g. 001 Flensburg – Schleswig). Report
  the top Erststimme party *and* `gewaehlt`.
- **No candidate names.** The data names parties only; say so if asked who the
  person is.
- Parties, constituencies and structural data → the **bundeswahl-reference** skill.
- **Cite the source** — "Quelle: Die Bundeswahlleiterin, Wiesbaden 2025".
