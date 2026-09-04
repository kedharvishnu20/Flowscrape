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

test("the unexportable types are the ones that need the extension", () => {
  const notExportable = USER_STEP_TYPES.filter(
    (t) => STEP_TYPES[t].exportable === false,
  );
  assert.deepEqual(notExportable.sort(), [
    "API_SNIFFER",
    "AUTO_EXTRACT",
    // PAGE_JSON's DOM walker is two hundred lines with its own budgets and
    // filters; a second copy inlined into every emitted script would drift
    // from it, and a script that dumps a *different* JSON than the pipeline
    // is worse than one that refuses.
    "PAGE_JSON",
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

// ── value transforms travel with the pipeline ────────────────────────────────

test("an exported script cleans values the way the pipeline does", () => {
  // Otherwise the export is a new instance of the old lie: it runs, it produces
  // a file, and the numbers in it are strings with currency symbols.
  const { py, js } = emit([
    step("EXTRACT", {
      fields: [
        { name: "price", selector: ".p", transform: ["number"] },
        {
          name: "link",
          selector: "a",
          type: "attribute",
          attribute: "href",
          transform: ["url"],
        },
      ],
    }),
  ]);
  assert.match(js, /fsNumber|_fs_number/i);
  assert.match(py, /fs_number/i);
  // A relative link is resolved against the page it came from.
  assert.match(js, /page\.url\(\)/);
  assert.match(py, /page\.url/);
});

test("a field with no transform is emitted with no wrapper", () => {
  const { js } = emit([
    step("EXTRACT", { fields: [{ name: "name", selector: ".n" }] }),
  ]);
  assert.match(js, /extracted\['name'\] = await page\.innerText\('\.n'\);/);
});

// ── the generated scripts are valid programs ─────────────────────────────────
//
// The emitters build source by concatenating string literals, which is exactly
// where an unbalanced brace or a bad escape hides: every assertion above
// pattern-matches the output, and a pattern match is happy with source that
// will not parse. So parse it.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "fs-emit-"));

/** Every construct the emitters can produce, in one pipeline. */
const KITCHEN_SINK = [
  step("NAVIGATE", { url: "https://shop.test/", wait: true }),
  step("WAIT", { mode: "selector-visible", selector: ".r", timeout: 9000 }),
  step("WAIT", { mode: "selector-gone", selector: ".spin" }),
  step("WAIT", { mode: "DOM-stable" }),
  step("WAIT", { mode: "fixed", ms: 500 }),
  step("SCROLL", { mode: "infinite", maxScrolls: 5, settleMs: 800 }),
  step("SCROLL", { mode: "percent", amount: 80 }),
  step("CLICK", { selector: ".buy" }),
  step("FILL", { selector: "#q", text: "shoes" }),
  step("SELECT", { selector: "#size", value: "l" }),
  step("HOVER", { selector: ".menu" }),
  step("KEYBOARD", { key: "Enter" }),
  step("DRAG_DROP", { source: ".a", target: ".b" }),
  step("PAGINATE", { selector: ".next" }),
  step("EXTRACT", {
    fields: [
      { name: "name", selector: ".n" },
      { name: "price", selector: ".p", transform: ["number"] },
      { name: "tidy", selector: ".t", transform: ["trim"] },
      { name: "loud", selector: ".l", transform: ["upper"] },
      { name: "quiet", selector: ".q", transform: ["lower"] },
      {
        name: "sku",
        selector: ".s",
        transform: ["regex"],
        regexPattern: "SKU: (\\S+)",
      },
      {
        name: "link",
        selector: "a",
        type: "attribute",
        attribute: "href",
        transform: ["url"],
      },
    ],
  }),
  step("PAGE_DATA", { source: "auto", type: "Product", flatten: true }),
  step("PAGE_DATA", { source: "jsonld", type: "", flatten: false }),
  step("SCREENSHOT", { quality: 90 }),
  step("EXPORT", { format: "csv" }),
];

const NESTED = [
  {
    id: "loop",
    type: "LOOP",
    config: { type: "paginate", selector: ".next", max: 5 },
    children: [step("EXTRACT", { fields: [{ name: "t", selector: "h1" }] })],
  },
  {
    id: "loop2",
    type: "LOOP",
    config: { type: "elements", selector: ".card", max: 0 },
    children: [step("CLICK", { selector: ".open" })],
  },
];

test("the emitted Node script parses", () => {
  const file = join(dir, "out.mjs");
  writeFileSync(file, emit([...KITCHEN_SINK, ...NESTED]).js);
  execFileSync(process.execPath, ["--check", file]);
});

test("the emitted Python script compiles", (t) => {
  let python;
  try {
    python = execFileSync("sh", ["-c", "command -v python3"], {
      encoding: "utf8",
    }).trim();
  } catch {
    t.skip("no python3 on this machine");
    return;
  }
  const file = join(dir, "out.py");
  writeFileSync(file, emit([...KITCHEN_SINK, ...NESTED]).py);
  execFileSync(python, ["-m", "py_compile", file]);
});

test("a user's regex pattern reaches the script intact", () => {
  // Both scripts parsed and both patterns were wrong, which is why the parse
  // check above is not enough on its own.
  //
  //   JS:     '\\S' inside a single-quoted literal is just 'S'
  //   Python: '\\\\S' inside an r"" raw string is a literal backslash then S
  //
  // Either way "SKU: (\\S+)" silently became a pattern that matches nothing,
  // and the column came back empty with no error anywhere.
  const { py, js } = emit([
    step("EXTRACT", {
      fields: [
        {
          name: "sku",
          selector: ".s",
          transform: ["regex"],
          regexPattern: "SKU: (\\S+)",
        },
      ],
    }),
  ]);

  // Read the emitted pattern back out and check what it actually matches,
  // rather than checking how it is spelled.
  const jsPattern = js.match(
    /fsRegex\(await page\.innerText\('\.s'\), '(.*)'\)/,
  )?.[1];
  assert.ok(jsPattern, `no fsRegex call emitted:\n${js}`);
  const jsSource = new Function(`return '${jsPattern}'`)();
  assert.equal("SKU: ABC-1".match(new RegExp(jsSource))?.[1], "ABC-1");

  const pyPattern = py.match(
    /fs_regex\(await page\.inner_text\("\.s"\), r"(.*)"\)/,
  )?.[1];
  assert.ok(pyPattern, `no fs_regex call emitted:\n${py}`);
  // r"" is raw: what is between the quotes is the pattern, verbatim.
  assert.equal("SKU: ABC-1".match(new RegExp(pyPattern))?.[1], "ABC-1");
});

test("a quote in a regex pattern cannot break out of the string", () => {
  const { py, js } = emit([
    step("EXTRACT", {
      fields: [
        {
          name: "q",
          selector: ".q",
          transform: ["regex"],
          regexPattern: `it's "(\\w+)"`,
        },
      ],
    }),
  ]);
  const file = join(dir, "quote.mjs");
  writeFileSync(file, js);
  execFileSync(process.execPath, ["--check", file]);
  assert.ok(py.includes("fs_regex"));
});

test("an invalid regex pattern makes the script refuse to run, not quietly differ", () => {
  // A lone trailing backslash is not a regex. Stripping it to make the emitted
  // literal well-formed would produce a script that runs and extracts
  // something other than what the pipeline extracts — the exact class of
  // defect the audit was about.
  const { py, js } = emit([
    step("EXTRACT", {
      fields: [
        {
          name: "q",
          selector: ".q",
          transform: ["regex"],
          regexPattern: "abc\\",
        },
      ],
    }),
  ]);
  assert.match(js, /INVALID|throw new Error/);
  assert.match(py, /INVALID|raise /);
});

test("the JavaScript PAGE_DATA hands to the browser is itself valid JavaScript", (t) => {
  // Both scripts compile with this broken, because to Python and Node the
  // browser snippet is just a string. Python's """...""" treats \\' as an
  // escape, so a single-quoted selector inside it arrives at the browser
  // unterminated — a run-time SyntaxError in a page, which no parse check
  // above can see.
  const { py, js } = emit([
    step("PAGE_DATA", { source: "auto", type: "Product", flatten: true }),
  ]);

  // Read it back the way Python will: the text in the .py file is not what
  // reaches the browser, because Python resolves the escapes in it first.
  // Checking the raw text passes with this broken, which is how it got here.
  let python;
  try {
    python = execFileSync("sh", ["-c", "command -v python3"], {
      encoding: "utf8",
    }).trim();
  } catch {
    t.skip("no python3 on this machine");
    return;
  }
  const pyFile = join(dir, "pd.py");
  writeFileSync(pyFile, py);
  const reader = join(dir, "read_snippet.py");
  writeFileSync(
    reader,
    [
      "import ast, sys",
      "tree = ast.parse(open(sys.argv[1]).read())",
      "for node in ast.walk(tree):",
      "    if isinstance(node, ast.Constant) and isinstance(node.value, str):",
      '        if "querySelectorAll" in node.value:',
      "            sys.stdout.write(node.value)",
      "            break",
    ].join("\n"),
  );
  const pySnippet = execFileSync(python, [reader, pyFile], {
    encoding: "utf8",
  });
  assert.ok(pySnippet.includes("querySelectorAll"), "no snippet found");
  assert.doesNotThrow(
    () => new Function(`return (${pySnippet})`),
    "the snippet Python sends to the browser does not parse as JavaScript",
  );

  // The Node emitter inlines the snippet as a real arrow function in the
  // script itself, so `node --check` above already parses it. Assert only that
  // it is present.
  assert.match(js, /page\.evaluate\(\(\) => \{/);
  assert.match(js, /ld\+json/);
});

// ── IF_ELSE conditions in an exported script ────────────────────────────────

test("every IF_ELSE condition is emitted, not stubbed to always-true", async () => {
  // Both emitters handled `exists` and fell through to
  // `if (true) { // TODO: impl extended condition ... }` for everything else.
  // The exported script therefore took the IF branch unconditionally — it ran,
  // produced a file, and had silently ignored its own branching. The B-13
  // check could not see it: it looks for "# TODO" in the Python output, and
  // the Node stub is a `//` comment.
  const { CONDITION_NAMES } = await import("../utils/conditions.js");
  const stubbed = [];
  for (const condition of CONDITION_NAMES) {
    const pipeline = [
      {
        id: "if",
        type: "IF_ELSE",
        config: { condition, selector: ".p", value: "10", attr: "data-id" },
        ifBranch: [step("CLICK", { selector: ".yes" })],
        elseBranch: [step("CLICK", { selector: ".no" })],
      },
    ];
    const { py, js } = emit(pipeline);
    if (/if \(true\)|if True:|TODO/.test(js + py)) stubbed.push(condition);
  }
  assert.deepEqual(stubbed, [], "these conditions are emitted as always-true");
});

test("an emitted numeric condition compares numbers, not strings", () => {
  // "$9.99" < "$25.50" is true as a string comparison and false as a number
  // one, which is the wrong branch on most of a shop.
  const { py, js } = emit([
    {
      id: "if",
      type: "IF_ELSE",
      config: { condition: "number-lt", selector: ".p", value: "50" },
      ifBranch: [step("CLICK", { selector: ".cheap" })],
      elseBranch: [],
    },
  ]);
  // The prelude defines fsNumber unconditionally, so look at the condition
  // itself rather than at the file.
  // Anchored on the emitted step, or the prelude's own `if`s match first.
  const jsTest = js.match(/\/\/ IF_ELSE:[\s\S]*?if \((.*)\) \{/)?.[1] ?? "";
  assert.match(
    jsTest,
    /fsNumber/,
    `the branch does not read a number: ${jsTest}`,
  );
  assert.match(jsTest, /< 50/);

  const pyTest = py.match(/# IF_ELSE:[\s\S]*?\n\s*if (.*):/)?.[1] ?? "";
  assert.match(
    pyTest,
    /fs_number/,
    `the branch does not read a number: ${pyTest}`,
  );
  assert.match(pyTest, /< 50/);
});

test("the emitted branches still parse with every condition in them", (t) => {
  const branchy = [
    {
      id: "a",
      type: "IF_ELSE",
      config: { condition: "is-empty", selector: ".p" },
      ifBranch: [step("CLICK", { selector: ".x" })],
      elseBranch: [
        {
          id: "b",
          type: "IF_ELSE",
          config: { condition: "text-matches", selector: ".q", value: "\\d+" },
          ifBranch: [step("CLICK", { selector: ".y" })],
          elseBranch: [],
        },
      ],
    },
    {
      id: "c",
      type: "IF_ELSE",
      config: { condition: "attr-exists", selector: ".r", attr: "data-id" },
      ifBranch: [],
      elseBranch: [step("CLICK", { selector: ".z" })],
    },
  ];
  const { py, js } = emit(branchy);

  const jsFile = join(dir, "branches.mjs");
  writeFileSync(jsFile, js);
  execFileSync(process.execPath, ["--check", jsFile]);

  let python;
  try {
    python = execFileSync("sh", ["-c", "command -v python3"], {
      encoding: "utf8",
    }).trim();
  } catch {
    t.skip("no python3 on this machine");
    return;
  }
  const pyFile = join(dir, "branches.py");
  writeFileSync(pyFile, py);
  execFileSync(python, ["-m", "py_compile", pyFile]);
});
