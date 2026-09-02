// Regression tests for audit findings E-05, E-09, E-11, E-12, E-15, E-16, E-17
// and E-20 — the rest of the side panel.
//
// E-05: bindDragAndDrop looked both the source and the target up in
// _pipeline.steps only. Dragging a step inside a LOOP or an IF/ELSE branch, or
// between a branch and the root, silently did nothing — while the drop target
// still drew the accent outline and signalled success.
//
// E-09: the board is built from divs with click handlers — nav pills, node
// headers, insert affordances, accordion headers, palette items — with no role,
// no tabindex and no keyboard activation. The panel could not be used without a
// mouse.
//
// E-11: _renderBoardWires regenerates the whole SVG as a string and assigns it
// to innerHTML. Pointer-move panning called it on every move event with no
// throttle.
//
// E-12: wheel zoom required Ctrl/Cmd/Shift with no hint anywhere, so trackpad
// users would reasonably conclude zoom was broken.
//
// E-15: IF_ELSE was the only step type without an "optional" toggle, and the
// toggle's label everywhere else was the raw key name, lowercase.
//
// E-16: multi-fill and extract field rows rendered as `disabled` inputs, so
// fixing a typo meant deleting the row and re-picking the element.
//
// E-17: key capture reverted after 15 seconds with no countdown and no
// explanation.
//
// E-20: the storage list showed no aggregate size, so the first sign of the
// quota was a refused save.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const src = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);
const html = await readFile(
  new URL("../sidepanel/index.html", import.meta.url),
  "utf8",
);

const extract = (re) => {
  const m = src.match(re);
  assert.ok(m, `could not find ${re}`);
  return m[0];
};

// ── E-05: moving a step anywhere in the tree ─────────────────────────────────

/** Build _moveStep and its helpers against a pipeline the test controls. */
function makeMover(steps) {
  const body =
    extract(/function _locateStep\(steps, id, parent = null\) \{[\s\S]*?\n\}/) +
    "\n" +
    extract(/function _containsStep\(step, id\) \{[\s\S]*?\n\}/) +
    "\n" +
    extract(/function _moveStep\(sourceId, targetId\) \{[\s\S]*?\n\}/);
  const pipeline = { steps };
  const warnings = [];
  const fn = new Function("_pipeline", "notify", `${body}; return _moveStep;`)(
    pipeline,
    (level, msg) => warnings.push(msg),
  );
  return { move: fn, pipeline, warnings };
}

const ids = (list) => list.map((s) => s.id);

