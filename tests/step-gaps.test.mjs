// KEYBOARD, API_SNIFFER and SCREENSHOT — the last three steps that could only
// do one thing.
//
//   * KEYBOARD dispatched at document.activeElement, once. Nothing could give
//     it a target, so "type into the search box and press Enter" needed a CLICK
//     to move focus first and worked only if that click actually focused the
//     right thing; and pressing a key twice needed two steps.
//   * API_SNIFFER recorded every request the page made. On a real site that is
//     analytics, fonts, session pings and ads, and the four calls you wanted
//     are somewhere inside them.
//   * SCREENSHOT captured the visible viewport, so "screenshot the page" gave
//     you the top of it, and there was no way to photograph one element.
import test from "node:test";
import assert from "node:assert/strict";
import { loadInjector } from "./helpers/content-harness.mjs";
import {
  calls,
  reset,
  onContentMessage,
  startRun,
  endRun,
  _dispatchStep,
} from "./helpers/worker-harness.mjs";
import { matchesSnifferFilter } from "../utils/sniffer-filter.js";

const step = (type, config = {}) => ({ id: `s_${type}`, type, config });
const ctx = () => ({ extracted: {} });

// ── KEYBOARD ─────────────────────────────────────────────────────────────────

/** Record what the given element received. */
function listen(el) {
  const seen = [];
  for (const type of ["keydown", "keyup"]) {
    el.addEventListener(type, (e) => seen.push({ type, key: e.key }));
  }
  return seen;
}

test("a key goes to the element the step names", async () => {
  const page = await loadInjector(`<input id="a"><input id="b">`);
  const { document } = page;
  document.getElementById("a").focus();
  const onB = listen(document.getElementById("b"));

  await page.api._stepKeyboard({ key: "Enter", selector: "#b" });

  assert.ok(
    onB.some((e) => e.type === "keydown" && e.key === "Enter"),
    "the named element did not receive the key",
  );
  page.close();
});

test("with no selector it still goes to whatever has focus", async () => {
  const page = await loadInjector(`<input id="a">`);
  const el = page.document.getElementById("a");
  const seen = listen(el);
  page.document.getElementById("a").focus();
  Object.defineProperty(page.document, "activeElement", {
    configurable: true,
    get: () => el,
  });

  await page.api._stepKeyboard({ key: "Enter" });
  assert.ok(seen.some((e) => e.key === "Enter"));
  page.close();
});

test("a selector that matches nothing fails rather than typing elsewhere", async () => {
  // Falling back to activeElement would send the key to whatever happened to
  // be focused — often the page body, where it does nothing, silently.
  const page = await loadInjector(`<input id="a">`);
  await assert.rejects(
    () => page.api._stepKeyboard({ key: "Enter", selector: "#nope" }),
    /#nope/,
  );
  page.close();
});

test("repeat presses the key that many times", async () => {
  const page = await loadInjector(`<input id="a">`);
  const seen = listen(page.document.getElementById("a"));

  await page.api._stepKeyboard({
    key: "ArrowDown",
    selector: "#a",
    repeat: 3,
    delayMs: 1,
  });

  const downs = seen.filter((e) => e.type === "keydown").length;
  assert.equal(downs, 3);
  page.close();
});

test("a nonsensical repeat count is clamped, not obeyed", async () => {
  // A template could resolve to anything. 10,000 ArrowDowns locks the tab.
  const page = await loadInjector(`<input id="a">`);
  const seen = listen(page.document.getElementById("a"));
  const out = await page.api._stepKeyboard({
    key: "a",
    selector: "#a",
    repeat: 99999,
    delayMs: 0,
  });
  assert.ok(out.repeated <= 500, `pressed ${out.repeated} times`);
  assert.ok(seen.length > 0);
  page.close();
});

test("repeat 0 or missing means once", async () => {
  const page = await loadInjector(`<input id="a">`);
  const seen = listen(page.document.getElementById("a"));
  await page.api._stepKeyboard({ key: "a", selector: "#a" });
  assert.equal(seen.filter((e) => e.type === "keydown").length, 1);
  page.close();
});

// ── API_SNIFFER filtering ────────────────────────────────────────────────────

const req = (url, method = "GET") => ({ url, method });

test("no filter keeps everything, as it always did", () => {
  assert.equal(matchesSnifferFilter(req("https://x.test/a"), {}), true);
  assert.equal(
    matchesSnifferFilter(req("https://x.test/a"), { urlFilter: "" }),
    true,
  );
});

test("a slash-wrapped filter is still a substring, not a pattern", () => {
  // The regression that named the design: "/api/" is what people type.
  assert.equal(
    matchesSnifferFilter(req("https://x.test/api/items"), {
      urlFilter: "/api/",
    }),
    true,
  );
  assert.equal(
    matchesSnifferFilter(req("https://x.test/apixitems"), {
      urlFilter: "/api/",
    }),
    false,
    "it is matched literally, slashes and all",
  );
});

test("a substring filter keeps only matching URLs", () => {
  const config = { urlFilter: "/api/" };
  assert.equal(
    matchesSnifferFilter(req("https://x.test/api/items"), config),
    true,
  );
  assert.equal(
    matchesSnifferFilter(req("https://x.test/fonts/a.woff"), config),
    false,
  );
});

