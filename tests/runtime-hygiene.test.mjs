// Regression tests for audit findings C-10, B-32, D-12, D-13 and E-19.
//
// C-10: CURRENT_LEVEL was pinned to LEVELS.debug with no way to change it, so
// every call in every module wrote to the console and into a 2000-entry buffer,
// always, in a shipped extension. Nothing ever read or exported that buffer
// either.
//
// B-32: _stepNavigate, _stepScreenshot, _stepLoop and _waitForSelector in the
// content script were unreachable — the service worker executes NAVIGATE,
// SCREENSHOT and LOOP itself and never forwards them — and two of them returned
// a shape no caller read.
//
// D-12: pushRow awaited flush() at the 50-row threshold and let a failure
// propagate, aborting the step that produced the row, while the module docblock
// promised "backpressure-safe pushRow() that never loses data".
//
// D-13: that same docblock described "a ring buffer (fixed-size array with head
// and tail pointers) ... to avoid O(n) copy costs". It is a plain array.
//
// E-19: stopRunUI left _runState.runId set, so a late pipeline:log for the
// finished run still passed the listener's filter.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { logger } from "../utils/logger.js";
import * as rowBuffer from "../checkpoint/row-buffer.js";

const injectorSrc = await readFile(
  new URL("../content/injector.js", import.meta.url),
  "utf8",
);
const panelSrc = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);
const bufferSrc = await readFile(
  new URL("../checkpoint/row-buffer.js", import.meta.url),
  "utf8",
);

// ── C-10: the log level ──────────────────────────────────────────────────────

test("the level can be changed at run time", () => {
  const before = logger.getLevel();
  assert.equal(logger.setLevel("warn"), "warn");
  assert.equal(logger.getLevel(), "warn");
  logger.setLevel(before);
});

test("an unknown level is ignored rather than disabling logging", () => {
  logger.setLevel("info");
  assert.equal(logger.setLevel("chatty"), "info", "the old level stands");
  assert.equal(logger.getLevel(), "info");
});

test("below-threshold entries do not reach the buffer", () => {
  logger.setLevel("warn");
  logger.clearLogs();
  logger.debug("t", "quiet");
  logger.info("t", "also-quiet");
  assert.equal(logger.getLogs().length, 0);
  logger.error("t", "loud");
  assert.equal(logger.getLogs().length, 1);
  logger.clearLogs();
  logger.setLevel("debug");
});

