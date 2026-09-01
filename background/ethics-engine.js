// === ethics-engine.js ===
/**
 * @module ethics-engine
 * @description Pre-run ethics gate orchestrator. Runs 7 gates before first
 *   pipeline step executes. Gate 7 is the new overlay readiness check — it
 *   runs previewAll() and shows the user the overlay state before they confirm.
 *
 *   Design decision: All hard blocks also trigger overlay-engine's 'blocked' mode
 *   on the offending element BEFORE throwing, so the user sees a visual gray
 *   crosshatch on the exact element that caused the block. This connects the
 *   ethics system directly to the visual philosophy.
 *
 * @dependencies robots-parser, pii-detector, overlay-engine (via content message), logger
 */

"use strict";

import { logger } from "../utils/logger.js";
import { parseRobots, isAllowedByRules } from "../ethics/robots-parser.js";
import { scanText } from "../ethics/pii-detector.js";

const MODULE = "ethics-engine";

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_FORM_ROWS_DEFAULT = 500;
const MAX_FORM_ROWS_CONFIRMED = 5000;
const MIN_INTER_ROW_DELAY_MS = 800;
const MAX_REQUESTS_BEFORE_WARN = 100;
const ROBOTS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ── Block/warn error classes ──────────────────────────────────────────────────
export class EthicsBlock extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "EthicsBlock";
  }
}
export class EthicsWarn {
  constructor(code, message) {
    this.code = code;
    this.message = message;
  }
}

// ── robots.txt cache ──────────────────────────────────────────────────────────
const _robotsCache = new Map(); // domain → { parsed, fetchedAt }

async function _fetchRobots(origin) {
  const cached = _robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_CACHE_TTL_MS) {
    return cached.parsed;
  }
  try {
    const resp = await fetch(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(5000),
    });
    const text = resp.ok ? await resp.text() : "";
    const parsed = parseRobots(text, origin);
    _robotsCache.set(origin, { parsed, fetchedAt: Date.now() });
    return parsed;
  } catch {
    logger.warn(MODULE, "robots-fetch-fail", { origin });
    return null; // unreachable → allow with warning
  }
}

// ── Gate implementations ──────────────────────────────────────────────────────

async function _gate1_robots(targetOrigin, targetPath, bypass) {
  if (bypass) return null;
  const robots = await _fetchRobots(targetOrigin);
  if (!robots) {
    return new EthicsWarn(
      "RobotsTxt",
      `Could not fetch robots.txt from ${targetOrigin} — proceeding with caution`,
    );
  }
  const disallowed = !isAllowedByRules(robots, targetPath, "FlowScrape");
  if (disallowed) {
    return new EthicsWarn(
      "RobotsTxt",
      `robots.txt Disallows access to ${targetPath} — confirm to override`,
    );
  }
  return null;
}

async function _gate2_pii(pipelineSteps) {
  // Only scan FORM_FILL data sources
  const formSteps = _flattenSteps(pipelineSteps).filter((s) => s.type === "FORM_FILL");
  if (!formSteps.length) return null;

  // We can't read the actual file here in SW; PII check deferred to content script
  // The content script calls pii-detector when file is uploaded
  // Return null (gate deferred to content side)
  return null;
}

/**
 * Steps that actually put a request on the network. A CLICK or an EXTRACT does
 * not; counting them made the estimate meaningless.
 */
const NETWORK_STEP_TYPES = new Set(["WEBSITE", "NAVIGATE", "API", "PDF_EXTRACTION"]);

/**
 * Count network requests a pipeline will make, multiplying nested steps by
 * their enclosing loop counts.
 *
 * @param {object[]} steps
 * @param {number} [multiplier=1]
 * @returns {number}
 */
