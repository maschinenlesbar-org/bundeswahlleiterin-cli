# Glossar

Fach- und Technikbegriffe, die Ihnen bei der Arbeit mit `bundeswahl` begegnen. Die
Referenz der Optionen finden Sie im **[README](README.md)**, die vollständige
Rezeptsammlung in **[Usage.md](Usage.md)** (beide englisch).

## Die Wahl

**Bundeswahlleiterin.** Die unabhängige Amtsträgerin, die Wahlen auf Bundesebene
organisiert und ihre Ergebnisse feststellt. Sie veröffentlicht die amtlichen Ergebnisse
und Referenzdaten als **Open Data**.

**Bundestagswahl (BTW).** Die Wahl zum Deutschen **Bundestag**. Diese CLI deckt die Wahl
**2025** ab (`Wahltag` 23.02.2025). `Wahlart` `BT` kennzeichnet Zeilen zur
Bundestagswahl.

**Amtliches Endergebnis.** Die festgestellten Zahlen (im Unterschied zu den vorläufigen
Auszählungen der Wahlnacht). Die Daten von `results` sind genau das.

## Gebiete

**Gebiet / Gebietsart.** Ein Wahlgebiet und seine **Ebene**. Es gibt drei Ebenen:
- **Bund** – das gesamte Bundesgebiet (`Gebietsnummer` 99).
- **Land** – ein Bundesland (`01`–`16`).
- **Wahlkreis** – einer der Wahlkreise (`001`–`299`).

Jede Ergebniszeile nennt ihr Gebiet (`gebietsart`, `gebietsnummer`, `gebietsname`) und bei
einem Wahlkreis zusätzlich das übergeordnete Land (`ueGebietsart`/`ueGebietsnummer`).

**Wahlkreis.** Einer der **299** Wahlkreise, in denen jeweils ein Mitglied des Bundestages
direkt gewählt wird (Erststimme). `wahlkreise` listet sie mit ihrem Land auf.

**Land / Länder.** Ein Bundesland (insgesamt 16).

## Stimmen

**Erststimme (Stimme 1).** Die Stimme für eine *Kandidatin oder einen Kandidaten* in Ihrem
Wahlkreis; wer die meisten Erststimmen erhält, gewinnt das **Direktmandat** des
Wahlkreises.

**Zweitstimme (Stimme 2).** Die Stimme für die *Liste* einer Partei; sie entscheidet über
den Gesamtanteil der Sitze jeder Partei. Meist ist sie gemeint, wenn von „dem Ergebnis“
die Rede ist.

In den Daten ist `stimme` `1` oder `2`; Zeilen der **System-Gruppe** (Summen zur
Wahlbeteiligung) haben keine Stimme (`null`).

## Gruppen & Ergebnisse

**Gruppe / Gruppenart.** Eine **Gruppe** in einer Ergebniszeile und ihre **Art**:
- **Partei** – eine politische Partei (SPD, CDU, GRÜNE, …).
- **Einzelbewerber/Wählergruppe** – ein parteiloser Einzelbewerber oder eine Wählergruppe.
- **System-Gruppe** – eine **Summe**, kein Wahlbewerber: `Wahlberechtigte`, `Wählende`,
  `Ungültige`/`Gültige Stimmen`.

**kerg2.** Die **normalisierte Ergebnisdatei** der Bundeswahlleiterin („Ergebnisse nach
Wahlkreisen“), die Quelle für `results`. Sie liegt im *Long-/Tidy-Format* vor: **eine Zeile
je Gebiet × Gruppe × Stimme**, sodass jede Partei getrennte Zeilen für Erst- und
Zweitstimme hat; jede Zeile enthält die Anzahl (`anzahl`), den Anteil (`prozent`) und den
Vergleich zur vorigen Wahl (`vorpAnzahl`, `diffProzentPkt`, …). (Die Datei `kerg.csv`
enthält dieselben Daten in einem schwer zu parsenden Breitformat; diese CLI verwendet
`kerg2`.)

**Gewählt.** Der Name der Partei, die das **Direktmandat des Wahlkreises gewonnen** hat
(Erststimme). Er wiederholt sich in jeder Zeile eines Wahlkreises (z. B. `"GRÜNE"`) und
ist bei Zeilen für Bund und Land leer.

**Strukturdaten.** Kennzahlen **je Wahlkreis** – rund 50 demografische und
wirtschaftliche Indikatoren (Fläche, Bevölkerung, Altersstruktur, Beschäftigung, …),
veröffentlicht, damit sich die Ergebnisse im Zusammenhang lesen lassen. `structure`
liefert jeden Wahlkreis als Zuordnung Spalte→Wert.

## Daten & Format

**Datenlizenz Deutschland – Namensnennung 2.0 (dl-de/by-2.0).** Die **offene Lizenz**
der Daten: Sie dürfen sie frei kopieren, bearbeiten und weiterverwenden, auch kommerziell,
**mit Namensnennung** („Quelle: Die Bundeswahlleiterin, Wiesbaden 2025“). Siehe
[DATA_LICENSE.md](DATA_LICENSE.md).

**CSV-Eigenheiten.** Die Dateien sind **durch Semikolons getrennt**, in **UTF-8 mit BOM**
kodiert, verwenden **deutsche Dezimalzahlen** (Komma, z. B. `82,5122`) und beginnen vor
der Kopfzeile mit einer mehrzeiligen, für Menschen gedachten **Präambel**. `bundeswahl`
erledigt all das; Anzahlen und Prozentwerte erhalten Sie als JSON-Zahlen, `null` bei
leeren oder `–`-Zellen.

## CLI / Technik

**Exit-Codes.** `0` Erfolg · `2` Aufruffehler · `4` nicht gefunden · `6`
Netzwerkfehler · `1` Sonstiges (auch eine Antwort, die kein CSV ist, etwa HTML). Siehe
[Usage.md](Usage.md#exit-codes).

**Filter wirken clientseitig.** Jeder Befehl lädt den gesamten Datensatz herunter und
filtert im Speicher; Filter lassen sich daher kombinieren, und ein Filter ohne Treffer
liefert `[]` (nicht alles).
