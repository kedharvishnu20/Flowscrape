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

// ── E-11 / E-12 / J-23: the board is a list, not a canvas ───────────────────
//
// E-11 and E-12 were performance and discoverability fixes for a pan/zoom
// canvas: throttle the wire redraw, tell people which modifier zooms. The
// canvas itself was the defect. A 1400x1200 stage transformed inside a ~400px
// side panel with `overflow: hidden` put steps where they could not be seen or
// reached, which is why dropping a step into a loop body appeared to do
// nothing. The board is a scrolling vertical list now, so the tests below
// assert the machinery is gone rather than that it is well-behaved.

test("the board carries no pan, zoom or wire machinery", () => {
  for (const gone of [
    "_boardState",
    "_applyBoardTransform",
    "_zoomBoard",
    "_fitBoardToContent",
    "_renderBoardWires",
    "_scheduleWireRender",
    "_hintZoomModifier",
    "initBoardSurface",
  ]) {
    assert.ok(
      !src.includes(`${gone}(`) && !src.includes(`${gone}.`),
      `${gone} is still referenced; the canvas was supposed to be removed`,
    );
  }
  assert.ok(
    !html.includes('id="pipeline-wires"'),
    "the wire SVG is still in the markup",
  );
  assert.ok(
    !html.includes('id="board-zoom-label"'),
    "the zoom readout is still in the markup",
  );
});

