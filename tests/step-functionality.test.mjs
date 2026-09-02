// What the steps can actually do.
//
// The audit was about things that were wrong. This is about things that were
// missing — steps whose configuration promised a capability the code never had,
// which is the same lie told in a different place.
//
//   * WAIT could only sleep. `_stepWait` in the content script has handled
//     "wait until this element appears" and "wait until the DOM settles" since
//     the beginning, and nothing ever sent it either one: the worker's WAIT case
//     called _sleep and returned, so the page code was unreachable.
//   * SCROLL could scroll by pixels, by percent, or to an element. None of those
//     scrape an infinite-scroll feed, which is most of what people want to
//     scrape and the reason they reach for a browser extension rather than curl.
//   * PAGINATE was `return _stepClick(config)` — a click, under a different
//     name. A loop set to 10 pages ran its body 10 times whether or not there
//     were 10 pages, re-scraping the last page until the count ran out.
//   * NAVIGATE slept 3000ms and hoped. A slow page was scraped empty; a fast one
//     cost three seconds per iteration.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  calls,
  reset,
  setTabStatuses,
  onInject,
  onContentMessage,
  startRun,
  endRun,
  _dispatchStep,
  _executeStepList,
} from "./helpers/worker-harness.mjs";
import { loadInjector } from "./helpers/content-harness.mjs";
import { STEP_TYPES } from "../utils/step-types.js";

const step = (type, config = {}, extra = {}) => ({
  id: `s_${type}`,
  type,
  config,
  ...extra,
});
const ctx = () => ({ extracted: {} });

// ── WAIT: the modes that were unreachable ────────────────────────────────────

test("WAIT in fixed mode still sleeps in the worker, without touching the page", async () => {
  reset();
  const { runId } = startRun();
  const t0 = Date.now();
  await _dispatchStep(step("WAIT", { mode: "fixed", ms: 60 }), 1, runId, ctx());
  assert.ok(Date.now() - t0 >= 55, "it waited");
  assert.equal(
    calls.contentMessages.length,
    0,
    "a fixed wait needs no content script, so a closed or hostile tab cannot break it",
  );
  await endRun(runId);
});

test("WAIT for an element is sent to the page", async () => {
  reset();
  const { runId } = startRun();
  onContentMessage(() => ({ ok: true, result: { waited: true } }));

  await _dispatchStep(
    step("WAIT", { mode: "selector-visible", selector: ".results" }),
    1,
    runId,
    ctx(),
  );

  const sent = calls.contentMessages.find((m) => m.payload?.type === "WAIT");
  assert.ok(sent, "the page was asked to wait");
  assert.equal(
    sent.payload.config.selector,
    ".results",
    "with the selector the user configured",
  );
  await endRun(runId);
});

test("a WAIT that times out fails the step instead of passing quietly", async () => {
  reset();
  const { runId } = startRun();
  onContentMessage(() => ({
    ok: false,
    error: "Timeout waiting for selector: .results",
  }));

  await assert.rejects(
    () =>
      _dispatchStep(
        step("WAIT", { mode: "selector-visible", selector: ".results" }),
        1,
        runId,
        ctx(),
      ),
    /Timeout waiting for selector/,
  );
  await endRun(runId);
});

test("WAIT's defaults describe every mode it supports", () => {
  const def = STEP_TYPES.WAIT.def;
  assert.equal(def.mode, "fixed", "the old behaviour is still the default");
  assert.ok("selector" in def, "so the config UI can offer a selector");
  assert.ok("timeout" in def, "so a wait cannot hang a run forever");
});

// ── WAIT, in the page ────────────────────────────────────────────────────────

test("wait-for-element resolves when the element arrives", async () => {
  const page = await loadInjector(`<div id="host"></div>`);
  const { _stepWait } = page.api;
  const { document } = page;

  const pending = _stepWait({
    mode: "selector-visible",
    selector: ".late",
    timeout: 3000,
  });
  setTimeout(() => {
    const el = document.createElement("div");
    el.className = "late";
    el.textContent = "here";
    document.getElementById("host").appendChild(el);
  }, 120);

  const result = await pending;
  assert.equal(result.waited, true);
  page.close();
});

test("wait-for-element ignores an element that is present but hidden", async () => {
  // "selector-visible" is what the mode is called. Matching a `display:none`
  // spinner placeholder and calling it visible is how a wait returns
  // immediately and the next step reads an empty page.
  const page = await loadInjector(
    `<div class="late" style="display:none">not yet</div>`,
  );
  await assert.rejects(
    () =>
      page.api._stepWait({
        mode: "selector-visible",
        selector: ".late",
        timeout: 300,
      }),
    /Timeout/,
  );
  page.close();
});

