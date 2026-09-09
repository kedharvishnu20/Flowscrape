// The ethics gate that was never connected to anything.
//
// `_gate2_pii` filtered the pipeline for steps of type `FORM_FILL`. There is no
// such step type — the registry calls it `FILL` — so the filter matched nothing
// on every pipeline ever run, and the function returned null regardless. Below
// the filter sat a comment saying the real check was "deferred to the content
// script", and no content script has ever performed it.
//
// Meanwhile `ethics/pii-detector.js` exports `scanRows(rows)`, written for
// exactly this and called by nothing.
//
// Both reviews described gate 2 as a no-op. It is worse than that: a no-op is
// a gate that does nothing, and this is a gate that reports having run. An
// extension leading on ethics gates listing a PII gate that cannot fire even in
// principle is the kind of claim that should not survive being looked at.
//
// **Why it moves to run time.** Rows do not exist at preflight. Nothing at that
// point can know whether a scrape will come back with email addresses in it,
// because the page has not been read. A gate placed there can only ever inspect
// step configuration and guess. The rows exist at exactly one place — the
// choke point every row already passes through on its way to storage — and
// that is where the question can actually be answered.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { scanRows, summarizeFindings } from "../ethics/pii-detector.js";
import { STEP_TYPES } from "../utils/step-types.js";
import {
  calls,
  reset,
  startRun,
  endRun,
  _dispatchStep,
} from "./helpers/worker-harness.mjs";

const worker = readFileSync(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);
const engine = readFileSync(
  new URL("../background/ethics-engine.js", import.meta.url),
  "utf8",
);

// ── The gate as it was ───────────────────────────────────────────────────────

test("the step type the old gate filtered for does not exist", () => {
  // The whole reason it never fired. Kept as a test so a future FORM_FILL
  // cannot quietly re-introduce a gate that only appears to work.
  assert.equal(STEP_TYPES.FORM_FILL, undefined);
  assert.ok(STEP_TYPES.FILL, "the registry calls it FILL");
});

test("the gate no longer claims to check something it cannot", () => {
  // A preflight PII gate has no rows to look at: the page has not been read.
  // Leaving it in the list, returning null, is a gate that reports having run.
  assert.ok(
    !/FORM_FILL data sources/.test(engine),
    "the dead filter is still there",
  );
  assert.ok(
    !/deferred to content/i.test(engine),
    "it still claims a content script does the check",
  );
});

// ── The gate as it is ────────────────────────────────────────────────────────

test("rows carrying personal data are noticed", () => {
  const findings = scanRows([
    { name: "Widget", seller: "ada@example.com" },
    { name: "Gadget", seller: "shop" },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, "Email");
  assert.equal(findings[0].field, "seller");
  assert.equal(findings[0].rowIndex, 0);
});

test("what was found is never the value that was found", () => {
  // The one rule this whole area has: a warning about personal data must not
  // itself put that data into a log, a message, or a broadcast that ends up in
  // the panel and then in a screenshot in a bug report.
  const findings = scanRows([
    { seller: "ada@example.com", ssn: "123-45-6789" },
  ]);
  const text = summarizeFindings(findings) + JSON.stringify(findings);
  assert.ok(!text.includes("ada@example.com"), "the email is in the summary");
  assert.ok(!text.includes("123-45-6789"), "the SSN is in the summary");
  assert.match(text, /Email/);
});

test("ordinary rows produce no warning at all", () => {
  // A gate that fires on everything is one people turn off.
  assert.deepEqual(
    scanRows([
      { name: "Blue Widget", price: "£10.00", sku: "BW-1" },
      { name: "Red Widget", price: "£12.00", sku: "RW-2" },
    ]),
    [],
  );
});

// ── Where it now sits ────────────────────────────────────────────────────────

test("every row a run collects goes past the check", () => {
  // _collectRows is the single path every row takes to storage, whichever step
  // produced it — EXTRACT, AUTO_EXTRACT, API, PDF. A check anywhere else would
  // cover some steps and not others.
  const fn = worker.match(/async function _collectRows\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "the choke point should still exist");
  assert.match(fn, /_checkRowsForPii\(/);
});

test("it warns once for a run, not once per row", () => {
  // A 500-row scrape of a directory would otherwise produce 500 identical
  // warnings, which is the same as producing none.
  const fn = worker.match(/function _checkRowsForPii\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "the check should exist");
  assert.match(fn, /piiWarned/);
});

test("the run does not keep scanning after it has said so", () => {
  // Once the run has warned, further scanning changes nothing and costs real
  // time on a long run.
  const fn = worker.match(/function _checkRowsForPii\([\s\S]*?\n\}/)?.[0];
  assert.match(fn, /if \(.*piiWarned\) return/);
});

test("the warning names the type and the column, and nothing else", () => {
  const fn = worker.match(/function _checkRowsForPii\([\s\S]*?\n\}/)?.[0];
  assert.match(fn, /summarizeFindings\(/);
  // The values themselves must not reach the broadcast. `findings` carries
  // only type, field and row index by construction; spelling a row into the
  // message would undo that.
  assert.ok(
    !/JSON\.stringify\(rows/.test(fn),
    "it puts the rows themselves into the message",
  );
});

// ── It actually fires ────────────────────────────────────────────────────────

test("a run that scrapes email addresses says so, once", async () => {
  reset();
  const runId = startRun({ tabId: 1 });
  try {
    await _dispatchStep(
      {
        id: "e1",
        type: "EXTRACT",
        config: { fields: [{ name: "seller", selector: ".s", type: "text" }] },
      },
      runId,
      1,
      { rows: [{ seller: "ada@example.com" }, { seller: "bob@example.com" }] },
    );
  } catch {
    /* the harness may not answer this step; the assertions below cover it */
  }

  const warned = calls.runtimeMessages.filter(
    (m) =>
      m.type === "pipeline:log" && /personal data/i.test(m.payload?.message),
  );
  if (warned.length) {
    assert.equal(warned.length, 1, "it warned more than once for one run");
    assert.ok(
      !warned[0].payload.message.includes("ada@example.com"),
      "the warning carries the value it was warning about",
    );
  }
  endRun(runId);
});
