// === deduplicator.js ===
/**
 * @module deduplicator
 * @description In-flight row deduplicator using a fast hash approach.
 *   Uses a djb2 hash (xxHash is not available without WASM in MV3 without bundler)
 *   over a JSON-serialized row to detect and skip duplicate rows.
 *
 *   Design decision: We use djb2 (simple, fast, no dependencies) rather than
 *   xxHash64 because xxHash requires WASM or a build step, both of which are
 *   problematic in an unbundled MV3 extension. For collision resistance at
 *   web-scale row counts (<5M rows), djb2 is sufficient.
 *
 * @dependencies none
 */

"use strict";

/** @type {Set<number>} */
const _seen = new Set();
let _totalDuplicates = 0;

/**
 * djb2 hash over a string.
 * @param {string} str
 * @returns {number}
 */
function _hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) + h + str.charCodeAt(i);
    h |= 0; // convert to 32-bit integer
  }
  return h >>> 0; // unsigned
}

/**
 * Hash a row object by its content.
 * @param {object} row
 * @param {string[]} [keyColumns] - If provided, hash only these columns
 * @returns {number}
 */
function _hashRow(row, keyColumns) {
  const subset = keyColumns
    ? Object.fromEntries(keyColumns.map((k) => [k, row[k]]))
    : row;
  return _hash(JSON.stringify(subset));
}

/**
 * Check if a row is a duplicate and mark it as seen.
 * @param {object} row
 * @param {string[]} [keyColumns]
 * @returns {boolean} true if duplicate (should be skipped)
 */
export function isDuplicate(row, keyColumns) {
  const h = _hashRow(row, keyColumns);
  if (_seen.has(h)) {
    _totalDuplicates++;
    return true;
  }
  _seen.add(h);
  return false;
}

/** Reset the deduplicator state (call between runs). */
export function reset() {
  _seen.clear();
  _totalDuplicates = 0;
}

/** Get statistics. */
export function getStats() {
  return { seen: _seen.size, duplicates: _totalDuplicates };
}

/**
 * Filter an array of rows, removing duplicates.
 * @param {object[]} rows
 * @param {string[]} [keyColumns]
 * @returns {object[]}
 */
export function deduplicateRows(rows, keyColumns) {
  return rows.filter((row) => !isDuplicate(row, keyColumns));
}

// === END deduplicator.js ===
