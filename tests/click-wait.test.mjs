// CLICK: waiting for what the click was supposed to cause.
//
// Two failures hide behind one step. "Load more" finishes after the click
// returns, so the next step reads the old rows — and the only answer used to be
// a WAIT step holding a guessed number of milliseconds, too small on a slow day
// and wasteful on a fast one. Meanwhile a click on a real link destroys the
// document that was about to answer, and the worker's reinjection then
// delivered the same click a second time, to whatever happened to match on the
// page that replaced it.
//
// Both are invisible when they happen: the run carries on and the rows are
// simply wrong. So they are tested here rather than trusted.
import test from "node:test";
import assert from "node:assert/strict";

import {
  calls,
  reset,
  startRun,
  endRun,
  onContentMessage,
  setTabStatuses,
  _dispatchStep,
} from "./helpers/worker-harness.mjs";

import { STEP_TYPES } from "../utils/step-types.js";
import { emitNode } from "../script-gen/node-emitter.js";
import { emitPython } from "../script-gen/python-emitter.js";

/** A CLICK step with the given wait configuration. */
const clickStep = (config = {}) => ({
  id: "s1",
  type: "CLICK",
  config: { selector: ".more", ...config },
});

/** The step types the worker was asked to run in the page, in order. */
const pageStepTypes = () =>
  calls.contentMessages.map((m) => m.payload?.type ?? m.type);

/** Chrome's wording when a click took the document away mid-message. */
const teardown = () =>
  Object.assign(
    new Error("The message port closed before a response was received."),
    { name: "Error" },
  );

// ── The step's own shape ─────────────────────────────────────────────────────

test("CLICK offers a wait, so a pipeline need not guess milliseconds", () => {
  const def = STEP_TYPES.CLICK.def;
  assert.equal(def.waitAfter, "none", "the default must not change behaviour");
  assert.ok("waitSelector" in def);
  assert.ok(def.waitTimeoutMs > 0, "a wait that cannot time out is a hang");
});

// ── What the worker does ─────────────────────────────────────────────────────

test("with no wait configured, the click is the whole step", async () => {
  reset();
  onContentMessage(() => ({ ok: true, result: { clicked: 1, matched: 1 } }));
  const { runId } = startRun();
  await _dispatchStep(clickStep(), 1, runId, { extracted: {} });
  assert.deepEqual(pageStepTypes(), ["CLICK"]);
  await endRun(runId);
});

test("'wait for the page to load' polls the tab until it is complete", async () => {
  reset();
  setTabStatuses(["loading", "loading", "complete"]);
  onContentMessage(() => ({ ok: true, result: { clicked: 1, matched: 1 } }));
  const { runId } = startRun();
  await _dispatchStep(clickStep({ waitAfter: "load" }), 1, runId, {
    extracted: {},
  });
  assert.ok(
    calls.tabGets.length >= 3,
    `the worker should have waited out both loading polls, saw ${calls.tabGets.length}`,
  );
  await endRun(runId);
});

test("'wait for an element' asks the page, with the selector and the timeout", async () => {
  reset();
  const seen = [];
  onContentMessage((payload) => {
    seen.push(payload);
    return { ok: true, result: { clicked: 1, matched: 1 } };
  });
  const { runId } = startRun();
  await _dispatchStep(
    clickStep({
      waitAfter: "selector",
      waitSelector: ".row",
      waitTimeoutMs: 4000,
    }),
    1,
    runId,
    { extracted: {} },
  );
  assert.deepEqual(pageStepTypes(), ["CLICK", "WAIT"]);
  assert.equal(seen[1].config.mode, "selector-visible");
  assert.equal(seen[1].config.selector, ".row");
  assert.equal(seen[1].config.timeout, 4000);
  await endRun(runId);
});

test("'wait for an element to go' asks for the disappearing mode", async () => {
  reset();
  const seen = [];
  onContentMessage((payload) => {
    seen.push(payload);
    return { ok: true, result: { clicked: 1, matched: 1 } };
  });
  const { runId } = startRun();
  await _dispatchStep(
    clickStep({ waitAfter: "selector-gone", waitSelector: ".spinner" }),
    1,
    runId,
    { extracted: {} },
  );
  assert.equal(seen[1].config.mode, "selector-gone");
  await endRun(runId);
});

test("'wait for the page to settle' uses the DOM-stable mode", async () => {
  reset();
  const seen = [];
  onContentMessage((payload) => {
    seen.push(payload);
    return { ok: true, result: { clicked: 1, matched: 1 } };
  });
  const { runId } = startRun();
  await _dispatchStep(clickStep({ waitAfter: "settle" }), 1, runId, {
    extracted: {},
  });
  assert.equal(seen[1].config.mode, "DOM-stable");
  await endRun(runId);
});

