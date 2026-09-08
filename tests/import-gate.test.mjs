// The gate on the door, as opposed to the lock in the drawer.
//
// tests/pipeline-capabilities.test.mjs proves the analyser reaches the right
// verdict. That is worth nothing on its own: a correct check the import path
// never calls is the same defect as `_gate2_pii` was — a gate that reports
// having run. These tests are about the wiring, so they read the panel source
// rather than exercising the analyser again.
//
// Source-reading tests are a blunt instrument and are used here for the reason
// the PII gate tests use them: the assertions are about *where* a call sits in
// a control flow, and a DOM harness can show the call happening without
// showing that nothing was written before it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);
const markup = readFileSync(
  new URL("../sidepanel/index.html", import.meta.url),
  "utf8",
);

test("the panel imports the analyser rather than reimplementing it", () => {
  // Two copies of a security rule drift, and the copy that drifts is the one
  // that stops refusing things.
  assert.match(panel, /from "\.\.\/utils\/pipeline-capabilities\.js"/);
});

test("an uploaded pipeline is reviewed before it becomes the pipeline", () => {
  // Order is the whole assertion. Reviewing after assignment would mean a
  // refused pipeline had already been loaded when the dialog appeared.
  const handler = panel.match(
    /uploadPipelineInput\?\.addEventListener\([\s\S]*?\n  \}\);/,
  )?.[0];
  assert.ok(handler, "the upload handler should still exist");

  const reviewAt = handler.indexOf("_reviewImport(");
  const assignAt = handler.indexOf("_pipeline = normalized");
  assert.ok(reviewAt !== -1, "the upload path does not review the import");
  assert.ok(assignAt !== -1, "the upload path no longer loads anything");
  assert.ok(reviewAt < assignAt, "it loads the pipeline before reviewing it");
});

test("a declined review stops the import entirely", () => {
  const handler = panel.match(
    /uploadPipelineInput\?\.addEventListener\([\s\S]*?\n  \}\);/,
  )?.[0];
  assert.match(handler, /if \(!accepted\)[\s\S]{0,120}return;/);
});

test("a refused pipeline is offered no way to load it anyway", () => {
  // The point of refusing rather than warning: there is no button. A dialog
  // that explains the attack and then offers to proceed is a warning wearing
  // a refusal's clothes.
  const fn = panel.match(/function _reviewImport\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "the review function should exist");
  assert.match(fn, /accept\.style\.display = blocked \? "none" : ""/);
  // And the promise cannot resolve true on the blocked path.
  assert.match(fn, /finish\(!blocked\)/);
});

test("a pipeline with nothing to disclose imports without a dialog", () => {
  // A gate that interrupts every ordinary import is one people stop reading.
  const fn = panel.match(/function _reviewImport\([\s\S]*?\n\}/)?.[0];
  assert.match(fn, /VERDICT\.ALLOW\) return Promise\.resolve\(true\)/);
});

test("a missing dialog refuses the import instead of waving it through", () => {
  // Fail closed. If the overlay is not in the document, the honest answer is
  // "not loaded", not "loaded unreviewed".
  const fn = panel.match(/function _reviewImport\([\s\S]*?\n\}/)?.[0];
  assert.match(fn, /if \(!overlay \|\| !body \|\| !accept\)/);
  assert.match(fn, /return Promise\.resolve\(false\)/);
});

test("what the review renders is escaped", () => {
  // The pipeline name, the header names and the blocked reason all come from
  // the file being reviewed, which is by assumption hostile (C-04/C-05).
  const fn = panel.match(/function _reviewImport\([\s\S]*?\n\}/)?.[0];
  const interpolations = fn.match(/\$\{[^}]*\}/g) || [];
  const unescaped = interpolations.filter(
    (i) =>
      /c\.title|c\.detail|filename|blockedReason/.test(i) && !/esc\(/.test(i),
  );
  assert.deepEqual(unescaped, [], "hostile text reaches the DOM unescaped");
});

test("the review sheet exists in the panel markup", () => {
  // _reviewImport fails closed when these are absent, so their absence would
  // silently turn every reviewable import into a refusal.
  for (const id of [
    "import-review-overlay",
    "import-review-body",
    "btn-import-accept",
    "btn-import-reject",
  ]) {
    assert.ok(markup.includes(`id="${id}"`), `${id} is missing from the panel`);
  }
});