test("focusing a running step scrolls it into view", () => {
  const fn = extract(/function _focusNodeOnBoard\(card\) \{[\s\S]*?\n\}/);
  assert.match(fn, /scrollIntoView\(/);
  assert.match(fn, /block: "nearest"/, "and does not yank the whole board");
  assert.match(src, /_focusNodeOnBoard\(active\);/, "and the run UI calls it");
});

test("the board viewport scrolls instead of clipping", () => {
  const rule = html.match(/#board-viewport \{[\s\S]*?\n {6}\}/);
  assert.ok(rule, "no #board-viewport rule");
  assert.match(rule[0], /overflow-y: auto/);
  assert.ok(
    !/overflow: hidden/.test(rule[0]),
    "clipping the board is what hid nested steps",
  );
});

test("a step card does not hardcode its own left border", () => {
  // The inline style used to set `border-left: 4px solid ...`, which no rule in
  // the stylesheet could override — the card's own hover and running states
  // could never restyle that edge.
  const line = extract(/html \+= `<div class="node-card [\s\S]*?`;/);
  assert.ok(
    !line.includes("border-left"),
    "the card sets --step-color only; the stylesheet spends it",
  );
  assert.match(line, /--step-color:var\(--step-\$\{step\.type\}\)/);
});

test("IF/ELSE branches stack rather than sitting side by side", () => {
  // Two columns in a 400px panel gave each branch ~170px — narrower than one
  // step card.
  const rule = html.match(/\.if-branches \{[\s\S]*?\n {6}\}/);
  assert.ok(rule, "no .if-branches rule");
  assert.match(rule[0], /flex-direction: column/);
});

test("the board toolbar wraps so every control stays reachable", () => {
  const rule = html.match(/#board-toolbar \{[\s\S]*?\n {6}\}/);
  assert.ok(rule, "no #board-toolbar rule");
  assert.match(rule[0], /flex-direction: column/);
  const row = html.match(/\.toolbar-row \{[\s\S]*?\n {6}\}/);
  assert.ok(row, "no .toolbar-row rule");
  assert.match(row[0], /flex-wrap: wrap/);
});

test("the toggle checkboxes stay in the tab order", () => {
  // `display: none` hid them from the keyboard as well as the eye, so no
  // toggle in the panel could be reached or operated without a mouse.
  const rule = html.match(
    /\.toggle-wrap input\[type="checkbox"\] \{[\s\S]*?\n {6}\}/,
  );
  assert.ok(rule, "no rule for the clipped checkbox");
  assert.ok(
    !/display: none/.test(rule[0]),
    "display:none takes the control out of the tab order",
  );
  assert.match(rule[0], /opacity: 0/);
  assert.match(
    html,
    /input\[type="checkbox"\]:focus-visible \+ \.toggle-switch/,
    "and focus is visible on the switch that replaces it",
  );
});

test("no remote font or stylesheet is loaded (A-09)", () => {
  // The panel's CSP blocks remote stylesheets, so the old <link> to
  // fonts.googleapis.com rendered in a fallback face while leaking a request
  // to Google on every open. Fonts are bundled; nothing is fetched.
  assert.ok(
    !/<link[^>]+rel=["']?stylesheet/i.test(html),
    "a stylesheet <link> is back in the panel",
  );
  assert.ok(
    !/src:\s*url\(["']?https?:/i.test(html),
    "an @font-face is pointing at a remote file",
  );
  for (const face of html.match(/src: url\("([^"]+)"\)/g) || []) {
    assert.match(face, /url\("fonts\//, `${face} is not a bundled font`);
  }
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

// ── E-05, continued: dropping into a container ──────────────────────────────
//
// Reported from real use: "even if I keep any activity inside the loop it is
// not working". E-05 fixed _moveStep so a step could be dragged *between*
// containers, and left the harder half: drops were only accepted on another
// `.node-wrapper`, so
//
//   * an empty loop had nothing to drop onto at all, and
//   * dropping on the loop's own card moved the step to where the loop is —
//     beside it, not into it — which looks exactly like nothing happening.

/** _moveStepInto, lifted out of the panel module. */
function makeMoverInto(steps) {
  const body =
    extract(/function _locateStep\(steps, id, parent = null\) \{[\s\S]*?\n\}/) +
    "\n" +
    extract(/function _containsStep\(step, id\) \{[\s\S]*?\n\}/) +
    "\n" +
    extract(
      /function _moveStepInto\(sourceId, parentId, branchKey\) \{[\s\S]*?\n\}/,
    );
  const pipeline = { steps };
  const warnings = [];
  const fn = new Function(
    "_pipeline",
    "notify",
    `${body}; return _moveStepInto;`,
  )(pipeline, (level, msg) => warnings.push(msg));
  return { move: fn, pipeline, warnings };
}

const loopWith = (id, children = []) => ({
  id,
  type: "LOOP",
  config: { type: "elements", selector: ".card" },
  children,
});

test("a step can be dropped into an empty loop", () => {
  const { move, pipeline } = makeMoverInto([{ id: "a" }, loopWith("L")]);
  assert.equal(move("a", "L", "children"), true);
  assert.deepEqual(ids(pipeline.steps), ["L"]);
  assert.deepEqual(ids(pipeline.steps[0].children), ["a"]);
});

test("a step dropped into a loop that already has steps goes to the end", () => {
  const { move, pipeline } = makeMoverInto([
    { id: "a" },
    loopWith("L", [{ id: "b" }]),
  ]);
  assert.equal(move("a", "L", "children"), true);
  assert.deepEqual(ids(pipeline.steps[0].children), ["b", "a"]);
});

test("a step can be dropped into either branch of an IF", () => {
  const steps = [
    { id: "a" },
    { id: "F", type: "IF_ELSE", config: {}, ifBranch: [], elseBranch: [] },
  ];
  const { move, pipeline } = makeMoverInto(steps);
  assert.equal(move("a", "F", "elseBranch"), true);
  // By id, not by index: removing "a" from the root shifts everything left.
  const branch = pipeline.steps.find((st) => st.id === "F");
  assert.deepEqual(ids(branch.elseBranch), ["a"]);
  assert.equal(branch.ifBranch.length, 0);
});

test("a step already inside the loop is moved, not duplicated", () => {
  const { move, pipeline } = makeMoverInto([
    loopWith("L", [{ id: "a" }, { id: "b" }]),
  ]);
  assert.equal(move("a", "L", "children"), true);
  assert.deepEqual(ids(pipeline.steps[0].children), ["b", "a"]);
});

test("a loop cannot be dropped into itself", () => {
  // It would vanish from the board, taking its children with it.
  const { move, warnings, pipeline } = makeMoverInto([
    loopWith("L", [{ id: "a" }]),
  ]);
  assert.equal(move("L", "L", "children"), false);
  assert.deepEqual(ids(pipeline.steps), ["L"]);
  assert.ok(warnings.length > 0, "it said nothing about refusing");
});

test("a loop cannot be dropped into a loop it contains", () => {
  const inner = loopWith("IN", []);
  const { move, pipeline } = makeMoverInto([loopWith("OUT", [inner])]);
  assert.equal(move("OUT", "IN", "children"), false);
  assert.deepEqual(ids(pipeline.steps), ["OUT"]);
});

test("the loop body is a drop target in the rendered board", () => {
  // Without this the handler above has nothing to fire on.
  assert.match(
    src,
    /class="loop-body-inner"[^`]*data-parent-id=/,
    "the loop body carries no container identity for a drop",
  );
  const bind = extract(/function bindDragAndDrop\(\) \{[\s\S]*?\n\}/);
  assert.match(bind, /loop-body-inner/, "nothing listens on the loop body");
  assert.match(bind, /_moveStepInto/);
});
