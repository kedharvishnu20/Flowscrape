// === loop-items.js ===
/**
 * @module loop-items
 * @description Turning a list into the things a LOOP walks.
 *
 *   Every other LOOP mode gets its bound from the page: the elements it
 *   matched, the page links it found, the count you typed. None of them can
 *   express "visit these 500 product URLs" — the list is the input, not
 *   something on screen.
 *
 *   Two sources, because they are the two that need no new permission and no
 *   new storage:
 *
 *   - **Lines you paste.** One item per line. With a delimiter and a header
 *     row it is a pasted CSV, which is what a spreadsheet column becomes when
 *     you copy it.
 *   - **Something the run already has.** A dotted path into the run context —
 *     `api.rows` after an API step, `pageData.records` after PAGE_DATA. No
 *     copying, and it follows whatever the site returned today.
 *
 *   Shared rather than written twice: the panel previews the items, the worker
 *   walks them, and both emitters bake them into the exported script. Three
 *   readings of one list that disagreed about where a quoted comma ends would
 *   be a scrape of the wrong URLs, and nothing about the result would say so.
 *
 * @dependencies none
 */

/** Where one pasted list stops. Past this, the paste is a file. */
export const MAX_LIST_ITEMS = 10000;

/**
 * Split one delimited line, respecting quotes.
 *
 * Written out rather than `line.split(delimiter)` because a spreadsheet column
 * holding `Smith, John` is one field, and splitting it into two shifts every
 * column after it — silently, into a scrape that looks like it worked.
 *
 * A doubled quote inside a quoted field is one quote, which is the rule every
 * CSV writer uses, this project's own included.
 *
 * @param {string} line
 * @param {string} delimiter - one character; anything else is treated as ","
 * @returns {string[]}
 */
export function splitDelimited(line, delimiter = ",") {
  const sep = String(delimiter || ",").charAt(0) || ",";
  const out = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      // Only at the start of a field: a quote in the middle of `12" pipe` is
      // part of the value, not the opening of a quoted field.
      quoted = true;
    } else if (ch === sep) {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * One item, in the shape a template expects.
 *
 * A plain string is published under both `value` and `text`: `{{item.value}}`
 * is what a list of URLs reads like, and `{{item.text}}` is what the other
 * LOOP modes already use, so a body written for one works in the other.
 *
 * @param {unknown} value
 * @param {number} index0
 * @returns {object}
 */
export function normalizeItem(value, index0) {
  const base = { index: index0 + 1, index0 };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    // A row's own fields win over the positional ones only if it has them;
    // `index` from an API row is more likely to be what the user means than
    // our counter.
    return {
      ...base,
      ...value,
      value: value.value ?? "",
      text: value.text ?? "",
    };
  }
  const text = value === null || value === undefined ? "" : String(value);
  return { ...base, value: text, text };
}

/**
 * Read a pasted list.
 *
 * @param {string} text
 * @param {{delimiter?: string, hasHeader?: boolean}} [opts]
 * @returns {{items: object[], columns: string[], truncated: number}}
 */
export function parseListLines(text, opts = {}) {
  const { delimiter = "", hasHeader = false } = opts;
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");

  if (lines.length === 0) return { items: [], columns: [], truncated: 0 };

  // No delimiter: the whole line is the value. This is the common case — a
  // column of URLs copied out of a spreadsheet — and splitting it on a comma
  // that happens to be in a query string would break it.
  if (!delimiter) {
    const kept = lines.slice(0, MAX_LIST_ITEMS);
    return {
      items: kept.map((l, i) => normalizeItem(l, i)),
      columns: ["value"],
      truncated: lines.length - kept.length,
    };
  }

  let columns = [];
  let body = lines;
  if (hasHeader) {
    columns = splitDelimited(lines[0], delimiter).map(
      (c, i) => c || `col${i + 1}`,
    );
    body = lines.slice(1);
  } else {
    const width = splitDelimited(lines[0], delimiter).length;
    columns = Array.from({ length: width }, (_, i) => `col${i + 1}`);
  }

  const kept = body.slice(0, MAX_LIST_ITEMS);
  const items = kept.map((line, i) => {
    const cells = splitDelimited(line, delimiter);
    const row = {};
    columns.forEach((name, c) => {
      row[name] = cells[c] ?? "";
    });
    // `value` is the first column, so a body written against a plain list
    // keeps working when a header row is added to the same paste.
    return normalizeItem({ ...row, value: cells[0] ?? "", text: line }, i);
  });

  return { items, columns, truncated: body.length - kept.length };
}

/**
 * Follow a dotted path into the run context and return what it holds as items.
 *
 * @param {object} ctx
 * @param {string} path - "api.rows", "pageData.records", "extracted"
 * @returns {{items: object[], reason: string}} `reason` is empty on success
 */
export function itemsFromContext(ctx, path) {
  const parts = String(path ?? "")
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { items: [], reason: "no path was given" };
  }

  let value = ctx;
  for (const part of parts) {
    if (value === null || typeof value !== "object") {
      return { items: [], reason: `"${path}" is not something this run has` };
    }
    value = value[part];
  }

  if (value === undefined) {
    return {
      items: [],
      reason: `"${path}" is not something this run has — check the step that stores it ran first`,
    };
  }
  if (!Array.isArray(value)) {
    // A single object is one item rather than an error: "loop over the API's
    // response" is a reasonable thing to mean, and refusing it would be
    // pedantry.
    if (value && typeof value === "object") {
      return { items: [normalizeItem(value, 0)], reason: "" };
    }
    return {
      items: [],
      reason: `"${path}" holds a ${typeof value}, not a list`,
    };
  }

  return {
    items: value.slice(0, MAX_LIST_ITEMS).map((v, i) => normalizeItem(v, i)),
    reason: "",
  };
}

// === END loop-items.js ===
