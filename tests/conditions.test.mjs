// What IF_ELSE can ask about a page.
//
// It could compare text and attributes, and that was all: no "is this empty",
// no numeric comparison, no pattern match. So "only scrape items under £50" or
// "skip the row if the price is missing" — the two things a branch is most
// often for — could not be expressed at all.
//
// The comparisons live in a pure module rather than in the content script for
// the reason G-01 keeps arriving at: the worker needs the same number parsing
// EXTRACT uses, a classic content script cannot import it, and a second copy
// in the page would drift. So the page reads the DOM and reports what it saw;
// the worker decides what that means.
import test from "node:test";
import assert from "node:assert/strict";
import { CONDITIONS, evaluateCondition } from "../utils/conditions.js";

/** What the page reports back about the element it looked at. */
const seen = (over = {}) => ({
  exists: true,
  text: "",
  attrValue: null,
  ...over,
});

const check = (condition, observed, config = {}) =>
  evaluateCondition(condition, observed, config);

// ── what it could already do ─────────────────────────────────────────────────

test("exists and not-exists still work", () => {
  assert.equal(check("exists", seen()), true);
  assert.equal(check("exists", seen({ exists: false })), false);
  assert.equal(check("not-exists", seen({ exists: false })), true);
});

test("text comparison ignores the whitespace markup adds", () => {
  // Real markup indents its text, so an element rendered as "Add to cart" has
  // a textContent of "\n      Add to cart\n    " (B-25).
  const observed = seen({ text: "\n   Add to\n   cart  \n" });
  assert.equal(check("text-equals", observed, { value: "Add to cart" }), true);
  assert.equal(check("text-contains", observed, { value: "to cart" }), true);
});

test("attribute comparison works on the value the page reported", () => {
  const observed = seen({ attrValue: "product-42" });
  assert.equal(check("attr-equals", observed, { value: "product-42" }), true);
  assert.equal(check("attr-contains", observed, { value: "42" }), true);
  assert.equal(check("attr-equals", observed, { value: "43" }), false);
});

// ── is it empty ──────────────────────────────────────────────────────────────

test("is-empty is true for missing, blank and whitespace-only text", () => {
  // Three different shapes of "there is nothing here", and a scrape has to
  // treat them the same: an empty <span>, a span full of newlines, and no span.
  assert.equal(check("is-empty", seen({ text: "" })), true);
  assert.equal(check("is-empty", seen({ text: "   \n  " })), true);
  assert.equal(check("is-empty", seen({ exists: false })), true);
  assert.equal(check("is-empty", seen({ text: "In stock" })), false);
});

test("not-empty is the mirror of it", () => {
  assert.equal(check("not-empty", seen({ text: "In stock" })), true);
  assert.equal(check("not-empty", seen({ text: "  " })), false);
  assert.equal(check("not-empty", seen({ exists: false })), false);
});

// ── numbers ──────────────────────────────────────────────────────────────────

test("numbers are compared as numbers, read out of the text around them", () => {
  const price = seen({ text: "$25.50" });
  assert.equal(check("number-lt", price, { value: "50" }), true);
  assert.equal(check("number-gt", price, { value: "50" }), false);
  assert.equal(check("number-gt", price, { value: "10" }), true);
  assert.equal(check("number-equals", price, { value: "25.5" }), true);
});

test("number comparison uses the same reader EXTRACT uses", () => {
  // Not a second parser: "1.234,56" is 1234.56 in most of Europe, and a branch
  // that read it as 1.234 would take the wrong path on every European price.
  const euro = seen({ text: "1.234,56 €" });
  assert.equal(check("number-gt", euro, { value: "1000" }), true);
  assert.equal(check("number-lt", euro, { value: "2" }), false);
});

test("text with no number in it fails a numeric test rather than passing as zero", () => {
  // "Out of stock" is not "less than 50". Reading it as 0 would put every
  // sold-out row into the cheap branch.
  const words = seen({ text: "Out of stock" });
  assert.equal(check("number-lt", words, { value: "50" }), false);
  assert.equal(check("number-gt", words, { value: "-1" }), false);
  assert.equal(check("number-equals", words, { value: "0" }), false);
});

test("a comparison value that is not a number is refused, not guessed at", () => {
  assert.throws(
    () => check("number-lt", seen({ text: "10" }), { value: "cheap" }),
    /number/i,
  );
});

// ── patterns ─────────────────────────────────────────────────────────────────

test("text-matches tests the text against a pattern", () => {
  const sku = seen({ text: "SKU: ABC-123" });
  assert.equal(check("text-matches", sku, { value: "[A-Z]{3}-\\d+" }), true);
  assert.equal(check("text-matches", sku, { value: "^\\d+$" }), false);
});

