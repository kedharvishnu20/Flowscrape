// === assertions.js ===
/**
 * @module assertions
 * @description What an ASSERT step can claim about a page, and what it says
 *   when the claim is false.
 *
 *   A scrape fails silently far more often than it crashes: the site renames a
 *   class, every selector misses, EXTRACT reports a miss as `null` by design
 *   (B-08), and the run exports five hundred empty rows and calls itself a
 *   success. ASSERT is the place to say "if this is not true, the page is not
 *   the page I was written against" and stop.
 *
 *   Split the same way conditions.js is, and for the same reason: **the page
 *   reads the DOM and reports what it saw; this decides what that means.** A
 *   classic content script cannot import a module, so a second copy of the
 *   comparison in the page would drift from this one (the G-01 rule).
 *
 * @dependencies none
 */

"use strict";

/**
 * What the content script reports back about the selector it looked at.
 *
 * @typedef {object} Seen
 * @property {number} count - how many elements matched
 * @property {string} text  - the first match's textContent, unnormalised
 */

/** Collapse the whitespace real markup leaves inside a rendered string. */
const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** Plural that reads as English in the failure message. */
const matches = (n) => `${n} element${n === 1 ? "" : "s"}`;

/**
 * The number an assertion counts against.
 *
 * Refused rather than coerced: `Number("ten")` is NaN, every comparison
 * against it is false, and the run would fail with a message blaming the page
 * for a typo in the step.
 */
function wanted(config) {
  const n = Number(String(config?.count ?? "").trim());
  if (!Number.isFinite(n)) {
    throw new Error(
      `ASSERT needs a number to count against (got "${config?.count}").`,
    );
  }
  return n;
}

/**
 * Every assertion, with what the UI must ask for and what it says on failure.
 *
 * `needs` drives the config panel, so an assertion cannot be added without the
 * panel knowing whether to show a number box, a text box, or neither.
 *
 * @type {Record<string, {label: string, needs: string, fn: Function,
 *   failure: Function}>}
 */
export const ASSERTIONS = Object.freeze({
  exists: {
    label: "Element exists",
    needs: "none",
    fn: (seen) => seen.count > 0,
    failure: (seen, c) => `nothing on the page matches "${c.selector}"`,
  },
  "not-exists": {
    label: "Element does NOT exist",
    needs: "none",
    fn: (seen) => seen.count === 0,
    failure: (seen, c) =>
      `${matches(seen.count)} still match "${c.selector}", and none were expected`,
  },
  "count-equals": {
    label: "Match count is exactly",
    needs: "count",
    fn: (seen, c) => seen.count === wanted(c),
    failure: (seen, c) =>
      `expected exactly ${matches(wanted(c))} matching "${c.selector}", found ${seen.count}`,
  },
  "count-at-least": {
    label: "Match count is at least",
    needs: "count",
    fn: (seen, c) => seen.count >= wanted(c),
    failure: (seen, c) =>
      `expected at least ${matches(wanted(c))} matching "${c.selector}", found ${seen.count}`,
  },
  "count-at-most": {
    label: "Match count is at most",
    needs: "count",
    fn: (seen, c) => seen.count <= wanted(c),
    failure: (seen, c) =>
      `expected at most ${matches(wanted(c))} matching "${c.selector}", found ${seen.count}`,
  },
  "text-contains": {
    label: "Text contains",
    needs: "value",
    fn: (seen, c) => seen.count > 0 && norm(seen.text).includes(norm(c.value)),
    failure: (seen, c) =>
      seen.count === 0
        ? `nothing on the page matches "${c.selector}"`
        : `"${c.selector}" reads "${norm(seen.text)}", which does not contain "${norm(c.value)}"`,
  },
  "text-equals": {
    label: "Text equals",
    needs: "value",
    fn: (seen, c) => seen.count > 0 && norm(seen.text) === norm(c.value),
    failure: (seen, c) =>
      seen.count === 0
        ? `nothing on the page matches "${c.selector}"`
        : `"${c.selector}" reads "${norm(seen.text)}", not "${norm(c.value)}"`,
  },
});

/** The names the UI offers, in the order it offers them. */
export const ASSERTION_NAMES = Object.freeze(Object.keys(ASSERTIONS));

/**
 * Check one assertion against what the page reported.
 *
 * @param {string} assertion - a key of ASSERTIONS
 * @param {Seen} seen
 * @param {{selector?: string, value?: string, count?: number|string}} [config]
 * @returns {?string} null when it holds; otherwise why it does not, phrased to
 *   go straight into the run log
 * @throws when the assertion is not one this module knows — defaulting to
 *   `exists` would make a mistyped step pass on any page with any element.
 */
export function evaluateAssertion(assertion, seen, config = {}) {
  const meta = ASSERTIONS[assertion];
  if (!meta) {
    throw new Error(
      `Unknown assertion "${assertion}". Supported: ${ASSERTION_NAMES.join(", ")}.`,
    );
  }
  return meta.fn(seen, config) ? null : meta.failure(seen, config);
}

// === END assertions.js ===
