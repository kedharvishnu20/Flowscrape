// Regression tests for audit finding E-01.
//
// The side panel had no pause control at all, and the worker had no resume
// message: MSG.PIPELINE_PAUSE set runState.paused and only PIPELINE_STOP ever
// cleared it, so pausing a run was a one-way trip to ending it.
//
// Worse, by the time this was found the executor was no longer reading the flag
// either. The old _executePipeline loop waited on it; merging the two step loops
// into one _executeSteps (B-27, f7a742c) dropped the wait, so pause had become a
// no-op that the UI could not reach anyway. That regression was mine.
//
// Putting the wait in _executeSteps rather than back in the top-level loop also
// means it now applies inside LOOP bodies and IF_ELSE branches, which the
// original never did.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  _executeSteps,
  startRun,
  endRun,
  calls,
  reset,
  onContentMessage,
} from "./helpers/worker-harness.mjs";

const swSrc = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);
const panelSrc = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);
const htmlSrc = await readFile(
  new URL("../sidepanel/index.html", import.meta.url),
  "utf8",
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (n) => ({ id: `s${n}`, type: "CLICK", config: { selector: `.c${n}` } });
const clicked = () =>
  calls.contentMessages.filter((m) => m.payload?.type === "CLICK").length;

// Steps have to take long enough for a pause to land mid-run; the harness's
// default responder returns instantly, so every step would be over before the
// test could set the flag.
const STEP_MS = 150;

test.beforeEach(() => {
  reset();
  onContentMessage(async () => {
    await sleep(STEP_MS);
    return { ok: true, result: null };
  });
});

test("a paused run stops before the next step and resumes where it was", async () => {
  const { runId, runState } = startRun();
  const done = _executeSteps([click(1), click(2), click(3)], 1, runId, {
    extracted: {},
  });

  // Pause as soon as the first step is under way.
  await sleep(STEP_MS / 3);
  runState.paused = true;
  const atPause = clicked();
  await sleep(900); // more than the 500ms poll, so a live loop would advance

  assert.equal(clicked(), atPause, "the executor kept running while paused");
  assert.ok(atPause < 3, "paused too late for the test to prove anything");

  runState.paused = false;
  await done;
  assert.equal(clicked(), 3, "the remaining steps ran after resume");
  await endRun(runId);
});

test("pause is honoured inside a loop body", async () => {
  // The wait used to live in the top-level loop only, so a pause during a long
  // LOOP did nothing until the whole loop finished.
  const { runId, runState } = startRun();
  const loop = {
    id: "L",
    type: "LOOP",
    config: { type: "count", max: 4, onFail: "skip" },
    children: [click(1)],
  };
  const done = _executeSteps([loop], 1, runId, { extracted: {} });

  await sleep(STEP_MS / 3);
  runState.paused = true;
  const atPause = clicked();
  await sleep(900);
  assert.equal(clicked(), atPause, "the loop kept iterating while paused");
  assert.ok(atPause < 4);

  runState.paused = false;
  await done;
  assert.equal(clicked(), 4);
  await endRun(runId);
});

test("stopping a paused run releases it rather than deadlocking", async () => {
  const { runId, runState } = startRun();
  const done = _executeSteps([click(1), click(2)], 1, runId, { extracted: {} });
  await sleep(STEP_MS / 3);
  runState.paused = true;
  await sleep(600);

  // What PIPELINE_STOP does. The wait loop has to test active as well as
  // paused, or this never returns.
  runState.active = false;
  runState.paused = false;
  await done;
  assert.ok(clicked() < 2, "the run ended instead of finishing its steps");
  await endRun(runId);
});

// ── the messages ─────────────────────────────────────────────────────────────

test("the worker answers a resume message, not only a pause", () => {
  assert.match(swSrc, /PIPELINE_RESUME: "pipeline:resume"/);
  const handler = swSrc.match(
    /_registerHandler\(MSG\.PIPELINE_RESUME[\s\S]*?\n\}\);/,
  )[0];
  assert.match(handler, /rs\.paused = false/);
  assert.match(handler, /return \{ ok: true, paused: false \}/);
});

test("pause and resume report failure for a run the worker does not have", () => {
  for (const name of ["PIPELINE_PAUSE", "PIPELINE_RESUME"]) {
    const handler = swSrc.match(
      new RegExp(`_registerHandler\\(MSG\\.${name}[\\s\\S]*?\\n\\}\\);`),
    )[0];
    assert.match(
      handler,
      /if \(!rs\) return \{ ok: false/,
      `${name} pretended to succeed for an unknown runId`,
    );
  }
});

test("the executor waits on the flag it is given", () => {
  const fn = swSrc.match(/async function _executeSteps\([\s\S]*?\n\}\n/)[0];
  assert.match(
    fn,
    /while \(runState\.paused && runState\.active\)/,
    "the pause wait was dropped in the B-27 dispatch merge",
  );
});

// ── the control ──────────────────────────────────────────────────────────────

test("the run bar offers a pause button beside stop", () => {
  assert.match(htmlSrc, /id="run-controls"/);
  assert.match(htmlSrc, /id="btn-master-pause"/);
  assert.match(htmlSrc, /id="btn-master-stop"/);
  assert.match(
    htmlSrc,
    /\.hidden \{[^}]*display: none !important/,
    "run-controls carries an inline display:flex that .hidden must beat",
  );
});

test("the button sends pause or resume depending on where the run is", () => {
  const fn = panelSrc.match(
    /btnPause\?\.addEventListener\("click"[\s\S]*?\n  \}\);/,
  )[0];
  assert.match(fn, /const next = !_runState\.paused/);
  assert.match(fn, /next \? MSG\.PIPELINE_PAUSE : MSG\.PIPELINE_RESUME/);
  assert.match(fn, /runId: _runState\.runId/, "the live run is named");
  assert.match(fn, /if \(!res\?\.ok \|\| res\.result\?\.ok === false\)/);
});

test("the label follows the state, and a stop clears it", () => {
  const fn = panelSrc.match(/function _setPausedUI\(paused\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /paused \? "▶ Resume" : "⏸ Pause"/);
  assert.match(fn, /_runState\.paused = paused/);

  const stop = panelSrc.match(/function stopRunUI\(\)[\s\S]*?\n\}/)[0];
  assert.match(stop, /_setPausedUI\(false\)/, "a stopped run must not stay Paused");
  assert.match(stop, /run-controls"\)\?\.classList\.add\("hidden"\)/);
});
