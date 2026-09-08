// Tests for K-13: nothing could say "stop if the page is not the page".
//
// A scrape fails silently far more often than it crashes. The site renames a
// class, every selector misses, EXTRACT reports a miss as null by design
// (B-08), and the run exports five hundred empty rows and reports success.
// ASSERT is the step that turns that into an error with a reason in it.
//
// It is split the way IF_ELSE is: the page reports what its selector matched,
// and utils/assertions.js decides what that means, so there is one definition
// of "the text equals" rather than one in the page and one in the worker
// drifting apart (G-01).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ASSERTIONS,
  ASSERTION_NAMES,
  evaluateAssertion,
} from "../utils/assertions.js";
import { STEP_TYPES, USER_STEP_TYPES } from "../utils/step-types.js";
import { loadInjector } from "./helpers/content-harness.mjs";
import {
  _executeSteps,
  startRun,
  endRun,
  calls,
  reset,
  onContentMessage,
} from "./helpers/worker-harness.mjs";

const logs = () =>
  calls.runtimeMessages
    .filter((m) => m.type === "pipeline:log")
    .map((m) => m.payload.message);

const assertStep = (config) => ({ id: "a1", type: "ASSERT", config });

const click = { id: "c1", type: "CLICK", config: { selector: ".after" } };

/** Run one ASSERT ahead of a CLICK, with the page reporting `seen`. */
async function runAssert(config, seen) {
  const { runId, runState } = startRun();
  onContentMessage(async (payload) =>
    payload.type === "ASSERT"
      ? { ok: true, result: seen }
      : { ok: true, result: null },
  );
  await _executeSteps(
    [assertStep(config), click],
    1,
    runId,
    { extracted: {} },
    { total: 2, count: 0 },
  );
  const reached = calls.contentMessages.some(
    (m) => m.payload?.type === "CLICK",
  );
  const active = runState.active;
  await endRun(runId);
  return { reached, active };
}

test.beforeEach(reset);

// ── The vocabulary ──────────────────────────────────────────────────────────

test("ASSERT is a step a user can add", () => {
  assert.ok(USER_STEP_TYPES.includes("ASSERT"));
  assert.equal(STEP_TYPES.ASSERT.runsIn, "page");
  assert.equal(STEP_TYPES.ASSERT.def.assertion, "exists");
});

test("each assertion holds or explains itself", () => {
  const cases = [
    ["exists", { count: 2, text: "x" }, true],
    ["exists", { count: 0, text: "" }, false],
    ["not-exists", { count: 0, text: "" }, true],
    ["not-exists", { count: 1, text: "x" }, false],
    ["count-equals", { count: 3, text: "" }, true],
    ["count-equals", { count: 4, text: "" }, false],
    ["count-at-least", { count: 3, text: "" }, true],
    ["count-at-least", { count: 2, text: "" }, false],
    ["count-at-most", { count: 3, text: "" }, true],
    ["count-at-most", { count: 9, text: "" }, false],
    ["text-contains", { count: 1, text: " In  stock \n" }, true],
    ["text-contains", { count: 1, text: "Sold out" }, false],
    ["text-equals", { count: 1, text: "In stock" }, true],
    ["text-equals", { count: 1, text: "In stock soon" }, false],
  ];
  const config = { selector: ".card", count: 3, value: "In stock" };

  for (const [name, seen, expected] of cases) {
    const failure = evaluateAssertion(name, seen, config);
    assert.equal(
      failure === null,
      expected,
      `${name} against ${JSON.stringify(seen)}: ${failure}`,
    );
    if (!expected) {
      assert.match(failure, /\.card|In stock/, `${name} says nothing useful`);
    }
  }
});

test("a failure names what was expected and what was there", () => {
  const failure = evaluateAssertion(
    "count-at-least",
    { count: 1, text: "" },
    { selector: ".product", count: 20 },
  );
  assert.match(failure, /at least 20 elements/);
  assert.match(failure, /found 1/);
});

test("a missing element is reported as missing, not as the wrong text", () => {
  // "the price does not say £10" and "there is no price" are different
  // diagnoses, and the second is the one that means the page has changed.
  const failure = evaluateAssertion(
    "text-equals",
    { count: 0, text: "" },
    { selector: ".price", value: "£10" },
  );
  assert.match(failure, /nothing on the page matches/);
});

test("an unknown assertion is refused rather than defaulting to exists", () => {
  // Defaulting would make a mistyped step pass on any page with any element.
  assert.throws(
    () => evaluateAssertion("text-startswith", { count: 1, text: "x" }, {}),
    /Unknown assertion/,
  );
});

