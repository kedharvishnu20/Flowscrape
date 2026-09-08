// === extraction-grounding.js ===
/**
 * @module extraction-grounding
 * @description Checking that a model's answer is actually on the page.
 *
 *   The prompt says "never invent". That is an instruction, not a guarantee,
 *   and the failure it is meant to prevent is the worst kind this tool
 *   produces: a column full of plausible values that the page never contained.
 *   Nothing about the export says so, and the first person to notice is
 *   whoever acts on the data.
 *
 *   There is a real check available, and it costs a string comparison. The
 *   text sent to the model is in hand — `_buildSimplifiedDom()` produced it —
 *   so **a value not present in that text was invented**. No second request,
 *   no second opinion, no model grading its own homework.
 *
 *   What this deliberately does not do is judge whether the value is the
 *   *right* answer. A model that returns the author's name in the price column
 *   passes: the name is on the page. Grounding rules out fabrication, not
 *   confusion, and saying so matters — the confidence figure beside it is what
 *   speaks to the second question.
 *
 *   Four ways a true answer legitimately fails a naive containment test, each
 *   handled rather than papered over:
 *
 *   - **A number the page writes differently.** The page says "£1,299.00" and
 *     the model answers "1299". Both are the same number, so numbers are
 *     compared as numbers.
 *   - **A list the model joined.** The page has "contract" and "damages" in
 *     separate tags; the model returns "contract, damages". Each part is
 *     checked separately.
 *   - **A URL resolved against the page.** The page has `/p/9`, the model
 *     returns `https://shop.test/p/9`. The path is what is compared.
 *   - **A value too short to prove anything.** "5" appears in almost any page.
 *     Containment there is not evidence, so it is reported as unproven rather
 *     than as verified — a weaker claim, made honestly.
 *
 * @dependencies utils/value-transforms.js
 */

import { applyTransform } from "./value-transforms.js";

/**
 * Below this many characters, finding the value in the page proves nothing.
 *
 * "5", "GB" and "OK" occur in almost any document. Reporting those as
 * *verified* would be the same overclaim this module exists to prevent, so
 * they come back `unproven` and the caller keeps them without the badge.
 */
export const MIN_GROUNDABLE = 4;

/** How each verdict is reported, in the order they are tried. */
export const GROUND_EXACT = "exact";
export const GROUND_NUMBER = "number";
export const GROUND_PARTS = "parts";
export const GROUND_URL = "url";
export const GROUND_UNPROVEN = "unproven";
export const GROUND_MISSING = "missing";

/**
 * A string as it will be compared.
 *
 * Whitespace collapsed because markup is full of it, case folded because a
 * heading is often shouted, and the soft punctuation a CMS substitutes —
 * curly quotes, en dashes, non-breaking spaces — flattened to its plain
 * equivalent. Without that last one a page written in Word never matches a
 * model that answered in ASCII.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseForMatch(value) {
  return String(value ?? "")
    .replace(/[   ]/g, " ")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Is this value a number, and nothing else?
 *
 * Currency symbols, spaces, thousands separators and a trailing percent are
 * part of how a number is written; a word is not.
 */
