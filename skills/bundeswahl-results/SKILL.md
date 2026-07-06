---
name: bundeswahl-results
description: >
  Look up official German federal election (Bundestagswahl 2025) results using the
  bundeswahlleiterin-cli. Trigger when the user asks "who won the Bundestagswahl
  2025?", "what was the SPD/CDU/GRÜNE second-vote share?", "who won the direct
  mandate in a constituency?", "election result for Bavaria / a Wahlkreis", "how
  high was turnout?", or wants first- or second-vote counts and percentages by
  Bund, Land or Wahlkreis, optionally filtered by party.
version: 1.0.0
userInvocable: true
---

# Bundeswahl Results

The Bundeswahlleiterin (Federal Returning Officer) publishes the official final
result of the 2025 Bundestagswahl as open data. This skill queries it by area,
party and ballot.

## Tooling

This skill drives the `bundeswahl` command. **Before anything else, validate it is available** — run `command -v bundeswahl` (or `bundeswahl --version`). If it is not on your PATH, STOP and inform the user that the `bundeswahl` CLI (`@maschinenlesbar.org/bundeswahlleiterin-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required** — the data is public open data, licensed **Datenlizenz Deutschland – Namensnennung 2.0**: free to reuse (including commercially) with attribution — cite "Quelle: Die Bundeswahlleiterin, Wiesbaden 2025". Use `--compact` when piping to `jq`.

## Command

```bash
bundeswahl results [--area-type Bund|Land|Wahlkreis] [--area <nr-or-name>] \
                   [--party <name>] [--vote 1|2] [--group-type <type>]
```

Each row is one **area × group × ballot** with `anzahl` (count, an integer),
`prozent` (share, a number), the previous-election comparison, and `gewaehlt` (the
constituency's direct-mandate winner). `stimme` is `1` (Erststimme) or `2`
(Zweitstimme); `null` for System-Gruppe totals.

## Filters

- `--area-type` — `Bund` (national), `Land` (a state), `Wahlkreis` (a constituency).
- `--area` — an area by **exact number** (`005`, `09`) or **name substring** (`Kiel`).
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

# Direct-mandate winner of a constituency
bundeswahl results --area "Kiel" --vote 1 --group-type Partei \
  | jq -r 'sort_by(-.anzahl)[0] | "\(.gebietsname): \(.gruppenname)"'

# Turnout (Wählende) nationally
bundeswahl results --area-type Bund --group-type System-Gruppe \
  | jq -r '.[] | select(.gruppenname=="Wählende") | "\(.prozent)%"'
```

## Traps

- **Erststimme (1) vs Zweitstimme (2).** The "result" people usually mean is the
  **Zweitstimme** (party-list share). The Erststimme decides the direct mandate.
  Always set `--vote` (or expect both).
- **System-Gruppe rows are totals, not parties** (`Wahlberechtigte`, `Wählende`,
  `Gültige/Ungültige Stimmen`) and have `stimme: null` — exclude them with
  `--group-type Partei` unless you want turnout numbers.
- **`gewaehlt` is the Wahlkreis winner**, repeated on every row of that
  constituency — not a per-row flag.
- **`prozent` can be `null`** (empty/`–` cell) — guard in `jq` before arithmetic.
- Parties, constituencies and structural data → the **bundeswahl-reference** skill.
- **Cite the source** — "Quelle: Die Bundeswahlleiterin, Wiesbaden 2025".
