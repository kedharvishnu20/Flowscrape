// === extraction-provenance.js ===
/**
 * @module extraction-provenance
 * @description Which layer answered each field, and how much that is worth.
 *
 *   A row used to carry one `_extractionMethod` for all of it. On a real page
 *   that is a plain untruth: `name` comes from the site's JSON-LD, `price`
 *   from a heuristic reading of the markup, `brand` from a model — and the row
 *   says `json-ld`, because layer 1 answered first and the label was taken
 *   from the layer rather than from the field.
 *
 *   It matters here more than it would elsewhere, because the three layers are
 *   not equally trustworthy and the difference is not a matter of degree:
 *
 *   - **The page's own structured data** is the publisher asserting something
 *     about its own page. Wrong sometimes, but wrong on the record.
 *   - **A heuristic** is this extension deciding which `<span>` looked like a
 *     price. It is a guess, and calling it anything else is the failure the
 *     whole layer stack was built to avoid.
 *   - **A model** is a model, and — since `extraction-grounding.js` — either
 *     checked against the page text or not.
 *
 *   Averaging those into one number and one word throws away the only thing
 *   that tells a user which cells to look at. This keeps them apart.
 *
 *   **Why this is not a column by default.** Provenance is per field; a CSV
 *   cell is not. Adding a JSON blob to every row would change the shape of
 *   every existing export for a detail most runs never look at, so it goes to
 *   the panel, where a person is already watching, and into the export only
 *   when the step is asked for it.
 *
 * @dependencies utils/extraction-grounding.js
 */

import {
  GROUND_EXACT,
  GROUND_NUMBER,
  GROUND_PARTS,
  GROUND_URL,
  GROUND_UNPROVEN,
} from "./extraction-grounding.js";

/** How much the source is worth, which is the distinction that matters. */
export const SOURCE_FREE = "free"; // the page said so, at no cost
export const SOURCE_MODEL = "model"; // something inferred it
export const SOURCE_NONE = "none"; // nothing answered

/** A grounding verdict that means the value was located in the page text. */
const PROVEN = new Set([GROUND_EXACT, GROUND_NUMBER, GROUND_PARTS, GROUND_URL]);

/**
 * Read one `from` marker.
 *
 * The markers are written by whoever answered: `json-ld:<key>` and
 * `meta:<key>` from `_applySchema`, plain `json-ld` / `microdata` / `og-meta`
 * / `heuristic` from the page's own layer merge, `llm` from the model merge.
 * The key half is kept because `json-ld` names the layer while `datePublished`
 * names the thing a person can go and check.
 *
 * @param {string|undefined} from
 * @returns {{kind: string, detail: string|null, label: string, trust: string}}
 */
export function describeSource(from) {
  const raw = String(from ?? "none");
  // Only the first colon: `meta:og:title` is one key, not two.
  const cut = raw.indexOf(":");
  const kind = cut === -1 ? raw : raw.slice(0, cut);
  const detail = cut === -1 ? null : raw.slice(cut + 1) || null;

  switch (kind) {
    case "json-ld":
      return {
        kind,
        detail,
        label: detail
          ? `the page's own JSON-LD (${detail})`
          : "the page's own JSON-LD",
        trust: SOURCE_FREE,
      };
    case "microdata":
      return {
        kind,
        detail,
        label: "the page's own microdata",
        trust: SOURCE_FREE,
      };
    case "meta":
    case "og-meta":
      return {
        kind: "meta",
        detail,
        label: detail ? `a meta tag (${detail})` : "a meta tag",
        trust: SOURCE_FREE,
      };
    case "heuristic":
      return {
        kind,
        detail,
        // Named for what it is. This layer picked the element that looked
        // most like the field; that is a guess from the page's markup, and a
        // user deciding what to spot-check needs to know which cells are one.
        label: "a guess from the page's markup",
        trust: SOURCE_FREE,
      };
    case "llm":
      return { kind, detail, label: "a model", trust: SOURCE_MODEL };
    default:
      // Includes an unrecorded source. Reporting that as free would put the
      // page's authority behind something that never came from the page.
      return {
        kind: "none",
        detail,
        label: "nothing answered",
        trust: SOURCE_NONE,
      };
  }
}

/**
 * The per-field record for one extracted row.
 *
 * @param {object} input
 * @param {string[]} input.fields - in the order asked for
 * @param {Record<string, any>} input.result
 * @param {Record<string, number>} [input.perField]
 * @param {Record<string, string>} [input.from]
 * @param {Record<string, string>} [input.grounding] - absent when the check
 *   was turned off, which is why `verified` is never assumed
 * @returns {Array<{field, value, kind, detail, label, trust, confidence,
 *                  verified, note}>}
 */
export function buildProvenance({
  fields = [],
  result = {},
  perField = {},
  from = {},
  grounding = {},
} = {}) {
  return fields.map((field) => {
    const described = describeSource(from[field]);
    const verdict = grounding[field];
    const value = result[field] ?? null;

    let verified = false;
    let note = "";
    if (described.trust === SOURCE_MODEL && verdict) {
      if (PROVEN.has(verdict)) {
        verified = true;
        note = `found in the page text (${verdict})`;
      } else if (verdict === GROUND_UNPROVEN) {
        // A weaker claim, made on purpose: "5" occurs in almost any page, so
        // finding it there is not evidence either way. Saying nothing would
        // read as "we checked and it failed".
        note = "too short to prove either way — kept, not proven";
      }
    }

    return {
      field,
      value,
      kind: described.kind,
      detail: described.detail,
      label: described.label,
      trust: described.trust,
      confidence: Number(perField[field] ?? 0),
      verified,
      note,
    };
  });
}

/**
 * One line answering the question a user actually has: how much of this did
 * the page tell us, and how much did something guess?
 *
 * @param {ReturnType<typeof buildProvenance>} rows
 * @returns {string}
 */
export function summarise(rows = []) {
  const free = rows.filter((r) => r.trust === SOURCE_FREE).length;
  const model = rows.filter((r) => r.trust === SOURCE_MODEL).length;
  const empty = rows.filter((r) => r.trust === SOURCE_NONE).length;
  const verified = rows.filter((r) => r.verified).length;

  const parts = [];
  if (free) parts.push(`${free} from the page`);
  if (model) {
    // Only when the check ran. Saying "0 verified" when grounding was off
    // would read as a failed check rather than an absent one.
    parts.push(
      verified
        ? `${model} from a model (${verified} verified)`
        : `${model} from a model`,
    );
  }
  if (empty) parts.push(`${empty} empty`);
  return parts.length ? parts.join(", ") + "." : "nothing extracted.";
}

/**
 * The record as a single cell, for the export column the step can be asked
 * for.
 *
 * Deliberately flat and newline-free: a newline inside a CSV cell is a support
 * ticket, and a nested object in a spreadsheet is `[object Object]`.
 *
 * @param {ReturnType<typeof buildProvenance>} rows
 * @returns {string}
 */
export function provenanceColumn(rows = []) {
  return rows
    .map((r) => {
      const src = r.detail ? `${r.kind}(${r.detail})` : r.kind;
      const conf = r.trust === "none" ? "" : `:${r.confidence}`;
      return `${r.field}=${src}${conf}${r.verified ? " verified" : ""}`;
    })
    .join("; ")
    .replace(/\s*\n\s*/g, " ");
}

// === END extraction-provenance.js ===
