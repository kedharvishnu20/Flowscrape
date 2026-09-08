// Regression tests for K-24 (retry on 429/5xx, honouring Retry-After) and
// K-25 (pagination: cursor, page/offset, and the Link header).
//
// K-24: the rate limiter paces steps, but a single API step that got a 429
// just failed — the server was naming exactly how long to wait, in
// `Retry-After`, and nothing read it. The retry lives inside the API step
// itself (separate from the generic step-level retry, K-12) and is held to
// the same rules that one is: a retry is a fresh HTTP request, so it queues
// behind the rate limiter and holds for a pause like the first attempt did,
// and both the attempt count and the total wait are capped so a server that
// keeps asking for more time cannot stall a run for an hour.
//
// K-25: a paged JSON API needs a LOOP whose exit condition it cannot
// express. Three shapes: a cursor/token in the body, a page/offset number,
// and the `Link` response header (RFC 8288). Rows land in the run's results
// the same way EXTRACT's and PAGE_DATA's do — one path into the buffer,
// whether the response came from a single call or several pages.
import test from "node:test";
import assert from "node:assert/strict";
import {
  _executeSteps,
  _executeApiStep,
  startRun,
  endRun,
  reset,
} from "./helpers/worker-harness.mjs";
import { initBucket } from "../background/rate-limiter.js";
import { API_RETRY_LIMITS } from "../utils/step-types.js";

/** Requests the stub fetch observed, in order. Reset per test via stubFetch. */
let fetchCalls;

function headerMap(obj = {}) {
  return new Map(
    Object.entries(obj).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
}

function fakeResponse({
  status = 200,
  statusText = "OK",
  url = "https://shop.test/x",
  headers = {},
  body = {},
}) {
  const h = headerMap({ "content-type": "application/json", ...headers });
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    url,
    headers: {
      get: (k) => h.get(String(k).toLowerCase()) ?? null,
      entries: () => h.entries(),
    },
    async json() {
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

/**
 * @param {object[] | ((url: string, init: object, call: number) => object)} specs
 *   Either a fixed sequence of response specs (the last repeats once
 *   exhausted) or a function computing one per call.
 */
function stubFetch(specs) {
  fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    const call = fetchCalls.length;
    fetchCalls.push({ url, init });
    const spec = Array.isArray(specs)
      ? specs[Math.min(call, specs.length - 1)]
      : specs(url, init, call);
    return fakeResponse(spec);
  };
}

/** Advance the mocked clock in the 200ms slices `_apiSleep` waits in. */
async function advanceFakeTime(t, totalMs, sliceMs = 200) {
  const iterations = Math.ceil(totalMs / sliceMs) + 2;
  for (let i = 0; i < iterations; i++) {
    t.mock.timers.tick(sliceMs);
    for (let f = 0; f < 10; f++) await Promise.resolve();
  }
}

const step = (config = {}) => ({
  id: "api1",
  type: "API",
  config: { url: "https://shop.test/items", method: "GET", ...config },
});

test.beforeEach(() => {
  reset();
  // Wide open by default — only the tests about the limiter itself pay for it.
  initBucket("shop.test", { capacity: 1000, refillRate: 1000 });
});

// ── K-24: retry on 429 / 5xx, honouring Retry-After ────────────────────────

test("a 429 with Retry-After in seconds is honoured before the retry, not guessed at", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  stubFetch([
    { status: 429, headers: { "retry-after": "5" } },
    { status: 200, body: { ok: true } },
  ]);
  const { runId, runState } = startRun();

  const p = _executeApiStep(
    { url: "https://shop.test/items" },
    {},
    { runId, runState },
  );

  await advanceFakeTime(t, 1000);
  assert.equal(fetchCalls.length, 1, "5s named — 1s in, the retry is not due");

  await advanceFakeTime(t, 4500);
  const result = await p;
  assert.equal(fetchCalls.length, 2);
  assert.equal(result.status, 200);
  await endRun(runId);
});

test("a 429 with Retry-After as an HTTP-date is honoured", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const retryAt = new Date(Date.now() + 3000).toUTCString();
  stubFetch([
    { status: 429, headers: { "retry-after": retryAt } },
    { status: 200, body: {} },
  ]);
  const { runId, runState } = startRun();

  const p = _executeApiStep(
    { url: "https://shop.test/items" },
    {},
    { runId, runState },
  );

  await advanceFakeTime(t, 500);
  assert.equal(fetchCalls.length, 1, "the date named is still 2.5s out");

  await advanceFakeTime(t, 3000);
  const result = await p;
  assert.equal(fetchCalls.length, 2);
  assert.equal(result.status, 200);
  await endRun(runId);
});

