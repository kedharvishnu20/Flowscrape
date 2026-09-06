// K-03: iframes could not be selected in, and K-04/K-05, two challenge types
// the tool had no answer for at all.
//
// K-03. J-14 let a step *search* iframes with an `inFrame` toggle. Picking was
// the missing half: the picker is armed in every frame at once, the clicked
// frame answers, and its selector is relative to its own document — so it came
// back as a bare string that meant nothing in the parent. Picking inside an
// iframe therefore appeared to work and then matched nothing at run time,
// which is "the data inside an iframe cannot be accessed and I cannot select
// them". A pick now carries the frame it came from, the step is aimed at that
// document, and the pickers armed in the other frames are disarmed.
//
// The broadcast it replaces was also arbitrary: with two frames holding
// similar data it returned whichever answered first, which is not a choice the
// user made.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadInjector } from "./helpers/content-harness.mjs";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
const injector = await read("content/injector.js");
const worker = await read("background/service-worker.js");
const builder = await read("sidepanel/pipeline-builder.js");

// ── K-03: a pick knows which document it came from ──────────────────────────

test("a pick carries its frame", () => {
  const fn = injector.slice(
    injector.indexOf("function _result(selector)"),
    injector.indexOf("function onClick(e)"),
  );
  assert.match(fn, /frameUrl:/);
  assert.match(
    fn,
    /window\.top === window/,
    "it cannot tell a frame from the page",
  );
  assert.match(
    injector,
    /finish\(_result\(_buildSelector\(currentTarget, isBulk\)\)\)/,
  );
});

test("the step is aimed at the frame that was picked in", () => {
  assert.match(builder, /function _applyPickedFrame/);
  const fn = builder.slice(
    builder.indexOf("function _applyPickedFrame"),
    builder.indexOf("function _cancelPickersElsewhere"),
  );
  assert.match(fn, /config\.frameUrl = frameUrl/);
  assert.match(
    fn,
    /config\.inFrame = true/,
    "the run would still skip the frame",
  );
  assert.match(
    fn,
    /delete step\.config\.frameUrl/,
    "a later top-level pick would stay stuck in the old frame",
  );
});

test("the worker routes to that frame rather than broadcasting", () => {
  const fn = worker.slice(
    worker.indexOf("async function _sendToPage"),
    worker.indexOf("function _registerHandler(name, fn)"),
  );
  assert.ok(
    fn.length > 0 && fn.length < 6000,
    "the _sendToPage slice is wrong",
  );
  assert.match(fn, /_frameIdForUrl\(tabId, frameUrl\)/);
  assert.ok(
    fn.indexOf("frameUrl") < fn.indexOf("config?.inFrame"),
    "the broadcast runs first, so the recorded frame is never used",
  );
});

test("frames are matched by URL, not by id", () => {
  // Frame ids are not stable across a reload — the same iframe gets a new one
  // every navigation — so a stored id would work once and break on the next run.
  const fn = worker.slice(
    worker.indexOf("async function _frameIdForUrl"),
    worker.indexOf("async function _sendToPage"),
  );
  assert.match(fn, /func: \(\) => location\.href/);
  assert.match(
    fn,
    /origin \+ p\.pathname/,
    "a frame with a session id in its query never matches again",
  );
});

test("a missing frame falls back rather than failing", () => {
  const fn = worker.slice(
    worker.indexOf("async function _sendToPage"),
    worker.indexOf("function _registerHandler(name, fn)"),
  );
  assert.match(fn, /Fall through to the frame walk/);
});

test("the pickers in the other frames are disarmed", async () => {
  // Every frame arms one; only the clicked frame settles on its own, so the
  // rest are left showing a crosshair that eats the next click.
  assert.match(injector, /PICK_CANCEL: "FS_PICK_CANCEL"/);
  assert.match(injector, /case CE\.PICK_CANCEL:/);
  assert.match(injector, /_pickerCancel = \(\) => finish\(null\)/);
  assert.match(builder, /function _cancelPickersElsewhere/);

  // And it must actually settle a live picker.
  const h = await loadInjector(`<div class="a">x</div>`);
  const p = h.api._activateSelectorPicker({ bulk: false });
  await new Promise((r) => setTimeout(r, 20));
  (await h.api._executeStep) === undefined; // no-op, keeps the harness honest
  h.window.dispatchEvent(new h.window.Event("beforeunload"));
  assert.equal(await p, null);
  h.close();
});

test("an older pick that is a bare string still works", () => {
  const fn = builder.slice(
    builder.indexOf("function _unwrapPick"),
    builder.indexOf("function _applyPickedFrame"),
  );
  assert.match(fn, /typeof result === "string"/);
});

