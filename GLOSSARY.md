# Glossary

Domain and technical terms you meet when using `bundeswahl`. For the option
reference see the **[README](README.md)** and the full cookbook in
**[Usage.md](Usage.md)**.

## The election

**Bundeswahlleiterin.** The Federal Returning Officer — the independent official
who organises federal elections and certifies their results. Publishes the
official results and reference data as **open data**.

**Bundestagswahl (BTW).** The election to the **Bundestag**, Germany's federal
parliament. This CLI covers the **2025** election (`Wahltag` 23.02.2025). `Wahlart`
`BT` marks Bundestag rows.

**Amtliches Endergebnis.** The *official final result* — the certified numbers (as
opposed to preliminary election-night counts). The `results` data is this.

## Areas

**Gebiet / Gebietsart.** An electoral **area** and its **level**. Three levels:
- **Bund** — the whole federal territory (`Gebietsnummer` 99).
- **Land** — a federal state (`01`–`16`).
- **Wahlkreis** — a constituency (`001`–`299`).

Each result row names its area (`gebietsart`, `gebietsnummer`, `gebietsname`) and,
for a Wahlkreis, its parent Land (`ueGebietsart`/`ueGebietsnummer`).

**Wahlkreis.** A **constituency** — one of the **299** districts, each electing one
member directly (Erststimme). `wahlkreise` lists them with their Land.

**Land / Länder.** A German federal state (16 in total).

## Votes

**Erststimme (Stimme 1).** The **first vote** — for a *candidate* in your Wahlkreis;
the candidate with the most first votes wins the constituency's **direct mandate**.

**Zweitstimme (Stimme 2).** The **second vote** — for a party *list*; this vote
decides each party's overall share of seats. Usually the number people mean by "the
result".

In the data, `stimme` is `1` or `2`; **System-Gruppe** rows (turnout totals) have no
ballot (`null`).

## Groups & results

**Gruppe / Gruppenart.** A **group** in a result row and its **kind**:
- **Partei** — a political party (SPD, CDU, GRÜNE, …).
- **Einzelbewerber/Wählergruppe** — an independent candidate or voter group.
- **System-Gruppe** — a **total**, not a contestant: `Wahlberechtigte` (eligible
  voters), `Wählende` (turnout), `Ungültige`/`Gültige Stimmen` (invalid/valid votes).

**kerg2.** The Bundeswahlleiterin's **normalized results file** ("Ergebnisse nach
Wahlkreisen"), the source for `results`. It is *long/tidy*: **one row per area ×
group × ballot**, so each party has separate first- and second-vote rows, and each
row carries the count (`anzahl`), share (`prozent`), and the comparison to the
previous election (`vorpAnzahl`, `diffProzentPkt`, …). (The `kerg.csv` file holds
the same data in a hard-to-parse wide layout; this CLI uses `kerg2`.)

**Gewählt.** The name of the party that **won the constituency's direct mandate**
(Erststimme). It repeats on every row of a Wahlkreis (e.g. `"GRÜNE"`), and is empty
for Bund/Land rows.

**Strukturdaten.** **Structural data** per Wahlkreis — ~50 demographic and economic
indicators (area, population, age structure, employment, …), published so results
can be read in context. `structure` returns each Wahlkreis as a column→value map.

## Data & format

**Datenlizenz Deutschland – Namensnennung 2.0 (dl-de/by-2.0).** The **open licence**
on the data: free to copy, adapt and reuse, including commercially, **with
attribution** ("Quelle: Die Bundeswahlleiterin, Wiesbaden 2025"). See
[DATA_LICENSE.md](DATA_LICENSE.md).

**CSV quirks.** The files are **semicolon-delimited**, **UTF-8 with a BOM**, use
**German decimals** (comma, e.g. `82,5122`), and start with a multi-line
human-readable **preamble** before the header row. `bundeswahl` handles all of this;
counts/percentages reach you as JSON numbers, `null` for empty/`–` cells.

## CLI / technical

**Exit codes.** `0` success · `2` usage error · `4` not found · `6` network
failure · `1` other (incl. a non-CSV/HTML response). See
[Usage.md](Usage.md#exit-codes).

**Filters are client-side.** Each command downloads the whole dataset and filters in
memory, so filters compose and an unmatched filter returns `[]` (not everything).
