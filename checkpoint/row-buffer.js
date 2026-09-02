// === row-buffer.js ===
/**
 * @module row-buffer
 * @description In-memory row buffer + periodic flush to IndexedDB.
 *   Flushes every 50 rows or every 30 seconds (whichever comes first).
 *
 *   This docblock used to describe "a ring buffer (fixed-size array with head
 *   and tail pointers) rather than an Array.push() approach to avoid O(n) copy
 *   costs" (audit D-13). It is a plain array, and always was. A ring buffer
 *   would buy nothing here: the array is drained whole every 50 rows, so it
 *   never grows past the flush threshold in normal operation and there is no
 *   O(n) cost to avoid. The description is corrected rather than the code.
 *
 *   pushRow() does not lose rows and does not abort the caller. A flush that
 *   fails puts its rows back and lets the run continue — a transient IndexedDB
 *   error used to propagate out of pushRow and kill the step that produced the
 *   row (audit D-12). The retained buffer is bounded, because an IndexedDB that
 *   is permanently broken would otherwise grow it without limit; when that
 *   bound is reached the oldest rows are dropped and said so, once.
 *
 *   Flush is to IDB (not local storage) because row data can be large and IDB
 *   has no size limit in practice.
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

/**
 * Ceiling on rows held for a run whose flushes keep failing. 50 rows is the
 * normal high-water mark, so reaching this means IndexedDB has been refusing
 * writes for a long time.
 */
const MAX_BUFFERED_ROWS = 5000;

const _buffers = new Map();
const _flushTimers = new Map();
/** runId → rows discarded because the buffer could not be flushed. */
const _droppedRows = new Map();

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
  if (buf.length < FLUSH_ROWS_COUNT) return;

  try {
    await flush(runId);
  } catch (err) {
    // The rows are back in the buffer and the next flush will retry them. What
    // must not happen is this taking the step down with it: an extraction that
    // succeeded should not be reported as failed because a write was busy.
    logger.warn(MODULE, "push-flush-deferred", { runId, error: err.message });
    _trimOverflow(runId);
  }
}

/**
 * Keep a buffer that cannot be flushed from growing without bound.
 *
 * If IndexedDB is genuinely unavailable, every flush fails and the rows pile up
 * in the worker's heap for the rest of the run. Dropping the oldest is the
 * least-bad option, and it is never silent.
 *
 * @param {string} runId
 */
function _trimOverflow(runId) {
  const buf = _buffers.get(runId);
  if (!buf || buf.length <= MAX_BUFFERED_ROWS) return;
  const dropped = buf.length - MAX_BUFFERED_ROWS;
  buf.splice(0, dropped);
  const total = (_droppedRows.get(runId) || 0) + dropped;
  _droppedRows.set(runId, total);
  if (total === dropped) {
    logger.error(MODULE, "buffer-overflow", {
      runId,
      dropped,
      note: "IndexedDB writes are failing; oldest rows are being discarded",
    });
  }
}

/**
 * How many rows this run lost to a buffer that could not be flushed.
 * @param {string} runId
 * @returns {number}
 */
export function droppedRowCount(runId) {
  return _droppedRows.get(runId) || 0;
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
    // concat, not unshift(...toWrite): spreading a large array into a call
    // blows the argument limit, and this is the path that runs when a big
    // buffer fails to write.
    _buffers.set(runId, toWrite.concat(buf));
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
 * @returns {Promise<{ dropped: number }>} rows lost to an unflushable buffer
 */
export async function finalizeBuffer(runId) {
  _stopFlushTimer(runId);
  await flush(runId);
  _buffers.delete(runId);
  // Read before clearing, and returned, so a caller can report a short run
  // rather than having to ask separately after the state is gone.
  const dropped = droppedRowCount(runId);
  _droppedRows.delete(runId);
  logger.info(MODULE, "buffer-finalized", { runId, dropped });
  return { dropped };
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
