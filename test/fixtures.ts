// Canned Bundeswahlleiterin open-data CSVs, trimmed to what the tests assert but
// structurally faithful to the live files: semicolon-delimited, a multi-line
// preamble before the header, German decimals, and (for kerg) a UTF-8 BOM.

/** Results (kerg2): preamble, header, then Bund system-group / party rows and a Wahlkreis row. */
export const kerg2Csv =
  "﻿(c) Die Bundeswahlleiterin, Wiesbaden 2025;;;;;;;;;;;;;;;;;;\n" +
  "Datenlizenz Deutschland – Namensnennung – Version 2.0;;;;;;;;;;;;;;;;;;\n" +
  ";;;;;;;;;;;;;;;;;;\n" +
  "Ergebnisse nach Wahlkreisen;;;;;;;;;;;;;;;;;;\n" +
  ";;;;;;;;;;;;;;;;;;\n" +
  "Wahlart;Wahltag;Gebietsart;Gebietsnummer;Gebietsname;UegGebietsart;UegGebietsnummer;Gruppenart;Gruppenname;Gruppenreihenfolge;Stimme;Anzahl;Prozent;VorpAnzahl;VorpProzent;DiffProzent;DiffProzentPkt;Bemerkung;Gewählt\n" +
  "BT;23.02.2025;Bund;99;Bundesgebiet;;;System-Gruppe;Wahlberechtigte;-4;;60510631;;61172771;;-1,08241;;;\n" +
  "BT;23.02.2025;Bund;99;Bundesgebiet;;;Partei;GRÜNE;3;2;5762380;11,606116;6814408;14,718457;-15,438289;-3,112341;;\n" +
  "BT;23.02.2025;Wahlkreis;005;Kiel;LAND;01;Partei;SPD;1;1;36690;22,076344;40000;25,0;-8,3;-2,9;;GRÜNE\n" +
  "BT;23.02.2025;Wahlkreis;005;Kiel;LAND;01;Partei;GRÜNE;3;1;43281;26,042143;38000;24,0;13,9;2,0;;GRÜNE\n";

/** Parties reference (btw25_parteien): `#`-commented preamble, header, rows. */
export const partiesCsv =
  "# (c) Die Bundeswahlleiterin, Wiesbaden 2025;;;;\n" +
  "# Datenlizenz Deutschland – Namensnennung – Version 2.0;;;;\n" +
  "Gruppenschluessel;Gruppenart_XML;Gruppenart_CSV;GruppennameKurz;Gruppenname\n" +
  "100;SYSTEM_GRUPPE;System-Gruppe;Wahlberechtigte;Wahlberechtigte\n" +
  "2;PARTEI;Partei;SPD;Sozialdemokratische Partei Deutschlands\n" +
  "3;PARTEI;Partei;GRÜNE;BÜNDNIS 90/DIE GRÜNEN\n";

/** Wahlkreis names reference: `#`-commented preamble, header, rows across two Länder. */
export const wahlkreiseCsv =
  "# Wahlkreisnamen;;;;\n" +
  "WKR_NR;WKR_NAME;LAND_NR;LAND_NAME;LAND_ABK\n" +
  "001;Flensburg – Schleswig;01;Schleswig-Holstein;SH\n" +
  "005;Kiel;01;Schleswig-Holstein;SH\n" +
  "212;München-Nord;09;Bayern;BY\n";

/** Strukturdaten: `#` preamble, a `Spalten-Nr.` row, then the real header (starts "Land") + rows. */
export const structureCsv =
  "# Strukturdaten für die Wahlkreise;;;;\n" +
  "Spalten-Nr.;;;1;2\n" +
  "Land;Wahlkreis-Nr.;Wahlkreis-Name;Fläche (km²);Bevölkerung\n" +
  "Schleswig-Holstein;1;Flensburg – Schleswig;2128,1;301,2\n" +
  "Bayern;212;München-Nord;100,0;250,0\n";

/** A minimal HTML error page (what the site returns for an unknown path). */
export const htmlShell = "<!doctype html>\n<html><head><title>404</title></head><body>Not found</body></html>";