function _countRequests(steps, multiplier = 1) {
  let total = 0;
  for (const step of Array.isArray(steps) ? steps : []) {
    if (NETWORK_STEP_TYPES.has(step.type)) total += multiplier;

    if (step.type === "LOOP") {
      // A loop over elements has no known count until it runs; `max` is the
      // ceiling the user set, which is the honest figure to warn against.
      const max = Number(step.config?.max);
      const iterations = Number.isFinite(max) && max > 0 ? max : 10;
      total += _countRequests(step.children, multiplier * iterations);
      continue;
    }

    // Only one branch runs, so charge the more expensive of the two rather
    // than both.
    if (step.type === "IF_ELSE") {
      total += Math.max(
        _countRequests(step.ifBranch, multiplier),
        _countRequests(step.elseBranch, multiplier),
      );
      continue;
    }

    total += _countRequests(step.children, multiplier);
  }
  return total;
}

/**
 * Gate 3: warn when the pipeline would hit a site hard.
 *
 * This used to count *every* step — clicks, extracts, waits — against a
 * hardcoded 1200ms interval, so a two-step pipeline estimated 6000 req/hr and
 * essentially every run produced a warning. A gate that always fires teaches
 * people to dismiss it, which costs the gates that matter.
 *
 * @param {object[]} pipelineSteps
 * @param {object} timingConfig
 * @returns {EthicsWarn|null}
 */
function _gate3_rateLimit(pipelineSteps, timingConfig) {
  const requests = _countRequests(pipelineSteps);
  if (requests <= MAX_REQUESTS_BEFORE_WARN) return null;

  // Pace is a property of the delay between requests, not of how many there
  // are: N requests at one every 1200ms is 3000/hr whether N is 2 or 2000. The
  // old formula multiplied the two, so a two-step pipeline "estimated"
  // 6000 req/hr and every single run produced a warning.
  const minDelay = Number(timingConfig?.min) || 1200;
  const perHour = Math.round(3600000 / minDelay);
  const minutes = Math.max(1, Math.round((requests * minDelay) / 60000));

  return new EthicsWarn(
    "HighRate",
    `This pipeline makes about ${requests} requests, roughly ${perHour}/hr sustained ` +
      `for ${minutes} minute${minutes === 1 ? "" : "s"}. Add WAIT steps if that is faster than the site expects.`,
  );
}

function _gate4_captcha(pipelineSteps, captchaConfig) {
  if (!captchaConfig?.enabled) return null;
  const formSteps = _flattenSteps(pipelineSteps).filter((s) => s.type === "FORM_FILL");
  const minDelay = formSteps[0]?.config?.interRowDelay?.min ?? 1200;
  const solveRatePerHr = Math.round(3600000 / minDelay);
  if (solveRatePerHr > 50) {
    return new EthicsWarn(
      "HighCaptchaVolume",
      `Estimated captcha solves: ~${solveRatePerHr}/hr (> 50 threshold)`,
    );
  }
  return null;
}

function _gate5_proxyGeo(proxyEntry, declaredRegion) {
  // Simplified region comparison — actual Haversine would require geo data
  if (!proxyEntry?.country || !declaredRegion) return null;
  if (proxyEntry.country.toUpperCase() !== declaredRegion.toUpperCase()) {
    return new EthicsWarn(
      "ProxyGeoMismatch",
      `Proxy country (${proxyEntry.country}) ≠ declared region (${declaredRegion})`,
    );
  }
  return null;
}

/**
 * Walk every step, including LOOP children and IF/ELSE branches.
 * @param {object[]} steps
 * @returns {object[]}
 */
function _flattenSteps(steps, out = []) {
  for (const step of Array.isArray(steps) ? steps : []) {
    out.push(step);
    _flattenSteps(step.children, out);
    _flattenSteps(step.ifBranch, out);
    _flattenSteps(step.elseBranch, out);
  }
  return out;
}

/** Config keys that carry a navigable URL, by step type. */
const URL_STEP_TYPES = Object.freeze({
  WEBSITE: "url",
  NAVIGATE: "url",
  API: "url",
  API_FETCH: "url",
});

/**
 * Origins this pipeline declares statically — i.e. that its author typed.
 *
 * A URL containing a template is deliberately excluded: its origin is not known
 * until the step runs, and if it came from the page (a `{{item.href}}` read out
 * of the DOM by QUERY_ELEMENTS) then the page, not the author, chooses it. Those
 * are checked at execution time instead, against exactly this set.
 *
 * @param {object[]} steps
 * @param {string} targetOrigin
 * @returns {Set<string>}
 */
