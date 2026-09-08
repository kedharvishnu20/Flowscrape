// Regression tests for audit findings B-01 and B-02.
//
// B-01: the side panel sent bypassRobots, but PIPELINE_START destructured only
// four fields from the payload and never forwarded it, so _gate1_robots always
// saw undefined and the "Bypass robots.txt" checkbox did nothing.
//
// B-02: runEthicsGates returns soft warnings that were handed to a caller which
// read only res.result.runId, so nothing was ever logged, shown or confirmed.
// These tests pin the shape the side panel renders.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ROBOTS = "User-agent: *\nDisallow: /private\n";

globalThis.fetch = async (url) => {
  if (String(url).endsWith("/robots.txt")) {
    return { ok: true, status: 200, text: async () => ROBOTS };
  }
  throw new Error(`unexpected fetch: ${url}`);
};
globalThis.chrome = { tabs: { sendMessage: async () => ({}) } };

const { runEthicsGates } = await import(
  new URL("../background/ethics-engine.js", import.meta.url).href
);

const base = {
  targetOrigin: "https://example.com",
  timing: {},
  confirmed: false,
  rowCount: 0,
  steps: [],
};

test("gate 1 warns on a disallowed path without blocking", async () => {
  const r = await runEthicsGates({ ...base, targetPath: "/private/x" });

  assert.equal(r.blocked, false, "robots is a soft gate");
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, "RobotsTxt");
  assert.match(
    r.warnings[0].message,
    /\/private\/x/,
    "the message names the path",
  );
});

test("bypassRobots suppresses the warning", async () => {
  const r = await runEthicsGates({
    ...base,
    targetPath: "/private/x",
    bypassRobots: true,
  });
  assert.deepEqual(
    r.warnings,
    [],
    "this is the flag the service worker used to drop",
  );
});

test("an allowed path is quiet", async () => {
  const r = await runEthicsGates({ ...base, targetPath: "/public" });
  assert.deepEqual(r.warnings, []);
});

test("warnings survive the trip to the side panel", async () => {
  const r = await runEthicsGates({ ...base, targetPath: "/private/x" });
  const serialized = r.warnings.map((w) => ({
    code: w.code,
    message: w.message,
  }));

  assert.equal(typeof serialized[0].code, "string");
  assert.equal(typeof serialized[0].message, "string");
  assert.equal(
    JSON.parse(JSON.stringify(serialized))[0].code,
    "RobotsTxt",
    "EthicsWarn instances must survive structured cloning as plain data",
  );
});

test("a cross-origin step is reported, not blocked", async () => {
  // Changed deliberately in B-03: the gate blocked the case the author typed
  // and could see, while waving through page-controlled origins. Enforcement
  // moved to execution time; see tests/cross-origin.test.mjs.
  const r = await runEthicsGates({
    ...base,
    targetPath: "/public",
    steps: [
      { type: "NAVIGATE", config: { url: "https://elsewhere.test/page" } },
    ],
  });

  assert.equal(r.blocked, false);
  const warning = r.warnings.find((w) => w.code === "CrossOrigin");
  assert.ok(warning);
  assert.match(warning.message, /elsewhere\.test/);
});

// ── Gate 3: rate estimate ────────────────────────────────────────────────────
// It used to count every step — clicks, extracts, waits — against a hardcoded
// 1200ms interval, so a two-step pipeline estimated 6000 req/hr and essentially
// every run produced a warning. A gate that always fires teaches people to
// dismiss the dialog, which costs the gates that matter.

test("a pipeline that makes no requests raises no rate warning", async () => {
  const r = await runEthicsGates({
    ...base,
    targetPath: "/public",
    steps: [
      { type: "CLICK", config: { selector: ".a" } },
      { type: "EXTRACT", config: { fields: [] } },
      { type: "WAIT", config: { ms: 500 } },
      { type: "SCREENSHOT", config: {} },
    ],
  });
  assert.ok(
    !r.warnings.some((w) => w.code === "HighRate"),
    "none of these steps touch the network",
  );
});

test("a handful of navigations stays under the threshold", async () => {
  const r = await runEthicsGates({
    ...base,
    targetPath: "/public",
    steps: [
      { type: "NAVIGATE", config: { url: "https://example.com/a" } },
      { type: "CLICK", config: { selector: ".x" } },
      { type: "EXTRACT", config: { fields: [] } },
    ],
  });
  assert.ok(!r.warnings.some((w) => w.code === "HighRate"));
});

test("a large loop of navigations does warn", async () => {
  const r = await runEthicsGates({
    ...base,
    targetPath: "/public",
    steps: [
      {
        type: "LOOP",
        config: { type: "elements", max: 200 },
        children: [
          { type: "NAVIGATE", config: { url: "{{item.href}}" } },
          { type: "EXTRACT", config: { fields: [] } },
        ],
      },
    ],
  });

  const warning = r.warnings.find((w) => w.code === "HighRate");
  assert.ok(warning, "200 page loads is worth flagging");
  assert.match(
    warning.message,
    /about 200 requests/,
    "the count is the loop bound, not the step count",
  );
});

test("only the more expensive branch of an IF/ELSE is charged", async () => {
  const r = await runEthicsGates({
    ...base,
    targetPath: "/public",
    steps: [
      {
        type: "IF_ELSE",
        config: {},
        ifBranch: [
          { type: "NAVIGATE", config: { url: "https://example.com/a" } },
        ],
        elseBranch: [
          { type: "NAVIGATE", config: { url: "https://example.com/b" } },
          { type: "NAVIGATE", config: { url: "https://example.com/c" } },
        ],
      },
    ],
  });
  // 2 requests, not 3 — only one branch runs.
  assert.ok(!r.warnings.some((w) => w.code === "HighRate"));
});

// ── Wiring ───────────────────────────────────────────────────────────────────
// The gate engine always supported bypassRobots; the bug was the service worker
// not passing it. Pin the forwarding so it cannot be dropped again.

const swSrc = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);

test("the service worker forwards bypassRobots to the gates", () => {
  const gateArgs = swSrc.match(/function _gateArgs\([\s\S]*?\n\}/)?.[0];
  assert.ok(gateArgs, "found _gateArgs");
  assert.match(gateArgs, /bypassRobots:\s*payload\.bypassRobots/);
});

test("preflight and start build their gate arguments from the same place", () => {
  assert.match(swSrc, /_registerHandler\("pipeline:preflight"/);
  const uses = swSrc.match(/_gateArgs\(payload,/g) ?? [];
  assert.ok(
    uses.length >= 2,
    "the check the user confirms must be the check that gates the run",
  );
});

test("pipeline:start re-runs the gates rather than trusting the preflight", () => {
  const start = swSrc.match(
    /_registerHandler\(MSG\.PIPELINE_START[\s\S]*?ethicsResult\.blocked/,
  )?.[0];
  assert.ok(start, "found the start handler");
  assert.match(
    start,
    /await runEthicsGates\(_gateArgs\(/,
    "enforcement cannot depend on the caller",
  );
});
