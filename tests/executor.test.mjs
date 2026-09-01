// Behavioural tests for the step executor, covering audit finding B-27.
//
// The dispatch chain existed twice — once in _executeStepList for loop and
// branch bodies, once inline in _executePipeline for top-level steps — and the
// copies had already drifted: only the nested one flushed the row buffer before
// an EXPORT, so exporting from the root silently missed anything still in
// memory. Adding the B-03 origin check meant patching four sites instead of
// two, which is what made the duplication worth removing.
//
// This is the first behavioural coverage the executor has had.
import test from "node:test";
import assert from "node:assert/strict";
import {
  calls,
  reset,
  onContentMessage,
  startRun,
  endRun,
  _dispatchStep,
  _executeSteps,
  _executeStepList,
} from "./helpers/worker-harness.mjs";

const step = (type, config = {}, extra = {}) => ({
  id: `s_${type}`,
  type,
  config,
  ...extra,
});

const ctx = () => ({ extracted: {} });

test("NAVIGATE drives the tab", async () => {
  reset();
  const { runId, runState } = startRun();

  await _dispatchStep(
    step("NAVIGATE", { url: "https://shop.test/products" }),
    1,
    runId,
    ctx(),
  );

  assert.equal(calls.tabUpdates.length, 1);
  assert.equal(calls.tabUpdates[0].url, "https://shop.test/products");
  await endRun(runId);
});

test("NAVIGATE to an undeclared origin is refused", async () => {
  reset();
  const { runId } = startRun();

  await assert.rejects(
    () => _dispatchStep(step("NAVIGATE", { url: "https://evil.test/x" }), 1, runId, ctx()),
    /UndeclaredOrigin|evil\.test/,
  );
  assert.equal(calls.tabUpdates.length, 0, "the tab was never sent there");
  await endRun(runId);
});

test("a page step is forwarded to the content script", async () => {
  reset();
  const { runId } = startRun();
  onContentMessage(() => ({ ok: true, result: { clicked: 1 } }));

  await _dispatchStep(step("CLICK", { selector: ".buy" }), 1, runId, ctx());

  assert.equal(calls.contentMessages.length, 1);
  assert.equal(calls.contentMessages[0].payload.type, "CLICK");
  await endRun(runId);
});

test("a failing page step throws with the content script's message", async () => {
  reset();
  const { runId } = startRun();
  onContentMessage(() => ({ ok: false, error: "Click target not found" }));

  await assert.rejects(
    () => _dispatchStep(step("CLICK", { selector: ".nope" }), 1, runId, ctx()),
    /Click target not found/,
  );
  await endRun(runId);
});

test("EXTRACT rows land in the run and in the context", async () => {
  reset();
  const { runId, runState } = startRun();
  onContentMessage(() => ({
    ok: true,
    result: [{ name: "Widget", price: "10" }, { name: "Gadget", price: "20" }],
  }));

  const context = ctx();
  await _dispatchStep(step("EXTRACT", { fields: [] }), 1, runId, context);

  assert.equal(runState.results.length, 2);
  assert.equal(
    context.extracted.name,
    "Gadget",
    "the last row is exposed to {{extracted.*}} for later steps",
  );
  await endRun(runId);
});

test("an API result is stored under its configured name", async () => {
  reset();
  const { runId } = startRun({
    allowedOrigins: new Set(["https://shop.test", "https://api.shop.test"]),
  });

  const context = ctx();
  await _dispatchStep(
    step("API", { url: "https://api.shop.test/x", storeAs: "lookup" }),
    1,
    runId,
    context,
  );

  assert.equal(context.lookup.status, 200);
  assert.equal(context.api.status, 200, "also available under the default name");
  await endRun(runId);
});

// ── the divergence that prompted the merge ───────────────────────────────────

test("EXPORT flushes buffered rows before writing", async () => {
  // The top-level copy of the chain did not do this, so exporting from the root
  // of a pipeline missed anything still sitting in the row buffer.
  reset();
  const { runId, runState } = startRun();
  onContentMessage(() => ({ ok: true, result: [{ name: "Widget" }] }));

  const context = ctx();
  await _executeSteps(
    [step("EXTRACT", { fields: [] }), step("EXPORT", { format: "csv" })],
    1,
    runId,
    context,
    { count: 0, total: 2 },
  );

  assert.equal(calls.downloads.length, 1, "the export happened");
  assert.match(calls.downloads[0].filename, /\.csv$/);
  await endRun(runId);
});

// ── error policy ─────────────────────────────────────────────────────────────

