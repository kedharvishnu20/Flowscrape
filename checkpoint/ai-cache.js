// === ai-cache.js ===
/**
 * @module ai-cache
 * @description Not asking the same model the same question twice.
 *
 *   The AI layer is the only part of this extension that costs anything —
 *   money on a hosted provider, ten to twenty seconds on a local one. A LOOP
 *   over a paginated list revisits pages; a run re-run after a failed EXPORT
 *   re-asks every page it already asked about; a user adjusting one field of a
 *   schema re-asks the pages that did not change. None of that is new
 *   information, and the model returns the same answer.
 *
 *   **Why this can be exact rather than a guess.** The question is in hand:
 *   `_buildSimplifiedDom()` produces the whole of what the model is shown, so
 *   two runs whose text hashes the same are asking the same thing, and a page
 *   that changed hashes differently and is asked again. That removes the part
 *   of caching that normally goes wrong — there is no TTL to tune, no
 *   staleness heuristic, no "cached five minutes ago, probably fine". The
 *   content decides.
 *
 *   **What is in the key, and why each part is.** The URL, so an answer is
 *   never served for a page it was not given for — identical text at two
 *   addresses is possible, and an answer attributed to the wrong page is a
 *   provenance lie even when the values are right. The requested fields, since
 *   a different schema is a different question. And which model was asked,
 *   which is the part a cache like this usually forgets: someone switching
 *   from a local llama to GPT-4o and being handed the llama's answer would
 *   have no way to tell. "Which model" includes the address it lives at —
 *   two local servers both answering to `llama3.2` are two different models,
 *   and on a local setup the endpoint is the only thing that tells them
 *   apart.
 *
 *   **What is not stored: the page.** Only the hash of it. A cache of
 *   everything this extension has ever read off every page would be a new and
 *   much larger thing to hold on a user's disk, and nothing here needs it —
 *   the hash answers "is this the same page" without keeping the page.
 *
 * @dependencies checkpoint/idb-schema.js, utils/logger.js
 */

import { withStores, requestAsPromise, STORE_AI_CACHE } from "./idb-schema.js";
import { logger } from "../utils/logger.js";

const MODULE = "ai-cache";

/**
 * How many answers are kept.
 *
 * Sized for the case this is for — a run over a few hundred pages, re-run —
 * rather than for a permanent archive. Each entry is one small object, so this
 * is a few megabytes at the top end.
 */
export const MAX_AI_CACHE_ENTRIES = 500;

/** How many go at once when the cap is passed, so eviction is not per-write. */
const EVICT_BATCH = 50;

/**
 * The fingerprint of one question.
 *
 * @param {object} q
 * @param {string} q.url
 * @param {string} q.dom - exactly the text the model would be sent
 * @param {string[]} q.fields
 * @param {string} q.provider
 * @param {string} q.model
 * @param {string} [q.baseUrl] - for a local server, the only thing that tells
 *   one `llama3.2` from another
 * @returns {Promise<string>} sha-256, hex
 */
export async function cacheKey({
  url = "",
  dom = "",
  fields = [],
  provider = "",
  model = "",
  baseUrl = "",
} = {}) {
  // Sorted: the same fields in a different order is the same request, and
  // missing on the order the user happened to type them in would be a cache
  // that misses on nothing at all.
  const canonical = [
    String(url),
    [...fields].map(String).sort().join(","),
    String(provider),
    String(model),
    String(baseUrl),
    String(dom),
  ].join(" ");

  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Look one up, and mark it used.
 *
 * The touch is what makes the eviction below an LRU rather than a FIFO: the
 * page a run revisits on every pass is the one most worth keeping, and
 * evicting by write time would drop it in favour of pages seen once.
 *
 * @param {string} key
 * @returns {Promise<{value: any, model: string, url: string}|null>}
 */
export async function readCache(key) {
  if (!key) return null;
  try {
    return await withStores([STORE_AI_CACHE], "readwrite", async (s) => {
      const entry = await requestAsPromise(s[STORE_AI_CACHE].get(key));
      if (!entry) return null;
      entry.lastUsed = Date.now();
      s[STORE_AI_CACHE].put(entry);
      return entry;
    });
  } catch (err) {
    // A cache that cannot be read is a cache miss, never a failed run.
    logger.warn(MODULE, "read-fail", { error: err.message });
    return null;
  }
}

/**
 * Remember an answer.
 *
 * @param {string} key
 * @param {any} value - the model's parsed answer
 * @param {{url?: string, model?: string}} [meta]
 * @returns {Promise<boolean>} whether it was stored
 */
export async function writeCache(key, value, meta = {}) {
  if (!key || value == null) return false;
  try {
    await withStores([STORE_AI_CACHE], "readwrite", (s) => {
      s[STORE_AI_CACHE].put({
        key,
        value,
        // Kept for the panel and for anyone inspecting the store: which model
        // answered, and for which page. Not the page text.
        url: String(meta.url ?? ""),
        model: String(meta.model ?? ""),
        storedAt: Date.now(),
        lastUsed: Date.now(),
      });
    });
    await _evictIfFull();
    return true;
  } catch (err) {
    logger.warn(MODULE, "write-fail", { error: err.message });
    return false;
  }
}

/** How many answers are held. */
export async function countCache() {
  try {
    return await withStores([STORE_AI_CACHE], "readonly", (s) =>
      requestAsPromise(s[STORE_AI_CACHE].count()),
    );
  } catch {
    return 0;
  }
}

/** Forget everything. */
export async function clearCache() {
  try {
    await withStores([STORE_AI_CACHE], "readwrite", (s) => {
      s[STORE_AI_CACHE].clear();
    });
    return true;
  } catch (err) {
    logger.warn(MODULE, "clear-fail", { error: err.message });
    return false;
  }
}

/**
 * Drop the least recently used entries once the cap is passed.
 *
 * Walked over the `lastUsed` index in ascending order, so the first ones the
 * cursor reaches are the ones to lose.
 */
async function _evictIfFull() {
  const total = await countCache();
  if (total <= MAX_AI_CACHE_ENTRIES) return;

  const toDrop = total - MAX_AI_CACHE_ENTRIES + EVICT_BATCH;
  try {
    await withStores([STORE_AI_CACHE], "readwrite", (s) => {
      return new Promise((resolve, reject) => {
        let dropped = 0;
        const req = s[STORE_AI_CACHE].index("lastUsed").openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || dropped >= toDrop) return resolve(dropped);
          cursor.delete();
          dropped++;
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
  } catch (err) {
    logger.warn(MODULE, "evict-fail", { error: err.message });
  }
}

// === END ai-cache.js ===