test("wait-for-element with no selector says so instead of sleeping", async () => {
  // It used to fall through to the default branch and sleep `ms`, so a
  // misconfigured wait looked like a working one.
  const page = await loadInjector("");
  await assert.rejects(
    () => page.api._stepWait({ mode: "selector-visible", selector: "" }),
    /selector/i,
  );
  page.close();
});

test("wait-until-gone resolves when the element leaves", async () => {
  const page = await loadInjector(`<div class="spinner">loading</div>`);
  const { document } = page;
  const pending = page.api._stepWait({
    mode: "selector-gone",
    selector: ".spinner",
    timeout: 3000,
  });
  setTimeout(() => document.querySelector(".spinner").remove(), 120);
  assert.equal((await pending).waited, true);
  page.close();
});

// ── SCROLL: infinite feeds ───────────────────────────────────────────────────

test("infinite scroll keeps going while the page grows, and stops when it does not", async () => {
  const page = await loadInjector(`<div id="feed"></div>`);
  const { window, document } = page;

  // A feed that appends a screenful three times, then stops — a page that has
  // run out of results.
  let appended = 0;
  let height = 2000;
  Object.defineProperty(window.document.documentElement, "scrollHeight", {
    configurable: true,
    get: () => height,
  });
  window.scrollTo = () => {
    if (appended < 3) {
      appended++;
      height += 1000;
      const el = document.createElement("div");
      el.className = "post";
      document.getElementById("feed").appendChild(el);
    }
  };

  const result = await page.api._stepScroll({
    mode: "infinite",
    maxScrolls: 20,
    settleMs: 30,
  });

  assert.equal(appended, 3, "it stopped when the feed stopped growing");
  assert.ok(
    result.scrolls >= 4 && result.scrolls <= 6,
    `it did not spin: ${result.scrolls} scrolls`,
  );
  assert.equal(
    result.exhausted,
    true,
    "and it reports that it reached the end",
  );
  page.close();
});

test("infinite scroll obeys its scroll limit on a feed that never ends", async () => {
  const page = await loadInjector(`<div id="feed"></div>`);
  const { window } = page;
  let height = 2000;
  Object.defineProperty(window.document.documentElement, "scrollHeight", {
    configurable: true,
    get: () => height,
  });
  window.scrollTo = () => {
    height += 1000; // Twitter does not stop.
  };

  const result = await page.api._stepScroll({
    mode: "infinite",
    maxScrolls: 4,
    settleMs: 10,
  });
  assert.equal(result.scrolls, 4);
  assert.equal(
    result.exhausted,
    false,
    "it says it hit the limit rather than the end, so the user can raise it",
  );
  page.close();
});

// ── PAGINATE: knowing when the pages run out ─────────────────────────────────

test("paginate clicks Next and reports that there is more", async () => {
  const page = await loadInjector(`<a class="next" href="/p2">Next</a>`);
  const result = await page.api._executeStep({
    type: "PAGINATE",
    config: { selector: ".next", settleMs: 20 },
  });
  assert.equal(result.paginated, true);
  assert.equal(result.exhausted, false);
  page.close();
});

test("paginate reports exhaustion when the Next control is gone", async () => {
  const page = await loadInjector(`<div>last page</div>`);
  const result = await page.api._executeStep({
    type: "PAGINATE",
    config: { selector: ".next", settleMs: 20 },
  });
  assert.equal(result.exhausted, true);
  assert.match(result.reason, /no|found|match/i);
  page.close();
});

test("paginate reports exhaustion when the Next control is disabled", async () => {
  // Every one of these shapes is in the wild, and all of them used to be
  // clicked happily, forever.
  for (const markup of [
    `<button class="next" disabled>Next</button>`,
    `<button class="next" aria-disabled="true">Next</button>`,
    `<a class="next disabled">Next</a>`,
    `<a class="next">Next</a>`, // an anchor with no href goes nowhere
  ]) {
    const page = await loadInjector(markup);
    const result = await page.api._executeStep({
      type: "PAGINATE",
      config: { selector: ".next", settleMs: 10 },
    });
    assert.equal(
      result.exhausted,
      true,
      `not detected as exhausted: ${markup}`,
    );
    page.close();
  }
});

