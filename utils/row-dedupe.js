// === row-dedupe.js ===
/**
 * @module row-dedupe
 * @description Deciding whether a row has been seen before.
 *
 *   Duplicate rows are the normal outcome of scraping, not an exotic one. A
 *   paginator that repeats its last page, an infinite feed re-rendering what is
 *   already on screen, a run repeated tomorrow over a list that has moved on by
 *   three items — all of them produce a file where the same record appears
 *   several times, and nothing in the run says so.
 *
 *   Two decisions worth stating:
 *
 *   - **The key is the user's, not ours.** Whole-row equality is almost never
 *     what a person means: two listings of the same product differ by a
 *     "3 left in stock" that changed between page loads. Naming the fields that
 *     identify a record — a URL, an id, a title — is what makes dedupe
 *     trustworthy, so the config takes them.
 *   - **The seen-set is bounded.** A million-row run cannot spend the worker's
 *     heap remembering keys. Past the bound the oldest keys are forgotten,
 *     which can let an old duplicate through — said out loud rather than
 *     presented as exact.
 *
 * @dependencies none
 */

/** Keys remembered before the oldest start being forgotten. */
export const DEFAULT_SEEN_LIMIT = 100000;

/**
 * Separates field values inside a key, and marks the two absent kinds.
 *
 * Unit separator: a character no page produces, so ["ab", "c"] and ["a", "bc"]
 * cannot collide into one key and silently drop a row that was never a
 * duplicate. A field the page did not have and a field the page had empty are
 * different facts, so they get different marks rather than both becoming "".
 */
const SEP = "\u001f";
const UNDEFINED = "\u001fundef";
const NULL = "\u001fnull";

/**
 * The identity of a row, as a string.
 *
 * Values are normalised the way a person compares them: trimmed, whitespace
 * collapsed, case-folded. "  Blue  Widget " and "blue widget" are the same
 * product, and a dedupe that disagreed would be worse than none — it would look
 * like it was working.
 *
 * @param {object} row
 * @param {string[]} [fields] - which fields identify the row; empty means all
 * @returns {string}
 */
export function rowKey(row, fields = []) {
  const source = row ?? {};
  const names = fields.length ? fields : Object.keys(source).sort();
  return names
    .map((name) => {
      const value = source[name];
      if (value === undefined) return UNDEFINED;
      if (value === null) return NULL;
      if (typeof value === "object") return JSON.stringify(value);
      return String(value).replace(/\s+/g, " ").trim().toLowerCase();
    })
    .join(SEP);
}

/**
 * Parse the comma-separated field list the panel collects.
 * @param {string} text
 * @returns {string[]}
 */
export function parseFields(text) {
  return String(text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A set of keys that forgets its oldest entries rather than growing forever.
 *
 * A Map is the whole implementation: JavaScript's Maps iterate in insertion
 * order, so the first key is always the oldest.
 */
export class SeenKeys {
  /**
   * @param {number} [limit]
   * @param {string[]} [initial] - keys restored from a previous run
   */
  constructor(limit = DEFAULT_SEEN_LIMIT, initial = []) {
    this.limit = Math.max(1, Number(limit) || DEFAULT_SEEN_LIMIT);
    this._keys = new Map();
    this.forgotten = 0;
    for (const key of initial) this.add(key);
  }

  has(key) {
    return this._keys.has(key);
  }

  /** @returns {boolean} whether the key was new */
  add(key) {
    if (this._keys.has(key)) return false;
    this._keys.set(key, 1);
    if (this._keys.size > this.limit) {
      const oldest = this._keys.keys().next().value;
      this._keys.delete(oldest);
      this.forgotten++;
    }
    return true;
  }

  get size() {
    return this._keys.size;
  }

  /** For persisting across runs. Newest last, so a restore keeps the order. */
  toArray() {
    return [...this._keys.keys()];
  }
}

/**
 * Split rows into the ones worth keeping and the ones already seen.
 *
 * Duplicates *within the batch* count too: a page that lists the same product
 * twice is a duplicate the moment it is read, not on the next page.
 *
 * @param {object[]} rows
 * @param {SeenKeys} seen
 * @param {string[]} fields
 * @returns {{kept: object[], dropped: number}}
 */
export function filterRows(rows, seen, fields = []) {
  const kept = [];
  let dropped = 0;
  for (const row of rows ?? []) {
    if (seen.add(rowKey(row, fields))) kept.push(row);
    else dropped++;
  }
  return { kept, dropped };
}

// === END row-dedupe.js ===