test("several substrings are separated by commas", () => {
  const config = { urlFilter: "/api/, /graphql" };
  assert.equal(
    matchesSnifferFilter(req("https://x.test/graphql"), config),
    true,
  );
  assert.equal(matchesSnifferFilter(req("https://x.test/api/x"), config), true);
  assert.equal(
    matchesSnifferFilter(req("https://x.test/track"), config),
    false,
  );
});

test("substring matching ignores case, because hosts and paths do not agree on it", () => {
  assert.equal(
    matchesSnifferFilter(req("https://X.test/API/Items"), {
      urlFilter: "/api/",
    }),
    true,
  );
});

test("a filter prefixed with re: is a regular expression", () => {
  // Deliberately not `/…/`: "/api/" is the most likely substring anyone types,
  // and it is also valid regex syntax, so slashes would silently reinterpret
  // the common case as a case-sensitive pattern.
  const config = { urlFilter: "re:/api/v[0-9]+/" };
  assert.equal(
    matchesSnifferFilter(req("https://x.test/api/v2/items"), config),
    true,
  );
  assert.equal(
    matchesSnifferFilter(req("https://x.test/api/beta/items"), config),
    false,
  );
});

test("an invalid regular expression is reported, not treated as no match", () => {
  // Silently dropping everything would look like a page that makes no
  // requests, which is the hardest kind of empty result to explain.
  assert.throws(
    () =>
      matchesSnifferFilter(req("https://x.test/"), { urlFilter: "re:([bad" }),
    /pattern|regex/i,
  );
});

test("a method filter narrows further, and both must pass", () => {
  const config = { urlFilter: "/api/", methods: "POST" };
  assert.equal(
    matchesSnifferFilter(req("https://x.test/api/x", "POST"), config),
    true,
  );
  assert.equal(
    matchesSnifferFilter(req("https://x.test/api/x", "GET"), config),
    false,
  );
  assert.equal(
    matchesSnifferFilter(req("https://x.test/other", "POST"), config),
    false,
  );
});

test("methods are listed however the user felt like listing them", () => {
  for (const methods of ["POST,PUT", "post, put", " POST  PUT "]) {
    assert.equal(
      matchesSnifferFilter(req("https://x.test/a", "PUT"), { methods }),
      true,
      `did not accept "${methods}"`,
    );
  }
});

// ── the filter, where the requests arrive ────────────────────────────────────

import { readFile } from "node:fs/promises";

test("the sniffer handler consults the filter before it stores anything", async () => {
  const sw = await readFile(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  const handler = sw.match(
    /_registerHandler\("network:sniff",[\s\S]*?\n\}\);/,
  )[0];
  assert.match(handler, /matchesSnifferFilter/);
  // Before, not after: the point is to keep noise out of a bounded buffer
  // (D-10), so filtering after _pushCapture would achieve nothing.
  assert.ok(
    handler.indexOf("matchesSnifferFilter") < handler.indexOf("_pushCapture"),
    "requests are stored before the filter runs",
  );
});

test("a filter that cannot be evaluated is reported once, not per request", async () => {
  // A busy page makes hundreds of requests. One bad pattern must not produce
  // one log line per request and drown the run monitor.
  const sw = await readFile(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  const handler = sw.match(
    /_registerHandler\("network:sniff",[\s\S]*?\n\}\);/,
  )[0];
  assert.match(handler, /snifferFilterWarned|_filterWarned/);
});

test("the sniffer's defaults describe the filtering it can do", async () => {
  const { STEP_TYPES } = await import("../utils/step-types.js");
  const def = STEP_TYPES.API_SNIFFER.def;
  assert.ok("urlFilter" in def);
  assert.ok("methods" in def);
  assert.equal(def.urlFilter, "", "and it still records everything by default");
});

// ── SCREENSHOT: more than the visible strip ─────────────────────────────────

test("the visible-area capture is unchanged, and needs nothing from the page", async () => {
  reset();
  const { runId, runState } = startRun();
  await _dispatchStep(
    step("SCREENSHOT", { area: "viewport" }),
    1,
    runId,
    ctx(),
  );
  assert.equal(runState.screenshots.length, 1);
  assert.equal(
    calls.contentMessages.filter((m) => m.payload?.type === "PAGE_METRICS")
      .length,
    0,
    "a viewport shot should not need to measure the page",
  );
  await endRun(runId);
});

