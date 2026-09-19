---
name: bundeswahl-reference
description: >
  Look up the German federal election reference data (Bundestagswahl 2025) using
  the bundeswahlleiterin-cli. Trigger when the user asks "which parties stood in the
  2025 Bundestagswahl?", "what does GRÜNE / CDU stand for?", "list the constituencies
  (Wahlkreise) in Bavaria", "which Land is Wahlkreis 5 in?", "how many Wahlkreise are
  there?", or wants the structural data (Strukturdaten — population, area, demographics)
  for a constituency.
compatibility: >
  Requires the `bundeswahl` CLI (npm package
  @maschinenlesbar.org/bundeswahlleiterin-cli) on PATH, installed by the user;
  the skill never installs it. Uses jq for JSON filtering. Network access to
  www.bundeswahlleiterin.de.
---

# Bundeswahl Reference Data

The reference datasets behind the 2025 Bundestagswahl: the parties/groups, the 299
constituencies (Wahlkreise), and the structural data per constituency.

## Tooling

This skill drives the `bundeswahl` command. **Before anything else, validate it is available** — run `command -v bundeswahl` (or `bundeswahl --version`). If it is not on your PATH, STOP and inform the user that the `bundeswahl` CLI (`@maschinenlesbar.org/bundeswahlleiterin-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

**No API key is required** — the data is public open data, licensed **Datenlizenz Deutschland – Namensnennung 2.0**: free to reuse (including commercially) with attribution — cite "Quelle: Die Bundeswahlleiterin, Wiesbaden 2025". Use `--compact` when piping to `jq`.

## Commands

```bash
bundeswahl parties                          # parties / groups (kurz + full name)
bundeswahl wahlkreise [--land <name|abbr|nr>]  # the 299 constituencies
bundeswahl structure [--wahlkreis <nr|name>]   # structural data per Wahlkreis
bundeswahl structure --include-aggregates      # + the official Land/Bund summary rows
```

- **parties** — each has `gruppenschluessel`, `gruppenartCsv` (`Partei` /
  `System-Gruppe` / `Einzelbewerber/Wählergruppe`), `kurz` (short name) and `name`
  (full). Filter out the System-Gruppe totals with `select(.gruppenartCsv=="Partei")`.
- **wahlkreise** — each has `nr`, `name`, and the Land (`landNr`, `landName`,
  `landAbk`). `--land` matches a Land by name substring, abbreviation (`BY`) or
  number (`09`).
- **structure** — each row is a **column→value map**: `Land`, `Wahlkreis-Nr.`,
  `Wahlkreis-Name`, 48 numbered indicator columns (area, population, age structure, …)
  and `Fußnoten`. **Every value is a string** in German number format (`"128,0"`,
  `"20545"`). `--wahlkreis` matches by number (leading zeros ignored) or name substring.

## Recipes

```bash
# Real parties (drop the totals) with their full names
bundeswahl parties | jq -r '.[] | select(.gruppenartCsv=="Partei") | "\(.kurz)\t\(.name)"'

# Constituencies in one Land (use the abbreviation or number when the name is ambiguous)
bundeswahl wahlkreise --land Bayern | jq -r '.[] | "\(.nr)\t\(.name)"'
bundeswahl wahlkreise --land SN | jq -r '.[] | "\(.nr)\t\(.name)"'

# How many Wahlkreise per Land?
bundeswahl wahlkreise | jq -r 'group_by(.landName)[] | "\(.[0].landName): \(length)"'

# Inspect the structural columns available (in file order), then read one
bundeswahl structure --wahlkreis 1 | jq '.[0] | keys_unsorted'

# One indicator as a number, with the footnote that qualifies it
bundeswahl structure --wahlkreis 152 \
  | jq -r '.[0] | "\(.["Wahlkreis-Name"])\t\(.["Arbeitslosenquote November 2024 - insgesamt"] | sub(",";".") | tonumber)\t\(.["Fußnoten"])"'
```

## Traps

- **`parties` includes non-party rows** — the System-Gruppe totals (Wahlberechtigte,
  Wählende, …) and independents. Filter by `gruppenartCsv` when you want only parties.
- **Wahlkreis numbers differ across files:** `wahlkreise`/results use `001`-style
  (leading zeros); Strukturdaten uses `1`. The CLI's `--wahlkreis` ignores leading
  zeros, so pass either.
- **`--land` is a name substring:** `--land Sachsen` returns 54 Wahlkreise from
  Niedersachsen, Sachsen and Sachsen-Anhalt. Use the abbreviation (`SN`) or number
  (`14`), or check `landName` in the output.
- **Strukturdaten column names are long, German, and dated** (e.g. "Bevölkerung am
  31.12.2023 …") — read `keys_unsorted` first rather than guessing a field name.
- **Strukturdaten values are strings with a decimal comma** — convert with
  `sub(",";".") | tonumber` before comparing or sorting (a plain string sort puts
  `"9,5"` above `"10,1"`).
- **Read `Fußnoten` before comparing Wahlkreise.** Where a city forms several
  Wahlkreise (Berlin, Hamburg, München, Köln, Leipzig, …), many columns hold the value
  for the *whole city* (e.g. Leipzig II: "In den Spalten 1 und 7 bis 48 sind die Werte
  für Leipzig insgesamt ausgewiesen"), so those Wahlkreise show identical figures. Some
  Kreise are split the same way (e.g. Wahlkreise 103/104, Kreis Mettmann). "Spalte n"
  is the n-th column after `Wahlkreis-Name` — the file's own `Spalten-Nr.` row confirms
  that numbering. Say so rather than ranking such Wahlkreise against each other.
  > **The footnote's ranges are an upper bound, not a guarantee.** Some columns inside
  > them genuinely differ per Wahlkreis. Berlin's footnote lists "1, 7 bis 14 und 17 bis
  > 48", but across its 12 Wahlkreise Spalten 7, 8 and 17–20 each hold ~10 distinct
  > values, while 1, 9–14 and 33–48 are identical. So the safe test is the data, not the
  > note: before declaring a column city-wide, check whether its values actually repeat
  > across that city's Wahlkreise. (Every column that *is* identical falls inside the
  > footnote's ranges, so the note never lets an identical column through unflagged.)
- Actual vote counts/percentages → the **bundeswahl-results** skill.
- **Cite the source** — "Quelle: Die Bundeswahlleiterin, Wiesbaden 2025".
