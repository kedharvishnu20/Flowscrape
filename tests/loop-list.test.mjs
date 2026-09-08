// LOOP over a list you supply, rather than one the page provides.
//
// Every other LOOP mode gets its bound from the page: the elements it matched,
// the page links it found, the count you typed. None of them can say "visit
// these 500 product URLs" — the list is the input, not something on screen.
//
// Two things decide whether this is real rather than decorative.
//
// **The splitting has to be right.** A spreadsheet column holding `Smith, John`
// is one field. Split on the comma and every column after it shifts, silently,
// into a scrape that looks like it worked.
//
// **The items have to reach the exported script.** Templates are otherwise
// resolved by the run and reported as unresolved on export, so a script that
// fetched `https://shop/{{item.value}}` five hundred times — braces and all —
// would be a script that does not work. Inside a list LOOP the emitters fill
// them in, because the list is known at export time.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as loopItems from "../utils/loop-items.js";
import { STEP_TYPES } from "../utils/step-types.js";
import { emitNode } from "../script-gen/node-emitter.js";
import { emitPython } from "../script-gen/python-emitter.js";
import {
  calls,
  reset,
  startRun,
  endRun,
  onContentMessage,
  _dispatchStep,
} from "./helpers/worker-harness.mjs";

const { parseListLines, splitDelimited, itemsFromContext } = loopItems;

/** The URLs a run navigated to, in order. */
const visited = () => calls.tabUpdates.map((u) => u.url);

const listLoop = (config, children = []) => ({
  id: "l",
  type: "LOOP",
  config: { type: "list", source: "lines", max: 0, ...config },
  children,
});

const navigate = (url) => ({ id: "n", type: "NAVIGATE", config: { url } });

// ── The step's shape ─────────────────────────────────────────────────────────

test("LOOP carries a list source", () => {
  const def = STEP_TYPES.LOOP.def;
  assert.equal(def.type, "elements", "the default mode must not change");
  assert.equal(def.source, "lines");
  assert.ok("lines" in def && "delimiter" in def && "contextPath" in def);
});

// ── Reading the list ─────────────────────────────────────────────────────────

test("a quoted comma is part of the field, not a split", () => {
  assert.deepEqual(splitDelimited('"Smith, John",42,"x"', ","), [
    "Smith, John",
    "42",
    "x",
  ]);
});

test("a doubled quote inside a quoted field is one quote", () => {
  assert.deepEqual(splitDelimited('"a ""b"" c",d', ","), ['a "b" c', "d"]);
});

test("a quote in the middle of a field is part of the value", () => {
  // `12" pipe` is a measurement, not the start of a quoted field.
  assert.deepEqual(splitDelimited('12" pipe,steel', ","), [
    '12" pipe',
    "steel",
  ]);
});

test("with no delimiter the whole line is the item", () => {
  // The common case: a column of URLs. Splitting on a comma that happens to
  // be in a query string would break every one of them.
  const { items } = parseListLines("https://a.test/?x=1,2\nhttps://b.test/");
  assert.equal(items.length, 2);
  assert.equal(items[0].value, "https://a.test/?x=1,2");
});

test("blank lines are not items", () => {
  const { items } = parseListLines("a\n\n  \nb\n");
  assert.deepEqual(
    items.map((i) => i.value),
    ["a", "b"],
  );
});

test("a header row names the columns", () => {
  const { items, columns } = parseListLines("url,sku\n/a,X1\n/b,X2", {
    delimiter: ",",
    hasHeader: true,
  });
  assert.deepEqual(columns, ["url", "sku"]);
  assert.equal(items.length, 2);
  assert.equal(items[0].url, "/a");
  assert.equal(items[1].sku, "X2");
});

