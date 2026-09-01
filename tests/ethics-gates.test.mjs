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
  assert.match(r.warnings[0].message, /\/private\/x/, "the message names the path");
});

test("bypassRobots suppresses the warning", async () => {
  const r = await runEthicsGates({ ...base, targetPath: "/private/x", bypassRobots: true });
  assert.deepEqual(r.warnings, [], "this is the flag the service worker used to drop");
});

test("an allowed path is quiet", async () => {
  const r = await runEthicsGates({ ...base, targetPath: "/public" });
  assert.deepEqual(r.warnings, []);
});

test("warnings survive the trip to the side panel", async () => {
  const r = await runEthicsGates({ ...base, targetPath: "/private/x" });
  const serialized = r.warnings.map((w) => ({ code: w.code, message: w.message }));

  assert.equal(typeof serialized[0].code, "string");
  assert.equal(typeof serialized[0].message, "string");
  assert.equal(
    JSON.parse(JSON.stringify(serialized))[0].code,
    "RobotsTxt",
    "EthicsWarn instances must survive structured cloning as plain data",
  );
});

test("a cross-origin step still hard-blocks", async () => {
  const r = await runEthicsGates({
    ...base,
    targetPath: "/public",
    steps: [{ type: "NAVIGATE", config: { url: "https://elsewhere.test/page" } }],
  });

  assert.equal(r.blocked, true);
  assert.equal(r.blocker?.code, "DomainMismatch");
  assert.match(r.blocker.message, /elsewhere\.test/);
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
  const start = swSrc.match(/_registerHandler\(MSG\.PIPELINE_START[\s\S]*?ethicsResult\.blocked/)?.[0];
  assert.ok(start, "found the start handler");
  assert.match(start, /await runEthicsGates\(_gateArgs\(/, "enforcement cannot depend on the caller");
});
