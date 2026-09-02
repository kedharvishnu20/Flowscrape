// Regression tests for audit findings B-28 and G-05.
//
// B-28: _executePdfExtraction never parsed anything. It logged "use MCP tool
// pdf_extract_text" and stored {status: "pending"}, while the palette offered
// the step with a full config UI — source, max pages, storeAs — that had no
// effect on anything.
//
// G-05: that message is an instruction the user cannot act on. There is no
// bridge from the extension to the MCP server, and the sibling message in
// _executeUploadActivityStep pointed at "upload_file_to_site", which is not one
// of the server's registered tools at all.
//
// The extension reads PDFs itself now. These tests build real PDFs byte by
// byte — there is no fixture to go stale — and check both what the reader can
// do and what it refuses to guess at.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractPdfText } from "../utils/pdf-text.js";

const enc = new TextEncoder();

/** Deflate, so a test can build the compressed streams real PDFs use. */
async function deflate(str) {
  const stream = new Blob([enc.encode(str)])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Assemble a PDF from object bodies.
 * @param {string[]} objects
 * @param {string} [extra] appended verbatim before the trailer
 */
function buildPdf(objects, extra = "") {
  let out = "%PDF-1.4\n";
  objects.forEach((body, i) => {
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  out += extra;
  out += "trailer\n<< /Root 1 0 R >>\n%%EOF";
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/** A content stream object, uncompressed. */
const plainStream = (content) =>
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;

// ── what it reads ────────────────────────────────────────────────────────────

test("text comes out of an uncompressed content stream", async () => {
  const pdf = buildPdf([plainStream("BT /F1 12 Tf (Hello world) Tj ET")]);
  const r = await extractPdfText(pdf);
  assert.equal(r.pageCount, 1);
  assert.equal(r.pages[0].text, "Hello world");
  assert.equal(r.text, "Hello world");
});

test("a TJ array is joined and its kerning numbers dropped", async () => {
  const pdf = buildPdf([
    plainStream("BT [(Total) -250 ( price:) -100 ( 42)] TJ ET"),
  ]);
  const r = await extractPdfText(pdf);
  assert.equal(r.pages[0].text, "Total price: 42");
});

test("escapes in a literal string are resolved", async () => {
  const pdf = buildPdf([
    plainStream(String.raw`BT (A \(quoted\) w\157rd\\here) Tj ET`),
  ]);
  const r = await extractPdfText(pdf);
  assert.equal(r.pages[0].text, "A (quoted) word\\here");
});

test("a hex string decodes", async () => {
  const pdf = buildPdf([plainStream("BT <4869207468657265> Tj ET")]);
  const r = await extractPdfText(pdf);
  assert.equal(r.pages[0].text, "Hi there");
});

test("an odd-length hex string is padded rather than dropped", async () => {
  const pdf = buildPdf([plainStream("BT <4869 2> Tj ET")]);
  const r = await extractPdfText(pdf);
  assert.match(r.pages[0].text, /^Hi/);
});

test("a FlateDecode content stream is inflated", async () => {
  const content = "BT (Compressed content) Tj ET";
  const body = await deflate(content);
  const raw =
    "%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length 99 >>\nstream\n";
  const head = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) head[i] = raw.charCodeAt(i);
  const tail = enc.encode("\nendstream\nendobj\ntrailer\n<< >>\n%%EOF");

  const pdf = new Uint8Array(head.length + body.length + tail.length);
  pdf.set(head, 0);
  pdf.set(body, head.length);
  pdf.set(tail, head.length + body.length);

  const r = await extractPdfText(pdf);
  assert.equal(r.pages[0].text, "Compressed content");
});

test("positioning operators become spaces, not run-together words", async () => {
  const pdf = buildPdf([
    plainStream("BT (First line) Tj 0 -14 Td (Second line) Tj ET"),
  ]);
  const r = await extractPdfText(pdf);
  assert.equal(r.pages[0].text, "First line Second line");
});

test("several content streams are several pages", async () => {
  const pdf = buildPdf([
    plainStream("BT (Page one) Tj ET"),
    plainStream("BT (Page two) Tj ET"),
    plainStream("BT (Page three) Tj ET"),
  ]);
  const r = await extractPdfText(pdf);
  assert.equal(r.pageCount, 3);
  assert.deepEqual(
    r.pages.map((p) => p.text),
    ["Page one", "Page two", "Page three"],
  );
  assert.equal(r.text, "Page one\n\nPage two\n\nPage three");
  assert.equal(r.pages[0].chars, "Page one".length);
});

test("maxPages stops early and says it did", async () => {
  const pdf = buildPdf([
    plainStream("BT (One) Tj ET"),
    plainStream("BT (Two) Tj ET"),
    plainStream("BT (Three) Tj ET"),
  ]);
  const r = await extractPdfText(pdf, { maxPages: 2 });
  assert.equal(r.pages.length, 2);
  assert.equal(r.pageCount, 3);
  assert.equal(r.truncated, true);
});

// ── /ToUnicode ───────────────────────────────────────────────────────────────

test("a bfchar CMap decodes glyph indices", async () => {
  const cmap = [
    "<< /Length 200 >>",
    "stream",
    "/CIDInit /ProcSet findresource begin",
    "1 begincmap",
    "2 beginbfchar",
    "<0003> <0048>",
    "<0004> <0069>",
    "endbfchar",
    "endcmap",
    "endstream",
  ].join("\n");
  const pdf = buildPdf([cmap, plainStream("BT <00030004> Tj ET")]);
  const r = await extractPdfText(pdf);
  assert.equal(r.pages[0].text, "Hi", "0003 maps to H and 0004 to i");
});

test("a bfrange CMap decodes a run of codes", async () => {
  const cmap = [
    "<< /Length 200 >>",
    "stream",
    "1 beginbfrange",
    "<0010> <0014> <0041>",
    "endbfrange",
    "endcmap",
    "endstream",
  ].join("\n");
  const pdf = buildPdf([cmap, plainStream("BT <00100011001200130014> Tj ET")]);
  const r = await extractPdfText(pdf);
  assert.equal(r.pages[0].text, "ABCDE");
});

// ── what it refuses to guess at ──────────────────────────────────────────────

test("an encrypted PDF is refused, not silently emptied", async () => {
  const pdf = buildPdf(
    [plainStream("BT (secret) Tj ET")],
    "9 0 obj\n<< /Encrypt 8 0 R >>\nendobj\n",
  );
  await assert.rejects(() => extractPdfText(pdf), /encrypted/i);
});

test("something that is not a PDF is refused by name", async () => {
  await assert.rejects(
    () => extractPdfText(enc.encode("<html>not a pdf</html>")),
    /Not a PDF/,
  );
});

test("a scanned page says it is probably a scan", async () => {
  const pdf = buildPdf([plainStream("q 612 0 0 792 0 0 cm /Im0 Do Q")]);
  const r = await extractPdfText(pdf);
  assert.equal(r.pageCount, 0);
  assert.match(r.warnings[0], /scanned PDF holds images, not text/);
});

test("undecodable glyph indices are reported, never emitted as mojibake", async () => {
  // Two-byte CIDs with no /ToUnicode anywhere in the file.
  const pdf = buildPdf([plainStream("BT <00030004000500060007> Tj ET")]);
  const r = await extractPdfText(pdf);
  assert.equal(r.pages[0].text, "", "no garbage is passed off as text");
  assert.match(r.pages[0].note, /glyph indices/);
  assert.match(r.warnings.join(" "), /no \/ToUnicode map/);
});

test("a stream compressed with something unreadable is skipped, not fatal", async () => {
  const pdf = buildPdf([
    "<< /Filter /JPXDecode /Length 10 >>\nstream\n \nendstream",
    plainStream("BT (Readable page) Tj ET"),
  ]);
  const r = await extractPdfText(pdf);
  assert.equal(r.pages[0].text, "Readable page");
});

// ── the executor and the instructions it used to give ────────────────────────

const swSrc = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);

test("the step extracts instead of pointing at an MCP tool", () => {
  const fn = swSrc.match(
    /async function _executePdfExtraction\([\s\S]*?\n\}\n/,
  )[0];

  assert.match(fn, /await extractPdfText\(bytes, \{ maxPages \}\)/);
  assert.match(
    fn,
    /_dataUrlToBytes\(file\.dataUrl\)/,
    "the storage library path",
  );
  assert.match(fn, /await res\.arrayBuffer\(\)/, "and the URL path");
  assert.match(fn, /_assertOriginAllowed\(/, "same origin rules as any fetch");

  const code = fn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/status: "pending"/.test(code));
  assert.ok(
    !/pdf_extract_text/.test(code),
    "no unreachable instruction remains",
  );
});

test("what the step returns is the text, not a promise of it", () => {
  const fn = swSrc.match(
    /async function _executePdfExtraction\([\s\S]*?\n\}\n/,
  )[0];
  assert.match(fn, /\[storeAs\]: \{/);
  assert.match(fn, /text: result\.text/);
  assert.match(fn, /pages: result\.pages/);
  assert.match(fn, /truncated: result\.truncated/);
  assert.match(fn, /warnings: result\.warnings/);
});