test("a count that is not a number is refused", () => {
  assert.throws(
    () => evaluateAssertion("count-equals", { count: 1 }, { count: "three" }),
    /needs a number/,
  );
});

test("every assertion tells the panel what to ask for", () => {
  for (const name of ASSERTION_NAMES) {
    assert.ok(
      ["none", "count", "value"].includes(ASSERTIONS[name].needs),
      `${name} has no UI contract`,
    );
    assert.ok(ASSERTIONS[name].label, `${name} has no label`);
  }
});

// ── What the page reports ───────────────────────────────────────────────────

test("the page reports the match count and the first match's text", async () => {
  const h = await loadInjector(
    `<ul><li class="p">One</li><li class="p"> Two </li></ul>`,
  );
  const seen = await h.api._executeStep({
    type: "ASSERT",
    config: { selector: ".p" },
  });
  assert.equal(seen.count, 2);
  assert.equal(seen.text, "One");
  h.close();
});

test("the page does not decide anything itself", async () => {
  const h = await loadInjector(`<div class="x">hi</div>`);
  const seen = await h.api._executeStep({
    type: "ASSERT",
    config: { assertion: "not-exists", selector: ".x" },
  });
  // A page that evaluated the assertion would have to carry a second copy of
  // the comparison; it reports, and the worker decides.
  assert.deepEqual(Object.keys(seen).sort(), ["count", "text"]);
  h.close();
});

test("an assertion sees inside a web component, like every other step", async () => {
  // The point of reusing _queryScoped rather than writing a query path: a
  // guard that cannot see what the steps it guards can see is worse than none.
  const h = await loadInjector("");
  const host = h.document.createElement("shop-card");
  h.document.body.appendChild(host);
  host.attachShadow({ mode: "open" }).innerHTML =
    `<span class="price">109.95</span>`;

  const piercing = await h.api._executeStep({
    type: "ASSERT",
    config: { selector: "shop-card >>> .price" },
  });
  assert.equal(piercing.count, 1);
  assert.equal(piercing.text, "109.95");

  const bare = await h.api._executeStep({
    type: "ASSERT",
    config: { selector: ".price" },
  });
  assert.equal(bare.count, 1, "the shadow fallback did not apply");
  h.close();
});

test("an assertion can be written as an XPath", async () => {
  const h = await loadInjector(`<table><tr><td>Total</td></tr></table>`);
  const seen = await h.api._executeStep({
    type: "ASSERT",
    config: { selector: '//td[contains(., "Total")]' },
  });
  assert.equal(seen.count, 1);
  h.close();
});

// ── What the run does about it ──────────────────────────────────────────────

test("a failed assertion stops the run and says why", async () => {
  const { reached, active } = await runAssert(
    { assertion: "count-at-least", selector: ".product", count: 20 },
    { count: 0, text: "" },
  );
  assert.equal(reached, false, "the run carried on past a failed assertion");
  assert.equal(active, false);
  const failure = logs().find((m) => m.includes("ASSERT"));
  assert.match(failure, /ASSERT \(count-at-least\) failed/);
  assert.match(failure, /found 0/);
});

test("an assertion that holds is logged and the run continues", async () => {
  const { reached, active } = await runAssert(
    { assertion: "exists", selector: ".product" },
    { count: 12, text: "Backpack" },
  );
  assert.ok(reached, "the next step did not run");
  assert.ok(active);
  assert.ok(
    logs().some((m) => /ASSERT \(exists\) held/.test(m)),
    `nothing was logged: ${logs().join(" | ")}`,
  );
});

test("optional still lets a run continue past a failed assertion", async () => {
  const { reached, active } = await runAssert(
    { assertion: "exists", selector: ".product", optional: true },
    { count: 0, text: "" },
  );
  assert.ok(reached, "optional did not apply to ASSERT");
  assert.ok(active);
});

test("the panel offers every assertion the registry knows", async () => {
  const src = await readFile(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  // Built from the registry, so an assertion cannot exist without the panel
  // offering it — the rule that came out of B-07.
  const block = src.match(
    /if \(step\.type === "ASSERT"\) \{[\s\S]*?\n    return html;\n  \}/,
  );
  assert.ok(block, "ASSERT has no config panel");
  assert.match(block[0], /Object\.entries\(ASSERTIONS\)/);
  assert.match(block[0], /toggle\(\s*\n?\s*step,\s*\n?\s*"optional"/);
});
