// Not asking the same model the same question twice.
//
// The AI layer is the only part of this that costs anything — money on a
// hosted provider, ten to twenty seconds on a local one. A LOOP over a
// paginated list revisits pages; a run re-run after a failed EXPORT re-asks
// every page; a user tweaking a schema re-asks the ones that did not change.
// None of that is new information, and the model gives the same answer.
//
// What makes the check exact rather than a guess is that the *question* is in
// hand: the simplified DOM is the whole of what the model was shown. Two runs
// whose text hashes the same are two runs asking the same thing, and a page
// that changed hashes differently and is asked again. No TTL, no staleness
// heuristic, no "cached 5 minutes ago" — the content decides.
//
// Three things it must get right, and each is a way a cache makes a tool worse
// rather than faster:
//
//   - **A different model is a different question.** Someone switching from a
//     local llama to GPT-4o and getting the llama's answer back would have no
//     way to tell.
//   - **A failure is never cached.** A rate limit or a server that was down for
//     a minute would otherwise be remembered as this page's answer.
//   - **A hit is not passed off as a fresh answer.** The run says the page was
//     answered from cache, because "the model said so" and "the model said so
//     last Tuesday" are different claims.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "fake-indexeddb/auto";

import * as cacheModule from "../checkpoint/ai-cache.js";
import { STEP_TYPES } from "../utils/step-types.js";

const {
  cacheKey,
  readCache,
  writeCache,
  clearCache,
  countCache,
  MAX_AI_CACHE_ENTRIES,
} = cacheModule;

const BASE = {
  url: "https://shop.test/p/1",
  dom: "Blue Widget £10.00",
  fields: ["name", "price"],
  provider: "openai-compatible",
  model: "llama3.2",
};
const ANSWER = { result: { name: "Blue Widget" }, perField: { name: 90 } };

// ── What counts as the same question ─────────────────────────────────────────

test("the same page, schema and model is the same question", async () => {
  const a = await cacheKey(BASE);
  const b = await cacheKey({ ...BASE });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/, "a sha-256, so the key is fixed-length");
});

test("a page that changed is a different question", async () => {
  const changed = await cacheKey({ ...BASE, dom: "Blue Widget £12.00" });
  assert.notEqual(changed, await cacheKey(BASE));
});

test("a different schema is a different question", async () => {
  const other = await cacheKey({ ...BASE, fields: ["name", "sku"] });
  assert.notEqual(other, await cacheKey(BASE));
  // Order is not meaning: the same fields asked for in a different order is
  // the same request, and re-asking for it would be a cache that misses on
  // nothing more than how the user typed the list.
  const reordered = await cacheKey({ ...BASE, fields: ["price", "name"] });
  assert.equal(reordered, await cacheKey(BASE));
});

test("a different model is a different question", async () => {
  // The failure that would be hardest to notice: switch provider, get the old
  // provider's answer, with nothing in the row saying which model produced it.
  const gpt = await cacheKey({ ...BASE, provider: "openai", model: "gpt-4o" });
  assert.notEqual(gpt, await cacheKey(BASE));
  const sameProviderNewModel = await cacheKey({ ...BASE, model: "llama3.3" });
  assert.notEqual(sameProviderNewModel, await cacheKey(BASE));
});

test("two local servers answering to the same name are two models", async () => {
  // Found by the browser check: a fake local server on one port and another on
  // the next, both called "fake-local", shared an answer. On a local setup the
  // endpoint is the only thing that tells one llama3.2 from another — a second
  // machine, a second Ollama, a model reloaded with different weights under
  // the same name.
  const elsewhere = await cacheKey({
    ...BASE,
    baseUrl: "http://127.0.0.1:11435/v1",
  });
  assert.notEqual(
    elsewhere,
    await cacheKey({ ...BASE, baseUrl: "http://127.0.0.1:11434/v1" }),
  );
});

test("an answer is not served for a page it was not given for", async () => {
  // Identical text at two URLs is possible, and an answer attributed to the
  // wrong page is a provenance lie even when the values happen to be right.
  const elsewhere = await cacheKey({ ...BASE, url: "https://shop.test/p/2" });
  assert.notEqual(elsewhere, await cacheKey(BASE));
});

// ── Storing it ───────────────────────────────────────────────────────────────

