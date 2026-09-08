// === selector-learning.js ===
/**
 * @module selector-learning
 * @description Making the AI pay for itself once instead of on every page.
 *
 *   Every hosted AI scraper charges per page, forever, because the model is in
 *   the loop on every page. It does not have to be. Ask the model for a **CSS
 *   selector** alongside each value it reports, check the selector in the page,
 *   and keep it only if it produces the value the model reported. From then on
 *   the site is scraped deterministically, for free, with no model involved.
 *
 *   **Why this is not a second guess stacked on the first.** A model asked for
 *   a selector will always produce one, and most of them are wrong. But a
 *   wrong selector is *detectable* in a way a wrong value is not: run it, and
 *   it finds nothing, or finds something else. A selector that survives has
 *   been tested against the page it came from; one that does not is dropped
 *   without a word, which is no worse than never having asked.
 *
 *   Four ways a selector fails, kept apart because they mean different things
 *   to whoever is looking at the log:
 *
 *   - **It points at the wrong thing.** The failure this exists to catch.
 *     Saved unchecked, it produces a pipeline that runs, reports success, and
 *     fills a column with the site's navigation.
 *   - **It finds nothing.** Usually a class the model half-remembered from
 *     some other site.
 *   - **It is not valid CSS.** Occasionally a model answers with a sentence.
 *   - **It matches everything.** AUTO_EXTRACT reads one page as one row, so a
 *     selector matching every card on a listing is the wrong answer even when
 *     its first match holds the right text.
 *
 *   **And one that is kept with a warning.** A selector made only of positions
 *   — `body > div:nth-child(7) > div:nth-child(3) > span` — verifies today and
 *   breaks when the site adds a banner. Dropping it throws away something that
 *   works; saying nothing hands it over as though it were solid. So it is kept
 *   and named.
 *
 *   The payoff is this project's existing story applied to AI. `AUTO_EXTRACT`
 *   cannot be exported to a Playwright script: two of its layers are an in-page
 *   extractor with no standalone equivalent, and the third needs a model the
 *   script has no configuration for. `EXTRACT` can. So the step stays
 *   unexportable and its *output* is a step that is not.
 *
 * @dependencies utils/extraction-grounding.js
 */

import { normaliseForMatch } from "./extraction-grounding.js";

/** Why a selector was kept or dropped. */
export const VERIFIED = "verified";
export const WRONG_VALUE = "wrong-value";
export const NOT_FOUND = "not-found";
export const AMBIGUOUS = "ambiguous";
export const BAD_SELECTOR = "bad-selector";

/** Past this a "selector" is prose, and no page needs one this long. */
export const MAX_SELECTOR_LEN = 300;

/**
 * A selector that works today and will not survive a redesign.
 *
 * The test is whether it names anything about the element — a class, an id, an
 * attribute, a role — or only where the element happens to sit. Position-only
 * chains break on the first banner, wrapper div or A/B test, and the person
 * who saved it will find out weeks later when a column is silently empty.
 *
 * @param {string} selector
 * @returns {boolean}
 */
export function isFragile(selector) {
  const sel = String(selector ?? "");
  if (!sel) return true;
  // Anything identifying: a class, an id, an attribute, or a semantic
  // pseudo-class. `nth-child` and `first-child` are positions, not identity.
  const identifies = /[.#[]|:not\(|\bdata-/.test(sel);
  if (identifies) return false;
  // A bare `h1` is fine. A chain of four bare tags, or anything counting
  // children, is a position.
  if (/:nth-|:first-child|:last-child/.test(sel)) return true;
  return sel.split(/\s*[>+~\s]\s*/).filter(Boolean).length >= 4;
}

/**
 * Decide which of the model's selectors are worth keeping.
 *
 * The DOM read is passed in rather than done here: `content/injector.js` is a
 * classic content script and cannot import a module, so the page runs the
 * selectors and this decides what the results mean. Same split as `IF_ELSE`
 * and `ASSERT` — the page observes, the worker judges.
 *
 * @param {object} input
 * @param {Record<string, string>} input.selectors - what the model answered
 * @param {Record<string, any>} input.values - the values it reported, after
 *   grounding: a field dropped there has nothing to check a selector against
 * @param {(selector: string, field: string) => {count?: number, text?: string|null, error?: string}} input.probe
 *   given the field name too, so a caller holding results keyed by field does
 *   not have to search its own map by selector — two fields can propose the
 *   same selector
 * @returns {{verified: Record<string, string>, how: Record<string, string>,
 *            fragile: string[]}}
 */
export function judgeSelectors({ selectors = {}, values = {}, probe }) {
  const verified = {};
  const how = {};
  const fragile = [];

  for (const [field, rawSelector] of Object.entries(selectors)) {
    const selector = String(rawSelector ?? "").trim();
    const expected = values[field];

    // Nothing to check against. Includes every field grounding dropped: a
    // selector "verified" against an invented value has been checked against
    // nothing at all, so it is not judged and not reported.
    if (
      !selector ||
      expected === null ||
      expected === undefined ||
      expected === ""
    ) {
      continue;
    }
    if (selector.length > MAX_SELECTOR_LEN) {
      how[field] = BAD_SELECTOR;
      continue;
    }

    let found;
    try {
      found = probe(selector, field);
    } catch (err) {
      found = { error: err?.message ?? "probe failed" };
    }

    if (found?.error) {
      how[field] = BAD_SELECTOR;
      continue;
    }
    if (!found?.count) {
      how[field] = NOT_FOUND;
      continue;
    }
    if (found.count > 1) {
      how[field] = AMBIGUOUS;
      continue;
    }
    if (normaliseForMatch(found.text) !== normaliseForMatch(expected)) {
      how[field] = WRONG_VALUE;
      continue;
    }

    how[field] = VERIFIED;
    verified[field] = selector;
    if (isFragile(selector)) fragile.push(field);
  }

  return { verified, how, fragile };
}

/**
 * Verified selectors as a step the pipeline can run without a model.
 *
 * Built in `EXTRACT`'s own field shape rather than one invented here, so what
 * comes out is an ordinary step: editable in the panel, runnable on its own,
 * and exportable to a Playwright or Python script like any other.
 *
 * @param {Record<string, string>} verified
 * @returns {{type: string, config: {fields: object[], inFrame: boolean}}|null}
 *   null when nothing verified — an empty step is worse than no offer.
 */
export function toExtractStep(verified = {}) {
  const fields = Object.entries(verified).map(([name, selector]) => ({
    name,
    selector,
    type: "text",
  }));
  if (fields.length === 0) return null;
  return { type: "EXTRACT", config: { fields, inFrame: false } };
}

// === END selector-learning.js ===