function _isNumericOnly(raw) {
  const bare = String(raw)
    .replace(/[\p{Sc}\s%+]/gu, "")
    .replace(/[,.']/g, "");
  return bare.length > 0 && /^-?\d+$/.test(bare);
}

/** Every number the page states, for comparing a differently-written one. */
function _numbersIn(corpus) {
  const found = new Set();
  for (const match of corpus.matchAll(/-?[\d][\d.,\s]*\d|-?\d/g)) {
    const n = applyTransform(match[0], "number");
    if (n !== null && Number.isFinite(Number(n))) found.add(Number(n));
  }
  return found;
}

/**
 * A corpus prepared once, so a schema of twenty fields does not rescan it
 * twenty times.
 *
 * @param {string} text - exactly the text the model was given
 * @returns {{text: string, numbers: Set<number>}}
 */
export function prepareCorpus(text) {
  const normalised = normaliseForMatch(text);
  return { text: normalised, numbers: _numbersIn(String(text ?? "")) };
}

/**
 * Is this value on the page?
 *
 * @param {unknown} value
 * @param {{text: string, numbers: Set<number>}} corpus
 * @returns {{ok: boolean, how: string}} `ok` false only for GROUND_MISSING;
 *   GROUND_UNPROVEN is ok, because a short value is not evidence of invention
 *   any more than it is evidence of truth.
 */
export function groundValue(value, corpus) {
  if (value === null || value === undefined || value === "") {
    // Nothing claimed, nothing to verify. An empty field is the honest
    // outcome this whole arrangement is trying to preserve.
    return { ok: true, how: GROUND_EXACT };
  }

  const raw = String(value);
  const needle = normaliseForMatch(raw);
  if (!needle) return { ok: true, how: GROUND_EXACT };

  if (corpus.text.includes(needle)) {
    return {
      ok: true,
      how: needle.length < MIN_GROUNDABLE ? GROUND_UNPROVEN : GROUND_EXACT,
    };
  }

  // A URL the model resolved against the page: compare the path, which is the
  // part the page actually wrote. Checked before the numeric branch below,
  // because `https://shop.test/p/9` has a 9 in it and any page mentioning 9
  // would otherwise "verify" the whole URL.
  if (/^https?:\/\//i.test(raw)) {
    try {
      const path = normaliseForMatch(new URL(raw).pathname);
      if (path && path !== "/" && corpus.text.includes(path)) {
        return { ok: true, how: GROUND_URL };
      }
    } catch {
      /* not a URL after all — fall through */
    }
  }

  // A number the page writes with a currency symbol, a thousands separator or
  // a different decimal mark is the same number.
  //
  // Only when the value is a number and nothing else. `applyTransform` will
  // happily pull 2026 out of "Grace Hopper 2026", and a page mentioning that
  // year would then vouch for a name it never contained — a false positive in
  // the one direction this module must not have.
  if (_isNumericOnly(raw)) {
    const asNumber = applyTransform(raw, "number");
    if (asNumber !== null && corpus.numbers.has(Number(asNumber))) {
      return { ok: true, how: GROUND_NUMBER };
    }
  }

  // A list the model joined from separate elements. Every part has to be
  // present: one part matching would let "contract, invented" through on the
  // strength of the half that was real.
  const parts = raw
    .split(/\s*[,;|]\s*/)
    .map(normaliseForMatch)
    .filter((p) => p.length >= MIN_GROUNDABLE);
  if (parts.length > 1 && parts.every((p) => corpus.text.includes(p))) {
    return { ok: true, how: GROUND_PARTS };
  }

  if (needle.length < MIN_GROUNDABLE) {
    return { ok: true, how: GROUND_UNPROVEN };
  }

  return { ok: false, how: GROUND_MISSING };
}

/**
 * Check every field of a model's answer against the page.
 *
 * @param {Record<string, any>} result
 * @param {string[]} fields
 * @param {string} corpusText - exactly what the model was sent
 * @returns {{result: Record<string, any>, how: Record<string, string>,
 *            dropped: Array<{field: string, value: string}>}}
 */
export function groundFields(result, fields, corpusText) {
  const corpus = prepareCorpus(corpusText);
  const out = {};
  const how = {};
  const dropped = [];

  for (const field of fields) {
    const value = result?.[field];
    const verdict = groundValue(value, corpus);
    how[field] = verdict.how;
    if (verdict.ok) {
      out[field] = value ?? null;
      continue;
    }
    // Dropped, not kept with a warning: a value that is not on the page is
    // worth less than an empty cell, because an empty cell cannot be acted on
    // by mistake.
    out[field] = null;
    dropped.push({ field, value: String(value).slice(0, 120) });
  }

  return { result: out, how, dropped };
}

// === END extraction-grounding.js ===
