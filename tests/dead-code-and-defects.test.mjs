// Regression tests for audit findings C-09, F-01, F-02, F-07, F-09, B-33 and
// B-34 — the dead half of the tree, and the last three defects in it.
//
// C-09: content/injector.js and content/smart-extractor.js were declared for
// <all_urls>, so both ran in every page the user visited, for a tool that acts
// on one tab at a time.
//
// F-01: eight modules were imported by nothing. Some were genuine duplicates of
// live code; one was written for a caller that never called it.
//
// F-02: data-sources/csv-parser.js and json-parser.js implement ingestion for a
// data-file input path that does not exist anywhere in the product.
//
// F-07: utils/strings.js held 210 lines of UI strings. Its only importer never
// referenced anything on it, and the panel hardcodes its text in index.html.
//
// F-09: rate-limiter.js was imported for two form-fill handlers that are
// themselves unreachable. Ethics gate 3 warned about request volume and nothing
// enforced it — while the emitted Python told its reader "MIN_DELAY_MS = 800 #
// Floor enforced by FlowScrape ethics engine".
//
// B-33: the three captcha pollers recursed once per attempt, 25 frames deep,
// with an undocumented two-minute budget.
//
// B-34: round-robin and sticky proxy selection advanced the same cursor.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = (p) => new URL(`../${p}`, import.meta.url);
const read = (p) => readFile(root(p), "utf8");

const manifest = JSON.parse(await read("manifest.json"));
const swSrc = await read("background/service-worker.js");
const injectorSrc = await read("content/injector.js");
const panelSrc = await read("sidepanel/pipeline-builder.js");

const gone = async (path) => {
  await assert.rejects(
    () => readFile(root(path), "utf8"),
    /ENOENT/,
    `${path} is still present`,
  );
};

// ── C-09: nothing runs on every page any more ────────────────────────────────

test("no content script is declared for every page", () => {
  assert.equal(
    manifest.content_scripts,
    undefined,
    "injector and smart-extractor ran in every page the user visited",
  );
  assert.match(
    manifest._comment_content_scripts,
    /injected on demand/,
    "and the manifest says why there are none",
  );
});

test("host access is kept, because the worker still needs it", () => {
  // <all_urls> host permission is what lets the worker fetch APIs and
  // robots.txt. Dropping it would break those; it is not what C-09 is about.
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.ok(manifest.permissions.includes("scripting"));
});

test("the worker injects on demand, and only once per tab", () => {
  const fn = swSrc.match(
    /async function _ensureInjected\(tabId\) \{[\s\S]*?\n\}/,
  )[0];
  assert.match(fn, /type: "fs:ping"/, "ask before injecting");
  assert.match(
    fn,
    /if \(alive\?\.ok\) return;/,
    "a second injection would double every reply",
  );
  assert.match(fn, /chrome\.scripting\.executeScript/);
  assert.match(
    swSrc,
    /const CONTENT_FILES = \[\s*\n?\s*"content\/smart-extractor\.js",\s*\n?\s*"content\/injector\.js",?\s*\n?\]/,
  );
});

test("a page that refuses injection says which pages those are", () => {
  const fn = swSrc.match(
    /async function _ensureInjected\(tabId\) \{[\s\S]*?\n\}/,
  )[0];
  assert.match(fn, /chrome:\/\/ pages, the Web Store and PDF viewers/);
});

test("the content script answers a ping", () => {
  assert.match(injectorSrc, /"fs:ping",/, "the type is owned");
  assert.match(injectorSrc, /case "fs:ping":\s*\n\s*return \{ ready: true \};/);
});