test("without a header the columns are numbered, and value is still the first", () => {
  const { items, columns } = parseListLines("/a,X1", { delimiter: "," });
  assert.deepEqual(columns, ["col1", "col2"]);
  assert.equal(items[0].col2, "X1");
  assert.equal(
    items[0].value,
    "/a",
    "a body written against a plain list must keep working when a delimiter is added",
  );
});

test("an item knows where it is in the list", () => {
  const { items } = parseListLines("a\nb\nc");
  assert.equal(items[0].index, 1);
  assert.equal(items[0].index0, 0);
  assert.equal(items[2].index, 3);
});

// ── Reading it from the run instead ──────────────────────────────────────────

test("a dotted path finds what an earlier step stored", () => {
  const ctx = { api: { rows: [{ id: 1 }, { id: 2 }] } };
  const { items, reason } = itemsFromContext(ctx, "api.rows");
  assert.equal(reason, "");
  assert.equal(items.length, 2);
  assert.equal(items[1].id, 2);
});

test("a path that holds nothing says so, rather than looping zero times", () => {
  const { items, reason } = itemsFromContext({ api: {} }, "api.rows");
  assert.equal(items.length, 0);
  assert.match(
    reason,
    /is not something this run has/,
    "an empty list and a typo look identical from the outside",
  );
});

test("a single object is one item rather than an error", () => {
  const { items, reason } = itemsFromContext(
    { api: { body: { a: 1 } } },
    "api.body",
  );
  assert.equal(reason, "");
  assert.equal(items.length, 1);
  assert.equal(items[0].a, 1);
});

// ── What a run does ──────────────────────────────────────────────────────────

test("a run visits every URL in the pasted list", async () => {
  reset();
  onContentMessage(() => ({ ok: true, result: null }));
  const { runId, runState } = startRun({
    allowedOrigins: new Set(["https://shop.test"]),
  });
  await _dispatchStep(
    listLoop({ lines: "https://shop.test/a\nhttps://shop.test/b" }, [
      navigate("{{item.value}}"),
    ]),
    1,
    runId,
    { extracted: {} },
  );
  assert.deepEqual(visited(), ["https://shop.test/a", "https://shop.test/b"]);
  await endRun(runId);
});

test("a run can build the URL out of a column", async () => {
  reset();
  onContentMessage(() => ({ ok: true, result: null }));
  const { runId } = startRun({
    allowedOrigins: new Set(["https://shop.test"]),
  });
  await _dispatchStep(
    listLoop({ lines: "sku\nX1\nX2", delimiter: ",", hasHeader: true }, [
      navigate("https://shop.test/p/{{item.sku}}"),
    ]),
    1,
    runId,
    { extracted: {} },
  );
  assert.deepEqual(visited(), [
    "https://shop.test/p/X1",
    "https://shop.test/p/X2",
  ]);
  await endRun(runId);
});

test("a run reads the list an earlier step produced", async () => {
  reset();
  onContentMessage(() => ({ ok: true, result: null }));
  const { runId } = startRun({
    allowedOrigins: new Set(["https://shop.test"]),
  });
  await _dispatchStep(
    listLoop({ source: "context", contextPath: "api.rows" }, [
      navigate("https://shop.test/{{item.slug}}"),
    ]),
    1,
    runId,
    { extracted: {}, api: { rows: [{ slug: "one" }, { slug: "two" }] } },
  );
  assert.deepEqual(visited(), [
    "https://shop.test/one",
    "https://shop.test/two",
  ]);
  await endRun(runId);
});

test("the safety max caps the list", async () => {
  reset();
  onContentMessage(() => ({ ok: true, result: null }));
  const { runId } = startRun({
    allowedOrigins: new Set(["https://shop.test"]),
  });
  await _dispatchStep(
    listLoop({ lines: "https://shop.test/a\nhttps://shop.test/b", max: 1 }, [
      navigate("{{item.value}}"),
    ]),
    1,
    runId,
    { extracted: {} },
  );
  // The URL, not just the count: an unrecognised mode falls through to
  // fixed-count and would also navigate once, to an unresolved template.
  assert.deepEqual(visited(), ["https://shop.test/a"]);
  await endRun(runId);
});

