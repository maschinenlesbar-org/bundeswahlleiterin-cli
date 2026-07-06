import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseCsvRows, rowsToObjects, parseGermanNumber } from "../src/client/csv.js";
import * as fx from "./fixtures.js";

test("parseCsvRows splits simple semicolon rows and ignores a trailing newline", () => {
  assert.deepEqual(parseCsvRows("a;b;c\n1;2;3\n"), [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("parseCsvRows handles CRLF line endings", () => {
  assert.deepEqual(parseCsvRows("a;b\r\n1;2\r\n"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("parseCsvRows respects quotes: embedded delimiter, newline and \"\" escape", () => {
  const rows = parseCsvRows('x;"a;b";"line1\nline2";"he said ""hi"""\n');
  assert.deepEqual(rows, [["x", "a;b", "line1\nline2", 'he said "hi"']]);
});

test("parseCsv strips the BOM and skips the preamble to the named header row", () => {
  const parsed = parseCsv(fx.kerg2Csv, { headerFirstCell: "Wahlart" });
  assert.equal(parsed.header[0], "Wahlart"); // no leftover BOM on the first cell
  assert.equal(parsed.header[2], "Gebietsart");
  assert.equal(parsed.rows.length, 5); // data rows, preamble dropped (client drops the ghost row)
  assert.equal(parsed.rows[0]![8], "Wahlberechtigte");
});

test("parseCsv without headerFirstCell uses the first non-empty row as header", () => {
  const parsed = parseCsv("\n;;\na;b\n1;2\n");
  assert.deepEqual(parsed.header, ["a", "b"]);
  assert.deepEqual(parsed.rows, [["1", "2"]]);
});

test("parseCsv drops fully-empty data rows", () => {
  const parsed = parseCsv("a;b\n1;2\n;;\n3;4\n", { headerFirstCell: "a" });
  assert.equal(parsed.rows.length, 2);
});

test("rowsToObjects keys cells by the header names", () => {
  const objs = rowsToObjects(parseCsv(fx.partiesCsv, { headerFirstCell: "Gruppenschluessel" }));
  assert.equal(objs[1]!["GruppennameKurz"], "SPD");
  assert.equal(objs[1]!["Gruppenname"], "Sozialdemokratische Partei Deutschlands");
});

test("parseGermanNumber handles decimals, thousands and placeholders", () => {
  assert.equal(parseGermanNumber("15,924417"), 15.924417);
  assert.equal(parseGermanNumber("60510631"), 60510631);
  assert.equal(parseGermanNumber("1.234.567,89"), 1234567.89);
  assert.equal(parseGermanNumber(""), null);
  assert.equal(parseGermanNumber("-"), null);
  assert.equal(parseGermanNumber("–"), null); // en-dash placeholder
  assert.equal(parseGermanNumber("nope"), null);
});