test("a step moves within the root, as it always could", () => {
  const { move, pipeline } = makeMover([{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.equal(move("c", "a"), true);
  assert.deepEqual(ids(pipeline.steps), ["c", "a", "b"]);
});

test("a step moves inside a loop body", () => {
  const { move, pipeline } = makeMover([
    { id: "loop", children: [{ id: "x" }, { id: "y" }] },
  ]);
  assert.equal(move("y", "x"), true);
  assert.deepEqual(ids(pipeline.steps[0].children), ["y", "x"]);
});

test("a step moves out of a branch and into the root", () => {
  const { move, pipeline } = makeMover([
    { id: "root1" },
    { id: "if", ifBranch: [{ id: "inner" }], elseBranch: [] },
  ]);
  assert.equal(move("inner", "root1"), true);
  assert.deepEqual(ids(pipeline.steps), ["inner", "root1", "if"]);
  assert.deepEqual(ids(pipeline.steps[2].ifBranch), []);
});

test("a step moves from the root into a branch", () => {
  const { move, pipeline } = makeMover([
    { id: "loose" },
    { id: "if", ifBranch: [{ id: "inner" }], elseBranch: [] },
  ]);
  assert.equal(move("loose", "inner"), true);
  assert.deepEqual(ids(pipeline.steps[0].ifBranch), ["loose", "inner"]);
});

test("a container cannot be dropped inside itself", () => {
  const { move, pipeline, warnings } = makeMover([
    { id: "loop", children: [{ id: "inner" }] },
  ]);
  assert.equal(move("loop", "inner"), false, "this would detach the subtree");
  assert.deepEqual(ids(pipeline.steps), ["loop"], "and nothing moved");
  assert.match(warnings[0], /cannot be moved inside itself/);
});

test("an unknown id is refused without disturbing the pipeline", () => {
  const { move, pipeline } = makeMover([{ id: "a" }, { id: "b" }]);
  assert.equal(move("ghost", "a"), false);
  assert.equal(move("a", "ghost"), false);
  assert.deepEqual(ids(pipeline.steps), ["a", "b"], "put back where it was");
});

test("the drop handler delegates instead of searching the root list", () => {
  const fn = extract(
    /w\.addEventListener\("drop", \(e\) => \{[\s\S]*?\n {4}\}\);/,
  );
  assert.match(fn, /_moveStep\(_dragSourceId, targetId\)/);
  assert.ok(
    !/_pipeline\.steps\.findIndex/.test(fn),
    "the root-only lookup is gone",
  );
  assert.match(
    fn,
    /if \(!moved\) return;/,
    "a refused move does not re-render",
  );
});

// ── E-09: keyboard ───────────────────────────────────────────────────────────

test("div-buttons get a role and a tab stop after every render", () => {
  assert.match(src, /const KEYBOARD_ACTIVATABLE =/);
  for (const cls of [
    ".nav-pill",
    ".node-header",
    ".insert-step",
    ".accordion-header",
    ".palette-item",
  ]) {
    assert.ok(src.includes(cls), `${cls} is not covered`);
  }
  assert.match(src, /_makeKeyboardAccessible\(elCanvas\)/);
  assert.match(src, /_makeKeyboardAccessible\(elPaletteContent\)/);
});

test("Enter and Space activate them", () => {
  const fn = extract(/function bindKeyboardActivation\(\) \{[\s\S]*?\n\}/);
  assert.match(fn, /e\.key !== "Enter" && e\.key !== " "/);
  assert.match(fn, /el\.click\(\)/);
  assert.match(fn, /e\.preventDefault\(\)/, "Space must not scroll the panel");
  assert.match(fn, /NATIVELY_INTERACTIVE/, "real buttons are left alone");
});

test("the stamping runs against a real DOM", () => {
  const dom = new JSDOM(
    `<!doctype html><body>
       <div class="nav-pill">Run</div>
       <button class="palette-item">already a button</button>
       <div class="insert-step" role="separator">+</div>
     </body>`,
  );
  const fn = new Function(
    "document",
    `${extract(/const KEYBOARD_ACTIVATABLE =[\s\S]*?;/)}
     ${extract(/const NATIVELY_INTERACTIVE =[\s\S]*?;/)}
     ${extract(/function _makeKeyboardAccessible\(root = document\) \{[\s\S]*?\n\}/)}
     return _makeKeyboardAccessible;`,
  )(dom.window.document);
  fn(dom.window.document);

  const pill = dom.window.document.querySelector(".nav-pill");
  assert.equal(pill.getAttribute("role"), "button");
  assert.equal(pill.getAttribute("tabindex"), "0");

  const real = dom.window.document.querySelector("button");
  assert.equal(
    real.getAttribute("tabindex"),
    null,
    "a button is already focusable",
  );

  const kept = dom.window.document.querySelector(".insert-step");
  assert.equal(
    kept.getAttribute("role"),
    "separator",
    "an explicit role stands",
  );
});

test("focus is visible", () => {
  assert.match(
    html,
    /:focus-visible \{[\s\S]*?outline: 2px solid var\(--accent\)/,
  );
  assert.match(html, /\.nav-pill:focus-visible/);
});

test("the nav pills carry their semantics in the markup", () => {
  assert.match(
    html,
    /class="nav-pill" role="tab" tabindex="0" data-tab="monitor"/,
  );
});

// ── E-11 / E-12: the board ───────────────────────────────────────────────────

test("wire redraws are coalesced to one per frame", () => {
  const fn = extract(/function _scheduleWireRender\(\) \{[\s\S]*?\n\}/);
  assert.match(fn, /if \(_wireFrame !== null\) return;/);
  assert.match(fn, /requestAnimationFrame\(/);
  assert.match(fn, /_wireFrame = null;/, "and re-armed after it runs");

  const transform = extract(/function _applyBoardTransform\(\) \{[\s\S]*?\n\}/);
  assert.match(transform, /_scheduleWireRender\(\)/);
  assert.ok(
    !/^\s*_renderBoardWires\(\);$/m.test(transform),
    "the synchronous redraw on every transform is gone",
  );
});

test("the transform itself stays synchronous, so panning still tracks", () => {
  const fn = extract(/function _applyBoardTransform\(\) \{[\s\S]*?\n\}/);
  assert.ok(
    fn.indexOf("elBoardStage.style.transform") <
      fn.indexOf("_scheduleWireRender"),
    "the CSS transform is applied before the deferred redraw is queued",
  );
});

test("a plain wheel says how to zoom, once", () => {
  const fn = extract(/function _hintZoomModifier\(\) \{[\s\S]*?\n\}/);
  assert.match(fn, /if \(_zoomHintShown\) return;/);
  assert.match(fn, /_zoomHintShown = true;/);
  assert.match(fn, /Hold \$\{key\} or Shift while scrolling/);
  assert.match(fn, /Mac/, "the modifier is named for the platform");
  assert.match(src, /_hintZoomModifier\(\);/, "and the wheel handler calls it");
});

// ── E-15 / E-16 / E-17 / E-20 ────────────────────────────────────────────────

test("every step type can be marked optional, including IF_ELSE", () => {
  // Anchored on the condition select so it can only match the config block,
  // not one of the other two `step.type === "IF_ELSE"` branches in the file.
  const block = extract(
    /const cond = c\.condition \|\| "exists";[\s\S]*?\n    return html;\n  \}/,
  );
  assert.match(
    block,
    /toggle\(\s*\n?\s*step,\s*\n?\s*"optional"/,
    "IF_ELSE was the only step type without it",
  );
});

test("the optional toggle has a human label", () => {
  assert.ok(
    !/toggle\(step, "optional", "optional"\)/.test(src),
    "the label was the raw key name, lowercase",
  );
  assert.match(src, /"Optional — keep going if this step fails"/);
});

test("field rows are editable", () => {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/value="\$\{esc\(f\.selector \|\| ""\)\}" disabled/.test(code),
    "selectors used to be greyed out and uneditable",
  );
  assert.match(src, /class="field-edit"[^>]*data-prop="selector"/);
  assert.match(src, /class="field-edit"[^>]*data-prop="value"/);
  assert.match(src, /class="field-edit"[^>]*data-prop="name"/);
});

test("editing a field row writes back to the step and saves", () => {
  const handler = extract(
    /if \(target\.classList\.contains\("field-edit"\)\) \{[\s\S]*?\n {4}\}/,
  );
  assert.match(handler, /field\[target\.dataset\.prop\] = target\.value;/);
  assert.match(handler, /saveState\(\);/);
  assert.match(
    handler,
    /if \(!field\) return;/,
    "a stale index is not a crash",
  );
});

test("key capture counts down and says when it gives up", () => {
  const fn = extract(/function _registerKey\(stepId\) \{[\s\S]*?\n\}/);
  assert.match(src, /const KEY_CAPTURE_SECONDS = 15;/);
  assert.match(fn, /Press key\(s\)… \$\{remaining\}s/);
  assert.match(fn, /key capture timed out/);
  assert.match(
    fn,
    /clearInterval\(countdown\)/,
    "a successful capture stops it",
  );
});

test("the storage panel shows how full it is", () => {
  assert.match(html, /id="storage-usage"/);
  const fn = extract(/function renderStoragePanel\(\) \{[\s\S]*?\n\}/);
  assert.match(fn, /_storageBytesUsed\(\)/);
  assert.match(fn, /STORAGE_BUDGET_BYTES/);
  assert.match(fn, /pct >= 90\s*\n?\s*\?\s*"var\(--red\)"/, "red at 90%");
  assert.match(fn, /pct >= 70\s*\n?\s*\?\s*"var\(--yellow\)"/, "amber at 70%");
  assert.match(fn, /available/, "and reads sensibly when empty");
});