test("an invalid pattern is reported, not treated as no match", () => {
  // Silently false would send every row down the ELSE branch, which looks like
  // a working pipeline that found nothing.
  assert.throws(
    () => check("text-matches", seen({ text: "x" }), { value: "([unclosed" }),
    /pattern|regex/i,
  );
});

test("a condition on an element that is not there is false, not an error", () => {
  // Except for not-exists and is-empty, which are precisely about absence.
  for (const condition of [
    "text-equals",
    "text-contains",
    "text-matches",
    "attr-equals",
    "number-gt",
  ]) {
    assert.equal(
      check(condition, seen({ exists: false }), { value: "1" }),
      false,
      `${condition} threw or passed on a missing element`,
    );
  }
});

// ── the registry ─────────────────────────────────────────────────────────────

test("an unknown condition is refused rather than defaulting to exists", () => {
  // Defaulting is how a typo becomes a branch that always takes the IF path.
  assert.throws(() => check("nonsense", seen()), /unknown|unsupported/i);
});

test("every condition is described for the UI, and says what it needs", () => {
  for (const [name, meta] of Object.entries(CONDITIONS)) {
    assert.ok(meta.label, `${name} has no label`);
    assert.equal(typeof meta.fn, "function", `${name} has no implementation`);
    assert.ok(
      ["none", "value", "attr", "attr+value"].includes(meta.needs),
      `${name} does not say what inputs it needs (got ${meta.needs})`,
    );
  }
  assert.ok(Object.keys(CONDITIONS).length >= 12);
});

// ── wired into the branch ────────────────────────────────────────────────────

import { loadInjector } from "./helpers/content-harness.mjs";
import {
  reset,
  onContentMessage,
  calls,
  startRun,
  endRun,
  _executeStepList,
} from "./helpers/worker-harness.mjs";

test("the page reports what it saw and does not decide", async () => {
  // The split that keeps one copy of the comparisons. A page that returned
  // conditionMet would need its own number parser.
  const page = await loadInjector(`<div class="price">  $25.50 </div>`);
  const out = await page.api._stepIfElse({
    condition: "number-lt",
    selector: ".price",
    value: "50",
  });
  assert.equal(out.exists, true);
  assert.equal(out.text.trim(), "$25.50");
  assert.equal(
    out.conditionMet,
    undefined,
    "the page must not evaluate the condition",
  );
  page.close();
});

test("the page reports the attribute the condition asked for", async () => {
  const page = await loadInjector(
    `<a class="l" href="/p/1" data-id="42">x</a>`,
  );
  const out = await page.api._stepIfElse({
    condition: "attr-equals",
    selector: ".l",
    attr: "data-id",
    value: "42",
  });
  assert.equal(out.attrValue, "42");
  page.close();
});

test("a missing element is reported as missing, not as an error", async () => {
  const page = await loadInjector(`<div>nothing here</div>`);
  const out = await page.api._stepIfElse({
    condition: "exists",
    selector: ".nope",
  });
  assert.equal(out.exists, false);
  page.close();
});

const step = (type, config = {}, extra = {}) => ({
  id: `s_${type}`,
  type,
  config,
  ...extra,
});

test("a numeric branch takes the IF path when the page's number qualifies", async () => {
  reset();
  const { runId } = startRun();
  onContentMessage((payload) => {
    if (payload.type === "IF_ELSE") {
      return {
        ok: true,
        result: { exists: true, text: "$25.50", attrValue: null },
      };
    }
    return { ok: true, result: { clicked: 1 } };
  });

  await _executeStepList(
    [
      step(
        "IF_ELSE",
        { condition: "number-lt", selector: ".price", value: "50" },
        {
          ifBranch: [step("CLICK", { selector: ".cheap" })],
          elseBranch: [step("CLICK", { selector: ".dear" })],
        },
      ),
    ],
    1,
    runId,
    { extracted: {} },
  );

  const clicked = calls.contentMessages
    .filter((m) => m.payload?.type === "CLICK")
    .map((m) => m.payload.config.selector);
  assert.deepEqual(clicked, [".cheap"]);
  await endRun(runId);
});

test("a branch whose condition cannot be evaluated says so in the log", async () => {
  // It used to swallow every failure into `met = false` and take ELSE, so a
  // broken condition was indistinguishable from an unmet one.
  reset();
  const { runId } = startRun();
  onContentMessage(() => ({
    ok: true,
    result: { exists: true, text: "10", attrValue: null },
  }));

  await _executeStepList(
    [
      step(
        "IF_ELSE",
        { condition: "number-lt", selector: ".p", value: "not a number" },
        { ifBranch: [], elseBranch: [] },
      ),
    ],
    1,
    runId,
    { extracted: {} },
  );

  const said = calls.runtimeMessages.some((m) =>
    /needs a number/i.test(m?.payload?.message ?? ""),
  );
  assert.ok(said, "the run log does not explain why the branch failed");
  await endRun(runId);
});