test("a paginating loop stops at the last page instead of re-running it", async () => {
  reset();
  const { runId, runState } = startRun();

  // Two pages, then the Next button is gone. Modelled as the two messages the
  // worker really sends — a probe that decides, then the click — rather than as
  // one convenient message that answers the whole question. A mock more capable
  // than the runtime is how the EXPORT bug (A-12) survived 442 tests.
  let page = 1;
  onContentMessage((payload) => {
    if (payload.type === "PAGINATE_PROBE") {
      return page >= 2
        ? {
            ok: true,
            result: { exhausted: true, reason: "no next", fingerprint: "p2" },
          }
        : {
            ok: true,
            result: { exhausted: false, reason: "", fingerprint: `p${page}` },
          };
    }
    if (payload.type === "PAGINATE") {
      page++;
      return { ok: true, result: { paginated: true, exhausted: false } };
    }
    if (payload.type === "EXTRACT") {
      return { ok: true, result: [{ page }] };
    }
    return { ok: true, result: {} };
  });

  await _executeStepList(
    [
      step(
        "LOOP",
        { type: "paginate", selector: ".next", max: 10, settleMs: 0 },
        { children: [step("EXTRACT", { fields: [] })] },
      ),
    ],
    1,
    runId,
    ctx(),
  );

  assert.equal(
    runState.results.length,
    2,
    `scraped ${runState.results.length} pages; there were 2`,
  );
  await endRun(runId);
});

// ── NAVIGATE: waiting for the page, not for the clock ────────────────────────

test("navigate waits for the tab to finish loading", async () => {
  reset();
  const { runId } = startRun();
  setTabStatuses(["loading", "loading", "complete"]);

  await _dispatchStep(
    step("NAVIGATE", { url: "https://shop.test/products", wait: true }),
    1,
    runId,
    ctx(),
  );

  assert.equal(calls.tabUpdates[0].url, "https://shop.test/products");
  assert.ok(
    calls.tabGets.length >= 3,
    `it polled the tab's load state (${calls.tabGets.length} times)`,
  );
  await endRun(runId);
});

test("navigate to a fast page does not sit out a fixed three seconds", async () => {
  reset();
  const { runId } = startRun();
  setTabStatuses(["complete"]);

  const t0 = Date.now();
  await _dispatchStep(
    step("NAVIGATE", { url: "https://shop.test/", wait: true }),
    1,
    runId,
    ctx(),
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `waited ${elapsed}ms for an already-loaded page`);
  await endRun(runId);
});

test("navigate gives up on a page that never loads, and says so", async () => {
  reset();
  const { runId } = startRun();
  setTabStatuses(["loading"]);

  await _dispatchStep(
    step("NAVIGATE", { url: "https://shop.test/slow", timeoutMs: 400 }),
    1,
    runId,
    ctx(),
  );

  const warned = calls.runtimeMessages.some((m) =>
    /still loading|did not finish/i.test(m?.payload?.message ?? ""),
  );
  assert.ok(warned, "the run log says the wait was cut short");
  await endRun(runId);
});

// ── Every step type can be configured ────────────────────────────────────────

test("no step type falls through to the generic key-name config UI", async () => {
  // The fallback renders raw config keys as labels: a WAIT card offered "ms",
  // a DRAG_DROP card offered "source" and "target", and SCREENSHOT offered
  // "quality" with no hint of what any of them meant or what values were legal.
  const src = await readFile(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  const body = src.slice(src.indexOf("function generateConfigHtml"));
  const handled = new Set(
    [...body.matchAll(/step\.type === "([A-Z_]+)"/g)].map((m) => m[1]),
  );
  const missing = Object.entries(STEP_TYPES)
    .filter(([type, meta]) => !meta.internal && !meta.aliasOf)
    .map(([type]) => type)
    .filter((type) => !handled.has(type));
  assert.deepEqual(
    missing,
    [],
    `these step types have no config UI of their own: ${missing.join(", ")}`,
  );
});

// ── the content script after a navigation ────────────────────────────────────

test("a page step re-injects after the page it was running on went away", async () => {
  // Found by the paginating-pipeline e2e check, which paginated correctly and
  // then extracted nothing from pages 2 and 3.
  //
  // Content scripts are injected on demand (C-09) and are destroyed with the
  // document. Only the start of a run injected them, so every page step after
  // any navigation — a NAVIGATE, a PAGINATE, a CLICK that follows a link —
  // failed with Chrome's "Receiving end does not exist". A pipeline that visits
  // more than one page is most of them.
  reset();
  const { runId } = startRun();

  // The page has navigated: nothing answers until the worker injects again.
  let injected = false;
  onInject(() => {
    injected = true;
  });
  onContentMessage(() => {
    if (!injected) throw new Error("Could not establish connection.");
    return { ok: true, result: [{ name: "row" }] };
  });

  const context = ctx();
  await _dispatchStep(step("EXTRACT", { fields: [] }), 1, runId, context);
  assert.equal(
    context.extracted.name,
    "row",
    "the step ran, rather than failing on a dead connection",
  );
  await endRun(runId);
});
