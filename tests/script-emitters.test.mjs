// Regression tests for audit findings B-13 and B-15.
//
// B-13: the emitters covered 11 of 21 step types. Everything else fell through
// to `# TODO: implement step type "X"` — a comment. The exported script looked
// complete, ran, and silently did less than the pipeline it came from. FILL was
// among the missing ones, so a form-filling pipeline exported as a script that
// filled nothing.
//
// B-15: SCROLL read config.value, but the UI writes config.amount, so every
// exported scroll used the hardcoded default of 300px.
import test from "node:test";
import assert from "node:assert/strict";
import {
  compilePipeline,
  findUnexportableSteps,
} from "../script-gen/pipeline-compiler.js";
import { emitPython } from "../script-gen/python-emitter.js";
import { emitNode } from "../script-gen/node-emitter.js";
import {
  EXPORTABLE_STEP_TYPES,
  USER_STEP_TYPES,
  STEP_TYPES,
} from "../utils/step-types.js";

const compile = (steps) =>
  compilePipeline({ name: "t", targetOrigin: "https://shop.test", steps }).ast;

const emit = (steps) => ({
  py: emitPython(compile(steps)),
  js: emitNode(compile(steps)),
});

const step = (type, config = {}, extra = {}) => ({
  id: `s_${type}`,
  type,
  config,
  ...extra,
});

test("FILL is emitted, in both languages", () => {
  const { py, js } = emit([
    step("FILL", { selector: "#email", text: "a@b.test" }),
  ]);
  // Values pass through fs_env/fsEnv so a credential marker (B-14) resolves at
  // run time; an ordinary value comes back from it unchanged.
  assert.match(py, /await page\.fill\("#email", fs_env\("a@b\.test"\)\)/);
  assert.match(js, /await page\.fill\('#email', fsEnv\('a@b\.test'\)\)/);
});

test("multi-field FILL emits every field and the submit click", () => {
  const { py } = emit([
    step("FILL", {
      mode: "multi",
      fields: [
        { selector: "#first", value: "Ada" },
        { selector: "#last", value: "Lovelace" },
      ],
      submitSelector: "#go",
    }),
  ]);
  assert.match(py, /page\.fill\("#first", fs_env\("Ada"\)\)/);
  assert.match(py, /page\.fill\("#last", fs_env\("Lovelace"\)\)/);
  assert.match(py, /page\.click\("#go"\)/);
});

test("HOVER, SELECT, KEYBOARD, PAGINATE, DRAG_DROP and SCREENSHOT all emit", () => {
  const { py, js } = emit([
    step("HOVER", { selector: ".menu" }),
    step("SELECT", { selector: "#size", value: "L" }),
    step("KEYBOARD", { key: "Enter" }),
    step("PAGINATE", { selector: ".next" }),
    step("DRAG_DROP", { source: ".a", target: ".b" }),
    step("SCREENSHOT", {}),
  ]);

  for (const [lang, code] of [
    ["python", py],
    ["node", js],
  ]) {
    assert.ok(!/TODO/.test(code), `${lang} emitted a TODO`);
    assert.ok(/hover/i.test(code), `${lang} hover`);
    assert.ok(/select_option|selectOption/.test(code), `${lang} select`);
    assert.ok(/keyboard\.press/.test(code), `${lang} keyboard`);
    assert.ok(/drag/i.test(code), `${lang} drag`);
    assert.ok(/screenshot/i.test(code), `${lang} screenshot`);
  }
});

test("a Ctrl combo becomes Playwright's key name", () => {
  const { py } = emit([step("KEYBOARD", { key: "Ctrl+Enter" })]);
  assert.match(py, /keyboard\.press\("Control\+Enter"\)/);
});

test("SCROLL uses the amount the UI actually writes", () => {
  const { py, js } = emit([step("SCROLL", { mode: "pixel", amount: 1200 })]);
  assert.match(
    py,
    /scrollBy\(0, 1200\)/,
    "config.amount, not the 300px default",
  );
  assert.match(js, /scrollBy\(0, 1200\)/);
});

test("SCROLL honours its other modes", () => {
  assert.match(
    emit([step("SCROLL", { mode: "selector", selector: "#footer" })]).py,
    /scroll_into_view_if_needed/,
  );
  assert.match(
    emit([step("SCROLL", { mode: "percent", amount: 50 })]).py,
    /scrollHeight \* 0\.5/,
  );
});

// ── what cannot be exported ──────────────────────────────────────────────────