test("an empty list is skipped and said out loud", async () => {
  reset();
  const { runId } = startRun();
  await _dispatchStep(
    listLoop({ lines: "   \n\n" }, [navigate("x")]),
    1,
    runId,
    {
      extracted: {},
    },
  );
  assert.equal(visited().length, 0);
  assert.ok(
    calls.runtimeMessages.some((m) =>
      /list is empty/i.test(String(m?.payload?.message ?? "")),
    ),
    "a loop that ran nothing and said nothing is the failure this avoids",
  );
  await endRun(runId);
});

// ── What the exported script does ────────────────────────────────────────────

const pipeline = (config, children) => ({
  name: "list",
  steps: [listLoop(config, children)],
});

test("the Node script carries the list and reads the item", () => {
  const src = emitNode(
    pipeline({ lines: "a\nb" }, [
      navigate("https://x.test/p/{{item.value}}?i={{loop.index}}"),
    ]),
  );
  assert.match(src, /const _items = \[\{/);
  assert.match(src, /for \(let i = 0; i < _items\.length; i\+\+\)/);
  assert.match(
    src,
    /page\.goto\('https:\/\/x\.test\/p\/' \+ String\(_item\["value"\] \?\? ''\)/,
    "an unresolved {{item}} would fetch the same literal URL every time",
  );
  assert.match(src, /String\(_loop\["index"\]/);
  assert.ok(!src.includes("{{item."), "a template survived into the script");
});

test("the Python script does the same thing", () => {
  const src = emitPython(
    pipeline({ lines: "a\nb" }, [navigate("https://x.test/p/{{item.value}}")]),
  );
  assert.match(src, /_items = json\.loads\(/);
  assert.match(src, /for i, _item in enumerate\(_items\)/);
  assert.match(src, /str\(_item\.get\("value", ""\)\)/);
  // Comments are allowed to echo the pipeline as written — that is what they
  // are for. Executable lines are not: a surviving template there is a URL
  // fetched with braces in it.
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  assert.ok(!code.includes("{{item."), "a template survived into the script");
});

test("a list read from the run refuses to export, rather than exporting a loop over nothing", () => {
  for (const [name, emit] of [
    ["node", emitNode],
    ["python", emitPython],
  ]) {
    const src = emit(
      pipeline({ source: "context", contextPath: "api.rows" }, [navigate("x")]),
    );
    assert.match(
      src,
      /not exportable/,
      `${name} exported a loop whose list does not exist outside the extension`,
    );
  }
});

test("the item is in scope for the body and nowhere else", () => {
  // A NAVIGATE after the loop must not read `_item`: it is out of scope there,
  // and the emitted script would not run.
  const src = emitNode({
    name: "list",
    steps: [
      listLoop({ lines: "a" }, [navigate("https://x.test/{{item.value}}")]),
      navigate("https://x.test/after/{{item.value}}"),
    ],
  });
  const after = src.slice(src.indexOf("after/"));
  assert.ok(
    !after.includes("_item"),
    "the resolver leaked past the end of the loop",
  );
});

test("the safety max is applied at export time too", () => {
  const src = emitNode(pipeline({ lines: "a\nb\nc", max: 2 }, [navigate("x")]));
  const items = JSON.parse(
    src.match(/const _items = (\[.*?\]);/s)[1].replace(/\n/g, ""),
  );
  assert.equal(items.length, 2);
});

// ── The panel ────────────────────────────────────────────────────────────────

test("the side panel offers the mode, or it is unreachable", () => {
  const src = readFileSync(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /value="list"/);
  assert.match(src, /data-key="source"/);
  assert.match(src, /data-key="lines"/);
  // The one thing a user would otherwise discover only on pressing Export.
  assert.match(src, /cannot be exported as a script/i);
});
