// SET_HEADERS — sending request headers of your choosing, for one run's tab.
//
// A browser will not let a page change its own request headers, which is the
// point of the forbidden-header list. So the only honest way to send a
// User-Agent a site will accept is declarativeNetRequest — and sites do refuse:
// tryscrapeme.com answers 403 to anything that looks automated, site-wide.
//
// The two things worth testing without a browser are the ones the user sees:
// what a typed header list turns into, and that the rules are scoped to the
// run's tab and taken back when the run ends. A rule that outlives its run is
// the same class of bug as the proxy that outlived its run (A-05).
import test from "node:test";
import assert from "node:assert/strict";

const MODULE = new URL("../background/header-rules.js", import.meta.url).href;

let sessionRules = [];
const calls = [];

globalThis.chrome = {
  declarativeNetRequest: {
    async getSessionRules() {
      return sessionRules;
    },
    async updateSessionRules({ addRules = [], removeRuleIds = [] }) {
      calls.push({ addRules, removeRuleIds });
      sessionRules = sessionRules.filter((r) => !removeRuleIds.includes(r.id));
      sessionRules.push(...addRules);
    },
  },
};

const {
  parseHeaderText,
  planHeaders,
  applyHeaderRules,
  clearHeaderRules,
  sweepHeaderRules,
} = await import(MODULE);

// ── What the user typed ──────────────────────────────────────────────────────

test("headers are typed the way a header actually looks", () => {
  const out = parseHeaderText(
    "User-Agent: Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0\nAccept-Language: en-GB,en;q=0.9",
  );
  assert.equal(out.length, 2);
  // The colon inside the value must not split the line a second time.
  assert.equal(
    out[0].value,
    "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0",
  );
  assert.equal(out[1].name, "Accept-Language");
});

test("blank lines and comments are not headers", () => {
  assert.deepEqual(parseHeaderText("\n# a note\n\nAccept: */*\n"), [
    { name: "Accept", value: "*/*" },
  ]);
});

// ── What can actually be sent ────────────────────────────────────────────────

test("the browser's own headers are refused by name, not dropped quietly", () => {
  const { usable, refused } = planHeaders(
    parseHeaderText("Host: elsewhere.test\nContent-Length: 5\nAccept: */*"),
  );
  // A user who typed Host and saw nothing happen would reasonably conclude the
  // whole step is broken.
  assert.deepEqual(refused.sort(), ["content-length", "host"]);
  assert.deepEqual(usable, [
    { header: "accept", operation: "set", value: "*/*" },
  ]);
});

test("an empty value removes the header rather than setting an empty one", () => {
  const { usable } = planHeaders(parseHeaderText("Accept-Language:"));
  assert.deepEqual(usable, [
    { header: "accept-language", operation: "remove" },
  ]);
});

test("the same header twice is one header, and the later one wins", () => {
  const { usable } = planHeaders(parseHeaderText("Accept: one\naccept: two"));
  assert.deepEqual(usable, [
    { header: "accept", operation: "set", value: "two" },
  ]);
});

// ── The lifecycle ────────────────────────────────────────────────────────────

test("the rule is scoped to the run's tab", async () => {
  sessionRules = [];
  calls.length = 0;
  const res = await applyHeaderRules(
    "run-1",
    42,
    parseHeaderText("Accept: */*"),
  );
  assert.equal(res.applied, 1);
  const rule = sessionRules[0];
  // Without tabIds this run's headers would be sent by every tab in the
  // browser, which is the A-05 mistake in a new place.
  assert.deepEqual([...rule.condition.tabIds], [42]);
  assert.equal(rule.action.type, "modifyHeaders");
});

test("a second SET_HEADERS replaces the first rather than stacking", async () => {
  await applyHeaderRules("run-1", 42, parseHeaderText("Accept-Language: fr"));
  assert.equal(sessionRules.length, 1);
  assert.equal(
    sessionRules[0].action.requestHeaders[0].header,
    "accept-language",
  );
});

test("the run's rules go when the run does", async () => {
  await clearHeaderRules("run-1");
  assert.deepEqual(sessionRules, []);
  // And a second clear is not an error: every exit path calls it.
  await clearHeaderRules("run-1");
});

test("a crash leaves nothing in force on a tab you are now browsing by hand", async () => {
  // Session rules survive a service-worker restart; the run that asked for
  // them did not. The startup sweep is what closes that window.
  sessionRules = [{ id: 90001, condition: { tabIds: [7] } }];
  const swept = await sweepHeaderRules();
  assert.equal(swept, 1);
  assert.deepEqual(sessionRules, []);
});

test("the sweep leaves rules that are not ours alone", async () => {
  sessionRules = [{ id: 12, condition: {} }];
  assert.equal(await sweepHeaderRules(), 0);
  assert.equal(sessionRules.length, 1);
});

test("the step is registered, run-only, and not exportable", async () => {
  const { STEP_TYPES, USER_STEP_TYPES } =
    await import("../utils/step-types.js");
  assert.ok(USER_STEP_TYPES.includes("SET_HEADERS"));
  assert.equal(STEP_TYPES.SET_HEADERS.exportable, false);

  const { readFile } = await import("node:fs/promises");
  const src = await readFile(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  // Testing it as a single step would leave the rules in force with no run to
  // end, so the test path refuses it with a reason instead.
  assert.match(
    src,
    /SET_HEADERS:\s*\n?\s*"Headers are set for the length of a run/,
  );
  // And every exit from a run takes them back.
  assert.match(src, /await clearHeaderRules\(runId\);/);
  assert.match(src, /await sweepHeaderRules\(\)/);
});