test("a full-page capture scrolls the page and stitches the strips", async () => {
  // captureVisibleTab photographs the viewport and nothing else, so "the whole
  // page" has to be several shots scrolled and joined. Anything else is the
  // top of the page under a name that says otherwise.
  reset();
  const { runId, runState } = startRun();

  const scrolls = [];
  onContentMessage((payload) => {
    if (payload.type === "PAGE_METRICS") {
      return {
        ok: true,
        result: {
          scrollHeight: 2400,
          viewportHeight: 800,
          dpr: 1,
          width: 1000,
        },
      };
    }
    if (payload.type === "SCROLL_TO") {
      scrolls.push(payload.config.top);
      return { ok: true, result: { top: payload.config.top } };
    }
    return { ok: true, result: {} };
  });

  await _dispatchStep(step("SCREENSHOT", { area: "full" }), 1, runId, ctx());

  assert.deepEqual(
    scrolls.slice(0, 3),
    [0, 800, 1600],
    "it walked the page in viewports",
  );
  assert.equal(scrolls.length, 4, "and one more to put the page back");
  assert.equal(
    runState.screenshots.length,
    1,
    "and stored one image, not three",
  );
  assert.equal(runState.screenshots[0].area, "full");
  await endRun(runId);
});

test("a full-page capture puts the scroll position back", async () => {
  // Scrolling the user's page to the bottom and leaving it there breaks every
  // step after it that depends on what is on screen.
  reset();
  const { runId } = startRun();
  const scrolls = [];
  onContentMessage((payload) => {
    if (payload.type === "PAGE_METRICS") {
      return {
        ok: true,
        result: {
          scrollHeight: 1600,
          viewportHeight: 800,
          dpr: 1,
          width: 1000,
          scrollY: 250,
        },
      };
    }
    if (payload.type === "SCROLL_TO") scrolls.push(payload.config.top);
    return { ok: true, result: {} };
  });

  await _dispatchStep(step("SCREENSHOT", { area: "full" }), 1, runId, ctx());
  assert.equal(
    scrolls[scrolls.length - 1],
    250,
    "the page was left where the run had it",
  );
  await endRun(runId);
});

test("a page taller than the cap is captured to the cap and says so", async () => {
  // An infinite feed has no bottom. Stitching until it ends never returns.
  reset();
  const { runId, runState } = startRun();
  onContentMessage((payload) => {
    if (payload.type === "PAGE_METRICS") {
      return {
        ok: true,
        result: {
          scrollHeight: 500000,
          viewportHeight: 800,
          dpr: 1,
          width: 1000,
        },
      };
    }
    return { ok: true, result: {} };
  });

  await _dispatchStep(step("SCREENSHOT", { area: "full" }), 1, runId, ctx());
  assert.ok(runState.screenshots.length >= 1);
  // Not /cap/ — that matched the word "captured" in the ordinary success log,
  // and the test passed against the unfixed code.
  const warned = calls.runtimeMessages.some((m) =>
    /truncated|taller than/i.test(m?.payload?.message ?? ""),
  );
  assert.ok(warned, "a truncated screenshot must say it was truncated");
  await endRun(runId);
});

test("an element capture crops to the element's box", async () => {
  reset();
  const { runId, runState } = startRun();
  onContentMessage((payload) => {
    if (payload.type === "ELEMENT_BOX") {
      return {
        ok: true,
        result: { x: 20, y: 40, width: 300, height: 150, dpr: 1 },
      };
    }
    return { ok: true, result: {} };
  });

  await _dispatchStep(
    step("SCREENSHOT", { area: "element", selector: ".card" }),
    1,
    runId,
    ctx(),
  );

  const asked = calls.contentMessages.find(
    (m) => m.payload?.type === "ELEMENT_BOX",
  );
  assert.equal(asked.payload.config.selector, ".card");
  assert.equal(runState.screenshots.length, 1);
  assert.equal(runState.screenshots[0].area, "element");
  await endRun(runId);
});

test("an element capture with no match fails, rather than photographing the page", async () => {
  // A viewport shot under the name "the element" is the worst outcome: it
  // looks like it worked.
  reset();
  const { runId } = startRun();
  onContentMessage((payload) => {
    if (payload.type === "ELEMENT_BOX") {
      return { ok: false, error: 'nothing matched ".nope"' };
    }
    return { ok: true, result: {} };
  });

  await assert.rejects(
    () =>
      _dispatchStep(
        step("SCREENSHOT", { area: "element", selector: ".nope" }),
        1,
        runId,
        ctx(),
      ),
    /nope/,
  );
  await endRun(runId);
});

test("the page can report its own metrics and box", async () => {
  const page = await loadInjector(
    `<div class="card" style="width:300px;height:150px"></div>`,
  );
  const metrics = await page.api._executeStep({
    type: "PAGE_METRICS",
    config: {},
  });
  assert.equal(typeof metrics.scrollHeight, "number");
  assert.equal(typeof metrics.viewportHeight, "number");
  assert.equal(typeof metrics.dpr, "number");

  const box = await page.api._executeStep({
    type: "ELEMENT_BOX",
    config: { selector: ".card" },
  });
  assert.equal(typeof box.width, "number");
  assert.equal(typeof box.height, "number");

  await assert.rejects(
    () =>
      page.api._executeStep({
        type: "ELEMENT_BOX",
        config: { selector: ".x" },
      }),
    /\.x/,
  );
  page.close();
});

test("SCREENSHOT's defaults describe the areas it can capture", async () => {
  const { STEP_TYPES } = await import("../utils/step-types.js");
  const def = STEP_TYPES.SCREENSHOT.def;
  assert.equal(def.area, "viewport", "the old behaviour is still the default");
  assert.ok("selector" in def);
});
