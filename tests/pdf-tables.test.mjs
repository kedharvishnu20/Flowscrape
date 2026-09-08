// Reading a table back out of a PDF.
//
// A PDF has no notion of a table. It has strings, and coordinates to draw them
// at; the grid is something the reader's eye assembles. So `PDF_EXTRACTION`
// returned one long blob with the columns run together, and a PDF of tabular
// data — which is most of the PDFs anyone wants to scrape — came out unusable.
//
// Three ways of getting it wrong, each of which still produces a plausible file:
//
//   - Demanding equal y puts every cell on its own row. A superscript or a
//     font-size change is enough to break it, and the result still looks like
//     a table.
//   - Matching cells to columns by index shifts everything after an empty cell
//     one place left. Nothing about the output says so.
//   - Splitting a padded row on a single space cuts "New York" in half.
//
// These build real PDFs byte by byte, as the text tests do — there is no
// fixture to go stale.
import test from "node:test";
import assert from "node:assert/strict";
import * as require$fs from "node:fs";

// A namespace import: a named one of an export that does not exist yet is a
// link-time error, which aborts the whole file instead of failing the tests
// that depend on it — and a fail-first check that reports one error rather
// than fifteen failures proves nothing.
import * as pdfText from "../utils/pdf-text.js";
const extractPdfItems =
  pdfText.extractPdfItems ??
  (async () => {
    throw new Error("extractPdfItems does not exist yet");
  });
import * as tables from "../utils/pdf-tables.js";
import { STEP_TYPES } from "../utils/step-types.js";

const {
  groupIntoRows,
  columnPositions,
  splitPadded,
  itemsToGrid,
  tablesFromPages,
} = tables;

