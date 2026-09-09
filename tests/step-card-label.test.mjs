// What a step card calls itself.
//
// The card rendered `step.type`, so the most visible text in the builder was
// AUTO_EXTRACT, UPLOAD_ACTIVITY and PAGINATE_PROBE — machine names in the human
// position. utils/step-types.js has carried an `icon` and a `desc` for every
// step type since it was written and the card used neither, which makes this
// less a redesign than picking up something already on the floor.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { STEP_TYPES } from "../utils/step-types.js";

const panel = readFileSync(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);
const markup = readFileSync(
  new URL("../sidepanel/index.html", import.meta.url),
  "utf8",
);

test("every step type has a human name and a glyph to show", () => {
  // The card can only lead with the friendly name if the registry has one for
  // every type. A new step added without a desc would silently fall back to
  // its enum, which is the defect this fixes.
  for (const [type, def] of Object.entries(STEP_TYPES)) {
    assert.ok(def.desc, `${type} has no desc`);
    assert.ok(def.icon, `${type} has no icon`);
  }
});

test("the card no longer leads with the raw enum", () => {
  assert.ok(
    !/<div class="node-title">\$\{step\.type\}/.test(panel),
    "the card still renders the step type as its label",
  );
  assert.match(panel, /<div class="node-title">\$\{stepCardTitle\(step\)\}/);
});

test("the title is built from the registry, not a second list of names", () => {
  // A parallel table of friendly names would drift from the registry, and the
  // copy that drifts is the one the user reads.
  const fn = panel.match(/function stepCardTitle\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "the title helper should exist");
  assert.match(fn, /STEP_TYPES\[step\.type\]/);
  assert.match(fn, /meta\.desc/);
  assert.match(fn, /meta\.icon/);
});

test("an unregistered type shows its raw name, not undefined", () => {
  const fn = panel.match(/function stepCardTitle\([\s\S]*?\n\}/)?.[0];
  assert.match(fn, /meta\.desc \|\| step\.type/);
});

test("the raw type is kept where the name does not already say it", () => {
  // It is what the docs, the exported Playwright script and the run log all
  // call the step, so someone reading any of those has to be able to find it —
  // but only where it adds something. "Smart Auto-Extract AUTO_EXTRACT" says
  // the same thing twice.
  const fn = panel.match(/function stepCardTitle\([\s\S]*?\n\}/)?.[0];
  assert.match(fn, /class="node-type"/);
  assert.match(fn, /includes\(flatten\(step\.type\)\)/);
  assert.match(markup, /\.node-type \{/);
});

test("the chip is dropped exactly where it would repeat the name", () => {
  // Mirrors the rule in stepCardTitle against the real registry, so a new step
  // whose desc restates its type does not quietly reintroduce the noise.
  const flatten = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const redundant = (t) => flatten(STEP_TYPES[t].desc).includes(flatten(t));

  // Names that already carry the enum.
  for (const t of ["AUTO_EXTRACT", "LOOP", "WEBSITE"]) {
    assert.ok(redundant(t), `${t} should not need a chip`);
  }
  // Names that do not, and where the enum is the only way to connect the card
  // to the exported script.
  for (const t of ["PAGE_DATA", "SOLVE_CAPTCHA", "SET_HEADERS"]) {
    assert.ok(!redundant(t), `${t} should keep its chip`);
  }
});

test("the run monitor's status glyph is still inside the title", () => {
  // renderStepNode's title is targeted by the monitor; moving that span would
  // break the running spinner silently.
  assert.match(
    panel,
    /class="node-title">[\s\S]{0,80}node-status-icon running-spinner/,
  );
});

test("a long name truncates instead of breaking a 400px strip", () => {
  // "Answer a written challenge (owned sites only)" is a real desc in the
  // registry and is far wider than the panel.
  const css = markup.match(/\.node-label \{[\s\S]*?\}/)?.[0];
  assert.ok(css, "the label needs its own rule to truncate");
  assert.match(css, /text-overflow: ellipsis/);
  assert.match(css, /min-width: 0/);
});
