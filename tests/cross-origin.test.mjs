// Regression tests for audit finding B-03.
//
// Gate 6 hard-blocked any step whose origin differed from the tab's. It got the
// risk backwards in three separate ways:
//
//   1. It blocked the safe case — a cross-origin URL the author typed into a
//      NAVIGATE or API step, visible in the step config and chosen
//      deliberately. That made multi-domain pipelines impossible and rejected
//      every third-party API call, including the API step's own default URL.
//   2. It only walked top-level steps, so moving the same step inside a LOOP or
//      an IF/ELSE branch bypassed it entirely.
//   3. It permitted the dangerous case. `{{item.href}}` is not a valid URL at
//      gate time, so new URL() threw and the step was waved through — and that
//      value comes from the page's own DOM via QUERY_ELEMENTS, which means the
//      page chooses where the pipeline navigates.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => "" });
globalThis.chrome = { tabs: { sendMessage: async () => ({}) } };

const { runEthicsGates, collectDeclaredOrigins } = await import(
  new URL("../background/ethics-engine.js", import.meta.url).href
);

const TARGET = "https://shop.test";
const base = { targetOrigin: TARGET, targetPath: "/", timing: {}, bypassRobots: true };
const gates = (steps) => runEthicsGates({ ...base, steps });
const codes = (r) => r.warnings.map((w) => w.code);

// ── the pre-run gate now reports rather than blocks ──────────────────────────

test("an authored cross-origin step is reported, not blocked", async () => {
  const r = await gates([{ type: "NAVIGATE", config: { url: "https://other.test/page" } }]);

  assert.equal(r.blocked, false, "the author typed this URL and can see it");
  const warning = r.warnings.find((w) => w.code === "CrossOrigin");
  assert.ok(warning, "reported as a warning");
  assert.match(warning.message, /other\.test/, "the user is told where it goes");
});

test("a third-party API step no longer blocks the run", async () => {
  // The API step's own registry default points at api.example.com, so adding
  // one and pressing Run used to hard-fail immediately.
  const r = await gates([
    { type: "API", config: { url: "https://api.example.com/resource" } },
  ]);
  assert.equal(r.blocked, false);
});

test("a same-origin pipeline produces no cross-origin warning", async () => {
  const r = await gates([
    { type: "NAVIGATE", config: { url: "https://shop.test/products" } },
    { type: "API", config: { url: "/api/items" } },
  ]);
  assert.ok(!codes(r).includes("CrossOrigin"));
});

test("steps nested in loops and branches are seen", async () => {
  // Previously the gate walked top-level steps only, so this was invisible.
  const r = await gates([
    {
      type: "LOOP",
      config: {},
      children: [{ type: "NAVIGATE", config: { url: "https://nested.test/x" } }],
    },
    {
      type: "IF_ELSE",
      config: {},
      ifBranch: [{ type: "API", config: { url: "https://branch.test/y" } }],
      elseBranch: [],
    },
  ]);

  const message = r.warnings.find((w) => w.code === "CrossOrigin").message;
  assert.match(message, /nested\.test/);
  assert.match(message, /branch\.test/);
});

// ── declared origins ─────────────────────────────────────────────────────────

test("templated URLs declare nothing", () => {
  const declared = collectDeclaredOrigins(
    [
      {
        type: "LOOP",
        config: {},
        children: [{ type: "NAVIGATE", config: { url: "{{item.href}}" } }],
      },
    ],
    TARGET,
  );
  assert.deepEqual(
    [...declared],
    [TARGET],
    "the origin is not knowable until the step runs, so it is enforced then",
  );
});

test("relative URLs resolve against the target origin", () => {
  const declared = collectDeclaredOrigins(
    [{ type: "NAVIGATE", config: { url: "/deals" } }],
    TARGET,
  );
  assert.deepEqual([...declared], [TARGET]);
});

test("every authored origin is collected once", () => {
  const declared = collectDeclaredOrigins(
    [
      { type: "NAVIGATE", config: { url: "https://a.test/1" } },
      { type: "NAVIGATE", config: { url: "https://a.test/2" } },
      { type: "API", config: { url: "https://b.test/x" } },
      { type: "CLICK", config: { selector: "https://not-a-url.test" } },
    ],
    TARGET,
  );
  assert.deepEqual([...declared].sort(), [TARGET, "https://a.test", "https://b.test"].sort());
});

// ── runtime enforcement ──────────────────────────────────────────────────────
// _assertOriginAllowed lives in service-worker.js, which starts a worker on
// import; the function is pure, so it is extracted and exercised directly.

const swSrc = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);

class EthicsBlock extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const assertOriginAllowed = new Function(
  "EthicsBlock",
  `${swSrc.match(/function _assertOriginAllowed\([\s\S]*?\n\}/)[0]}; return _assertOriginAllowed;`,
)(EthicsBlock);

const runState = (origins) => ({
  targetOrigin: TARGET,
  allowedOrigins: new Set(origins),
});

test("a same-origin templated link is allowed", () => {
  // The ordinary case: loop the product cards, open each one.
  assert.doesNotThrow(() =>
    assertOriginAllowed("https://shop.test/product/1", runState([TARGET]), "NAVIGATE"),
  );
});

test("a page-controlled link to an undeclared origin is blocked", () => {
  // This is what the old gate waved through.
  assert.throws(
    () => assertOriginAllowed("https://evil.test/steal", runState([TARGET]), "NAVIGATE"),
    (err) => {
      assert.equal(err.code, "UndeclaredOrigin");
      assert.match(err.message, /evil\.test/);
      assert.match(err.message, /chosen by the page/, "the error explains why");
      return true;
    },
  );
});

test("an origin the author declared stays allowed at runtime", () => {
  assert.doesNotThrow(() =>
    assertOriginAllowed(
      "https://other.test/page",
      runState([TARGET, "https://other.test"]),
      "NAVIGATE",
    ),
  );
});

test("API calls are enforced too", () => {
  assert.throws(
    () => assertOriginAllowed("https://evil.test/exfil", runState([TARGET]), "API"),
    /UndeclaredOrigin|evil\.test/,
  );
});

test("a relative URL resolves against the target and passes", () => {
  assert.doesNotThrow(() =>
    assertOriginAllowed("/checkout", runState([TARGET]), "NAVIGATE"),
  );
});

test("enforcement is skipped when nothing was declared", () => {
  // Started from a new tab with no usable origin: there is no baseline to
  // enforce against, so the gate stays out of the way rather than blocking
  // everything.
  assert.doesNotThrow(() =>
    assertOriginAllowed("https://anywhere.test/x", runState([]), "NAVIGATE"),
  );
});

test("both executors enforce before navigating", () => {
  // The step dispatch chain is duplicated in _executeStepList and
  // _executePipeline (audit B-27); a check added to only one is a hole.
  const calls = swSrc.match(/_assertOriginAllowed\(/g) ?? [];
  assert.ok(
    calls.length >= 5,
    `expected the helper plus both navigation and both API sites, found ${calls.length}`,
  );
});
