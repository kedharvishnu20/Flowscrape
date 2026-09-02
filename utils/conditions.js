// === conditions.js ===
/**
 * @module conditions
 * @description What an IF_ELSE branch can ask about a page.
 *
 *   It could compare text and attributes, and that was all. No "is this
 *   empty", no numeric comparison, no pattern match — so "only scrape items
 *   under £50" and "skip the row when the price is missing", the two things a
 *   branch is most often for, could not be expressed at all.
 *
 *   Pure, and separate from the content script deliberately. The numeric
 *   comparisons need the same number reader `EXTRACT` uses — a branch that
 *   read `"1.234,56"` as `1.234` would take the wrong path on every European
 *   price — and a classic content script cannot import a module, so a copy in
 *   the page would be a second parser drifting from the first (the G-01 rule).
 *
 *   So the split is: **the page reads the DOM and reports what it saw; this
 *   decides what that means.** The page never evaluates a condition.
 *
 * @dependencies utils/value-transforms.js
 */

import { applyTransform, isValidRegex } from "./value-transforms.js";

/**
 * What the content script reports back about the element it looked at.
 *
 * @typedef {object} Observed
 * @property {boolean} exists   - did the selector match anything
 * @property {string}  text     - its textContent, unnormalised
 * @property {?string} attrValue - the requested attribute, or null
 */

/** Collapse the whitespace real markup leaves inside a rendered string. */
const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The number the user typed to compare against.
 *
 * Refused rather than coerced: `Number("cheap")` is NaN, every comparison
 * against it is false, and the branch would silently always take ELSE.
 */
function comparand(value, condition) {
  const n = Number(String(value ?? "").trim());
  if (!Number.isFinite(n)) {
    throw new Error(
      `Condition "${condition}" needs a number to compare against (got "${value}").`,
    );
  }
  return n;
}

/**
 * The number in the element's text, or null when there is none.
 *
 * `null`, not `0`. "Out of stock" is not "less than 50", and reading it as 0
 * would put every sold-out row into the cheap branch.
 */
const observedNumber = (observed) =>
  observed.exists ? applyTransform(observed.text, "number") : null;

/**
 * Every condition IF_ELSE can use, with what the UI must ask for.
 *
 * `needs` drives the config UI, so a condition cannot be added without the
 * panel knowing whether to show a value box, an attribute box, or neither —
 * which is how "Attr" once shipped with nowhere to type the attribute name
 * (B-07).
 *
 * @type {Record<string, {label: string, needs: string, fn: Function}>}
 */
export const CONDITIONS = Object.freeze({
  exists: {
    label: "Element exists",
    needs: "none",
    fn: (o) => o.exists,
  },
  "not-exists": {
    label: "Element does NOT exist",
    needs: "none",
    fn: (o) => !o.exists,
  },
  "is-empty": {
    label: "Element is empty or missing",
    needs: "none",
    // Three shapes of "there is nothing here" — no element, an empty one, and
    // one holding only whitespace — and a scrape must treat them alike.
    fn: (o) => !o.exists || norm(o.text) === "",
  },
  "not-empty": {
    label: "Element has some text",
    needs: "none",
    fn: (o) => o.exists && norm(o.text) !== "",
  },
  "text-equals": {
    label: "Text equals",
    needs: "value",
    fn: (o, c) => o.exists && norm(o.text) === norm(c.value),
  },
  "text-contains": {
    label: "Text contains",
    needs: "value",
    fn: (o, c) => o.exists && norm(o.text).includes(norm(c.value)),
  },
  "text-matches": {
    label: "Text matches pattern",
    needs: "value",
    fn: (o, c) => {
      if (!o.exists) return false;
      const pattern = String(c.value ?? "");
      if (!isValidRegex(pattern)) {
        // Returning false would send every row down ELSE, which looks exactly
        // like a working pipeline that found nothing.
        throw new Error(
          `Condition "text-matches" has an invalid pattern: ${pattern}`,
        );
      }
      return new RegExp(pattern).test(norm(o.text));
    },
  },
  "attr-equals": {
    label: "Attribute equals",
    needs: "attr+value",
    fn: (o, c) =>
      o.exists && String(o.attrValue ?? "").trim() === String(c.value).trim(),
  },
  "attr-contains": {
    label: "Attribute contains",
    needs: "attr+value",
    fn: (o, c) => o.exists && String(o.attrValue ?? "").includes(c.value),
  },
  "attr-exists": {
    label: "Attribute is present",
    needs: "attr",
    fn: (o) => o.exists && o.attrValue !== null && o.attrValue !== undefined,
  },
  "number-equals": {
    label: "Number equals",
    needs: "value",
    fn: (o, c) => {
      const n = observedNumber(o);
      return n !== null && n === comparand(c.value, "number-equals");
    },
  },
  "number-gt": {
    label: "Number is greater than",
    needs: "value",
    fn: (o, c) => {
      const n = observedNumber(o);
      return n !== null && n > comparand(c.value, "number-gt");
    },
  },
  "number-lt": {
    label: "Number is less than",
    needs: "value",
    fn: (o, c) => {
      const n = observedNumber(o);
      return n !== null && n < comparand(c.value, "number-lt");
    },
  },
});

/** The names the UI offers, in the order it offers them. */
export const CONDITION_NAMES = Object.freeze(Object.keys(CONDITIONS));

/**
 * Decide whether a branch's condition is met.
 *
 * @param {string} condition - a key of CONDITIONS
 * @param {Observed} observed - what the page reported
 * @param {{value?: string, attr?: string}} [config]
 * @returns {boolean}
 * @throws when the condition is not one this module knows — a typo that
 *   defaulted to `exists` would make the branch always take the IF path.
 */
export function evaluateCondition(condition, observed, config = {}) {
  const meta = CONDITIONS[condition];
  if (!meta) {
    throw new Error(
      `Unknown condition "${condition}". Supported: ${CONDITION_NAMES.join(", ")}.`,
    );
  }
  return Boolean(meta.fn(observed, config));
}

// === END conditions.js ===
