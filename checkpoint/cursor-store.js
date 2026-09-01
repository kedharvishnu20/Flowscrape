// === cursor-store.js ===
/**
 * @module cursor-store
 * @description IndexedDB cursor read/write for checkpoint/resume.
 *   Stores the pipeline run position (row index, step index, runId) so that
 *   an interrupted run can be resumed from the last saved cursor.
 *
 *   Design decision: We use IndexedDB (not session/local storage) because
 *   cursor data may be large and needs to survive SW restarts. IDB is the
 *   correct tier for structured run-state data per the storage architecture.
 *
 * @dependencies logger
 */

import { logger } from "../utils/logger.js";
import { STORE_CURSORS, withStores, requestAsPromise } from "./idb-schema.js";

const MODULE = "cursor-store";

// The database schema lives in idb-schema.js — see that module for why.
// `_tx` resolves only once the transaction commits, so a saved cursor is
// durable by the time the caller continues.
const _tx = withStores;

/**
 * @typedef {Object} Cursor
 * @property {string} runId
 * @property {number} rowIndex   - Last successfully processed row (0-based)
 * @property {number} stepIndex  - Current step index
 * @property {string} savedAt    - ISO8601
 * @property {object} [extra]    - Any extra pipeline-specific state
 */

/**
 * Save a cursor to IDB.
 * @param {Cursor} cursor
 */
export async function saveCursor(cursor) {
  try {
    await _tx([STORE_CURSORS], "readwrite", ({ [STORE_CURSORS]: store }) =>
      requestAsPromise(
        store.put({ ...cursor, savedAt: new Date().toISOString() }),
      ),
    );
    logger.debug(MODULE, "cursor-saved", {
      runId: cursor.runId,
      rowIndex: cursor.rowIndex,
    });
  } catch (err) {
    logger.error(MODULE, "cursor-save-fail", { error: err.message });
    throw err;
  }
}

/**
 * Load a cursor by runId.
 * @param {string} runId
 * @returns {Promise<Cursor|null>}
 */
export async function loadCursor(runId) {
  try {
    const cursor = await _tx(
      [STORE_CURSORS],
      "readonly",
      ({ [STORE_CURSORS]: store }) => requestAsPromise(store.get(runId)),
    );
    return cursor ?? null;
  } catch (err) {
    logger.error(MODULE, "cursor-load-fail", { error: err.message });
    return null;
  }
}

/**
 * List all stored cursors (incomplete runs).
 * @returns {Promise<Cursor[]>}
 */
export async function listCursors() {
  try {
    const cursors = await _tx(
      [STORE_CURSORS],
      "readonly",
      ({ [STORE_CURSORS]: store }) => requestAsPromise(store.getAll()),
    );
    return cursors ?? [];
  } catch (err) {
    logger.error(MODULE, "cursor-list-fail", { error: err.message });
    return [];
  }
}

/**
 * Delete a cursor (called on run completion).
 * @param {string} runId
 */
export async function deleteCursor(runId) {
  try {
    await _tx([STORE_CURSORS], "readwrite", ({ [STORE_CURSORS]: store }) =>
      requestAsPromise(store.delete(runId)),
    );
    logger.info(MODULE, "cursor-deleted", { runId });
  } catch (err) {
    logger.error(MODULE, "cursor-delete-fail", { error: err.message });
  }
}

// === END cursor-store.js ===
