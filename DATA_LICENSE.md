# Data license

> **This tool does not include, host, or redistribute any data.**
> `bundeswahlleiterin-cli` is a *client*. It fetches open-data files served live by
> the **Bundeswahlleiterin** (the German Federal Returning Officer). That data is
> the Bundeswahlleiterin's and is governed by **their** licence, summarized below.
> The licence of this CLI's own source code is a separate matter — see
> [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Die Bundeswahlleiterin, Wiesbaden |
| **Source** | `https://www.bundeswahlleiterin.de` open data (Bundestagswahl 2025 results, parties, Wahlkreise, Strukturdaten) · [opendata page](https://www.bundeswahlleiterin.de/bundestagswahlen/2025/ergebnisse/opendata.html) |
| **Data licence** | **Datenlizenz Deutschland – Namensnennung – Version 2.0** ([dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0)) — an **open** licence. |
| **What that allows** | Copy, distribute, adapt and combine the data, including **commercially**, provided you give attribution. |
| **Attribution** | **Required.** Name the source (**"Die Bundeswahlleiterin, Wiesbaden"**, ideally with the year and a link) and, if you change the data, note that. |

## The "Namensnennung" requirement (dl-de/by-2.0)

The licence permits free reuse — including commercial use and redistribution — on
one condition: **name the source**. The recommended attribution is the source
note carried in each file, e.g.:

> Quelle: Die Bundeswahlleiterin, Wiesbaden 2025

If you modify the data (e.g. reshape or recompute), the licence asks you to
indicate that a change was made. Each CSV also embeds this notice in its first
lines; `bundeswahl` drops that preamble when parsing, so **carry the attribution
yourself** when you publish results.

## Notes & caveats

- This CLI targets the **Bundestagswahl 2025** open-data files. Their exact URLs
  (some behind opaque `dam/jcr` identifiers) are pinned in the client; if the
  Bundeswahlleiterin reorganises the open-data section, a path may need updating.
- The data is the **official final result** ("Amtliches Endergebnis"), but no
  warranty of accuracy, completeness or availability is given — verify against the
  source for anything critical.

## Sources

- https://www.bundeswahlleiterin.de/bundestagswahlen/2025/ergebnisse/opendata.html — Open Data
- https://www.govdata.de/dl-de/by-2-0 — Datenlizenz Deutschland – Namensnennung – Version 2.0

---

*Good-faith summary compiled 2026-07-06; not legal advice. The provider's terms
are authoritative and can change — verify at the source before relying on the
data.*
