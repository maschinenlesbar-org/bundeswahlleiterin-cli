import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { MAX_CSV_CELLS, MAX_CSV_ROWS, hasTooManyDigits, headerMatchThreshold, parseCsv, parseCsvRows, rowsToObjects, parseGermanNumber } from "../src/csv.js";
import { BundeswahlParseError } from "../src/errors.js";
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
  assert.equal(parsed.rows.length, 7); // data rows, preamble dropped
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
  assert.equal(parseGermanNumber("-1,08241"), -1.08241);
  assert.equal(parseGermanNumber(" 12,5 "), 12.5);
});

test("parseGermanNumber rejects JS literal syntax and malformed cells instead of guessing", () => {
  for (const bad of ["nope", "0x10", "0b101", "1e3", "Infinity", "1.5", "1,2,3", "+5", "12.34,5", "1 000", "abc"]) {
    assert.throws(
      () => parseGermanNumber(bad),
      (err: unknown) => err instanceof BundeswahlParseError && /is not a German-formatted number/.test(err.message),
      bad,
    );
  }
});

test("parseGermanNumber refuses a number with more digits than a JS number holds, never a rounded value", () => {
  // A double carries 15 significant decimal digits exactly; a 20-digit count used to
  // come back rounded (12345678901234567890 -> 12345678901234567000), with exit 0.
  for (const bad of [
    "12345678901234567890",
    "-12345678901234567890",
    "12.345.678.901.234.567.890",
    "1234567890123456", // 16 digits
    "1,23456789012345678",
    "0,0000000000000001", // the fraction's leading zeros count: 16 digits
  ]) {
    assert.throws(
      () => parseGermanNumber(bad),
      (err: unknown) =>
        err instanceof BundeswahlParseError &&
        err.message === `Malformed CSV: "${bad}" has more than 15 significant digits, more than a JS number holds exactly.`,
      bad,
    );
  }
  // A huge cell is named cut, not echoed whole.
  const huge = "9".repeat(2000);
  assert.throws(
    () => parseGermanNumber(huge),
    (err: unknown) => err instanceof BundeswahlParseError && err.message.length < 700 && err.message.includes(`"${"9".repeat(500)}…"`),
  );
  // Up to the cap every value parses exactly; leading zeros of the integer and trailing
  // zeros of the fraction don't count.
  assert.equal(parseGermanNumber("999999999999999"), 999999999999999);
  assert.equal(parseGermanNumber("-999.999.999.999.999"), -999999999999999);
  assert.equal(parseGermanNumber("0,123456789012345"), 0.123456789012345);
  assert.equal(parseGermanNumber("000000000000000000012"), 12);
  assert.equal(parseGermanNumber("12,500000000000000000000"), 12.5);
});