/** Assemble a PDF from object bodies. */
function buildPdf(objects) {
  let out = "%PDF-1.4\n";
  objects.forEach((body, i) => {
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  out += "trailer\n<< /Root 1 0 R >>\n%%EOF";
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

const plainStream = (content) =>
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;

/**
 * A content stream drawing cells at explicit positions, the way a writer lays
 * a table out.
 * @param {Array<[number, number, string]>} cells - [x, y, text]
 */
const table = (cells) =>
  plainStream(
    "BT /F1 10 Tf " +
      cells.map(([x, y, t]) => `1 0 0 1 ${x} ${y} Tm (${t}) Tj`).join(" ") +
      " ET",
  );

// ── The step's shape ─────────────────────────────────────────────────────────

test("PDF_EXTRACTION can be asked for the table rather than the text", () => {
  const def = STEP_TYPES.PDF_EXTRACTION.def;
  assert.equal(def.mode, "text", "the default must not change behaviour");
  assert.equal(def.hasHeader, true);
});

// ── Positions come out of the PDF at all ─────────────────────────────────────

test("the reader keeps the coordinates the text reader throws away", async () => {
  const pdf = buildPdf([
    table([
      [72, 700, "Name"],
      [200, 700, "Price"],
      [72, 680, "Widget"],
      [200, 680, "10.00"],
    ]),
  ]);
  const { pages } = await extractPdfItems(pdf);
  assert.equal(pages.length, 1);
  assert.deepEqual(
    pages[0].items.map((i) => [i.x, i.y, i.text]),
    [
      [72, 700, "Name"],
      [200, 700, "Price"],
      [72, 680, "Widget"],
      [200, 680, "10.00"],
    ],
  );
});

test("Td moves relative to the line, and T* drops one leading", async () => {
  const pdf = buildPdf([
    plainStream(
      "BT /F1 10 Tf 14 TL 1 0 0 1 72 700 Tm (first) Tj T* (second) Tj 0 -20 Td (third) Tj ET",
    ),
  ]);
  const { pages } = await extractPdfItems(pdf);
  const ys = pages[0].items.map((i) => i.y);
  assert.deepEqual(ys, [700, 686, 666], `positions were ${ys.join(", ")}`);
});

// ── Grouping ─────────────────────────────────────────────────────────────────

test("cells a fraction apart are still one row", () => {
  // A superscript, or a font-size change. Demanding equality would give three
  // rows of one cell each — and that still looks like a table.
  const rows = groupIntoRows([
    { x: 72, y: 700, text: "a" },
    { x: 200, y: 700.4, text: "b" },
    { x: 320, y: 698.9, text: "c" },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows[0].map((c) => c.text),
    ["a", "b", "c"],
  );
});

test("rows come out in the order they were drawn, not in y order", () => {
  // Which way is up is not knowable from the numbers. PDF's default space has
  // y growing upward, but a page can install a matrix that flips it — and
  // Chrome's own print-to-PDF does, so its tables arrive with the last row at
  // the highest y. Sorting on y put the header at the bottom and named every
  // column after a data value.
  const rows = groupIntoRows([
    { x: 72, y: 100, text: "header" },
    { x: 72, y: 200, text: "first" },
    { x: 72, y: 300, text: "second" },
  ]);
  assert.deepEqual(
    rows.map((r) => r[0].text),
    ["header", "first", "second"],
  );

  // And the other direction, which is the ordinary case.
  const upward = groupIntoRows([
    { x: 72, y: 700, text: "header" },
    { x: 72, y: 680, text: "first" },
  ]);
  assert.deepEqual(
    upward.map((r) => r[0].text),
    ["header", "first"],
  );
});

test("a column is found even when only one row uses it", () => {
  const rows = groupIntoRows([
    { x: 72, y: 700, text: "a" },
    { x: 200, y: 700, text: "b" },
    { x: 72, y: 680, text: "c" },
    { x: 200, y: 680, text: "d" },
    { x: 330, y: 680, text: "e" },
  ]);
  assert.equal(columnPositions(rows).length, 3);
});

test("a right-aligned number column is one column, not several", () => {
  // The x of a right-aligned figure moves by the width of a digit.
  const rows = groupIntoRows([
    { x: 200, y: 700, text: "9.00" },
    { x: 194, y: 680, text: "10.00" },
    { x: 188, y: 660, text: "100.00" },
  ]);
  assert.equal(columnPositions(rows).length, 1);
});

// ── The grid ─────────────────────────────────────────────────────────────────

test("an empty cell keeps the values after it under the right headings", () => {
  // The failure this guards: matching by index would put "In stock" in the
  // price column for the middle row, and the file would look fine.
  const grid = itemsToGrid([
    { x: 72, y: 700, text: "Name" },
    { x: 200, y: 700, text: "Price" },
    { x: 330, y: 700, text: "Stock" },
    { x: 72, y: 680, text: "Widget" },
    { x: 200, y: 680, text: "10.00" },
    { x: 330, y: 680, text: "In stock" },
    { x: 72, y: 660, text: "Gadget" },
    { x: 330, y: 660, text: "Sold out" },
  ]);
  assert.deepEqual(grid, [
    ["Name", "Price", "Stock"],
    ["Widget", "10.00", "In stock"],
    ["Gadget", "", "Sold out"],
  ]);
});

test("a row drawn as one padded string is split on the padding", () => {
  assert.deepEqual(splitPadded("Widget    10.00    In stock"), [
    "Widget",
    "10.00",
    "In stock",
  ]);
  assert.deepEqual(
    splitPadded("New York    8.3m"),
    ["New York", "8.3m"],
    "a single space inside a value must not be a column boundary",
  );
});

test("prose is left as prose rather than given invented columns", () => {
  const grid = itemsToGrid([
    { x: 72, y: 700, text: "This is an ordinary sentence." },
    { x: 72, y: 680, text: "And so is this one." },
  ]);
  assert.deepEqual(grid, [
    ["This is an ordinary sentence."],
    ["And so is this one."],
  ]);
});

// ── Records ──────────────────────────────────────────────────────────────────

test("the first row names the columns, and the rest become rows", () => {
  const { records } = tablesFromPages([
    {
      page: 1,
      items: [
        { x: 72, y: 700, text: "Name" },
        { x: 200, y: 700, text: "Price" },
        { x: 72, y: 680, text: "Widget" },
        { x: 200, y: 680, text: "10.00" },
      ],
    },
  ]);
  assert.deepEqual(records, [{ Name: "Widget", Price: "10.00", _page: 1 }]);
});

test("without a header the columns are numbered and no row is lost", () => {
  const { records } = tablesFromPages(
    [
      {
        page: 1,
        items: [
          { x: 72, y: 700, text: "Widget" },
          { x: 200, y: 700, text: "10.00" },
        ],
      },
    ],
    { hasHeader: false },
  );
  assert.deepEqual(records, [{ col1: "Widget", col2: "10.00", _page: 1 }]);
});

test("a blank heading still gets a name, or its column vanishes", () => {
  const { records } = tablesFromPages([
    {
      page: 1,
      items: [
        { x: 72, y: 700, text: "Name" },
        { x: 200, y: 680, text: "10.00" },
        { x: 72, y: 680, text: "Widget" },
      ],
    },
  ]);
  assert.ok("col2" in records[0], `columns were ${Object.keys(records[0])}`);
  assert.equal(records[0].col2, "10.00");
});

test("a PDF with no table produces no rows rather than nonsense", () => {
  const { records } = tablesFromPages([{ page: 1, items: [] }]);
  assert.deepEqual(records, []);
});

test("every page's rows land in one list, tagged with the page", () => {
  const { records } = tablesFromPages([
    {
      page: 1,
      items: [
        { x: 72, y: 700, text: "Name" },
        { x: 72, y: 680, text: "A" },
      ],
    },
    {
      page: 2,
      items: [
        { x: 72, y: 700, text: "Name" },
        { x: 72, y: 680, text: "B" },
      ],
    },
  ]);
  assert.deepEqual(
    records.map((r) => [r.Name, r._page]),
    [
      ["A", 1],
      ["B", 2],
    ],
  );
});

// ── End to end, from PDF bytes to rows ───────────────────────────────────────

test("a real PDF of a table comes out as rows", async () => {
  const pdf = buildPdf([
    table([
      [72, 700, "Product"],
      [220, 700, "Price"],
      [350, 700, "Stock"],
      [72, 680, "Widget"],
      [220, 680, "10.00"],
      [350, 680, "In stock"],
      [72, 660, "Gadget"],
      [220, 660, "25.50"],
      [350, 660, "In stock"],
      [72, 640, "Doohickey"],
      [350, 640, "Sold out"],
    ]),
  ]);
  const { pages } = await extractPdfItems(pdf);
  const { records } = tablesFromPages(pages);
  assert.deepEqual(
    records.map((r) => [r.Product, r.Price, r.Stock]),
    [
      ["Widget", "10.00", "In stock"],
      ["Gadget", "25.50", "In stock"],
      ["Doohickey", "", "Sold out"],
    ],
  );
});

// ── The step and the panel ───────────────────────────────────────────────────

test("the run puts the rows into its results, not only into the context", () => {
  const src = require$fs.readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /_collectRows\(runState, runId, records\)/,
    "rows that never reach the buffer cannot be exported",
  );
  // A PDF of prose has no table; saying nothing would look like a successful
  // read of nothing.
  assert.match(src, /no table found/i);
});

test("the side panel offers the mode, or it is unreachable", () => {
  const src = require$fs.readFileSync(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /The table, as rows/);
  assert.match(src, /data-key="mode"/);
});
