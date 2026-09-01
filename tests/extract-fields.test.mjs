// Regression tests for audit finding B-07, plus a defect found alongside it.
//
// B-07: injector's _extractValue requires field.attribute, but the EXTRACT
// config UI never rendered an input for it. Choosing "Attr" therefore fell
// through to text extraction — a wrong value that looked like a right one.
//
// Found while fixing it: the field-type <select> was wired to the delegated
// *click* listener. Clicking a select fires click before the user picks an
// option, so the handler wrote back the value already selected and the choice
// never stuck. "Attr" could not be chosen even in principle.
//
// These are source-level assertions. injector.js is a classic content script
// that builds a shadow host at load, so exercising _stepExtract for real needs
// a DOM harness (jsdom); worth adding when more content-script behaviour is
// under test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const panelSrc = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);
const injectorSrc = await readFile(
  new URL("../content/injector.js", import.meta.url),
  "utf8",
);

test("the EXTRACT config renders an attribute-name input", () => {
  assert.match(
    panelSrc,
    /class="extract-attr-input"/,
    "there must be somewhere to type href/src/data-id",
  );
  assert.match(
    panelSrc,
    /if \(f\.type === "attribute"\) \{/,
    "shown only for fields actually set to Attr",
  );
});

test("the field-type select is handled on change, not on click", () => {
  assert.ok(
    !/data-action="update-extract-type"/.test(panelSrc),
    "click fires before the user picks an option",
  );
  assert.ok(
    !/case "update-extract-type"/.test(panelSrc),
    "and the click-listener case is gone with it",
  );
  assert.match(
    panelSrc,
    /target instanceof HTMLSelectElement &&\s*\n\s*target\.classList\.contains\("extract-type-select"\)/,
    "the select is now read from the change listener",
  );
});

test("switching away from Attr drops a stale attribute name", () => {
  assert.match(
    panelSrc,
    /if \(field\.type !== "attribute"\) delete field\.attribute;/,
    "a leftover attribute on a text field would be silently ignored",
  );
});

test("attribute extraction refuses to run unconfigured", () => {
  const fn = injectorSrc.match(/const _extractValue = \(el, field\) => \{[\s\S]*?\n  \};/)?.[0];
  assert.ok(fn, "found _extractValue");
  assert.match(
    fn,
    /is set to Attr but has no attribute name/,
    "silently returning text made a misconfigured field look like it worked",
  );
  assert.ok(
    !/field\.type === "attribute" && field\.attribute/.test(fn),
    "the old guard fell through to text when the name was missing",
  );
});