test("an optional step that fails is skipped, and the run continues", async () => {
  reset();
  const { runId, runState } = startRun();
  onContentMessage((payload) =>
    payload.type === "CLICK"
      ? { ok: false, error: "not found" }
      : { ok: true, result: null },
  );

  await _executeSteps(
    [
      step("CLICK", { selector: ".missing", optional: true }),
      step("WAIT", { ms: 1 }),
    ],
    1,
    runId,
    ctx(),
    { count: 0, total: 2 },
  );

  assert.equal(runState.active, true, "the run was not stopped");
  const warned = calls.runtimeMessages.some(
    (m) => m.type === "pipeline:log" && /optional, skipping/.test(m.payload?.message ?? ""),
  );
  assert.ok(warned, "and the skip was reported rather than hidden");
  await endRun(runId);
});

test("a required step that fails stops the run at the top level", async () => {
  reset();
  const { runId, runState } = startRun();
  onContentMessage(() => ({ ok: false, error: "boom" }));

  await _executeSteps(
    [step("CLICK", { selector: ".x" }), step("WAIT", { ms: 1 })],
    1,
    runId,
    ctx(),
    { count: 0, total: 2 },
  );

  assert.equal(runState.active, false, "the run stopped");
  await endRun(runId);
});

test("a required step that fails inside a loop body propagates", async () => {
  // Nested lists must throw so the enclosing LOOP can apply its own onFail
  // setting, rather than silently ending the whole run.
  reset();
  const { runId, runState } = startRun();
  onContentMessage(() => ({ ok: false, error: "boom" }));

  await assert.rejects(
    () => _executeStepList([step("CLICK", { selector: ".x" })], 1, runId, ctx()),
    /boom/,
  );
  assert.equal(runState.active, true, "the run itself is still alive");
  await endRun(runId);
});

test("an optional step inside a loop body is also skipped", async () => {
  // Previously only the top-level chain honoured `optional`; nested, any failure
  // aborted the iteration.
  reset();
  const { runId } = startRun();
  onContentMessage((payload) =>
    payload.type === "CLICK"
      ? { ok: false, error: "not found" }
      : { ok: true, result: null },
  );

  await assert.doesNotReject(() =>
    _executeStepList(
      [step("CLICK", { selector: ".missing", optional: true }), step("WAIT", { ms: 1 })],
      1,
      runId,
      ctx(),
    ),
  );
  await endRun(runId);
});

// ── context and progress ─────────────────────────────────────────────────────

test("templates are resolved against the live context", async () => {
  reset();
  const { runId } = startRun();
  onContentMessage(() => ({ ok: true, result: [{ slug: "widget" }] }));

  await _executeSteps(
    [
      step("EXTRACT", { fields: [] }),
      step("NAVIGATE", { url: "https://shop.test/p/{{extracted.slug}}" }),
    ],
    1,
    runId,
    ctx(),
    { count: 0, total: 2 },
  );

  assert.equal(
    calls.tabUpdates[0].url,
    "https://shop.test/p/widget",
    "the EXTRACT result fed the next step's URL",
  );
  await endRun(runId);
});

test("a nested list does not leak its extractions into the parent", async () => {
  reset();
  const { runId } = startRun();
  onContentMessage(() => ({ ok: true, result: [{ inner: "value" }] }));

  const parent = ctx();
  await _executeStepList([step("EXTRACT", { fields: [] })], 1, runId, parent);

  assert.equal(parent.extracted.inner, undefined, "the parent context is untouched");
  await endRun(runId);
});

test("top-level progress is reported; nested progress is not", async () => {
  reset();
  const { runId } = startRun();
  onContentMessage(() => ({ ok: true, result: null }));

  await _executeSteps([step("WAIT", { ms: 1 })], 1, runId, ctx(), {
    count: 0,
    total: 5,
  });
  const top = calls.runtimeMessages.find((m) => m.type === "pipeline:status");
  assert.equal(top.payload.progress.total, 5);

  reset();
  await _executeStepList([step("WAIT", { ms: 1 })], 1, runId, ctx());
  const nested = calls.runtimeMessages.find((m) => m.type === "pipeline:status");
  assert.deepEqual(nested.payload.progress, {}, "a loop body has no total to report");
  await endRun(runId);
});

test("a stopped run halts before the next step", async () => {
  reset();
  const { runId, runState } = startRun();
  onContentMessage(() => {
    runState.active = false; // as the stop handler would
    return { ok: true, result: null };
  });

  await _executeSteps(
    [step("CLICK", { selector: ".a" }), step("CLICK", { selector: ".b" })],
    1,
    runId,
    ctx(),
    { count: 0, total: 2 },
  );

  assert.equal(calls.contentMessages.length, 1, "the second step never ran");
  await endRun(runId);
});
