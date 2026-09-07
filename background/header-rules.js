// === header-rules.js ===
/**
 * @module header-rules
 * @description Rewriting the headers a run's requests carry, for the length of
 *   that run and no longer.
 *
 *   Why this exists: tryscrapeme.com answers `403 Invalid User Agent` to
 *   anything that looks automated, site-wide, and it is not unusual. A browser
 *   will not let a page change its own request headers — that is the point of
 *   the forbidden-header list — so the only honest way to send a different
 *   `User-Agent` or `Accept-Language` is `declarativeNetRequest`.
 *
 *   Two decisions carry the weight here, and both come from the proxy bug
 *   (A-05), where a run set something browser-wide and never gave it back:
 *
 *   1. **Session rules, scoped by `tabIds`.** A `tabIds` condition is only
 *      allowed on session rules, and it is exactly what stops one run's
 *      headers from being sent by every other tab you have open. Session rules
 *      also die with the browser, so the worst case of a crash is bounded.
 *   2. **Removed on every exit from the run**, and swept again at startup for
 *      anything a crash left behind. A rule that outlives its run is the same
 *      class of bug as a proxy that outlives its run.
 *
 *   The `WithHostAccess` variant of the permission is deliberate: it can only
 *   act on hosts the user has already granted, where plain
 *   `declarativeNetRequest` is a broader grant than this needs.
 *
 * @dependencies logger
 */

import { logger } from "../utils/logger.js";

const MODULE = "header-rules";

/**
 * Headers Chrome will not let a rule set, or that would break the request.
 *
 * Refused by name rather than silently dropped: a user who typed `Host` and
 * saw nothing happen would reasonably conclude the whole step is broken.
 */
const REFUSED = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "trailer",
  "te",
]);

/** runId → the rule ids it owns, so a run cleans up exactly its own. */
const _byRun = new Map();

/** Rule ids start here, well above anything a static ruleset would use. */
const ID_BASE = 90000;

/** Is the permission held? Asked here so callers need not import both. */
async function _available() {
  return !!chrome.declarativeNetRequest?.updateSessionRules;
}

async function _nextId() {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const max = existing.reduce((m, r) => Math.max(m, r.id), ID_BASE);
  return max + 1;
}

/**
 * Turn the text a user typed into header entries.
 *
 * One `Name: value` per line, the way a header actually looks on the wire and
 * the way every tool that prints one shows it — rather than JSON, which puts
 * quoting rules between the user and a User-Agent string that is full of
 * slashes, semicolons and brackets.
 *
 * @param {string|Array} text
 * @returns {Array<{name: string, value: string}>}
 */
export function parseHeaderText(text) {
  if (Array.isArray(text)) return text;
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    // A line with no colon is a header name on its own, which means "send this
    // one empty" nowhere and is far more likely to be a typo. Keep it, with an
    // empty value, so planHeaders decides — it treats empty as "remove", which
    // is at least a describable thing rather than a silent skip.
    if (colon < 0) {
      out.push({ name: trimmed, value: "" });
      continue;
    }
    out.push({
      name: trimmed.slice(0, colon).trim(),
      value: trimmed.slice(colon + 1).trim(),
    });
  }
  return out;
}

/**
 * Validate a header list, separating what can be sent from what cannot.
 *
 * Pure, and exported, because this is the part worth testing without a
 * browser: the refusals are the user-visible behaviour.
 *
 * @param {Array<{name: string, value: string}>} headers
 * @returns {{usable: Array<{header: string, operation: string, value?: string}>, refused: string[]}}
 */
export function planHeaders(headers) {
  const usable = [];
  const refused = [];
  const seen = new Set();
  for (const entry of headers || []) {
    // Header names are case-insensitive; the platform lowercases them anyway,
    // so two rows differing only in case are one header and the later wins.
    const name = String(entry?.name ?? "")
      .trim()
      .toLowerCase();
    if (!name) continue;
    if (
      REFUSED.has(name) ||
      name.startsWith("proxy-") ||
      name.startsWith("sec-")
    ) {
      refused.push(name);
      continue;
    }
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      refused.push(name);
      continue;
    }
    if (seen.has(name))
      usable.splice(
        usable.findIndex((h) => h.header === name),
        1,
      );
    seen.add(name);

    const value = String(entry?.value ?? "");
    // An empty value means remove the header, which is a real thing to want:
    // some sites treat the presence of Accept-Language as a signal at all.
    usable.push(
      value === ""
        ? { header: name, operation: "remove" }
        : { header: name, operation: "set", value },
    );
  }
  return { usable, refused };
}

/**
 * Send these headers on this tab's requests, until the run ends.
 *
 * Replaces whatever the run set before rather than stacking: two SET_HEADERS
 * steps in one pipeline mean the second one's list, not both merged, which is
 * what reading the pipeline top to bottom would lead you to expect.
 *
 * @param {string} runId
 * @param {number} tabId
 * @param {Array<{name: string, value: string}>} headers
 * @returns {Promise<{applied: number, refused: string[]}>}
 */
export async function applyHeaderRules(runId, tabId, headers) {
  if (!(await _available())) {
    throw new Error(
      "Request-header rewriting is not available without the Request headers permission.",
    );
  }
  const { usable, refused } = planHeaders(headers);
  await clearHeaderRules(runId);
  if (!usable.length) return { applied: 0, refused };

  const id = await _nextId();
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [
      {
        id,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: usable },
        // tabIds is the whole point: without it this run's headers would be
        // sent by every tab in the browser.
        condition: {
          tabIds: [tabId],
          // Every type, listed out: leaving resourceTypes off would default to
          // "everything except main_frame", so the page itself would be
          // fetched with the browser's own User-Agent and only its
          // sub-resources with yours — a mismatch a bot check reads as a lie.
          resourceTypes: [
            "main_frame",
            "sub_frame",
            "xmlhttprequest",
            "script",
            "stylesheet",
            "image",
            "font",
            "media",
            "websocket",
            "ping",
            "csp_report",
            "other",
          ],
        },
      },
    ],
  });
  _byRun.set(runId, [id]);
  logger.info(MODULE, "applied", { runId, tabId, headers: usable.length });
  return { applied: usable.length, refused };
}

/**
 * Take the run's rules back.
 *
 * Called on every exit from a run — completed, stopped, crashed — the same
 * discipline the proxy release follows.
 *
 * @param {string} runId
 */
export async function clearHeaderRules(runId) {
  const ids = _byRun.get(runId);
  _byRun.delete(runId);
  if (!ids?.length || !(await _available())) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ids,
    });
    logger.info(MODULE, "cleared", { runId, rules: ids.length });
  } catch (err) {
    logger.warn(MODULE, "clear-failed", { runId, error: err.message });
  }
}

/**
 * Sweep anything a crash left behind.
 *
 * Session rules survive a service-worker restart, so a run killed mid-flight
 * leaves its headers in force on a tab the user is now browsing by hand. The
 * id range is ours alone, which is what makes this safe to run at startup.
 */
export async function sweepHeaderRules() {
  if (!(await _available())) return 0;
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const mine = rules.filter((r) => r.id > ID_BASE).map((r) => r.id);
    if (!mine.length) return 0;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: mine,
    });
    logger.info(MODULE, "swept", { rules: mine.length });
    return mine.length;
  } catch (err) {
    logger.warn(MODULE, "sweep-failed", { error: err.message });
    return 0;
  }
}

// === END header-rules.js ===
