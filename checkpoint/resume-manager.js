// === resume-manager.js ===
/**
 * @module resume-manager
 * @description Detects incomplete runs and provides resume UI data.
 *   On startup, scans IDB cursors for runs that did not complete.
 *   Sends resume info to the side panel for user action.
 *
 * @dependencies cursor-store, logger
 */

import { logger } from "../utils/logger.js";
import { listCursors, deleteCursor } from "./cursor-store.js";

const MODULE = "resume-manager";

/**
 * @typedef {Object} ResumeInfo
 * @property {string} runId
 * @property {number} rowIndex
 * @property {number} stepIndex
 * @property {string} savedAt
 */

/**
 * Scan IDB for incomplete runs.
 * @returns {Promise<ResumeInfo[]>}
 */
export async function detectIncompleteRuns() {
  const cursors = await listCursors();
  const incomplete = cursors.filter((c) => !c.completed);
  logger.info(MODULE, "incomplete-runs", { count: incomplete.length });
  return incomplete.map((c) => ({
    runId: c.runId,
    rowIndex: c.rowIndex,
    stepIndex: c.stepIndex,
    savedAt: c.savedAt,
  }));
}

/**
 * Mark a run as completed and remove its cursor.
 * @param {string} runId
 */
export async function markRunCompleted(runId) {
  await deleteCursor(runId);
  logger.info(MODULE, "run-completed", { runId });
}

/**
 * Build resume payload to send to the side panel.
 * @returns {Promise<{ hasResumable: boolean, runs: ResumeInfo[] }>}
 */
export async function getResumePayload() {
  const runs = await detectIncompleteRuns();
  return { hasResumable: runs.length > 0, runs };
}

// === END resume-manager.js ===
