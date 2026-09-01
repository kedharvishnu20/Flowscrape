// Regression tests for audit findings D-01, B-26 and D-14.
//
// D-01: _runStates is a plain in-memory Map. MV3 terminates an idle worker, so
// a run in flight simply vanishes — no completion event, the side panel's Stop
// button stays visible forever, and the rows already written to IndexedDB are
// orphaned under a runId the UI has forgotten. The service worker's own
// docblock claimed "All state is persisted to storage before every await to
// survive SW termination". It was not.
//
// Resuming the pipeline itself is not attempted here — that would mean
// re-entering the step chain with the right context against a tab that may have
// navigated. What is fixed is the silence: the loss is detected and the data
// stays reachable.
//
// B-26: markRunCompleted was exported and called from nowhere, so cursors
// accumulated forever and every finished run kept showing up as resumable.
//
// D-14: the partial download passed the string "latest" when no runId was
// known. It matched no index key, so the tool reported "no data" instead of an
// error.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startRun, endRun, _runStates } from "./helpers/worker-harness.mjs";
import {
  saveCursor,
  listCursors,
  deleteCursor,
} from "../checkpoint/cursor-store.js";
import {
  getResumePayload,
  markRunCompleted,
} from "../checkpoint/resume-manager.js";

const swSrc = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);
const panelSrc = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);

async function clearCursors() {
  for (const c of await listCursors()) await deleteCursor(c.runId);
}

test("a finished run stops being reported as resumable", async () => {
  await clearCursors();
  await saveCursor({ runId: "run_done", rowIndex: 3, stepIndex: 3 });

  assert.equal((await getResumePayload()).hasResumable, true);
  await markRunCompleted("run_done");
  assert.equal(
    (await getResumePayload()).hasResumable,
    false,
    "cursors used to accumulate forever because nothing called this",
  );
});

test("the executor marks a completed run, but keeps a stopped one", () => {
  // A run the user stopped keeps its cursor, because its rows are still worth
  // recovering; a run that finished has nothing left to recover.
  assert.match(
    swSrc,
    /if \(stateStr === "completed"\) \{\s*\n\s*await markRunCompleted\(runId\)/,
    "completion clears the cursor",
  );
  assert.match(
    swSrc,
    /import \{\s*\n\s*getResumePayload,\s*\n\s*markRunCompleted,/,
  );
});

test("an interrupted run stays resumable and keeps its rows", async () => {
  await clearCursors();
  await saveCursor({ runId: "run_killed", rowIndex: 7, stepIndex: 2 });

  const payload = await getResumePayload();
  assert.equal(payload.hasResumable, true);
  assert.equal(payload.runs[0].runId, "run_killed");
  assert.equal(payload.runs[0].rowIndex, 7, "how far it got is preserved");
  await clearCursors();
});

// ── telling a lost run from a finished one ───────────────────────────────────

test("pipeline:status distinguishes unknown from not-running", () => {
  const handler = swSrc.match(
    /_registerHandler\(MSG\.PIPELINE_STATUS[\s\S]*?\n\}\);/,
  )[0];

  assert.match(handler, /known: false/, "a run this worker never heard of");
  assert.match(handler, /known: true/, "a run it is tracking");
  assert.ok(
    !/\.\.\.\(_runStates\.get/.test(handler),
    "spreading the run state leaked internals and could not express 'unknown'",
  );
});

test("an unknown runId reports known:false", async () => {
  // The handler is registered inside the worker's message bus, so exercise the
  // condition it turns on directly: a runId absent from _runStates.
  assert.equal(_runStates.has("run_never_existed"), false);

  const { runId } = startRun();
  assert.equal(_runStates.has(runId), true, "a live run is present");
  await endRun(runId);
  assert.equal(_runStates.has(runId), false, "and gone once it ends");
});

test("the panel polls while a run is in flight", () => {
  assert.match(panelSrc, /async function _checkRunAlive\(\)/);
  assert.match(
    panelSrc,
    /if \(\+\+ticks % 5 === 0\) _checkRunAlive\(\);/,
    "checked every 5s from the monitor timer",
  );
});

test("no answer is treated as a waking worker, not a dead run", () => {
  const fn = panelSrc.match(/async function _checkRunAlive\(\)[\s\S]*?\n\}/)[0];
  assert.match(
    fn,
    /if \(!res\?\.ok\) return;/,
    "an unanswered poll must not declare the run dead",
  );
  assert.match(fn, /if \(res\.result\?\.known\) return;/);
});

test("a lost run resets the UI and says what happened", () => {
  const fn = panelSrc.match(/async function _checkRunAlive\(\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /stopRunUI\(\)/, "the Stop button stops being offered");
  assert.match(fn, /Interrupted/);
  assert.match(fn, /still recoverable/, "and points at the data");
  assert.match(fn, /_showResumeBanner\(\)/);
});

// ── the download path ────────────────────────────────────────────────────────

test("data:download refuses a missing runId instead of returning nothing", () => {
  const handler = swSrc.match(
    /_registerHandler\("data:download"[\s\S]*?\n\}\);/,
  )[0];
  assert.match(
    handler,
    /if \(!runId\) \{/,
    "a missing id is an error, not a lookup",
  );
  assert.match(handler, /requires a runId/);
  assert.match(
    handler,
    /readAllRows\(runId\)/,
    "the caller's id is used verbatim",
  );
});

test("the resume banner downloads each run by its own id", () => {
  assert.match(panelSrc, /async function _downloadRunRows\(runId\)/);
  assert.match(
    panelSrc,
    /btn\.addEventListener\("click", \(\) => _downloadRunRows\(run\.runId\)\)/,
    "the banner used to delegate to a button that had no runId to pass",
  );
  assert.match(
    panelSrc,
    /_downloadRunRows\(_runState\.runId\)/,
    "the monitor button passes the live run id rather than a sentinel",
  );

  // Asserting the *absence* of a string in source keeps matching the comment
  // that explains its removal, so check the code with comments stripped.
  const code = panelSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/"latest"/.test(code), "no sentinel remains in executable code");
});

test("the banner is built as nodes, not markup", () => {
  const fn = panelSrc.match(
    /async function _showResumeBanner\(\)[\s\S]*?\n\}/,
  )[0];
  assert.ok(!/innerHTML/.test(fn), "run ids and counts go in as text");
  assert.match(fn, /document\.createElement\("button"\)/);
});
