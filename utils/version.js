// === version.js ===
/**
 * @module version
 * @description The project's version number, in one place.
 *
 *   It used to be written out separately in manifest.json, utils/strings.js,
 *   mcp/server.mjs (twice) and pipeline-compiler.js's AST stamp, while
 *   mcp/package.json had none at all and the git history called the same code
 *   v3 and v4 (audit I-04). Nothing kept them in step.
 *
 *   manifest.json is the one Chrome reads, so it stays canonical and this file
 *   mirrors it. tests/version.test.mjs fails if any of them drift apart, which
 *   is what makes "one place" true rather than aspirational.
 *
 * @dependencies none
 */

"use strict";

/** Keep in step with manifest.json — a test enforces it. */
export const VERSION = "3.0.0";

// === END version.js ===
