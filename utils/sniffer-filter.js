// === sniffer-filter.js ===
/**
 * @module sniffer-filter
 * @description Decide which requests the API sniffer keeps.
 *
 *   It kept every request the page made. On a real site that is analytics
 *   beacons, font files, session pings, ad auctions and image lazy-loads — and
 *   the four calls you actually wanted are somewhere inside them. The capture
 *   buffer is bounded (D-10), so on a busy page the noise could push out the
 *   signal before the run finished.
 *
 *   Pure and separate so the panel can validate a filter as it is typed rather
 *   than after a run, and so the rules are tested rather than inferred from
 *   what a page happened to request.
 *
 * @dependencies none
 */

/**
 * A filter written as `re:…` is a regular expression; anything else is a list
 * of substrings separated by commas.
 *
 * The obvious spelling for "a regex" would be `/…/`, and it is wrong here:
 * `/api/` is the single most likely substring anyone will type, and it is also
 * valid regex syntax. Slashes would have silently reinterpreted the common
 * case as a case-sensitive pattern — which a test caught by asking for
 * `/api/` against a mixed-case URL. So substrings keep the plain spelling and
 * the regex says so explicitly.
 */
const REGEX_FORM = /^re:(.*)$/s;

/**
 * @param {string} filter
 * @returns {?RegExp} null when the filter is not in regex form
 * @throws when it is, but does not compile
 */
function asRegex(filter) {
  const m = String(filter).trim().match(REGEX_FORM);
  if (!m) return null;
  try {
    return new RegExp(m[1]);
  } catch (err) {
    // Returning "matches nothing" would look like a page that makes no
    // requests at all, which is the hardest kind of empty result to explain.
    throw new Error(
      `Sniffer URL filter is not a valid pattern: ${err.message}`,
    );
  }
}

/**
 * Should this request be recorded?
 *
 * @param {{url: string, method: string}} request
 * @param {{urlFilter?: string, methods?: string}} [config]
 * @returns {boolean}
 */
export function matchesSnifferFilter(request, config = {}) {
  const url = String(request?.url ?? "");
  const method = String(request?.method ?? "").toUpperCase();

  const methods = String(config.methods ?? "")
    .split(/[,\s]+/)
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
  if (methods.length > 0 && !methods.includes(method)) return false;

  const filter = String(config.urlFilter ?? "").trim();
  if (!filter) return true;

  const re = asRegex(filter);
  if (re) return re.test(url);

  // Case-insensitive: hosts are case-insensitive, paths conventionally
  // lowercase, and nobody types a filter thinking about which is which.
  const haystack = url.toLowerCase();
  return filter
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .some((part) => haystack.includes(part));
}

/**
 * Is this filter usable? For validating as the user types.
 * @returns {string} "" when fine, otherwise why not
 */
export function snifferFilterError(filter) {
  try {
    asRegex(String(filter ?? ""));
    return "";
  } catch (err) {
    return err.message;
  }
}

// === END sniffer-filter.js ===