test("every path that talks to the page sets it up first", () => {
  const start = swSrc.match(
    /_registerHandler\(MSG\.PIPELINE_START[\s\S]*?\n\}\);/,
  )[0];
  assert.match(start, /await _ensureInjected\(runState\.tabId\)/);
  assert.match(
    start,
    /_runStates\.delete\(runId\)/,
    "a failed injection is not a live run",
  );

  const stepTest = swSrc.match(
    /_registerHandler\(MSG\.STEP_EXECUTE[\s\S]*?\n\}\);/,
  )[0];
  assert.match(stepTest, /await _ensureInjected\(targetTabId\)/);

  assert.match(
    swSrc,
    /_registerHandler\("content:ensure"/,
    "and the picker has a route",
  );
  assert.equal(
    (panelSrc.match(/_ensureContentReady\(tab\.id\)/g) ?? []).length,
    3,
    "all three picker entry points",
  );
});

// ── F-01 / F-02: the dead modules ────────────────────────────────────────────

test("modules that duplicated live code are gone", async () => {
  await gone("utils/deduplicator.js"); // superseded by _rowKey (D-07)
  await gone("content/smart-sleep.js"); // injector has its own waits, and
  // cannot import a module anyway
});

test("the data-source parsers are gone, with no input path to feed them", async () => {
  await gone("data-sources/csv-parser.js");
  await gone("data-sources/json-parser.js");
});

test("nothing still references the removed modules", async () => {
  for (const file of [
    "background/service-worker.js",
    "content/injector.js",
    "sidepanel/pipeline-builder.js",
    "exporters/row-formatters.js",
  ]) {
    const src = await read(file);
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const name of [
      "csv-parser",
      "json-parser",
      "deduplicator",
      "smart-sleep",
    ]) {
      assert.ok(!code.includes(name), `${file} still imports ${name}`);
    }
  }
});

test("the save-dialog exporter is reached instead of deleted", async () => {
  // text-exporters.js and stream-writer.js were written for the File System
  // Access API save dialog, which a service worker cannot show and the side
  // panel can. Nothing imported either (F-01).
  assert.match(
    panelSrc,
    /import \{ exportRows \} from "\.\.\/exporters\/text-exporters\.js"/,
  );
  const fn = panelSrc.match(
    /async function _downloadRunRows\(runId\) \{[\s\S]*?\n\}/,
  )[0];
  assert.match(
    fn,
    /await exportRows\(rows, "csv", `flowscrape_\$\{runId\}\.csv`\)/,
  );
  assert.match(
    fn,
    /err\?\.name === "AbortError"/,
    "a cancelled dialog is not a failure",
  );

  const src = await read("exporters/text-exporters.js");
  assert.ok(!/NOT CURRENTLY REACHED/.test(src), "the header said it was dead");
});

