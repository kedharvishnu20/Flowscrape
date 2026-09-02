// === value-transforms.js ===
/**
 * @module value-transforms
 * @description Clean an extracted value at the point it is extracted.
 *
 *   EXTRACT returned exactly what was on the page. A price came back as
 *   `"$25.50"` — a string, with a currency symbol inside it. A link came back
 *   as `"/p/123"`, which is not a link anywhere except on that page. A review
 *   count came back as `"1,234 reviews"`. So every scrape ended in a
 *   spreadsheet doing find-and-replace, which is the part of the job people
 *   actually mind.
 *
 *   Pure, and separate from the content script on purpose: the script emitters
 *   apply the same transforms, so an exported script produces the same values
 *   as the extension rather than a plausible-looking approximation of them.
 *
 *   The rule throughout is the one the audit kept arriving at: **a transform
 *   that cannot do its job returns `null`, and never a wrong answer that looks
 *   right.** `"Out of stock"` as a number is not `0` — `0` is a price, and it
 *   would sit in the column indistinguishable from a real one.
 *
 * @dependencies none
 */

/**
 * Read a number out of the text wrapped around it.
 *
 * The hard part is the thousands separator. `"1.234,56"` is how most of Europe
 * writes 1234.56, and reading it as `1.234` is a hundredfold error in a price
 * column with nothing to signal it. So the separator is decided by which mark
 * appears last, which is what actually distinguishes the two conventions.
 *
 * @param {string} text
 * @returns {number|null}
 */
function toNumber(text) {
  const raw = String(text ?? "");
  // Grab the numeric run, including separators and a leading sign.
  const match = raw.match(/-?\d[\d.,  \s]*\d|-?\d/);
  if (!match) return null;

  let body = match[0].replace(/[\s  ]/g, "");
  const lastComma = body.lastIndexOf(",");
  const lastDot = body.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    // Both present: the later one is the decimal point.
    const decimal = lastComma > lastDot ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    body = body.split(thousands).join("").replace(decimal, ".");
  } else if (lastComma > -1) {
    // Only commas. Exactly one, with 1-2 digits after it, is a decimal comma
    // ("9,99"); anything else is thousands ("1,234", "1,234,567").
    const after = body.length - lastComma - 1;
    const single = body.indexOf(",") === lastComma;
    body =
      single && after > 0 && after <= 2
        ? body.replace(",", ".")
        : body.split(",").join("");
  } else if (lastDot > -1) {
    // Only dots. The mirror of the above: "1.234" is thousands, "25.50" is not.
    const after = body.length - lastDot - 1;
    const single = body.indexOf(".") === lastDot;
    if (!(single && after > 0 && after <= 2)) body = body.split(".").join("");
  }

  const n = Number(body);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve a relative link against the page it came from.
 *
 * Left alone when there is no base to resolve against, or when the value is
 * not a URL at all — a half-resolved link is worse than an untouched one,
 * because it looks usable.
 */
function toAbsoluteUrl(value, { base } = {}) {
  const text = String(value ?? "").trim();
  if (!text) return text;
  try {
    return new URL(text, base || undefined).href;
  } catch {
    return text;
  }
}

/**
 * Pull a substring out with a pattern.
 *
 * The first capture group if there is one, otherwise the whole match. No match
 * is `null` rather than the original string: returning the input unchanged
 * would make a pattern that never matched look like one that worked.
 */
function byRegex(value, { pattern, flags = "" } = {}) {
  if (!pattern) throw new Error("Transform 'regex' needs a pattern.");
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch (err) {
    throw new Error(`Transform 'regex' has an invalid pattern: ${err.message}`);
  }
  const m = String(value ?? "").match(re);
  if (!m) return null;
  return m[1] ?? m[0];
}

/** Collapse the whitespace real markup leaves inside a rendered string. */
const collapse = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Every transform the UI can offer, with the text it offers them under.
 *
 * Kept in one place so the panel cannot list a transform that does not exist,
 * and a test fails if one is added without a label or help text — the same
 * single-definition rule the step registry follows (G-01).
 *
 * @type {Record<string, {label: string, help: string, fn: Function, opts?: string[]}>}
 */
export const TRANSFORMS = Object.freeze({
  trim: {
    label: "Tidy whitespace",
    help: "Collapses the line breaks and indentation markup leaves inside text.",
    fn: (v) => collapse(v),
  },
  number: {
    label: "Number",
    help: 'Reads the number out of text like "$25.50" or "1,234 reviews". Text with no number in it becomes empty rather than zero.',
    fn: (v) => toNumber(v),
  },
  url: {
    label: "Full URL",
    help: 'Turns a relative link like "/p/123" into a complete address you can open.',
    fn: (v, o) => toAbsoluteUrl(v, o),
  },
  regex: {
    label: "Pattern",
    help: "Keeps the part matching your pattern — the first (bracketed group) if you use one. No match becomes empty.",
    fn: (v, o) => byRegex(v, o),
    opts: ["pattern"],
  },
  lower: {
    label: "lowercase",
    help: "Useful for values you will match or group on later.",
    fn: (v) => String(v ?? "").toLowerCase(),
  },
  upper: {
    label: "UPPERCASE",
    help: "Useful for codes and country abbreviations.",
    fn: (v) => String(v ?? "").toUpperCase(),
  },
});

/**
 * Is this something RegExp will accept?
 *
 * Used by the panel to reject a pattern as it is typed, and by both script
 * emitters to refuse a field rather than repair it — a repaired pattern gives
 * a script that runs and extracts something other than what the pipeline
 * extracts, which is worse than one that stops and says why.
 *
 * @param {string} pattern
 * @returns {boolean}
 */
export function isValidRegex(pattern) {
  try {
    new RegExp(String(pattern ?? ""));
    return true;
  } catch {
    return false;
  }
}

/** The names the UI offers, in the order it offers them. */
export const TRANSFORM_NAMES = Object.freeze(Object.keys(TRANSFORMS));

/**
 * Apply one transform.
 *
 * @param {*} value
 * @param {string} name  - a key of TRANSFORMS, or "none"
 * @param {object} [opts] - `base` for url, `pattern` for regex
 * @returns {*}
 * @throws when `name` is not a transform — a misspelled name silently ignored
 *   is a pipeline that quietly does not do what its configuration says.
 */
export function applyTransform(value, name, opts = {}) {
  if (!name || name === "none") return value;
  const meta = TRANSFORMS[name];
  if (!meta) {
    throw new Error(
      `Unknown value transform "${name}". Supported: ${TRANSFORM_NAMES.join(", ")}.`,
    );
  }
  return meta.fn(value, opts);
}

/**
 * Apply transforms in order, stopping at the first that yields null.
 *
 * Carrying a null onward would let the *next* transform's behaviour on null
 * decide the output — `number` on null becoming 0 being the case that matters,
 * since 0 is a plausible price.
 *
 * @param {*} value
 * @param {string[]} [names]
 * @param {object} [opts]
 * @returns {*}
 */
export function applyTransforms(value, names, opts = {}) {
  if (!Array.isArray(names) || names.length === 0) return value;
  let out = value;
  for (const name of names) {
    out = applyTransform(out, name, opts);
    if (out === null) return null;
  }
  return out;
}

// === END value-transforms.js ===
