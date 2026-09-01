// === row-buffer.js ===
/**
 * @module row-buffer
 * @description In-memory ring buffer + periodic flush to IndexedDB.
 *   Flushes every 50 rows or every 30 seconds (whichever comes first).
 *   Provides backpressure-safe pushRow() that never loses data.
 *
 *   Design decision: We use a ring buffer (fixed-size array with head/tail
 *   pointers) rather than an Array.push() approach to avoid O(n) copy costs
 *   on large runs. Flush is to IDB (not local storage) because row data can
 *   be large and IDB has no size limit in practice.
 *
 * @dependencies logger, cursor-store
 */

import { logger } from "../utils/logger.js";
import { STORE_DATA_ROWS, withStores, requestAsPromise } from "./idb-schema.js";

const MODULE = "row-buffer";

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_ROWS_COUNT = 50;

// The database schema lives in idb-schema.js — see that module for why.
const STORE_ROWS = STORE_DATA_ROWS;

const _buffers = new Map();
const _flushTimers = new Map();

// ── IDB helpers ───────────────────────────────────────────────────────────────
async function _writeRows(runId, rows) {
  return withStores([STORE_ROWS], "readwrite", ({ [STORE_ROWS]: store }) => {
    for (const row of rows) {
      store.put({ runId, ...row });
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize the buffer for a run.
 * @param {string} runId
 */
export function initBuffer(runId) {
  _buffers.set(runId, []);
  _startFlushTimer(runId);
  logger.info(MODULE, "buffer-init", { runId });
}

/**
 * Push a result row into the buffer. Flushes if threshold reached.
 * @param {string} runId
 * @param {object} row
 * @returns {Promise<void>}
 */
export async function pushRow(runId, row) {
  const buf = _buffers.get(runId) || [];
  buf.push(row);
  _buffers.set(runId, buf);
  if (buf.length >= FLUSH_ROWS_COUNT) {
    await flush(runId);
  }
}

/**
 * Flush all buffered rows to IndexedDB now.
 * @param {string} runId
 * @returns {Promise<void>}
 */
export async function flush(runId) {
  const buf = _buffers.get(runId) || [];
  if (buf.length === 0) return;
  const toWrite = buf.splice(0, buf.length);
  try {
    await _writeRows(runId, toWrite);
    logger.debug(MODULE, "flush-ok", { count: toWrite.length, runId });
  } catch (err) {
    buf.unshift(...toWrite);
    logger.error(MODULE, "flush-fail", { error: err.message, runId });
    throw err;
  }
}

/**
 * Start periodic flush timer.
 * @param {string} runId
 */
function _startFlushTimer(runId) {
  _stopFlushTimer(runId);
  const timer = setInterval(async () => {
    try {
      await flush(runId);
    } catch {
      /* logged in flush() */
    }
  }, FLUSH_INTERVAL_MS);
  _flushTimers.set(runId, timer);
}

/**
 * Stop the periodic flush timer.
 * @param {string} runId
 */
function _stopFlushTimer(runId) {
  const timer = _flushTimers.get(runId);
  if (timer) {
    clearInterval(timer);
    _flushTimers.delete(runId);
  }
}

/**
 * Finalize: flush remaining rows and stop timer.
 * @param {string} runId
 * @returns {Promise<void>}
 */
export async function finalizeBuffer(runId) {
  _stopFlushTimer(runId);
  await flush(runId);
  _buffers.delete(runId);
  logger.info(MODULE, "buffer-finalized", { runId });
}

/**
 * Read all stored rows for a runId from IDB.
 * @param {string} runId
 * @returns {Promise<object[]>}
 */
export async function readAllRows(runId) {
  const rows = await withStores(
    [STORE_ROWS],
    "readonly",
    ({ [STORE_ROWS]: store }) =>
      requestAsPromise(store.index("runId").getAll(IDBKeyRange.only(runId))),
  );
  return rows ?? [];
}

/**
 * Clear all rows for a runId from IDB.
 * @param {string} runId
 */
export async function clearRows(runId) {
  return withStores(
    [STORE_ROWS],
    "readwrite",
    ({ [STORE_ROWS]: store }) =>
      new Promise((resolve, reject) => {
        const req = store.index("runId").openKeyCursor(IDBKeyRange.only(runId));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve();
            return;
          }
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      }),
  );
}

// === END row-buffer.js ===