test("the default depends on whether the build is packed", async () => {
  const src = await readFile(
    new URL("../utils/logger.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /function _defaultLevel\(\)/);
  assert.match(src, /getManifest\?\.\(\)\.update_url/);
  assert.match(src, /packed \? LEVELS\.info : LEVELS\.debug/);
  assert.match(src, /let CURRENT_LEVEL/, "it has to be reassignable");
});

// ── B-32: dead content-script handlers ───────────────────────────────────────

test("the unreachable step handlers are gone", () => {
  const code = injectorSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const name of ["_stepNavigate", "_stepScreenshot", "_stepLoop"]) {
    assert.ok(!code.includes(name), `${name} is still referenced`);
  }
  assert.ok(
    !/async function _waitForSelector\(/.test(code),
    "_waitForSelector duplicated _waitForSelectorScoped without the scoping",
  );
});

test("the scoped wait is the one that remains", () => {
  assert.match(injectorSrc, /async function _waitForSelectorScoped\(/);
});

test("the switch no longer claims to handle background-only types", () => {
  const sw = injectorSrc.match(
    /async function _executeStep\(step\) \{[\s\S]*?\n\}/,
  )[0];
  for (const type of ["WEBSITE", "NAVIGATE", "SCREENSHOT", "LOOP"]) {
    assert.ok(!sw.includes(`case "${type}"`), `${type} is still a case`);
  }
  assert.match(sw, /case "CLICK"/, "the page-side types are untouched");
  assert.match(sw, /case "EXTRACT"/);
});

// ── D-12 / D-13: the row buffer ──────────────────────────────────────────────

test("the docblock no longer describes a ring buffer it does not have", () => {
  // The correction quotes the old claim, so assert on the correction rather
  // than on the absence of a phrase this very fix had to write down.
  assert.match(bufferSrc, /It is a plain array, and always was/);
  assert.match(bufferSrc, /The description is corrected rather than the code/);
  assert.ok(
    !/Provides backpressure-safe pushRow\(\) that never loses data/.test(
      bufferSrc,
    ),
    "the unqualified promise is gone",
  );
});

test("a failing flush does not take the step down with it", async () => {
  const runId = "run_backpressure";
  rowBuffer.initBuffer(runId);

  // Break the write path the way a busy or blocked IndexedDB would.
  const realOpen = globalThis.indexedDB.open;
  globalThis.indexedDB.open = () => {
    throw new Error("IndexedDB unavailable");
  };

  try {
    for (let i = 0; i < 60; i++) {
      await rowBuffer.pushRow(runId, { i });
    }
  } finally {
    globalThis.indexedDB.open = realOpen;
  }

  // Getting here at all is the fix: the 50th push used to throw.
  await rowBuffer.finalizeBuffer(runId).catch(() => {});
});

test("rows survive a failed flush and are written by the next one", async () => {
  const runId = "run_retry";
  rowBuffer.initBuffer(runId);

  const realOpen = globalThis.indexedDB.open;
  globalThis.indexedDB.open = () => {
    throw new Error("IndexedDB unavailable");
  };
  for (let i = 0; i < 55; i++) await rowBuffer.pushRow(runId, { i });
  globalThis.indexedDB.open = realOpen;

  await rowBuffer.finalizeBuffer(runId);
  const rows = await rowBuffer.readAllRows(runId);
  assert.equal(rows.length, 55, "nothing was lost while IndexedDB was down");
});

test("a buffer that can never flush is bounded, and says what it dropped", () => {
  assert.match(bufferSrc, /const MAX_BUFFERED_ROWS = 5000;/);
  const fn = bufferSrc.match(
    /function _trimOverflow\(runId\) \{[\s\S]*?\n\}/,
  )[0];
  assert.match(fn, /buf\.splice\(0, dropped\)/, "oldest first");
  assert.match(fn, /if \(total === dropped\)/, "warned once, not per row");
  assert.match(fn, /buffer-overflow/);
});

test("finalizing reports what was dropped, and the export adds it in", async () => {
  const runId = "run_clean";
  rowBuffer.initBuffer(runId);
  await rowBuffer.pushRow(runId, { a: 1 });
  const { dropped } = await rowBuffer.finalizeBuffer(runId);
  assert.equal(dropped, 0);
  assert.equal(
    rowBuffer.droppedRowCount(runId),
    0,
    "and the counter is cleared",
  );

  const swSrc = await readFile(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(
    swSrc,
    /droppedRowCount\(runId\)/,
    "counted in the export total",
  );
});

test("a large failed flush is restored without spreading it into a call", () => {
  const fn = bufferSrc.match(
    /export async function flush\(runId\) \{[\s\S]*?\n\}/,
  )[0];
  assert.match(fn, /_buffers\.set\(runId, toWrite\.concat\(buf\)\)/);
  const code = fn.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/unshift\(\.\.\.toWrite\)/.test(code),
    "spreading a large array into unshift blows the argument limit",
  );
});

// ── E-19: the stale run id ───────────────────────────────────────────────────

test("stopping a run clears the id the log filter matches on", () => {
  const fn = panelSrc.match(/function stopRunUI\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /_runState\.runId = null;/);
  assert.match(
    fn,
    /_runState\.timer = null;/,
    "and the cleared interval handle",
  );
});

test("the finished run stays downloadable", () => {
  const fn = panelSrc.match(/function stopRunUI\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /_lastRunId = _runState\.runId \?\? _lastRunId;/);
  assert.ok(
    fn.indexOf("_lastRunId =") < fn.indexOf("_runState.runId = null"),
    "captured before it is cleared",
  );
  assert.match(
    panelSrc,
    /_downloadRunRows\(_runState\.runId \?\? _lastRunId\)/,
  );
});