test("Levenshtein has one implementation, not two", async () => {
  const mapper = await read("content/field-auto-mapper.js");
  assert.match(mapper, /from "\.\.\/utils\/levenshtein\.js"/);
  const code = mapper
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/function levenshteinDistance\(/.test(code),
    "the local copy is gone",
  );
  assert.ok(!/function levenshteinNorm\(/.test(code));
  assert.match(
    mapper,
    /function tokenCoverage\(setA, setB\)/,
    "the one term the shared module does not have stays here",
  );
});

// ── F-07: the strings module ─────────────────────────────────────────────────

test("the unused strings module is gone, and its dead import with it", async () => {
  await gone("utils/strings.js");
  const proxy = await read("background/proxy-manager.js");
  assert.ok(
    !/utils\/strings\.js/.test(proxy),
    "its only importer never used it",
  );
});

// ── F-09: rate limiting that actually limits ─────────────────────────────────

test("steps that touch the page or the network are paced", () => {
  const fn = swSrc.match(/async function _executeSteps\([\s\S]*?\n\}\n/)[0];
  assert.match(fn, /if \(RATE_LIMITED_STEPS\.has\(resolvedStep\.type\)\)/);
  assert.match(fn, /await acquire\(_runDomain\(runState\)\)/);
});

test("the pacing excludes the steps that would double-count", () => {
  const set = swSrc.match(
    /const RATE_LIMITED_STEPS = new Set\([\s\S]*?\n\);/,
  )[0];
  for (const type of ["WAIT", "EXPORT", "LOOP", "IF_ELSE"]) {
    assert.ok(set.includes(`"${type}"`), `${type} should be excluded`);
  }
  assert.match(
    set,
    /ALL_STEP_TYPES\.filter/,
    "built from the registry, not a list",
  );
});

test("the bucket is keyed on the run's host", () => {
  const fn = swSrc.match(/function _runDomain\(runState\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /new URL\(runState\?\.targetOrigin \?\? ""\)\.hostname/);
  assert.match(fn, /"default"/, "a run with no origin still gets a bucket");

  const run = new Function(`${fn}; return _runDomain;`)();
  assert.equal(run({ targetOrigin: "https://shop.test/x" }), "shop.test");
  assert.equal(run({ targetOrigin: "not a url" }), "default");
  assert.equal(run({}), "default");
  assert.equal(run(null), "default");
});

test("acquire loops instead of recursing", async () => {
  const src = await read("background/rate-limiter.js");
  const fn = src.match(/export async function acquire\([\s\S]*?\n\}/)[0];
  assert.match(fn, /for \(;;\) \{/);
  assert.ok(
    !/return acquire\(domain, count\)/.test(fn),
    "the recursion is gone",
  );
});

test("the token bucket really does block a burst", async () => {
  const { acquire, initBucket } = await import("../background/rate-limiter.js");
  initBucket("burst.test", { capacity: 2, refillRate: 1000 });

  const started = Date.now();
  await acquire("burst.test");
  await acquire("burst.test");
  assert.ok(Date.now() - started < 50, "the first two come from the bucket");

  await acquire("burst.test"); // has to wait for a refill
  assert.ok(
    Date.now() - started >= 1,
    "the third waited for the bucket to refill",
  );
});

// ── B-33 / B-34 ──────────────────────────────────────────────────────────────

test("captcha polling loops, and says how long it waited", async () => {
  const src = await read("background/api-key-manager.js");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  for (const poller of [
    "_poll2captcha",
    "_pollAnticaptcha",
    "_pollCapsolver",
  ]) {
    const fn = code.match(
      new RegExp(`async function ${poller}\\([\\s\\S]*?\\n\\}`),
    )[0];
    assert.match(
      fn,
      /for \(let attempt = 0; attempt <= POLL_MAX_ATTEMPTS/,
      poller,
    );
    assert.ok(
      !new RegExp(`return ${poller}\\(`).test(fn),
      `${poller} still recurses`,
    );
    assert.match(
      fn,
      /POLL_TIMEOUT_MESSAGE\(/,
      `${poller} timeout is unexplained`,
    );
  }

  assert.match(src, /const POLL_INTERVAL_MS = 5000;/);
  assert.match(src, /const POLL_MAX_ATTEMPTS = 24;/);

  // The message states the real budget rather than leaving it to arithmetic.
  const msg = new Function(
    `${src.match(/const POLL_INTERVAL_MS[\s\S]*?POLL_TIMEOUT_MESSAGE = [\s\S]*?;/)[0]}
     return POLL_TIMEOUT_MESSAGE;`,
  )();
  assert.equal(
    msg("2captcha"),
    "2captcha did not return a solution within 125s.",
  );
});

test("round-robin and sticky proxy selection keep separate cursors", async () => {
  const src = await read("background/proxy-manager.js");
  assert.match(src, /let _stickyIndex = 0;/);

  const sticky = src.match(/case "sticky": \{[\s\S]*?\n {4}\}/)[0];
  assert.match(sticky, /alive\[_stickyIndex % alive\.length\]/);
  assert.ok(
    !/_rrIndex/.test(sticky),
    "sticky used to advance the round-robin cursor",
  );

  const rr = src.match(/case "round-robin": \{[\s\S]*?\n {4}\}/)[0];
  assert.match(rr, /_rrIndex = \(_rrIndex \+ 1\) % alive\.length/);

  assert.match(src, /_stickyIndex = 0;/, "and both reset together");
});