test("a wait for an element with no selector says so, rather than waiting for nothing", async () => {
  reset();
  onContentMessage(() => ({ ok: true, result: { clicked: 1, matched: 1 } }));
  const { runId } = startRun();
  await assert.rejects(
    () => _dispatchStep(clickStep({ waitAfter: "selector" }), 1, runId, {}),
    /needs a selector/i,
  );
  await endRun(runId);
});

test("an element that never appears fails the step, it does not pass quietly", async () => {
  reset();
  onContentMessage((payload) =>
    payload.type === "WAIT"
      ? { ok: false, error: "timed out waiting for .row" }
      : { ok: true, result: { clicked: 1, matched: 1 } },
  );
  const { runId } = startRun();
  await assert.rejects(
    () =>
      _dispatchStep(
        clickStep({ waitAfter: "selector", waitSelector: ".row" }),
        1,
        runId,
        {},
      ),
    /timed out waiting for \.row/,
  );
  await endRun(runId);
});

// ── The click that navigates ─────────────────────────────────────────────────

test("a click that navigates is not clicked a second time on the new page", async () => {
  reset();
  let clicks = 0;
  onContentMessage((payload) => {
    if (payload.type === "CLICK") {
      clicks++;
      throw teardown();
    }
    return { ok: true, result: null };
  });
  const { runId } = startRun();
  await _dispatchStep(clickStep(), 1, runId, { extracted: {} });
  assert.equal(
    clicks,
    1,
    "the reinjection retry would have delivered the click to the page that replaced it",
  );
  await endRun(runId);
});

test("a click that navigates waits for the new page, even with no wait configured", async () => {
  reset();
  setTabStatuses(["loading", "complete"]);
  onContentMessage((payload) => {
    if (payload.type === "CLICK") throw teardown();
    return { ok: true, result: null };
  });
  const { runId } = startRun();
  await _dispatchStep(clickStep(), 1, runId, { extracted: {} });
  assert.ok(
    calls.tabGets.length >= 2,
    "the next step would otherwise run against a page being replaced",
  );
  await endRun(runId);
});

test("a real click failure is still a failure, not a navigation", async () => {
  reset();
  onContentMessage((payload) =>
    payload.type === "CLICK"
      ? { ok: false, error: "Click target not found" }
      : { ok: true, result: null },
  );
  const { runId } = startRun();
  await assert.rejects(
    () => _dispatchStep(clickStep(), 1, runId, {}),
    /Click target not found/,
  );
  await endRun(runId);
});

// ── What the exported script does ────────────────────────────────────────────

const pipeline = (config) => ({
  name: "wait after click",
  steps: [clickStep(config)],
});

test("the Node script waits for the same thing the pipeline waits for", () => {
  const none = emitNode(pipeline({}));
  assert.ok(
    !/waitForLoadState|waitForSelector/.test(none.split("CLICK")[1] ?? none),
    "a step configured to wait for nothing must not wait",
  );

  assert.match(
    emitNode(pipeline({ waitAfter: "load", waitTimeoutMs: 9000 })),
    /waitForLoadState\('load', \{ timeout: 9000 \}\)/,
  );
  assert.match(
    emitNode(pipeline({ waitAfter: "selector", waitSelector: ".row" })),
    /waitForSelector\('\.row', \{ state: 'visible', timeout: 15000 \}\)/,
  );
  assert.match(
    emitNode(
      pipeline({ waitAfter: "selector-gone", waitSelector: ".spinner" }),
    ),
    /waitForSelector\('\.spinner', \{ state: 'hidden'/,
  );
  assert.match(
    emitNode(pipeline({ waitAfter: "settle" })),
    /waitForLoadState\('networkidle'/,
  );
});

test("the Python script waits for the same thing, and no longer for network idle after every click", () => {
  const none = emitPython(pipeline({}));
  // This is the divergence the step exposed: Python waited for network idle
  // after every click while Node and the extension waited for nothing, so the
  // same pipeline read the page at two different moments.
  assert.ok(
    !/wait_for_load_state\("networkidle"\)/.test(none),
    "an unconditional networkidle wait is a difference the user never asked for",
  );

  assert.match(
    emitPython(pipeline({ waitAfter: "load", waitTimeoutMs: 9000 })),
    /wait_for_load_state\("load", timeout=9000\)/,
  );
  assert.match(
    emitPython(pipeline({ waitAfter: "selector", waitSelector: ".row" })),
    /wait_for_selector\("\.row", state="visible", timeout=15000\)/,
  );
  assert.match(
    emitPython(pipeline({ waitAfter: "settle" })),
    /wait_for_load_state\("networkidle", timeout=15000\)/,
  );
});

test("the side panel offers the wait, or the config is unreachable", async () => {
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(
      new URL("../sidepanel/pipeline-builder.js", import.meta.url),
      "utf8",
    ),
  );
  assert.match(
    src,
    /data-key="waitAfter"/,
    "a config key with no control in the panel is a feature nobody can switch on",
  );
  assert.match(src, /waitSelector/);
});
