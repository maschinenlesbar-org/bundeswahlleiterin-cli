---
name: bundeswahl-reference
description: >
  Look up the German federal election reference data (Bundestagswahl 2025) using
  the bundeswahlleiterin-cli. Trigger when the user asks "which parties stood in the
  2025 Bundestagswahl?", "what does GRÜNE / CDU stand for?", "list the constituencies
  (Wahlkreise) in Bavaria", "which Land is Wahlkreis 5 in?", "how many Wahlkreise are
  there?", or wants the structural data (Strukturdaten — population, area, demographics)
  for a constituency.
version: 1.0.0
userInvocable: true
---

# Bundeswahl Reference Data

The reference datasets behind the 2025 Bundestagswahl: the parties/groups, the 299
constituencies (Wahlkreise), and the structural data per constituency.

## Tooling

This skill drives the `bundeswahl` command. **Before anything else, validate it is available** — run `command -v bundeswahl` (or `bundeswahl --version`). If it is not on your PATH, STOP and inform the user that the `bundeswahl` CLI (`@maschinenlesbar.org/bundeswahlleiterin-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

**No API key is required** — the data is public open data, licensed **Datenlizenz Deutschland – Namensnennung 2.0**: free to reuse (including commercially) with attribution — cite "Quelle: Die Bundeswahlleiterin, Wiesbaden 2025". Use `--compact` when piping to `jq`.

## Commands

```bash
bundeswahl parties                          # parties / groups (kurz + full name)
bundeswahl wahlkreise [--land <name|abbr|nr>]  # the 299 constituencies
bundeswahl structure [--wahlkreis <nr|name>]   # structural data per Wahlkreis
```

- **parties** — each has `gruppenschluessel`, `gruppenartCsv` (`Partei` /
  `System-Gruppe` / `Einzelbewerber/Wählergruppe`), `kurz` (short name) and `name`
  (full). Filter out the System-Gruppe totals with `select(.gruppenartCsv=="Partei")`.
- **wahlkreise** — each has `nr`, `name`, and the Land (`landNr`, `landName`,
  `landAbk`). `--land` matches a Land by name substring, abbreviation (`BY`) or
  number (`09`).
- **structure** — each row is a **column→value map** of ~50 German-named columns
  (`Wahlkreis-Nr.`, `Wahlkreis-Name`, area, population, age structure, …). `--wahlkreis`
  matches by number (leading zeros ignored) or name substring.

## Recipes

```bash
# Real parties (drop the totals) with their full names
bundeswahl parties | jq -r '.[] | select(.gruppenartCsv=="Partei") | "\(.kurz)\t\(.name)"'

# Constituencies in one Land
bundeswahl wahlkreise --land Bayern | jq -r '.[] | "\(.nr)\t\(.name)"'

# How many Wahlkreise per Land?
bundeswahl wahlkreise | jq -r 'group_by(.landName)[] | "\(.[0].landName): \(length)"'

# Inspect the structural columns available, then read one
bundeswahl structure --wahlkreis 1 | jq 'keys'
```

## Traps

- **`parties` includes non-party rows** — the System-Gruppe totals (Wahlberechtigte,
  Wählende, …) and independents. Filter by `gruppenartCsv` when you want only parties.
- **Wahlkreis numbers differ across files:** `wahlkreise`/results use `001`-style
  (leading zeros); Strukturdaten uses `1`. The CLI's `--wahlkreis` ignores leading
  zeros, so pass either.
- **Strukturdaten column names are long, German, and dated** (e.g. "Bevölkerung am
  31.12.2023 …") — read `keys` first rather than guessing a field name.
- Actual vote counts/percentages → the **bundeswahl-results** skill.
- **Cite the source** — "Quelle: Die Bundeswahlleiterin, Wiesbaden 2025".