test("a 5xx with no Retry-After falls back to backoff, and gives up at the attempt cap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  stubFetch(() => ({ status: 503, statusText: "Service Unavailable" }));
  const { runId, runState } = startRun();

  const p = _executeApiStep(
    { url: "https://shop.test/items" },
    {},
    { runId, runState },
  );
  p.catch(() => {});

  // 1000 + 2000 + 4000ms of fallback backoff between the 4 attempts.
  await advanceFakeTime(t, 8000);
  await assert.rejects(p, /503/);
  assert.equal(fetchCalls.length, API_RETRY_LIMITS.maxAttempts);
  await endRun(runId);
});

test("a 404 is not retried — only 429 and 5xx are", async () => {
  stubFetch(() => ({ status: 404, statusText: "Not Found" }));
  const { runId, runState } = startRun();

  await assert.rejects(
    _executeApiStep(
      { url: "https://shop.test/items" },
      {},
      { runId, runState },
    ),
    /404/,
  );
  assert.equal(fetchCalls.length, 1);
  await endRun(runId);
});

test("Retry-After is capped, so a server naming an hour cannot stall the run that long", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  stubFetch(() => ({ status: 429, headers: { "retry-after": "3600" } }));
  const { runId, runState } = startRun();

  const p = _executeApiStep(
    { url: "https://shop.test/items" },
    {},
    { runId, runState },
  );
  p.catch(() => {});

  // One capped wait (60s) happens; a second capped wait does not.
  await advanceFakeTime(t, API_RETRY_LIMITS.maxTotalWaitMs + 4000);
  await assert.rejects(p, /429/);
  assert.equal(
    fetchCalls.length,
    2,
    "one retry gets the full capped wait; the total-wait cap stops a second",
  );
  await endRun(runId);
});

test("a retry queues behind the rate limiter, the same as a first attempt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  // One token, slow refill: the run's own pre-dispatch acquire spends it, so
  // the retry has nothing left and has to wait for a refill — exactly what a
  // first attempt would have to do against an empty bucket.
  initBucket("shop.test", { capacity: 1, refillRate: 1 });
  stubFetch([
    { status: 429, headers: { "retry-after": "0" } },
    { status: 200, body: {} },
  ]);
  const { runId, runState } = startRun();

  const p = _executeSteps([step()], 1, runId, { extracted: {} });
  p.catch(() => {});

  await advanceFakeTime(t, 400);
  assert.equal(
    fetchCalls.length,
    1,
    "the bucket is empty — a bypassing retry would have fetched again by now",
  );

  await advanceFakeTime(t, 1200);
  await p;
  assert.equal(fetchCalls.length, 2);
  await endRun(runId);
});

// ── K-25: pagination ─────────────────────────────────────────────────────────

test("cursor pagination follows next_cursor until the source names none", async () => {
  const pages = [
    { data: [{ id: 1 }, { id: 2 }], next_cursor: "c2" },
    { data: [{ id: 3 }], next_cursor: "c3" },
    { data: [{ id: 4 }] }, // no next_cursor — the exit condition
  ];
  stubFetch((_url, _init, call) => ({
    status: 200,
    body: pages[Math.min(call, pages.length - 1)],
  }));
  const { runId, runState } = startRun();

  await _executeSteps(
    [
      step({
        rowsPath: "data",
        pagination: { mode: "cursor", cursorPath: "next_cursor" },
      }),
    ],
    1,
    runId,
    { extracted: {} },
  );

  assert.deepEqual(
    runState.results.map((r) => r.id),
    [1, 2, 3, 4],
  );
  assert.equal(fetchCalls.length, 3);
  assert.match(fetchCalls[1].url, /cursor=c2/);
  assert.match(fetchCalls[2].url, /cursor=c3/);
  await endRun(runId);
});

test("cursor pagination reads a nested path (meta.next), not only a top-level field", async () => {
  const pages = [
    { data: [{ id: 1 }], meta: { next: "abc" } },
    { data: [{ id: 2 }], meta: {} },
  ];
  stubFetch((_url, _init, call) => ({
    status: 200,
    body: pages[Math.min(call, pages.length - 1)],
  }));
  const { runId, runState } = startRun();

  await _executeSteps(
    [
      step({
        rowsPath: "data",
        pagination: { mode: "cursor", cursorPath: "meta.next" },
      }),
    ],
    1,
    runId,
    { extracted: {} },
  );

  assert.deepEqual(
    runState.results.map((r) => r.id),
    [1, 2],
  );
  assert.match(fetchCalls[1].url, /cursor=abc/);
  await endRun(runId);
});

test("page-number pagination increments per request and stops on an empty page", async () => {
  const pages = [{ items: [{ id: 1 }] }, { items: [{ id: 2 }] }, { items: [] }];
  stubFetch((_url, _init, call) => ({
    status: 200,
    body: pages[Math.min(call, pages.length - 1)],
  }));
  const { runId, runState } = startRun();

  await _executeSteps(
    [
      step({
        rowsPath: "items",
        pagination: { mode: "page", pageParam: "page", startPage: 1 },
      }),
    ],
    1,
    runId,
    { extracted: {} },
  );

  assert.deepEqual(
    runState.results.map((r) => r.id),
    [1, 2],
  );
  assert.equal(
    fetchCalls.length,
    3,
    "the empty 3rd page is fetched and then stops it",
  );
  assert.match(fetchCalls[0].url, /page=1/);
  assert.match(fetchCalls[1].url, /page=2/);
  assert.match(fetchCalls[2].url, /page=3/);
  await endRun(runId);
});

