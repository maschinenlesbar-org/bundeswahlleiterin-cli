# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `bundeswahl`, eines pro Skill: eine
Anfrage, die `bundeswahl`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `bundeswahl` 0.0.5 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [bundeswahl-reference](#bundeswahl-reference) · [bundeswahl-results](#bundeswahl-results)

## bundeswahl-reference

> Welche Bundestagswahlkreise liegen in Sachsen? Und wie unterscheiden sich Leipzig II und Görlitz in den Strukturdaten?

```bash
bundeswahl --compact wahlkreise --land SN | jq -r '.[] | "\(.nr)\t\(.name)"'
bundeswahl --compact wahlkreise | jq -r 'group_by(.landName)[] | "\(.[0].landName): \(length)"'
bundeswahl --compact wahlkreise --land Sachsen | jq -r 'group_by(.landName)[] | "\(.[0].landName): \(length)"'   # auch Niedersachsen, Sachsen-Anhalt
bundeswahl --compact structure --wahlkreis 152 > s152.json
jq '.[0] | keys_unsorted' s152.json
bundeswahl --compact structure --wahlkreis Görlitz > sgoe.json
```

`--land` vergleicht den Ländernamen als Teilstring, deshalb lieferte `--land Sachsen` auch
Niedersachsen und Sachsen-Anhalt (54 Zeilen). Das Kürzel `SN` ergibt nur die 16 sächsischen.
Die Zeile für Leipzig II trägt in `Fußnoten` den Hinweis: „Die Stadt Leipzig bildet mehrere
Wahlkreise. In den Spalten 1 und 7 bis 48 sind die Werte für Leipzig insgesamt ausgewiesen".
Die Fußnote ist eine Obergrenze: Fläche, Bevölkerung und Dichte (Spalten 2–6) gelten für den
Wahlkreis selbst, ebenso Geburten- und Wanderungssaldo (Spalten 7 und 8), die sich zwischen
Leipzig I und II unterscheiden (Wanderungssaldo 29,7 gegenüber 22,1); die übrigen unten gezeigten
Spalten sind für beide gleich. Die Werte sind Zeichenketten mit Dezimalkomma.

**Sachsen, 16 Wahlkreise (150–165)**: 150 Nordsachsen · 151 Leipzig I · 152 Leipzig II ·
153 Leipzig-Land · 154 Meißen · 155 Bautzen I · 156 Görlitz · 157 Sächsische
Schweiz-Osterzgebirge · 158 Dresden I · 159 Dresden II – Bautzen II · 160 Mittelsachsen ·
161 Chemnitz · 162 Chemnitzer Umland – Erzgebirgskreis II · 163 Erzgebirgskreis I ·
164 Zwickau · 165 Vogtlandkreis. (Bundesweit sind es 299; die meisten hat NRW mit 64, die wenigsten Bremen mit 2.)

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

¹ Wert für die Stadt Leipzig insgesamt (laut Fußnote des Datensatzes).

Quelle: Die Bundeswahlleiterin, Wiesbaden 2025

## bundeswahl-results

> Wer hat bei der Bundestagswahl 2025 den Wahlkreis Görlitz gewonnen, und wie haben sich die Zweitstimmen dort gegenüber 2021 verändert?

```bash
bundeswahl --compact results --area Görlitz --vote 1 --group-type Partei | jq -r 'sort_by(-.anzahl)[0] | "\(.gebietsname): \(.gruppenname)"'   # jq: null (null) cannot be negated
bundeswahl --compact results --area Görlitz --vote 1 --group-type Partei | jq -r 'map(select(.anzahl != null)) | sort_by(-.anzahl)[:3][] | "\(.gruppenname)\t\(.anzahl)\t\(.prozent)\t\(.gewaehlt)"'
bundeswahl --compact results --area Görlitz --vote 2 --group-type Partei | jq -r 'map(select(.prozent != null)) | sort_by(-.prozent)[] | "\(.gruppenname)\t\(.prozent)\t\(.vorpProzent)\t\(.diffProzentPkt)"'
bundeswahl --compact results --area Görlitz --group-type System-Gruppe | jq -r '.[] | select(.gruppenname=="Wählende") | "\(.anzahl)\t\(.prozent)%\t\(.vorpProzent)%"'
bundeswahl --compact results --area-type Land --area 14 --vote 2 --group-type Partei | jq -r 'map(select(.prozent != null)) | sort_by(-.prozent)[:3][] | "\(.gruppenname)\t\(.prozent)"'
bundeswahl --compact results --area-type Bund --vote 2 --party AfD | jq -r '.[] | "\(.prozent)\t\(.vorpProzent)"'
bundeswahl --compact results --area-type Bund --group-type System-Gruppe | jq -r '.[] | select(.gruppenname=="Wählende") | "\(.prozent)%"'
```

Das Direktmandats-Rezept des Skills scheiterte in `jq`. Parteien ohne Direktkandidatur in
Görlitz (ÖDP, Volt, dieBasis, …) kommen mit `anzahl: null` zurück, deshalb wurden diese Zeilen
vor dem Sortieren herausgefiltert. Für den Landesvergleich nutzte der Skill
`--area-type Land --area 14`. Ein Name allein (`--area Sachsen`) trifft auch Sachsen-Anhalt und
Niedersachsen, und ein bloßes `--area 14` trifft zusätzlich Wahlkreis 014.

**Wahlkreis 156 Görlitz (Sachsen), Bundestagswahl 23.02.2025**

Direktmandat (Erststimme): **AfD** mit 75.147 Stimmen (48,9 %), vor CDU mit 37.197 (24,2 %)
und BSW mit 9.832 (6,4 %). Der Datensatz nennt die siegreiche Partei (`gewaehlt: "AfD"`), nicht die Person.

| Zweitstimme | 2025 % | 2021 % | ± Pp. |
|---|---|---|---|
| AfD | 46,7 | 32,5 | +14,1 |
| CDU | 19,8 | 18,3 | +1,5 |
| BSW | 9,0 | – | neu |
| Die Linke | 7,7 | 7,5 | +0,2 |
| SPD | 6,4 | 16,8 | −10,5 |
| GRÜNE | 3,4 | 4,9 | −1,5 |
| FDP | 2,9 | 10,0 | −7,0 |
| FREIE WÄHLER | 1,5 | 2,4 | −0,9 |
| … 7 weitere, alle unter 1,3 % | | | |

Wahlbeteiligung: 155.057 von 196.873 Wahlberechtigten, **78,8 %** (2021: 75,0 %; bundesweit 82,5 %).
Zum Vergleich: Die AfD erreichte bei den Zweitstimmen in Sachsen 37,3 % und bundesweit 20,8 % (2021: 10,4 %).

Quelle: Die Bundeswahlleiterin, Wiesbaden 2025