test("an unexportable step fails loudly instead of becoming a comment", () => {
  const { py, js } = emit([step("AUTO_EXTRACT", {})]);

  assert.match(
    py,
    /raise NotImplementedError/,
    "python refuses to run past it",
  );
  assert.match(js, /throw new Error/, "node refuses to run past it");
  assert.ok(!/# TODO/.test(py), "a comment let the script run and do nothing");
});

test("unexportable steps are reported, including nested ones", () => {
  const ast = compile([
    step("NAVIGATE", { url: "https://shop.test" }),
    step("LOOP", { max: 3 }, { children: [step("AUTO_EXTRACT", {})] }),
    step(
      "IF_ELSE",
      {},
      {
        ifBranch: [step("API_SNIFFER", {})],
        elseBranch: [step("CLICK", { selector: ".x" })],
      },
    ),
  ]);

  const found = findUnexportableSteps(ast)
    .map((s) => s.type)
    .sort();
  assert.deepEqual(found, ["API_SNIFFER", "AUTO_EXTRACT"]);
});

test("a fully exportable pipeline reports nothing", () => {
  const ast = compile([
    step("NAVIGATE", { url: "https://shop.test" }),
    step("CLICK", { selector: ".a" }),
    step("EXTRACT", { fields: [{ name: "t", selector: "h1" }] }),
    step("EXPORT", { format: "csv" }),
  ]);
  assert.deepEqual(findUnexportableSteps(ast), []);
});

test("each unexportable step says why", () => {
  const ast = compile([step("UPLOAD_ACTIVITY", {})]);
  const [found] = findUnexportableSteps(ast);
  assert.equal(found.type, "UPLOAD_ACTIVITY");
  assert.ok(found.reason.length > 0);
  assert.equal(found.id, "s_UPLOAD_ACTIVITY");
});

// ── registry agreement ───────────────────────────────────────────────────────

test("every step the registry calls exportable really is emitted", () => {
  // Closes the drift loop: marking a type exportable without teaching the
  // emitters about it fails here rather than in a user's downloaded script.
  const missing = [];
  for (const type of EXPORTABLE_STEP_TYPES) {
    if (STEP_TYPES[type].internal) continue;
    const code = emitPython(compile([step(type, STEP_TYPES[type].def)]));
    if (/NotImplementedError|# TODO/.test(code)) missing.push(type);
  }
  assert.deepEqual(
    missing,
    [],
    "these are marked exportable but emit a failure",
  );
});

test("the four unexportable types are the ones that need the extension", () => {
  const notExportable = USER_STEP_TYPES.filter(
    (t) => STEP_TYPES[t].exportable === false,
  );
  assert.deepEqual(notExportable.sort(), [
    "API_SNIFFER",
    "AUTO_EXTRACT",
    "PDF_EXTRACTION",
    "UPLOAD_ACTIVITY",
  ]);
});

test("the exportable flag sits on the step, not inside its defaults", () => {
  // It is easy to nest this by accident, and JS stays valid when you do.
  for (const type of USER_STEP_TYPES) {
    assert.ok(
      !("exportable" in STEP_TYPES[type].def),
      `${type} has exportable inside def`,
    );
  }
});

test("generated Python and Node are structurally complete", () => {
  const { py, js } = emit([
    step("NAVIGATE", { url: "https://shop.test" }),
    step("FILL", { selector: "#q", text: "hi" }),
  ]);

  assert.match(py, /async def run_pipeline\(\)/);
  assert.match(py, /asyncio\.run\(run_pipeline\(\)\)/);
  assert.match(js, /await chromium\.launch/);
  assert.match(js, /await browser\.close\(\)/);
});

// ── The new step modes ───────────────────────────────────────────────────────
//
// WAIT, SCROLL and PAGINATE gained real behaviour (task #40). An exported
// script that still emits a fixed sleep where the pipeline waits for an element
// — or a bare click where the pipeline detects the last page — is the same
// class of defect the audit was about: an artefact that looks complete and does
// less than the thing it was generated from.

test("waiting for an element to disappear is emitted, not turned into a sleep", () => {
  const { py, js } = emit([
    step("WAIT", {
      mode: "selector-gone",
      selector: ".spinner",
      timeout: 9000,
    }),
  ]);
  assert.match(
    js,
    /waitForSelector\('\.spinner',\s*\{[^}]*hidden|state:\s*'hidden'/,
  );
  assert.match(py, /wait_for_selector\("\.spinner"[\s\S]*?hidden/);
  assert.doesNotMatch(js, /sleep\(1000\)/);
});

test("waiting for the DOM to settle becomes a network-idle wait", () => {
  const { py, js } = emit([
    step("WAIT", { mode: "DOM-stable", timeout: 9000 }),
  ]);
  assert.match(js, /waitForLoadState\('networkidle'/);
  assert.match(py, /wait_for_load_state\("networkidle"/);
});

test("a wait's timeout is carried into the script", () => {
  const { py, js } = emit([
    step("WAIT", { mode: "selector-visible", selector: ".r", timeout: 9000 }),
  ]);
  assert.match(js, /9000/);
  assert.match(py, /9000/);
});

test("infinite scroll is emitted as a loop, not as one scroll", () => {
  const { py, js } = emit([
    step("SCROLL", { mode: "infinite", maxScrolls: 7, settleMs: 900 }),
  ]);
  for (const src of [py, js]) {
    assert.match(src, /7/, "the scroll limit is carried over");
    assert.match(src, /scrollHeight/);
  }
  assert.match(js, /for \(/);
  assert.match(py, /for _ in range/);
});

test("PAGINATE stops at the last page in an exported script too", () => {
  const { py, js } = emit([step("PAGINATE", { selector: ".next" })]);
  // A bare click is what this used to emit. The script has to make the same
  // decision the extension makes: is there another page?
  assert.match(js, /count\(\)|isDisabled|is_disabled/);
  assert.match(py, /count\(\)|is_disabled/);
});