test('Link-header pagination follows rel="next" until it is absent', async () => {
  const responses = [
    {
      body: { data: [{ id: 1 }] },
      headers: { link: '<https://shop.test/items?page=2>; rel="next"' },
    },
    {
      body: { data: [{ id: 2 }] },
      headers: {
        link:
          '<https://shop.test/items?page=3>; rel="next", ' +
          '<https://shop.test/items?page=1>; rel="prev"',
      },
    },
    { body: { data: [{ id: 3 }] } }, // no Link header — the exit condition
  ];
  stubFetch((_url, _init, call) => ({
    status: 200,
    ...responses[Math.min(call, responses.length - 1)],
  }));
  const { runId, runState } = startRun();

  await _executeSteps(
    [step({ rowsPath: "data", pagination: { mode: "link" } })],
    1,
    runId,
    { extracted: {} },
  );

  assert.deepEqual(
    runState.results.map((r) => r.id),
    [1, 2, 3],
  );
  assert.equal(fetchCalls.length, 3);
  assert.equal(fetchCalls[1].url, "https://shop.test/items?page=2");
  assert.equal(fetchCalls[2].url, "https://shop.test/items?page=3");
  await endRun(runId);
});

test("maxPages is a safety cap, not the exit condition", async () => {
  stubFetch(() => ({
    status: 200,
    body: { data: [{ id: 1 }], next_cursor: "always-more" },
  }));
  const { runId, runState } = startRun();

  await _executeSteps(
    [
      step({
        rowsPath: "data",
        pagination: { mode: "cursor", cursorPath: "next_cursor", maxPages: 3 },
      }),
    ],
    1,
    runId,
    { extracted: {} },
  );

  assert.equal(fetchCalls.length, 3);
  assert.equal(runState.results.length, 3);
  await endRun(runId);
});

test("a later page failing keeps the rows already collected", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  stubFetch((_url, _init, call) =>
    call === 0
      ? { status: 200, body: { data: [{ id: 1 }], next_cursor: "c2" } }
      : { status: 500, statusText: "Boom" },
  );
  const { runId, runState } = startRun();

  const p = _executeSteps(
    [
      step({
        rowsPath: "data",
        pagination: { mode: "cursor", cursorPath: "next_cursor" },
      }),
    ],
    1,
    runId,
    { extracted: {} },
  );
  await advanceFakeTime(t, 8000);
  await p;

  assert.deepEqual(
    runState.results.map((r) => r.id),
    [1],
  );
  await endRun(runId);
});

test("rowsPath alone, with no pagination, pushes rows the same way a paginated call does", async () => {
  stubFetch(() => ({ status: 200, body: { items: [{ id: 1 }, { id: 2 }] } }));
  const { runId, runState } = startRun();

  await _executeSteps([step({ rowsPath: "items" })], 1, runId, {
    extracted: {},
  });

  assert.deepEqual(
    runState.results.map((r) => r.id),
    [1, 2],
  );
  assert.equal(fetchCalls.length, 1);
  await endRun(runId);
});

test("no rowsPath configured pushes nothing — unchanged from before this existed", async () => {
  stubFetch(() => ({ status: 200, body: { items: [{ id: 1 }] } }));
  const { runId, runState } = startRun();

  await _executeSteps([step()], 1, runId, { extracted: {} });

  assert.equal(runState.results.length, 0);
  await endRun(runId);
});

test("cursor mode without cursorPath refuses rather than never advancing", async () => {
  const { runId, runState } = startRun();
  await assert.rejects(
    _executeApiStep(
      {
        url: "https://shop.test/x",
        rowsPath: "data",
        pagination: { mode: "cursor" },
      },
      {},
      { runId, runState },
    ),
    /cursorPath/,
  );
});

test("pagination without rowsPath refuses — nothing would say what an empty page is", async () => {
  const { runId, runState } = startRun();
  await assert.rejects(
    _executeApiStep(
      { url: "https://shop.test/x", pagination: { mode: "page" } },
      {},
      { runId, runState },
    ),
    /rowsPath/,
  );
});

test("an unknown pagination mode refuses instead of silently doing nothing", async () => {
  const { runId, runState } = startRun();
  await assert.rejects(
    _executeApiStep(
      {
        url: "https://shop.test/x",
        rowsPath: "data",
        pagination: { mode: "bogus" },
      },
      {},
      { runId, runState },
    ),
    /unknown mode/,
  );
});
