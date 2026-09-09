// Opening a step card.
//
// e2e/panel.mjs proves the behaviour in a real browser: two cards open at once,
// and the canvas surviving a toggle. These cover the two invariants a browser
// test cannot show without contriving a very long session — that closing one
// card deletes one id rather than resetting the set, and that ids for deleted
// steps do not accumulate for the life of the panel.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);

test("expansion is a set, so one open card does not close another", () => {
  // It was a single id. Configuring a LOOP with five children under that rule
  // was open, read, close, open.
  assert.match(panel, /const _expandedNodeIds = new Set\(\)/);
  assert.ok(
    !/let _expandedNodeId\b/.test(panel),
    "the single-id state is still there",
  );
});

test("opening a card toggles a class instead of redrawing the board", () => {
  // `.node-config` is rendered for every card whether open or not, and
  // `.expanded` only flips a display rule — so a full redraw changed nothing on
  // screen while costing the scroll position and every bound handler.
  const fn = panel.match(/function _toggleExpand\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "the toggle should still exist");
  assert.match(fn, /classList\.toggle\("expanded"/);
});

test("a card that is not in the DOM still falls back to a redraw", () => {
  // Fail visibly rather than leaving a header that answers clicks by doing
  // nothing.
  const fn = panel.match(/function _toggleExpand\([\s\S]*?\n\}/)?.[0];
  assert.match(fn, /else renderPipeline\(\)/);
});

test("removing one step does not close every other card", () => {
  // The bug this shape invites: clearing the set to forget one id.
  const fn = panel.match(/function _removeStep\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "the remove handler should still exist");
  assert.match(fn, /_expandedNodeIds\.delete\(id\)/);
  assert.ok(
    !/_expandedNodeIds\.clear\(\)/.test(fn),
    "removing a step clears every open card",
  );
});

test("ids for steps that no longer exist are pruned", () => {
  // Removing a LOOP takes its children with it, so without a sweep the set
  // grows for the life of the panel and a re-used id would open a card nobody
  // opened.
  const fn = panel.match(/function renderPipeline\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "renderPipeline should still exist");
  assert.match(fn, /_expandedNodeIds\.delete\(id\)/);
});

test("a redraw keeps the board where the user left it", () => {
  // innerHTML discards the scrolled position along with the nodes. Add and
  // remove both redraw, and neither is a reason to send someone back to step 1.
  const fn = panel.match(/function renderPipeline\([\s\S]*?\n\}/)?.[0];
  assert.match(fn, /scrollTop/);
});