export function collectDeclaredOrigins(steps, targetOrigin) {
  const origins = new Set();
  if (targetOrigin) origins.add(targetOrigin);

  for (const step of _flattenSteps(steps)) {
    const key = URL_STEP_TYPES[step.type];
    if (!key) continue;

    const raw = step.config?.[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (raw.includes("{{")) continue; // resolved at runtime; see above

    try {
      origins.add(new URL(raw, targetOrigin || undefined).origin);
    } catch {
      // Not a URL yet (a bare path with no target origin); nothing to declare.
    }
  }

  return origins;
}

/**
 * Gate 6: report the origins this pipeline will visit.
 *
 * This used to be a hard block on any step whose origin differed from the
 * tab's, and it got the risk backwards in three ways:
 *
 *   - It blocked the safe case. A cross-origin URL the author typed into a
 *     NAVIGATE or API step is visible in the step config and was chosen
 *     deliberately, yet it made multi-domain pipelines impossible and rejected
 *     every third-party API call — including the API step's own default URL.
 *   - It only walked top-level steps, so moving the same step inside a LOOP or
 *     an IF/ELSE branch bypassed it entirely.
 *   - It permitted the dangerous case. A templated URL like `{{item.href}}` is
 *     not a valid URL at gate time, so `new URL` threw and the step was waved
 *     through — and that value comes from the page's own DOM, which means the
 *     page chose where the pipeline navigates.
 *
 * Authored origins are now surfaced for the user to confirm, and the origins
 * that are not authored are enforced where they become known: at execution.
 *
 * @param {object[]} steps
 * @param {string} targetOrigin
 * @returns {EthicsWarn|null}
 */
function _gate6_crossOrigin(steps, targetOrigin) {
  const internalPrefixes = ["chrome", "about", "edge", "chrome-extension", "moz-extension"];
  const isInternalOrigin =
    !targetOrigin ||
    targetOrigin === "null" ||
    internalPrefixes.some((p) => targetOrigin.startsWith(p));

  const declared = collectDeclaredOrigins(steps, targetOrigin);
  const others = [...declared].filter((o) => o !== targetOrigin);
  if (others.length === 0) return null;

  return new EthicsWarn(
    "CrossOrigin",
    isInternalOrigin
      ? `This pipeline will visit: ${others.join(", ")}`
      : `This pipeline leaves ${targetOrigin} for: ${others.join(", ")}`,
  );
}

/**
 * Gate 7: Overlay readiness check (SOFT WARN).
 * Sends previewAll message to content script and checks for unmatched selectors.
 * @param {object[]} steps
 * @param {number}   tabId
 * @returns {Promise<EthicsWarn|null>}
 */
async function _gate7_overlayReadiness(steps, tabId) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      type: "overlay:setMode",
      payload: { action: "previewAll", steps },
    });
    if (result?.unmatched?.length > 0) {
      return new EthicsWarn(
        "SelectorNotFound",
        `${result.unmatched.length} selector(s) not found on page: ${result.unmatched.slice(0, 3).join(", ")}${result.unmatched.length > 3 ? "…" : ""}`,
      );
    }
  } catch (err) {
    logger.warn(MODULE, "gate7-overlay-check-fail", { error: err.message });
    // Non-fatal: content script may not be loaded yet
  }
  return null;
}

// ── FORM_FILL specific checks ─────────────────────────────────────────────────