test("what was written comes back", async () => {
  await clearCache();
  const key = await cacheKey(BASE);
  assert.equal(await readCache(key), null, "nothing cached yet");
  await writeCache(key, ANSWER, { url: BASE.url, model: BASE.model });
  const got = await readCache(key);
  assert.deepEqual(got.value, ANSWER);
  assert.equal(
    got.model,
    BASE.model,
    "the row should say which model answered",
  );
});

test("the page text is not kept, only the fingerprint of it", async () => {
  // A cache of everything this extension has read off every page would be a
  // new and much larger thing to hold, and nothing here needs it: the hash
  // answers "is this the same page" without storing the page.
  await clearCache();
  const key = await cacheKey(BASE);
  await writeCache(key, ANSWER, { url: BASE.url, model: BASE.model });
  const entry = await readCache(key);
  const serialised = JSON.stringify(entry);
  assert.ok(
    !serialised.includes(BASE.dom),
    "the simplified DOM was stored alongside the answer",
  );

  const src = readFileSync(
    new URL("../checkpoint/ai-cache.js", import.meta.url),
    "utf8",
  );
  assert.ok(!/\bdom\s*[,:]\s*dom\b/.test(src), "it still stores the text");
});

// ── Bounded ──────────────────────────────────────────────────────────────────

test("it stops growing, and the oldest use is what goes", async () => {
  await clearCache();
  const keys = [];
  for (let i = 0; i < MAX_AI_CACHE_ENTRIES + 5; i++) {
    const key = await cacheKey({ ...BASE, url: `https://shop.test/p/${i}` });
    keys.push(key);
    await writeCache(key, ANSWER, { url: `https://shop.test/p/${i}` });
  }
  const total = await countCache();
  assert.ok(
    total <= MAX_AI_CACHE_ENTRIES,
    `${total} entries kept, cap is ${MAX_AI_CACHE_ENTRIES}`,
  );
  assert.equal(await readCache(keys[0]), null, "the oldest should have gone");
  assert.ok(await readCache(keys.at(-1)), "the newest should still be there");
});

test("using an entry is what keeps it, not writing it", async () => {
  // Evicting by write time is a FIFO wearing an LRU's name: the page you
  // revisit on every run would be dropped for pages seen once.
  await clearCache();
  const first = await cacheKey({ ...BASE, url: "https://shop.test/keep" });
  await writeCache(first, ANSWER, { url: "https://shop.test/keep" });

  for (let i = 0; i < MAX_AI_CACHE_ENTRIES - 1; i++) {
    const key = await cacheKey({ ...BASE, url: `https://shop.test/f/${i}` });
    await writeCache(key, ANSWER, { url: `https://shop.test/f/${i}` });
    // Touch the one that must survive, the way a run revisiting it would.
    await readCache(first);
  }
  const extra = await cacheKey({ ...BASE, url: "https://shop.test/extra" });
  await writeCache(extra, ANSWER, { url: "https://shop.test/extra" });

  assert.ok(
    await readCache(first),
    "the entry used on every pass was evicted anyway",
  );
});

// ── How the run uses it ──────────────────────────────────────────────────────

test("a failure is never remembered as an answer", async () => {
  const src = readFileSync(
    new URL("../background/llm-extractor.js", import.meta.url),
    "utf8",
  );
  // A rate limit, a local server not yet started, a malformed response — all
  // transient, and all would become this page's permanent answer.
  assert.match(src, /!out\?\.error && out\?\.result/);
});

test("a cached answer says it is cached", async () => {
  const src = readFileSync(
    new URL("../background/llm-extractor.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /cached: true/);
  const worker = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(
    worker,
    /answered from cache/i,
    '"the model answered" and "the model answered last Tuesday" are different claims',
  );
});

test("the step can be told not to", async () => {
  assert.equal(STEP_TYPES.AUTO_EXTRACT.def.cache, true);
  const src = readFileSync(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /"cache",/);
});

test("the cache is keyed on the whole question, in the run", async () => {
  const src = readFileSync(
    new URL("../background/llm-extractor.js", import.meta.url),
    "utf8",
  );
  // Built where the gateway config is known, because provider and model are
  // part of the question and the worker would have to re-read them.
  assert.match(src, /cacheKey\(/);
  assert.match(src, /provider: config\.provider/);
});