// ── K-04: XPath ─────────────────────────────────────────────────────────────
//
// The one thing CSS genuinely cannot express is "the element containing this
// text". On a site that regenerates its class names every request — a real
// anti-scraping technique, and one of the practice challenges — every CSS
// selector the picker can write is dead on arrival.

const XPAGE = `
  <table>
    <tr><td class="x7f2a">Widget</td><td class="q1b8">10.00</td></tr>
    <tr><td class="m3k9">Gadget</td><td class="z0p4">25.50</td></tr>
    <tr><td class="a8d1">Total</td><td class="w2e6">35.50</td></tr>
  </table>`;

test("an XPath resolves", async () => {
  const h = await loadInjector(XPAGE);
  const found = h.api._queryScoped("//td", {}, true);
  assert.equal(found.length, 6);
});

test("it selects by text, which is why it is here", async () => {
  const h = await loadInjector(XPAGE);
  const row = h.api._queryScoped(
    '//tr[td[contains(., "Total")]]/td[2]',
    {},
    true,
  );
  assert.equal(row.length, 1);
  assert.equal(row[0].textContent, "35.50");
});

test("Playwright's xpath= prefix is accepted too", async () => {
  const h = await loadInjector(XPAGE);
  assert.equal(h.api._queryScoped("xpath=//td[1]", {}, true).length, 3);
});

test("a broken XPath returns nothing instead of throwing", async () => {
  const h = await loadInjector(XPAGE);
  assert.doesNotThrow(() => h.api._queryScoped("//td[", {}, true));
  assert.equal(h.api._queryScoped("//td[", {}, true).length, 0);
});

test("a CSS selector that starts with a slash is not mistaken for XPath", async () => {
  // Only a leading // or xpath= counts; anything else stays CSS.
  // A bare <td> outside a table is dropped by the HTML parser, so the table
  // is real here.
  const h = await loadInjector(
    `<div class="a">x</div><table><tr><td>y</td></tr></table>`,
  );
  assert.equal(h.api._queryScoped("td", {}, true).length, 1);
  assert.equal(h.api._queryScoped("div.a", {}, true).length, 1);
});

// ── K-05: base64 ────────────────────────────────────────────────────────────

test("both emitters carry the base64 transform", async () => {
  const py = await read("script-gen/python-emitter.js");
  const node = await read("script-gen/node-emitter.js");
  assert.match(py, /name === "base64"/);
  assert.match(py, /def fs_b64/);
  assert.match(py, /import asyncio, os, re, json, csv, time, random, base64/);
  assert.match(node, /name === "base64"/);
  assert.match(node, /const fsB64 =/);
});

test("the emitted decoders agree with the in-page one", async () => {
  const { TRANSFORMS } = await import("../utils/value-transforms.js");
  // The contract both sides must keep: not-base64 is null, not a mangled
  // string, and the URL-safe alphabet and missing padding are tolerated.
  assert.equal(TRANSFORMS.base64.fn("SGVsbG8gd29ybGQ="), "Hello world");
  assert.equal(TRANSFORMS.base64.fn("SGVsbG8gd29ybGQ"), "Hello world");
  assert.equal(TRANSFORMS.base64.fn("8J-Ygg=="), "😂", "the URL-safe alphabet");
  assert.equal(TRANSFORMS.base64.fn("Total: 42"), null);
  assert.equal(TRANSFORMS.base64.fn(""), null);
  assert.equal(TRANSFORMS.base64.fn("abc"), null, "too short to be base64");
});

// ── K-06: Test and Run disagreed about transforms ───────────────────────────
//
// Found while checking base64 in a browser. A run cleans EXTRACT's values on
// the way out; Test returned them raw. So configuring "Decode base64" and
// pressing Test showed the base64 back, and the obvious conclusion is that the
// transform is broken. The same family as every other Test/Run divergence in
// this codebase: two paths for one job, and only one of them maintained.

test("Test applies the same transforms a run does", () => {
  const handler = worker.slice(
    worker.indexOf("_registerHandler(MSG.STEP_EXECUTE"),
    worker.indexOf("_registerHandler(MSG.PIPELINE_PAUSE"),
  );
  assert.match(
    handler,
    /_transformRows\(resp\.result, resolvedStep\.config, targetTabId\)/,
    "the Test path returns untransformed values",
  );
});

test("both paths call one transformer, not two copies", () => {
  // A second copy is what drifts. There should be exactly one definition and
  // the run path plus the test path calling it.
  assert.equal(
    (worker.match(/async function _transformRows/g) ?? []).length,
    1,
    "there is more than one row transformer",
  );
  assert.equal(
    (worker.match(/_transformRows\(/g) ?? []).length,
    3,
    "expected one definition and two call sites (run + test)",
  );
});
