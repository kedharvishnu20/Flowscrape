// Tests for K-12: a step could be marked `optional` but not "try again".
//
// The registry had one answer to a failing step — give up, and either stop the
// run or skip it. A selector that is flaky rather than wrong (an image that
// loads late, a panel that animates in) therefore lost the row rather than the
// attempt, and the only workaround was a WAIT with a guessed number in it.
//
// The retry loop lives in the executor, so a second attempt is a step like any
// other: it queues behind the rate limiter, it holds while the run is paused,
// and it does not happen at all once the run has been stopped.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RETRY_LIMITS, retryCount, retryDelayMs } from "../utils/step-types.js";
import { initBucket } from "../background/rate-limiter.js";
import {
  _executeSteps,
  startRun,
  endRun,
  calls,
  reset,
  onContentMessage,
} from "./helpers/worker-harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const flaky = (config = {}) => ({
  id: "s1",
  type: "CLICK",
  config: { selector: ".flaky", ...config },
});

const attempts = () =>
  calls.contentMessages.filter((m) => m.payload?.type === "CLICK").length;

const logs = () =>
  calls.runtimeMessages
    .filter((m) => m.type === "pipeline:log")
    .map((m) => m.payload.message);

/** A responder that fails the first `n` calls and then succeeds. */
function failsTimes(n) {
  let seen = 0;
  onContentMessage(async () => {
    seen += 1;
    return seen <= n
      ? { ok: false, error: "nothing matched .flaky" }
      : { ok: true, result: null };
  });
}

test.beforeEach(() => {
  reset();
  // A wide bucket by default, so only the test that is about pacing pays for it.
  initBucket("shop.test", { capacity: 1000, refillRate: 1000 });
});

test("the retry bounds are clamped, not taken as typed", () => {
  assert.equal(retryCount({}), 0, "no retries unless asked for");
  assert.equal(retryCount({ retries: 2 }), 2);
  assert.equal(retryCount({ retries: -3 }), 0);
  assert.equal(retryCount({ retries: "nope" }), 0);
  assert.equal(retryCount({ retries: 99 }), RETRY_LIMITS.maxRetries);

  assert.equal(retryDelayMs({}), RETRY_LIMITS.defaultDelayMs);
  assert.equal(retryDelayMs({ retryDelayMs: 250 }), 250);
  assert.equal(retryDelayMs({ retryDelayMs: -1 }), RETRY_LIMITS.defaultDelayMs);
  assert.equal(
    retryDelayMs({ retryDelayMs: 10 ** 9 }),
    RETRY_LIMITS.maxDelayMs,
  );
});

test("a step that works on the second attempt does not fail the run", async () => {
  const { runId, runState } = startRun();
  failsTimes(1);

  await _executeSteps(
    [flaky({ retries: 2, retryDelayMs: 0 })],
    1,
    runId,
    { extracted: {} },
    { total: 1, count: 0 },
  );

  assert.equal(attempts(), 2, "the step was not tried again");
  assert.ok(runState.active, "the run stopped on a failure it recovered from");
  await endRun(runId);
});

test("a step with no retries still fails on the first attempt", async () => {
  const { runId, runState } = startRun();
  failsTimes(1);

  await _executeSteps(
    [flaky()],
    1,
    runId,
    { extracted: {} },
    { total: 1, count: 0 },
  );

  assert.equal(attempts(), 1);
  assert.equal(
    runState.active,
    false,
    "a failing step no longer stops the run",
  );
  await endRun(runId);
});

test("retries run out, and then the step fails as it always did", async () => {
  const { runId, runState } = startRun();
  failsTimes(99);

  await _executeSteps(
    [flaky({ retries: 2, retryDelayMs: 0 })],
    1,
    runId,
    { extracted: {} },
    { total: 1, count: 0 },
  );

  assert.equal(attempts(), 3, "one attempt plus two retries");
  assert.equal(runState.active, false);
  assert.ok(
    logs().some((m) => /^\[CLICK\] nothing matched \.flaky$/.test(m)),
    `the original failure was not reported: ${logs().join(" | ")}`,
  );
  await endRun(runId);
});

test("an optional step still keeps the run going once its retries are spent", async () => {
  const { runId, runState } = startRun();
  failsTimes(99);

  await _executeSteps(
    [flaky({ retries: 1, retryDelayMs: 0, optional: true })],
    1,
    runId,
    { extracted: {} },
    { total: 1, count: 0 },
  );

  assert.equal(attempts(), 2);
  assert.ok(runState.active, "optional no longer means keep going");
  await endRun(runId);
});

test("every retry is announced in the run log", async () => {
  const { runId } = startRun();
  failsTimes(2);

  await _executeSteps(
    [flaky({ retries: 2, retryDelayMs: 0 })],
    1,
    runId,
    { extracted: {} },
    { total: 1, count: 0 },
  );

  const retryLines = logs().filter((m) => /retry \d+ of 2/.test(m));
  assert.equal(
    retryLines.length,
    2,
    `retries went unlogged: ${logs().join(" | ")}`,
  );
  assert.match(retryLines[0], /\[CLICK\] nothing matched \.flaky/);
  await endRun(runId);
});

test("a stopped run does not go on retrying", async () => {
  const { runId, runState } = startRun();
  failsTimes(99);

  const done = _executeSteps(
    [flaky({ retries: 5, retryDelayMs: 400 })],
    1,
    runId,
    { extracted: {} },
    { total: 1, count: 0 },
  );

  await sleep(150);
  runState.active = false; // what pipeline:stop does
  await done;

  assert.ok(
    attempts() <= 2,
    `Stop was ignored: the step was attempted ${attempts()} times`,
  );
  await endRun(runId);
});

test("a paused run holds its next attempt until it resumes", async () => {
  const { runId, runState } = startRun();
  failsTimes(99);

  const done = _executeSteps(
    [flaky({ retries: 3, retryDelayMs: 50 })],
    1,
    runId,
    { extracted: {} },
    { total: 1, count: 0 },
  );

  await sleep(30);
  runState.paused = true;
  const atPause = attempts();
  await sleep(700); // far longer than the 50ms retry delay

  assert.equal(attempts(), atPause, "the step kept retrying while paused");
  runState.paused = false;
  await done;
  assert.equal(attempts(), 4, "the remaining attempts never happened");
  await endRun(runId);
});

test("a retry queues behind the rate limiter like any other request", async () => {
  // One token, refilled once a second: the first attempt spends it, so a retry
  // that skipped the limiter would land immediately. This is the whole reason
  // the loop is in the executor rather than inside a step handler.
  initBucket("shop.test", { capacity: 1, refillRate: 1 });
  const { runId } = startRun();
  failsTimes(1);

  const started = Date.now();
  await _executeSteps(
    [flaky({ retries: 1, retryDelayMs: 0 })],
    1,
    runId,
    { extracted: {} },
    { total: 1, count: 0 },
  );
  const elapsed = Date.now() - started;

  assert.equal(attempts(), 2);
  assert.ok(
    elapsed >= 800,
    `the retry outran the rate limiter (${elapsed}ms for two attempts)`,
  );
  await endRun(runId);
});

test("the panel offers both retry fields on every step", async () => {
  const src = await readFile(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  // Appended in generateConfigHtml with the iframe toggle, so a new step type
  // cannot ship without them — the same argument that put "optional" there.
  assert.match(src, /html \+= _retryFields\(step\);/);
  const fn = src.match(/function _retryFields\(step\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /"retries"/);
  assert.match(fn, /"retryDelayMs"/);
});