test("a number with a long run of zeros is counted in linear time (security audit, class A)", () => {
  // `fraction.replace(/0+$/, "")` tried a match at every zero of a run that doesn't end the
  // fraction and scanned to its end each time: 100 000 zeros took seconds per cell.
  const zeros = "0".repeat(100_000);
  for (const cell of [`1,${zeros}1`, `${zeros}1,${zeros}1`, `-1.000,${zeros}1`]) {
    const start = performance.now();
    assert.equal(hasTooManyDigits(cell), true);
    assert.throws(() => parseGermanNumber(cell), (e: unknown) => e instanceof BundeswahlParseError && e.message.length < 700);
    const ms = performance.now() - start;
    assert.ok(ms < 1000, `${Math.round(ms)} ms on ${cell.slice(0, 12)}…`);
  }
  // The trailing zeros of the fraction still don't count, the leading zeros of the integer neither.
  assert.equal(parseGermanNumber(`${zeros}12,5${zeros}`), 12.5);
  assert.equal(parseGermanNumber("0,0"), 0);
  assert.equal(parseGermanNumber("100,000"), 100);
  assert.equal(hasTooManyDigits(`1,${"0".repeat(13)}1`), false);
  assert.equal(hasTooManyDigits(`1,${"0".repeat(14)}1`), true);
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

test("the duplicate-column error strips terminal escapes and bidi controls from the name", () => {
  const esc = String.fromCharCode(0x1b);
  const name = `${esc}[2J${esc}[31mX${String.fromCharCode(0x202e)}\t Y`;
  const parsed = parseCsv(`a;${name};${name}\n1;2;3\n`, { headerFirstCell: "a" });
  assert.throws(
    () => rowsToObjects(parsed),
    (err: unknown) =>
      err instanceof BundeswahlParseError &&
      err.message.includes('duplicate column name "X Y"') &&
      !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‮\n]/.test(err.message),
  );
});

test("parseCsv with headerColumns finds the header by its names in any position", () => {
  const text = "# preamble;x;y\nb;a;c\n2;1;3\n";
  assert.deepEqual(parseCsv(text, { headerColumns: ["a", "b", "c"] }), { header: ["b", "a", "c"], rows: [["2", "1", "3"]] });
  // A row with half of the names (at least two) counts, so a renamed column can be named.
  assert.deepEqual(parseCsv("x;a;b;z\n1;2;3;4\n", { headerColumns: ["a", "b", "c", "d"] }).header, ["x", "a", "b", "z"]);
  assert.deepEqual(parseCsv("x;a;q\n1;2;3\n", { headerColumns: ["a", "b", "c", "d"] }), { header: [], rows: [] });
  assert.equal(headerMatchThreshold(19), 10);
  assert.equal(headerMatchThreshold(3), 2);
  assert.equal(headerMatchThreshold(1), 1);
});

test("parseCsvRows cuts fields out as slices: the same rows as before for quotes, escapes, CR, a long field", () => {
  const long = "x".repeat(200_000);
  assert.deepEqual(parseCsvRows(`a;"b;c""d"e;\r\nf\rg;"h\ni"\n${long};"${long}"`), [
    ["a", 'b;c"de', ""],
    ["fg", "h\ni"],
    [long, long],
  ]);
  assert.deepEqual(parseCsvRows('""""'), [['"']]);
  assert.deepEqual(parseCsvRows("a,b\n", ","), [["a", "b"]]);
  assert.deepEqual(parseCsvRows("a;b", "::"), [["a;b"]]);
});

test("parseCsvRows stops at a row and a cell budget, with headroom over the largest published file", () => {
  // The largest file (kerg2) has about 15 600 rows of 19 cells; one row array per line break
  // cost ~195 bytes, so a 4 MB answer of line breaks aborted a 512 MB heap.
  assert.equal(MAX_CSV_ROWS, 200_000);
  assert.equal(MAX_CSV_CELLS, 4_000_000);
  const rows = (csv: string): number => parseCsvRows(csv).length;
  assert.equal(rows("a;b\n".repeat(MAX_CSV_ROWS)), MAX_CSV_ROWS);
  assert.equal(rows(`${";".repeat(MAX_CSV_CELLS - 1)}\n`), 1);
  for (const [label, csv, message] of [
    ["line breaks", `${"\n".repeat(MAX_CSV_ROWS)}x`, /^Malformed CSV: more than 200000 rows, more than any published file has\.$/],
    ["rows", "a;b\n".repeat(MAX_CSV_ROWS + 1), /more than 200000 rows/],
    ["cells", `${";".repeat(MAX_CSV_CELLS)}\n`, /^Malformed CSV: more than 4000000 cells, more than any published file has\.$/],
  ] as const) {
    assert.throws(() => parseCsvRows(csv), (e: unknown) => e instanceof BundeswahlParseError && message.test(e.message), label);
  }
  // A long run of CRs inside a field is one field, not one part per CR.
  assert.deepEqual(parseCsvRows(`a${"\r".repeat(1000)}b;c\n`), [["ab", "c"]]);
});

// This test starts a process with a small heap: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

test("a quoted field of millions of \"\" pairs is read within a small heap", STARTS_A_PROCESS, () => {
  // Each `""` pushed one piece into the field's parts, a string and an array slot each, bounded by
  // neither the cell nor the row budget: 5 million `x""` (15 MB) exhausted a 96 MB heap.
  const csv = new URL("../src/csv.js", import.meta.url).href;
  const n = 5_000_000;
  const script =
    `const { parseCsvRows } = await import(${JSON.stringify(csv)});` +
    `const rows = parseCsvRows('a;"' + 'x""'.repeat(${n}) + '"\\nb;c\\n');` +
    `process.stdout.write(rows.length + " " + rows[0][1].length + " " + /^(?:x")+$/.test(rows[0][1]) + " " + rows[1][1]);`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=96", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, `2 ${2 * n} true c`);
  // The pieces still come out in order, across the batches they are joined in.
  const mixed = Array.from({ length: 40_000 }, (_, i) => `${i}""`).join("");
  assert.deepEqual(parseCsvRows(`"${mixed}";x`), [[mixed.replace(/""/g, '"'), "x"]]);
});