function _checkFormFillHardConstraints(config, rowCount, confirmed) {
  // Delay floor
  const minDelay = config.interRowDelay?.min ?? 1200;
  if (minDelay < MIN_INTER_ROW_DELAY_MS) {
    throw new EthicsBlock(
      "DelayFloor",
      `Inter-row delay ${minDelay}ms < minimum ${MIN_INTER_ROW_DELAY_MS}ms`,
    );
  }

  // Row cap
  const cap = confirmed ? MAX_FORM_ROWS_CONFIRMED : MAX_FORM_ROWS_DEFAULT;
  if (rowCount > cap) {
    throw new EthicsBlock(
      "SubmitCapExceeded",
      `Row count ${rowCount} exceeds cap ${cap} (confirmed=${confirmed})`,
    );
  }

  // Field type checks (password / hidden)
  for (const mapping of config.fieldMappings ?? []) {
    if (mapping.inputType === "password") {
      throw new EthicsBlock(
        "PasswordField",
        `Password field in mapping: ${mapping.selector}`,
      );
    }
    if (mapping.inputType === "hidden") {
      throw new EthicsBlock(
        "HiddenField",
        `Hidden field in mapping: ${mapping.selector}`,
      );
    }
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} EthicsResult
 * @property {boolean}        blocked    Any hard block found
 * @property {EthicsBlock|null} blocker  The blocking error if blocked
 * @property {EthicsWarn[]}   warnings   Soft warnings requiring user confirm
 */

/**
 * Run all 7 pre-run ethics gates.
 * @param {object} opts
 * @param {object[]} opts.steps          - Pipeline steps
 * @param {string}   opts.targetOrigin   - Declared pipeline origin
 * @param {string}   [opts.targetPath='/'] - Path for robots.txt check
 * @param {object}   [opts.timing]       - Timing configuration
 * @param {object}   [opts.proxy]        - Current proxy entry
 * @param {string}   [opts.region]       - Declared geo region
 * @param {object}   [opts.captcha]      - Captcha config
 * @param {number}   [opts.tabId]        - Active tab for Gate 7
 * @param {boolean}  [opts.confirmed]    - User explicitly confirmed row count
 * @param {number}   [opts.rowCount]     - Total rows to process
 * @returns {Promise<EthicsResult>}
 */
export async function runEthicsGates(opts = {}) {
  const {
    steps = [],
    targetOrigin = "",
    targetPath = "/",
    timing = {},
    proxy = null,
    region = null,
    captcha = {},
    tabId = null,
    confirmed = false,
    rowCount = 0,
    bypassRobots = false,
  } = opts;

  const warnings = [];

  // Gate 1: robots.txt
  const w1 = await _gate1_robots(targetOrigin, targetPath, bypassRobots);
  if (w1) warnings.push(w1);

  // Gate 2: PII (deferred to content)
  await _gate2_pii(steps);

  // Gate 3: Rate limit
  const w3 = _gate3_rateLimit(steps, timing);
  if (w3) warnings.push(w3);

  // Gate 4: Captcha volume
  const w4 = _gate4_captcha(steps, captcha);
  if (w4) warnings.push(w4);

  // Gate 5: Proxy geo
  const w5 = _gate5_proxyGeo(proxy, region);
  if (w5) warnings.push(w5);

  // Gate 6: cross-origin reporting. Enforcement of *unauthored* origins happens
  // at execution time, where the resolved URL is actually known.
  const w6 = _gate6_crossOrigin(steps, targetOrigin);
  if (w6) warnings.push(w6);

  // FORM_FILL hard constraints
  const formSteps = _flattenSteps(steps).filter((s) => s.type === "FORM_FILL");
  for (const step of formSteps) {
    try {
      _checkFormFillHardConstraints(step.config ?? {}, rowCount, confirmed);
    } catch (err) {
      if (err instanceof EthicsBlock) {
        logger.error(MODULE, "form-fill-block", {
          code: err.code,
          message: err.message,
        });
        return { blocked: true, blocker: err, warnings };
      }
      throw err;
    }
  }

  // Gate 7: Overlay readiness (SOFT — needs tabId)
  if (tabId) {
    const w7 = await _gate7_overlayReadiness(steps, tabId);
    if (w7) warnings.push(w7);
  }

  logger.info(MODULE, "gates-complete", {
    blocked: false,
    warnings: warnings.map((w) => w.code),
  });

  return { blocked: false, blocker: null, warnings };
}

// === END ethics-engine.js ===
