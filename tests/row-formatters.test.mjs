// Regression tests for audit findings D-03, D-04 and D-08.
//
// There were three independent row-formatting implementations — _doExport in
// the service worker, the side panel's "Download Data" button, and
// exporters/text-exporters.js, which was the only correct one and was imported
// by nothing. A fourth formatted the API sniffer log. They disagreed:
//
//   D-03: two of them quoted every CSV field and used String(v || ""), so a
//         legitimate 0 or false became an empty cell.
//   D-08: text-exporters and the MCP server used Object.keys(rows[0]), so a
//         column missing from the first row vanished from the output.
//   D-04: the README advertises six formats; the UI offered four and the
//         service worker implemented four. XML and Markdown were unreachable.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  formatRows,
  formatMeta,
  collectHeaders,
  defaultFilename,
  ROW_FORMATS,
} from "../exporters/row-formatters.js";

test("all six advertised formats are available", () => {
  assert.deepEqual(
    [...ROW_FORMATS],
    ["csv", "json", "jsonl", "tsv", "xml", "markdown"],
  );
});

test("headers are the union of every row's keys", () => {
  const rows = [{ a: 1 }, { b: 2 }, { a: 3, c: 4 }];
  assert.deepEqual(
    collectHeaders(rows),
    ["a", "b", "c"],
    "Object.keys(rows[0]) would have dropped b and c entirely",
  );
});

test("a column missing from the first row still appears", () => {
  const csv = formatRows(
    [{ name: "Widget" }, { name: "Gadget", sku: "G-1" }],
    "csv",
  );
  assert.match(csv, /^name,sku/);
  assert.match(csv, /Gadget,G-1/);
});

test("falsy values survive", () => {
  const rows = [{ stock: 0, active: false, note: "" }];
  const csv = formatRows(rows, "csv");

  assert.equal(
    csv.trim().split("\r\n")[1],
    "0,false,",
    "0 and false are real values",
  );
});

test("CSV quotes only what needs quoting", () => {
  const rows = [
    { plain: "simple", comma: "a,b", quote: 'say "hi"', nl: "one\ntwo" },
  ];
  const line = formatRows(rows, "csv").trim().split("\r\n")[1];

  assert.match(line, /^simple,/, "a plain value is not quoted");
  assert.match(line, /"a,b"/);
  assert.match(line, /"say ""hi"""/, "embedded quotes are doubled");
  assert.match(line, /"one\ntwo"/);
});

test("TSV neutralises tabs and newlines rather than corrupting the grid", () => {
  const line = formatRows([{ a: "x\ty", b: "p\nq" }], "tsv")
    .trim()
    .split("\n")[1];
  assert.equal(line, "x y\tp q");
});

test("XML escapes content and produces usable element names", () => {
  const xml = formatRows([{ "price (USD)": "<5 & rising", "2nd": "x" }], "xml");

  assert.match(
    xml,
    /<price__USD_>&lt;5 &amp; rising<\/price__USD_>/,
    "a tag cannot contain spaces or parens",
  );
  assert.match(
    xml,
    /<_2nd>x<\/_2nd>/,
    "an element name cannot start with a digit",
  );
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
});

test("Markdown escapes pipes so cells do not become columns", () => {
  const md = formatRows([{ a: "x|y", b: "line\nbreak" }], "markdown");
  assert.match(md, /x\\\|y/);
  assert.match(md, /line break/, "a newline would end the table row");
});

test("JSON and JSONL round-trip", () => {
  const rows = [{ a: 1 }, { a: 2 }];
  assert.deepEqual(JSON.parse(formatRows(rows, "json")), rows);
  assert.deepEqual(
    formatRows(rows, "jsonl")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l)),
    rows,
  );
});

test("empty input produces empty output, not a header-only file", () => {
  for (const format of ["csv", "tsv", "xml", "markdown"]) {
    assert.equal(formatRows([], format), "", format);
  }
  assert.equal(formatRows([], "json"), "[]");
  assert.equal(formatRows([], "jsonl"), "");
});

test("nested values are serialised rather than stringified as [object Object]", () => {
  const csv = formatRows([{ meta: { a: 1 } }], "csv");
  assert.match(csv, /\{""a"":1\}/);
});

test("an unknown format is rejected", () => {
  assert.throws(
    () => formatRows([{ a: 1 }], "yaml"),
    /Unsupported export format/,
  );
  assert.throws(() => formatMeta("yaml"), /Unsupported export format/);
});

test("filenames and MIME types match the format", () => {
  assert.equal(defaultFilename("markdown"), "export.md");
  assert.equal(defaultFilename("jsonl", "rows"), "rows.jsonl");
  assert.equal(formatMeta("xml").mime, "application/xml");
});

// ── the consumers ────────────────────────────────────────────────────────────

test("every consumer uses the shared formatter", async () => {
  const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

  const sw = await read("background/service-worker.js");
  assert.match(sw, /from "\.\.\/exporters\/row-formatters\.js"/);
  assert.ok(
    !/dataContent =\s*\n?\s*headers\.join\(","\)/.test(sw),
    "the inline CSV builder is gone",
  );

  const panel = await read("sidepanel/pipeline-builder.js");
  assert.match(panel, /from "\.\.\/exporters\/row-formatters\.js"/);
  assert.ok(
    !/const csv =\s*\n?\s*headers\.join\(","\)/.test(panel),
    "the partial-download CSV builder is gone",
  );

  const mcp = await read("mcp/server.mjs");
  assert.match(mcp, /const renderRows = formatRows;/);
  assert.ok(!/^function toCSV\(/m.test(mcp), "the MCP copies are gone");
});

test("the EXPORT step offers every format", async () => {
  const panel = await readFile(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  assert.match(
    panel,
    /\$\{ROW_FORMATS\.map\(/,
    "the dropdown is built from the format list, not hardcoded to four",
  );
});
