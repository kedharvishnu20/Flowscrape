// Checking that a model's answer is actually on the page.
//
// The prompt says "never invent". That is an instruction, not a guarantee, and
// the failure it is meant to prevent is the worst kind this tool produces: a
// column of plausible values the page never contained. Nothing about the export
// says so, and the first person to notice is whoever acts on the data.
//
// The check costs a string comparison, because the text sent to the model is
// already in hand: a value not present in it was invented. No second request,
// no model grading its own homework.
//
// The tests below are mostly about the *false positives*, because a grounding
// check that vouches for an invented value is worse than none — it puts a badge
// on the thing it was built to catch.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as grounding from "../utils/extraction-grounding.js";
import { STEP_TYPES } from "../utils/step-types.js";

const {
  prepareCorpus,
  groundValue,
  groundFields,
  normaliseForMatch,
  GROUND_EXACT,
  GROUND_NUMBER,
  GROUND_PARTS,
  GROUND_URL,
  GROUND_UNPROVEN,
  GROUND_MISSING,
} = grounding;

const PAGE =
  "Acme Ltd v Bloggs — published 2 January 2026 by Ada Lovelace. " +
  "Price £1,299.00. Tags: contract, damages. See /p/9 for details.";
const corpus = prepareCorpus(PAGE);

// ── The thing it is for ──────────────────────────────────────────────────────

test("a value the page states is verified", () => {
  assert.deepEqual(groundValue("Ada Lovelace", corpus), {
    ok: true,
    how: GROUND_EXACT,
  });
});

test("a value the page never contained is refused", () => {
  const out = groundValue("Grace Hopper", corpus);
  assert.equal(out.ok, false);
  assert.equal(out.how, GROUND_MISSING);
});

test("an empty answer is not a lie", () => {
  // The honest outcome the whole layer stack is built to preserve: a field
  // nothing could answer stays empty and passes.
  for (const empty of [null, undefined, ""]) {
    assert.equal(groundValue(empty, corpus).ok, true);
  }
});

// ── False positives: the failures that would make it worthless ───────────────

test("a real year does not vouch for the invented name beside it", () => {
  // The page says 2026. A naive numeric check pulls 2026 out of
  // "Grace Hopper 2026" and calls the whole string verified — a badge on
  // exactly the thing this exists to catch.
  const out = groundValue("Grace Hopper 2026", corpus);
  assert.equal(out.ok, false, `wrongly verified as ${out.how}`);
});

test("a digit in a URL does not vouch for the URL", () => {
  // /p/9 is on the page, so 9 is one of its numbers. Without ordering the
  // checks, https://shop.test/p/77 "grounds" on that 9.
  assert.equal(groundValue("https://shop.test/p/9", corpus).how, GROUND_URL);
  assert.equal(groundValue("https://shop.test/p/77", corpus).ok, false);
});

test("half a list is not a list", () => {
  // One part matching would let "contract, fraud" through on the strength of
  // the half that was real.
  assert.equal(groundValue("contract, damages", corpus).ok, true);
  assert.equal(groundValue("contract, fraud", corpus).ok, false);
});

test("a value too short to prove anything is not called verified", () => {
  // "9" occurs in almost any page. Reporting it as proven would be the same
  // overclaim this module exists to prevent, so it is kept and marked.
  const out = groundValue("9", corpus);
  assert.equal(out.ok, true);
  assert.equal(out.how, GROUND_UNPROVEN);
});

// ── False negatives: a true answer must not be thrown away ───────────────────

test("a number the page writes differently is the same number", () => {
  assert.equal(groundValue("1299", corpus).how, GROUND_NUMBER);
  assert.equal(groundValue("£1,299.00", corpus).ok, true);
});

test("a list the model joined from separate elements passes", () => {
  const spread = prepareCorpus("Tags: contract and damages appear apart.");
  assert.equal(groundValue("contract, damages", spread).how, GROUND_PARTS);
});

test("the punctuation a CMS substitutes does not break a match", () => {
  // A page written in Word says “Acme’s”; a model answers "Acme's".
  const fancy = prepareCorpus("The judgment in “Acme’s case” was given.");
  assert.equal(groundValue("Acme's case", fancy).ok, true);
});

test("whitespace and case are not evidence of invention", () => {
  const messy = prepareCorpus("ACME   LTD\n\n v  Bloggs");
  assert.equal(groundValue("Acme Ltd v Bloggs", messy).ok, true);
  assert.equal(normaliseForMatch("  A  B  "), "a b");
});

// ── What a run does with the verdict ─────────────────────────────────────────

test("a whole answer is checked field by field, and the failures named", () => {
  const { result, dropped, how } = groundFields(
    { author: "Ada Lovelace", editor: "Grace Hopper", price: "1299" },
    ["author", "editor", "price"],
    PAGE,
  );
  assert.equal(result.author, "Ada Lovelace");
  assert.equal(result.price, "1299");
  assert.equal(
    result.editor,
    null,
    "an empty cell cannot be acted on by mistake; a made-up one can",
  );
  assert.deepEqual(
    dropped.map((d) => d.field),
    ["editor"],
  );
  assert.equal(
    dropped[0].value,
    "Grace Hopper",
    "the log has to say what was claimed, or 'it invented something' is unusable",
  );
  assert.equal(how.price, GROUND_NUMBER);
});

test("the step checks by default, and the log says what was dropped", () => {
  assert.equal(STEP_TYPES.AUTO_EXTRACT.def.grounded, true);

  const src = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /groundFields\(/);
  assert.match(src, /which is not on the page it was shown/);
  // A dropped field must lose its confidence too, or the merge prefers the
  // hole the model left over whatever the free layers found.
  assert.match(src, /llmResult\.perField\[field\] = 0/);
});

test("the panel says what turning the check off means", () => {
  const src = readFileSync(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  // Built through the generic `toggle` helper, so the source names the key
  // rather than spelling out the attribute.
  assert.match(src, /"grounded",/);
  assert.match(
    src,
    /Nothing downstream can tell the difference/,
    '"disable verification" is not a description of the consequence',
  );
  // The honest limit, on screen: this rules out invention, not confusion.
  assert.match(src, /rules out invention, not confusion/i);
});
