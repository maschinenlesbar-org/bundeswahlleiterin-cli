# Examples

Real examples for the Claude Code skills of the `bundeswahl` plugin, one per skill: a request,
the `bundeswahl` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `bundeswahl` 0.0.5.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [bundeswahl-reference](#bundeswahl-reference) · [bundeswahl-results](#bundeswahl-results)

## bundeswahl-reference

> Which Bundestag constituencies are in Saxony? And how do Leipzig II and Görlitz compare structurally?

```bash
bundeswahl --compact wahlkreise --land SN | jq -r '.[] | "\(.nr)\t\(.name)"'
bundeswahl --compact wahlkreise | jq -r 'group_by(.landName)[] | "\(.[0].landName): \(length)"'
bundeswahl --compact wahlkreise --land Sachsen | jq -r 'group_by(.landName)[] | "\(.[0].landName): \(length)"'   # also Niedersachsen, Sachsen-Anhalt
bundeswahl --compact structure --wahlkreis 152 > s152.json
jq '.[0] | keys_unsorted' s152.json
bundeswahl --compact structure --wahlkreis Görlitz > sgoe.json
```

`--land` matches the Land name as a substring, so `--land Sachsen` also returned Niedersachsen
and Sachsen-Anhalt (54 rows). The abbreviation `SN` gives only Saxony's 16. The Leipzig II row
carries a `Fußnoten` value: "Die Stadt Leipzig bildet mehrere Wahlkreise. In den Spalten 1 und
7 bis 48 sind die Werte für Leipzig insgesamt ausgewiesen". The footnote is an upper bound:
area, population and density (columns 2–6) are specific to the constituency, and so are the
birth and migration balances (columns 7 and 8), which differ between Leipzig I and II (migration
29,7 vs 22,1); the other columns shown below are the same for both. Values are strings with a
decimal comma.

**Sachsen, 16 Wahlkreise (150–165)**: 150 Nordsachsen · 151 Leipzig I · 152 Leipzig II ·
153 Leipzig-Land · 154 Meißen · 155 Bautzen I · 156 Görlitz · 157 Sächsische
Schweiz-Osterzgebirge · 158 Dresden I · 159 Dresden II – Bautzen II · 160 Mittelsachsen ·
161 Chemnitz · 162 Chemnitzer Umland – Erzgebirgskreis II · 163 Erzgebirgskreis I ·
164 Zwickau · 165 Vogtlandkreis. (Germany has 299 in total; NRW has the most with 64, Bremen the fewest with 2.)

| Strukturdaten | 152 Leipzig II | 156 Görlitz |
|---|---|---|
| Gemeinden (31.12.2023) | 1 ¹ | 53 |
| Fläche (km²) | 128,0 | 2111,4 |
| Bevölkerung (in 1000) | 305,9 | 245,9 |
| Ausländer/-innen (%) | 15,4 | 6,9 |
| Bevölkerungsdichte (EW je km²) | 2389,5 | 116,4 |
| Wanderungssaldo 2022 (je 1000 EW) | 22,1 | 16,9 |
| Alter 75 und mehr (%) | 10,6 ¹ | 15,5 |
| PKW mit Elektro- oder Hybrid-Antrieb (%) | 7,3 ¹ | 3,7 |
| Verfügbares Einkommen 2021 (EUR je EW) | 20545 ¹ | 21037 |
| Bruttoinlandsprodukt 2021 (EUR je EW) | 39695 ¹ | 30745 |
| Arbeitslosenquote Nov. 2024 (%) | 7,9 ¹ | 8,6 |

¹ Value for the city of Leipzig as a whole (per the dataset's footnote).

Quelle: Die Bundeswahlleiterin, Wiesbaden 2025

## bundeswahl-results

> Who won the Görlitz constituency in the 2025 Bundestagswahl, and how did the second vote change there compared with 2021?

```bash
bundeswahl --compact results --area Görlitz --vote 1 --group-type Partei | jq -r 'sort_by(-.anzahl)[0] | "\(.gebietsname): \(.gruppenname)"'   # jq: null (null) cannot be negated
bundeswahl --compact results --area Görlitz --vote 1 --group-type Partei | jq -r 'map(select(.anzahl != null)) | sort_by(-.anzahl)[:3][] | "\(.gruppenname)\t\(.anzahl)\t\(.prozent)\t\(.gewaehlt)"'
bundeswahl --compact results --area Görlitz --vote 2 --group-type Partei | jq -r 'map(select(.prozent != null)) | sort_by(-.prozent)[] | "\(.gruppenname)\t\(.prozent)\t\(.vorpProzent)\t\(.diffProzentPkt)"'
bundeswahl --compact results --area Görlitz --group-type System-Gruppe | jq -r '.[] | select(.gruppenname=="Wählende") | "\(.anzahl)\t\(.prozent)%\t\(.vorpProzent)%"'
bundeswahl --compact results --area-type Land --area 14 --vote 2 --group-type Partei | jq -r 'map(select(.prozent != null)) | sort_by(-.prozent)[:3][] | "\(.gruppenname)\t\(.prozent)"'
bundeswahl --compact results --area-type Bund --vote 2 --party AfD | jq -r '.[] | "\(.prozent)\t\(.vorpProzent)"'
bundeswahl --compact results --area-type Bund --group-type System-Gruppe | jq -r '.[] | select(.gruppenname=="Wählende") | "\(.prozent)%"'
```

The skill's direct-mandate recipe crashed in `jq`. Parties that fielded no candidate in Görlitz
(ÖDP, Volt, dieBasis, …) come back with `anzahl: null`, so the rows were filtered before sorting.
For the Land comparison the skill used `--area-type Land --area 14`. A name alone
(`--area Sachsen`) also matches Sachsen-Anhalt and Niedersachsen, and a bare `--area 14`
also matches Wahlkreis 014.

**Wahlkreis 156 Görlitz (Sachsen), Bundestagswahl 23.02.2025**

Direct mandate (Erststimme): **AfD**, 75,147 votes (48.9 %), ahead of CDU 37,197 (24.2 %)
and BSW 9,832 (6.4 %). The dataset names the winning party (`gewaehlt: "AfD"`), not the candidate.

| Zweitstimme | 2025 % | 2021 % | ± pp |
|---|---|---|---|
| AfD | 46.7 | 32.5 | +14.1 |
| CDU | 19.8 | 18.3 | +1.5 |
| BSW | 9.0 | – | new |
| Die Linke | 7.7 | 7.5 | +0.2 |
| SPD | 6.4 | 16.8 | −10.5 |
| GRÜNE | 3.4 | 4.9 | −1.5 |
| FDP | 2.9 | 10.0 | −7.0 |
| FREIE WÄHLER | 1.5 | 2.4 | −0.9 |
| … 7 more, all below 1.3 % | | | |

Turnout: 155,057 of 196,873 eligible voters, **78.8 %** (2021: 75.0 %; nationally 82.5 %).
For context, the AfD's Zweitstimme share was 37.3 % in Sachsen and 20.8 % nationally (2021: 10.4 %).

Quelle: Die Bundeswahlleiterin, Wiesbaden 2025
