import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseCsvRows, rowsToObjects, parseGermanNumber } from "../src/client/csv.js";
import { BundeswahlParseError } from "../src/client/errors.js";
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

test("parseCsvRows throws on an unterminated quoted field instead of truncating", () => {
  // A single stray opening quote used to put the tokenizer into inQuotes for the
  // rest of the file, swallowing every following row and returning partial data
  // with a success exit code. It must now fail loudly.
  assert.throws(
    () => parseCsvRows('a;b\n1;2\n"broken;line\n3;4\n'),
    (err) => err instanceof BundeswahlParseError && /unterminated quoted field/.test(err.message),
  );
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

test("rowsToObjects does not pollute Object.prototype via a __proto__/constructor header", () => {
  // A hostile CSV whose header names are dangerous keys. If rowsToObjects built
  // rows on a normal prototype, these could reach inherited accessors; on a null
  // prototype they are ordinary own data properties and nothing leaks.
  const objs = rowsToObjects(parseCsv("__proto__;constructor;prototype;safe\np;c;q;ok\n"));

  // Object.prototype is untouched: no global pollution.
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "safe"), false);

  // The dangerous columns are captured as plain own properties on this row.
  const row = objs[0]!;
  assert.equal(Object.getPrototypeOf(row), null);
  assert.equal(row["__proto__"], "p");
  assert.equal(row["constructor"], "c");
  assert.equal(row["prototype"], "q");
  assert.equal(row["safe"], "ok");

  // JSON serialisation of a null-prototype row still works and includes them.
  const json = JSON.parse(JSON.stringify(row)) as Record<string, string>;
  assert.equal(json["__proto__"], "p");
  assert.equal(json["safe"], "ok");
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

test("rowsToObjects rejects a duplicate column name instead of overwriting it", () => {
  // Two "b" columns: the second would win and the displaced field would go empty,
  // producing a wrong row that still exits 0. Fail loudly instead.
  const parsed = parseCsv("a;b;c;b\n1;2;3;4\n", { headerFirstCell: "a" });
  assert.throws(() => rowsToObjects(parsed), BundeswahlParseError);
  assert.throws(() => rowsToObjects(parsed), /duplicate column name "b"/);
});

test("rowsToObjects tolerates repeated empty padding cells in the header", () => {
  // The published files pad short header rows with trailing `;`, so empty column
  // names repeat legitimately and must not trip the duplicate check.
  const parsed = parseCsv("a;b;;\n1;2;;\n", { headerFirstCell: "a" });
  const [row] = rowsToObjects(parsed);
  assert.equal(row!["a"], "1");
  assert.equal(row!["b"], "2");
});
