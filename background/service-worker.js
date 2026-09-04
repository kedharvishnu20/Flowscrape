// === service-worker.js ===
/**
 * @module service-worker
 * @description MV3 Service Worker: pipeline orchestrator, message bus, and
 *   SW lifecycle manager.
 *
 *   (This file used to claim all state was persisted before every await to
 *   survive SW termination. It never was; the lifecycle note below says what is
 *   actually guaranteed.)
 *
 *   Design decision: The SW uses a message-handler registry pattern (Map of
 *   handlers keyed by message name) instead of a giant switch statement. This
 *   keeps the bus extensible and each handler independently testable.
 *   All inbound message names must match the canonical registry.
 *
 *   SW lifecycle: state that must survive worker termination is re-hydrated by
 *   _bootstrap() at module scope, not from the `activate` event — MV3 does not
 *   re-fire `activate` when it wakes a terminated worker.
 *
 *   What does NOT survive: _runStates. A run in flight when the worker is
 *   terminated is lost, and the pipeline cannot be resumed from where it
 *   stopped — that would mean re-entering the step chain with the right
 *   template context against a tab that may since have navigated. What is
 *   guaranteed instead is that the loss is visible: rows already collected stay
 *   in IndexedDB under their run's cursor, the side panel polls pipeline:status
 *   and reports the interruption rather than showing a Stop button forever, and
 *   the rows remain downloadable. See docs/ISSUE_AUDIT.md D-01.
 *
 * @dependencies proxy-manager, api-key-manager, rate-limiter, ethics-engine, logger
 */

import { logger } from "../utils/logger.js";
import { extractPdfText } from "../utils/pdf-text.js";
import { ALL_STEP_TYPES, STEP_TYPES } from "../utils/step-types.js";
import { applyTransforms } from "../utils/value-transforms.js";
import { evaluateCondition } from "../utils/conditions.js";
import { matchesSnifferFilter } from "../utils/sniffer-filter.js";
import { initSessionKey } from "./api-key-manager.js";
import { setApiKey } from "./api-key-manager.js";
import {
  loadPool,
  selectProxy,
  rotateProxy,
  markProxyFailure,
  testAllProxies,
  parseProxyText,
  addToPool,
  savePool,
  setRotationMode,
} from "./proxy-manager.js";
import { acquire, backoff, resetRetry } from "./rate-limiter.js";
import {
  runEthicsGates,
  EthicsBlock,
  collectDeclaredOrigins,
} from "./ethics-engine.js";
import {
  initBuffer,
  pushRow,
  flush,
  finalizeBuffer,
  droppedRowCount,
  readAllRows,
} from "../checkpoint/row-buffer.js";
import { saveCursor } from "../checkpoint/cursor-store.js";
import {
  getResumePayload,
  markRunCompleted,
} from "../checkpoint/resume-manager.js";
import {
  compilePipeline,
  findUnexportableSteps,
  findUnresolvedTemplates,
  redactSecrets,
} from "../script-gen/pipeline-compiler.js";
import { emitPython } from "../script-gen/python-emitter.js";
import { emitNode } from "../script-gen/node-emitter.js";
import { runLlmLayer } from "./llm-extractor.js";
import {
  formatRows,
  formatMeta,
  ROW_FORMATS,
} from "../exporters/row-formatters.js";

const MODULE = "service-worker";
const STORAGE_FILES_KEY = "fs_storage_files_v1";

// ── Restricted sites that block automated file uploads ────────────────────────
const RESTRICTED_UPLOAD_SITES = Object.freeze({
  "linkedin.com": true,
  "www.linkedin.com": true,
  "facebook.com": true,
  "www.facebook.com": true,
  "twitter.com": true,
  "x.com": true,
  "instagram.com": true,
  "www.instagram.com": true,
});

// ── Cross-origin enforcement ──────────────────────────────────────────────────
/**
 * Refuse to navigate or call an origin the pipeline never declared.
 *
 * The pre-run gate can only see URLs the author typed. A templated URL —
 * `{{item.href}}`, most often — is resolved from the page's own DOM by
 * QUERY_ELEMENTS, which means the *page* chooses it. A hostile or merely
 * compromised page could point a NAVIGATE at any origin it liked and have the
 * following steps (a FILL carrying credentials, an UPLOAD_ACTIVITY carrying
 * files) run there.
 *
 * So the check happens here, where the resolved URL is finally known, against
 * the set of origins the pipeline declared. Same-origin templated links — the
 * ordinary "loop the product cards and open each one" case — pass untouched.
 *
 * @param {string} rawUrl   - already template-resolved
 * @param {object} runState
 * @param {string} stepType
 */
function _assertOriginAllowed(rawUrl, runState, stepType) {
  const allowed = runState?.allowedOrigins;
  if (!allowed || allowed.size === 0) return; // nothing declared; nothing to enforce

  let origin;
  try {
    origin = new URL(rawUrl, runState.targetOrigin || undefined).origin;
  } catch {
    return; // not resolvable here; the step will fail on its own terms
  }

  if (allowed.has(origin)) return;

  throw new EthicsBlock(
    "UndeclaredOrigin",
    `${stepType} resolved to ${origin}, which this pipeline never declared. ` +
      `Allowed: ${[...allowed].join(", ")}. ` +
      `A URL built from page content (for example {{item.href}}) is chosen by the page, ` +
      `not by you — add a step targeting ${origin} explicitly if you meant to go there.`,
  );
}

// ── Network sniffer lifecycle ─────────────────────────────────────────────────
/**
 * page-sniffer.js wraps window.fetch and XMLHttpRequest and forwards every
 * request and response body it sees. It used to be declared in the manifest as
 * a MAIN-world content script on <all_urls> at document_start, so it ran on
 * every site the user visited — banking, webmail, everything — buffering up to
 * 500 KB per response and messaging it to this worker, which then discarded it
 * unless an API_SNIFFER run happened to be active.
 *
 * It is now registered only while such a run is in flight, and scoped to the
 * run's own origin rather than every site.
 */
const SNIFFER_SCRIPT_ID = "fs_page_sniffer";
const SNIFFER_FILE = "content/page-sniffer.js";

/** Runs currently requesting the sniffer; it is unregistered when this empties. */
const _snifferRuns = new Set();

function _snifferMatches(targetOrigin) {
  if (typeof targetOrigin === "string" && /^https?:\/\//.test(targetOrigin)) {
    return [`${targetOrigin}/*`];
  }
  // No usable origin (started from a new tab); fall back to all sites for the
  // duration of the run rather than capturing nothing.
  return ["<all_urls>"];
}

async function _enableSniffer(runId, tabId, targetOrigin) {
  _snifferRuns.add(runId);

  try {
    const existing = await chrome.scripting
      .getRegisteredContentScripts({ ids: [SNIFFER_SCRIPT_ID] })
      .catch(() => []);
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({
        ids: [SNIFFER_SCRIPT_ID],
      });
    }

    await chrome.scripting.registerContentScripts([
      {
        id: SNIFFER_SCRIPT_ID,
        js: [SNIFFER_FILE],
        matches: _snifferMatches(targetOrigin),
        runAt: "document_start",
        world: "MAIN",
        allFrames: false,
        persistAcrossSessions: false,
      },
    ]);
    logger.info(MODULE, "sniffer-registered", { runId });
  } catch (err) {
    logger.error(MODULE, "sniffer-register-fail", { error: err.message });
    _broadcastLog(
      "error-log",
      `API Sniffer could not start: ${err.message}`,
      runId,
    );
    return;
  }

  // The registration above only takes effect on the next document_start. Inject
  // into the page that is already open so the run does not have to navigate
  // first — traffic that happened before this point is necessarily missed.
  if (tabId) {
    await chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        files: [SNIFFER_FILE],
      })
      .then(() =>
        _broadcastLog(
          "info-log",
          "API Sniffer active. Requests made before this point are not captured.",
          runId,
        ),
      )
      .catch((err) =>
        _broadcastLog(
          "warn-log",
          `API Sniffer could not hook the current page (${err.message}). It will start on the next navigation.`,
          runId,
        ),
      );
  }
}

async function _disableSniffer(runId) {
  if (!_snifferRuns.delete(runId)) return;
  if (_snifferRuns.size > 0) return; // another run still wants it

  await chrome.scripting
    .unregisterContentScripts({ ids: [SNIFFER_SCRIPT_ID] })
    .then(() => logger.info(MODULE, "sniffer-unregistered", { runId }))
    .catch((err) =>
      logger.warn(MODULE, "sniffer-unregister-fail", { error: err.message }),
    );
}

// ── Utility helpers ────────────────────────────────────────────────────────────
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _broadcastLog(level, message, runId) {
  const rs = _runStates.get(runId);
  chrome.runtime
    .sendMessage({
      type: "pipeline:log",
      payload: { level, message, runId, tabId: rs?.tabId },
    })
    .catch(() => {});
}

// ── Canonical message names ────────────────────────────────────────────────────
const MSG = Object.freeze({
  PIPELINE_START: "pipeline:start",
  PIPELINE_PAUSE: "pipeline:pause",
  PIPELINE_RESUME: "pipeline:resume",
  PIPELINE_STOP: "pipeline:stop",
  PIPELINE_STATUS: "pipeline:status",
  STEP_EXECUTE: "step:execute",
  STEP_RESULT: "step:result",
  PROXY_SELECT: "proxy:select",
  PROXY_ROTATE: "proxy:rotate",
  PROXY_TEST: "proxy:test",
  CAPTCHA_SOLVE: "captcha:solve",
  CAPTCHA_RESULT: "captcha:result",
  KEY_GET: "key:get",
  FORM_ROW_START: "form:rowStart",
  FORM_ROW_RESULT: "form:rowResult",
  CHECKPOINT_SAVE: "checkpoint:save",
});

// ── Pipeline run state ─────────────────────────────────────────────────────────
/** @type {{ active: boolean, paused: boolean, runId: string|null, tabId: number|null, results: any[], screenshots: string[] }} */
const _runStates = new Map();

// ── SW bootstrap ──────────────────────────────────────────────────────────────
/**
 * Re-hydrate module-scope state that does not survive worker termination.
 *
 * This runs at module scope, not only from the `activate` event: MV3 tears an
 * idle worker down after ~30s and fires `activate` only on a genuine
 * (re)installation, not when it wakes the worker again. Anything hung off
 * `activate` alone is therefore absent for the rest of the browser session —
 * which is why the proxy pool used to come back empty after the first idle
 * timeout.
 *
 * Kept as a floating promise so MV3 listener registration below stays
 * synchronous.
 */
async function _bootstrap() {
  await initSessionKey().catch((err) =>
    logger.error(MODULE, "session-key-init-fail", { error: err.message }),
  );
  await loadPool().catch((err) =>
    logger.error(MODULE, "pool-load-fail", { error: err.message }),
  );
  // Runs that were in flight when this worker was terminated. Their rows are
  // still in IndexedDB; nothing can resume the pipeline itself.
  const resumable = await getResumePayload().catch(() => null);
  if (resumable?.hasResumable) {
    logger.warn(MODULE, "interrupted-runs", {
      count: resumable.runs.length,
      runIds: resumable.runs.map((r) => r.runId),
    });
  }

  logger.info(MODULE, "sw-bootstrapped", {});
}

_bootstrap();

self.addEventListener("activate", () => {
  logger.info(MODULE, "sw-activated", {});
});

self.addEventListener("install", () => {
  logger.info(MODULE, "sw-installed", {});
  self.skipWaiting();
});

// ── Keeping the worker alive during a run ─────────────────────────────────────
/**
 * MV3 shuts an idle service worker down after 30 seconds, and an `await` on a
 * timer does not count as activity. This mattered: a run doing anything slower
 * than 30s between extension events simply vanished mid-pipeline.
 *
 * The old approach was an alarm at `periodInMinutes: 0.33`, described in the
 * code as "~20s". Chrome clamps any period below 1 to one minute in a packed
 * extension (30s unpacked), so the alarm fired *after* the worker it was meant
 * to keep alive had already been torn down (D-02). It was also armed only from
 * the `activate` event, so it never came back after a restart, and cleared
 * whenever the last run ended.
 *
 * What actually resets the idle timer is calling an extension API. So the
 * keep-alive is an interval that makes a cheap call, and the alarm stays as the
 * backstop that can restart a worker Chrome killed anyway — at a period Chrome
 * will honour, and no longer claiming to be a 20-second heartbeat.
 */
const KEEPALIVE_MS = 20000;
let _keepaliveTimer = null;

function _startHeartbeat() {
  chrome.alarms.create("fs_sw_heartbeat", { periodInMinutes: 1 });
  if (_keepaliveTimer) return;
  _keepaliveTimer = setInterval(() => {
    if (_runStates.size === 0) {
      _stopHeartbeat();
      return;
    }
    // Any extension API call resets the 30s idle timer. getPlatformInfo is the
    // cheapest one that touches no state.
    chrome.runtime.getPlatformInfo?.().catch(() => {});
  }, KEEPALIVE_MS);
}

function _stopHeartbeat() {
  if (_keepaliveTimer) {
    clearInterval(_keepaliveTimer);
    _keepaliveTimer = null;
  }
  chrome.alarms.clear("fs_sw_heartbeat").catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "fs_sw_heartbeat") {
    logger.debug(MODULE, "heartbeat", { active: _runStates.size > 0 });
    // The worker may have been restarted by this very alarm, in which case the
    // interval is gone. Re-arm it if a run is still supposed to be in flight.
    if (_runStates.size > 0) _startHeartbeat();
    else _stopHeartbeat();
  }
});

// ── Capture limits ────────────────────────────────────────────────────────────
/**
 * Screenshots and sniffed requests live in the worker's heap until export, and
 * nothing bounded either of them. A 200-iteration loop with a screenshot step
 * exhausted memory long before the export it was collecting for (D-10), and a
 * sniffer run on a chatty page did the same at up to 550 KB per request (D-11).
 *
 * These are ceilings, not a fix for the design: the right answer is to stream
 * captures to IndexedDB the way rows already are. Until then a run stops
 * retaining rather than dying, and says so once so the export is not silently
 * short.
 */
const CAPTURE_LIMITS = Object.freeze({
  screenshotBytes: 48 * 1024 * 1024,
  screenshotCount: 500,
  networkBytes: 32 * 1024 * 1024,
  networkCount: 5000,
});

/**
 * Append to a capture buffer unless it is full.
 *
 * @param {object} runState
 * @param {'screenshots'|'networks'} key
 * @param {object} entry
 * @param {number} bytes - approximate size of this entry
 * @param {number} maxBytes
 * @param {number} maxCount
 * @param {string} runId
 * @returns {boolean} false when the entry was dropped
 */
function _pushCapture(runState, key, entry, bytes, maxBytes, maxCount, runId) {
  if (!Array.isArray(runState[key])) runState[key] = [];
  const sizeKey = `${key}Bytes`;
  const dropKey = `${key}Dropped`;
  runState[sizeKey] = runState[sizeKey] || 0;
  runState[dropKey] = runState[dropKey] || 0;

  if (
    runState[key].length >= maxCount ||
    runState[sizeKey] + bytes > maxBytes
  ) {
    runState[dropKey]++;
    // One warning per run, not one per dropped item.
    if (runState[dropKey] === 1) {
      _broadcastLog(
        "warn-log",
        `${key === "screenshots" ? "Screenshot" : "Network capture"} buffer is full ` +
          `(${runState[key].length} kept, ~${Math.round(runState[sizeKey] / 1048576)} MB). ` +
          `Further captures in this run are dropped; the export will say how many.`,
        runId,
      );
    }
    return false;
  }

  runState[key].push(entry);
  runState[sizeKey] += bytes;
  return true;
}

// ── Content script injection ─────────────────────────────────────────────────
/**
 * Files the page needs before a step can be dispatched to it.
 *
 * These used to be declared in the manifest for `<all_urls>`, so both ran in
 * every page the user visited — for a tool that operates on one tab at a time
 * (audit C-09). They are injected on demand now, into the tab a run or a picker
 * is about to touch, which is the only tab that ever needed them.
 *
 * Order matters: injector.js expects the smart extractor to be present.
 */
const CONTENT_FILES = [
  "content/smart-extractor.js",
  "content/structure-detector.js",
  "content/page-data.js",
  "content/injector.js",
];

/**
 * Make sure the content scripts are live in a tab.
 *
 * Injecting twice would re-register the message listener and double every
 * response, so ask first. A tab that answers is already set up.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function _ensureInjected(tabId) {
  if (!tabId) throw new Error("No tab to inject into");

  // Aimed at the top document: an unqualified sendMessage reaches every frame
  // and returns the first answer, so an iframe could report "already injected"
  // for a page whose top document has no script at all.
  const alive = await chrome.tabs
    .sendMessage(tabId, { type: "fs:ping" }, { frameId: 0 })
    .catch(() => null);
  if (alive?.ok) return;

  try {
    await chrome.scripting.executeScript({
      // Every frame, not just the top document. An iframe is a separate
      // document rather than a branch of its parent's DOM, so a script in the
      // top frame cannot see into one at all — which is why nothing could
      // touch an element inside an iframe. injector.js guards against being
      // evaluated twice, so re-injecting a frame that is already set up is
      // harmless.
      target: { tabId, allFrames: true },
      files: CONTENT_FILES,
    });
  } catch (err) {
    // chrome:// pages, the Web Store, and PDF viewers refuse injection. Saying
    // which is more use than "Receiving end does not exist".
    throw new Error(
      `Cannot run steps on this page (${err.message}). Chrome blocks extensions ` +
        `on chrome:// pages, the Web Store and PDF viewers.`,
    );
  }
}

/**
 * Every frame id in a tab, the top document first.
 *
 * Discovered by running a trivial script in all frames. `chrome.webNavigation`
 * would also do it and would cost another permission — C-07 cut four unused
 * ones, and adding one back for a list this cheap would be a poor trade.
 *
 * @returns {Promise<number[]>}
 */
async function _frameIds(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => 1,
    });
    const ids = results.map((r) => r.frameId).filter((id) => id !== undefined);
    // 0 is the top document; try it first so a selector that matches there
    // behaves exactly as it did before the toggle existed.
    return [...new Set([0, ...ids])];
  } catch {
    return [0];
  }
}

/**
 * Did this step actually find anything, or merely not throw?
 *
 * The frame walk needs the difference. EXTRACT does not fail when a field
 * misses — by design, since B-08: it returns the row with nulls rather than
 * inventing data — so the top document "succeeded" with `[{t: null}]` and the
 * walk stopped before reaching the frame that had the element. CLICK is the
 * same shape: `{clicked: 0}` is a successful message and an unsuccessful step.
 *
 * @param {*} result
 * @returns {boolean} true when nothing was found
 */
function _looksEmpty(result) {
  if (result === null || result === undefined) return true;

  if (Array.isArray(result)) {
    if (result.length === 0) return true;
    return result.every(
      (row) =>
        row &&
        typeof row === "object" &&
        Object.values(row).every(
          (v) => v === null || v === undefined || v === "",
        ),
    );
  }

  if (typeof result === "object") {
    if (result.clicked === 0 || result.matched === 0) return true;
    if (result.exists === false) return true;
    if (Array.isArray(result.records) && result.records.length === 0) {
      return result.found === false;
    }
  }
  return false;
}

/**
 * Send a step to each frame in turn, and take the first that succeeds.
 *
 * Only used when a step asks for it. Searching every frame by default would
 * change what an ambiguous selector matches — a page can carry a dozen
 * advertising iframes that each happen to contain a `.title` — so it is a
 * toggle on the step, as it should be.
 *
 * @param {number} tabId
 * @param {object} payload - a resolved step
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
async function _sendToFrames(tabId, payload) {
  await _ensureInjected(tabId);
  const frames = await _frameIds(tabId);
  const failures = [];
  let lastEmpty = null;

  for (const frameId of frames) {
    let resp;
    try {
      resp = await chrome.tabs.sendMessage(
        tabId,
        { type: "step:execute", payload },
        { frameId },
      );
    } catch (err) {
      // A frame with no content script — a cross-origin one Chrome refused to
      // inject, or one that has since navigated. Not this step's problem.
      failures.push(`frame ${frameId}: ${err.message}`);
      continue;
    }
    if (resp?.ok && !_looksEmpty(resp.result)) return resp;
    if (resp?.ok) {
      // Ran, found nothing. Keep the last one: if no frame has the element
      // either, this is the answer the step would have given without the
      // toggle, and changing that would make the toggle alter results rather
      // than widen the search.
      lastEmpty = resp;
      failures.push(`frame ${frameId}: nothing matched`);
      continue;
    }
    failures.push(`frame ${frameId}: ${resp?.error ?? "no answer"}`);
  }

  if (lastEmpty) return lastEmpty;
  return {
    ok: false,
    error:
      `Not found in the page or in any of its ${Math.max(0, frames.length - 1)} frame(s). ` +
      failures.slice(0, 3).join("; "),
  };
}

/**
 * What finished runs captured, so it outlives the run state.
 *
 * Bounded twice over: each run's captures are already capped (D-10, D-11), and
 * only the few most recent runs are kept — a worker that hoards every run's
 * screenshots is the memory leak those caps exist to prevent.
 *
 * @type {Map<string, {networks: object[], screenshots: object[]}>}
 */
const _finishedCaptures = new Map();
const FINISHED_CAPTURE_RUNS = 5;

function _keepCaptures(runId, runState) {
  if (!runState) return;
  const networks = runState.networks ?? [];
  const screenshots = runState.screenshots ?? [];
  if (networks.length === 0 && screenshots.length === 0) return;

  _finishedCaptures.set(runId, { networks, screenshots });
  while (_finishedCaptures.size > FINISHED_CAPTURE_RUNS) {
    _finishedCaptures.delete(_finishedCaptures.keys().next().value);
  }
}

/** A run's captures, live or just finished. */
function _capturesFor(runId) {
  const live = _runStates.get(runId);
  if (live) {
    return {
      networks: live.networks ?? [],
      screenshots: live.screenshots ?? [],
    };
  }
  return _finishedCaptures.get(runId) ?? { networks: [], screenshots: [] };
}

/** Chrome's ways of saying "there is no content script on that tab". */
const _GONE =
  /Receiving end does not exist|message channel closed|Could not establish connection/i;

/**
 * Send a step to a page, putting the content script back if it is not there.
 *
 * Content scripts are injected on demand (C-09) and are destroyed with the
 * document that hosts them. The run injected once, at the start, so every page
 * step after any navigation — a NAVIGATE, a PAGINATE, a CLICK that follows a
 * link — failed with "Receiving end does not exist". A pipeline that visits
 * more than one page is most pipelines, so this was close to the whole product
 * on any multi-page site; it survived because nothing had ever paginated far
 * enough to notice.
 *
 * Optimistic rather than defensive: send first, and pay for the injection only
 * on the tab where it is actually needed. `_ensureInjected` pings before it
 * injects, so a retry cannot double-register the listener.
 *
 * @param {number} tabId
 * @param {object} payload - a resolved step, `{type, config}`
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
async function _sendToPage(tabId, payload) {
  // "Look inside frames too" — off by default, so a page without iframes
  // behaves exactly as it always did.
  if (payload?.config?.inFrame) return _sendToFrames(tabId, payload);

  // frameId 0 — the top document — explicitly. Without it Chrome delivers the
  // message to *every* frame and hands back whichever answers first, so once
  // the script was injected into all frames an advert's iframe could answer a
  // step aimed at the page. Caught by an e2e check that asserted a selector
  // inside an iframe is *not* found without the toggle.
  const to = { frameId: 0 };
  try {
    return await chrome.tabs.sendMessage(
      tabId,
      { type: "step:execute", payload },
      to,
    );
  } catch (err) {
    if (!_GONE.test(err.message)) throw err;
    await _ensureInjected(tabId);
    return chrome.tabs.sendMessage(
      tabId,
      { type: "step:execute", payload },
      to,
    );
  }
}

// ── Message bus ───────────────────────────────────────────────────────────────
/** @type {Map<string, (payload: any, sender: chrome.runtime.MessageSender) => Promise<any>>} */
const _handlers = new Map();

function _registerHandler(name, fn) {
  _handlers.set(name, fn);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message ?? {};
  if (!type) return false;

  const handler = _handlers.get(type);
  if (!handler) {
    logger.warn(MODULE, "unknown-message", { type });
    sendResponse({ ok: false, error: `Unknown message type: ${type}` });
    return false;
  }

  handler(payload ?? {}, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => {
      // Don't flag "Receiving end does not exist" as a hard SW crash, it just means the target tab needs F5
      if (err.message && err.message.includes("Receiving end does not exist")) {
        logger.warn(MODULE, "tab-not-ready", {
          type,
          message: "Target tab not active/refreshed.",
        });
      } else {
        logger.error(MODULE, "handler-error", { type, error: err.message });
      }
      sendResponse({ ok: false, error: err.message, code: err.code });
    });

  return true; // keep channel open for async response
});

// ── Message handlers ───────────────────────────────────────────────────────────

/**
 * Build the argument object for runEthicsGates from a run payload.
 *
 * Shared by pipeline:preflight and pipeline:start so the two cannot drift —
 * the preflight the user confirms must be the same evaluation that gates the
 * run. Note bypassRobots: it is sent by the side panel's "Bypass robots.txt"
 * checkbox and used to be dropped here, which made the checkbox inert.
 */
function _gateArgs(payload, tabId) {
  return {
    steps: payload.pipeline?.steps ?? [],
    targetOrigin: payload.targetOrigin,
    targetPath: payload.targetPath ?? "/",
    timing: payload.timing ?? {},
    captcha: {
      enabled: payload.captchaEnabled,
      authorized: payload.captchaAuthorized,
    },
    tabId,
    confirmed: payload.confirmed ?? false,
    rowCount: payload.rowCount ?? 0,
    bypassRobots: payload.bypassRobots ?? false,
  };
}

/** Serialize gate output for the side panel. */
function _serializeEthics(result) {
  return {
    blocked: result.blocked,
    blocker: result.blocker
      ? { code: result.blocker.code, message: result.blocker.message }
      : null,
    warnings: result.warnings.map((w) => ({
      code: w.code,
      message: w.message,
    })),
  };
}

/**
 * Evaluate the ethics gates without starting anything, so the side panel can
 * show the user what the gates found and let them decide. The gates still run
 * again inside pipeline:start — this is for visibility, not enforcement, and a
 * caller that skips it cannot bypass anything.
 */
_registerHandler("pipeline:preflight", async (payload, sender) => {
  const { pipeline } = payload;
  if (!pipeline) throw new Error("No pipeline provided");
  const tabId = payload.tabId ?? sender.tab?.id;

  const result = await runEthicsGates(_gateArgs(payload, tabId));
  logger.info(MODULE, "preflight", {
    blocked: result.blocked,
    warnings: result.warnings.length,
  });
  return _serializeEthics(result);
});

_registerHandler(MSG.PIPELINE_START, async (payload, sender) => {
  const { pipeline, tabId } = payload;
  if (!pipeline) throw new Error("No pipeline provided");

  // The sniffer is a run-wide capture rather than a step that executes, so its
  // filter comes off the step's config once, here, rather than being consulted
  // per request from a step that has long since finished.
  const snifferStep = (pipeline.steps || []).find(
    (s) => s.type === "API_SNIFFER",
  );
  const enableSniffer = Boolean(snifferStep);
  const snifferFilter = {
    urlFilter: snifferStep?.config?.urlFilter ?? "",
    methods: snifferStep?.config?.methods ?? "",
  };

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runState = {
    active: true,
    paused: false,
    runId,
    tabId: tabId ?? sender.tab?.id,
    enableSniffer,
    snifferFilter,
    targetOrigin: payload.targetOrigin ?? null,
    allowedOrigins: collectDeclaredOrigins(
      pipeline.steps ?? [],
      payload.targetOrigin,
    ),
    results: [],
    screenshots: [],
  };
  _runStates.set(runId, runState);
  _startHeartbeat(); // only needed while a run is in flight

  // The content scripts are no longer declared for every page (C-09), so put
  // them in before the first step needs them. Failing here is better than
  // failing on step 1 with "Receiving end does not exist".
  try {
    await _ensureInjected(runState.tabId);
  } catch (err) {
    _runStates.delete(runId);
    if (_runStates.size === 0) _stopHeartbeat();
    throw err;
  }

  if (enableSniffer) {
    await _enableSniffer(runId, runState.tabId, payload.targetOrigin);
  }

  // Persist state before any await
  await chrome.storage.local.set({
    fs_run_log: { runId, startedAt: Date.now(), status: "running" },
  });

  // Run ethics gates first. Re-run rather than trusting the preflight result:
  // enforcement must not depend on the caller having asked politely.
  const ethicsResult = await runEthicsGates(_gateArgs(payload, runState.tabId));

  // If ethics gates hard-blocked, abort the run
  if (ethicsResult.blocked) {
    _runStates.delete(runId);
    await _disableSniffer(runId);
    throw new EthicsBlock(
      ethicsResult.blocker.code,
      ethicsResult.blocker.message,
    );
  }

  const warnings = ethicsResult.warnings;
  logger.info(MODULE, "pipeline-start", { runId, warnings: warnings.length });

  // Echo warnings into the run log. They were previously returned to the caller
  // and nothing rendered them, so every soft gate was silent.
  for (const warning of warnings) {
    _broadcastLog(
      "warn-log",
      `Ethics · ${warning.code}: ${warning.message}`,
      runId,
    );
  }

  // Start execution loop async (do not await so UI returns early!)
  _executePipeline(runId, pipeline, runState.tabId).catch((err) => {
    logger.error(MODULE, "pipeline-crash", { runId, error: err.message });
  });

  return {
    runId,
    warnings: warnings.map((w) => ({ code: w.code, message: w.message })),
  };
});

/**
 * Runs whose sniffer filter has already been reported as broken.
 *
 * A busy page makes hundreds of requests. Without this, one bad pattern would
 * log one line per request and bury everything else in the run monitor.
 * @type {Set<string>}
 */
const _snifferFilterWarned = new Set();

_registerHandler("network:sniff", async (payload, sender) => {
  const tabId = sender.tab?.id;
  if (!tabId) return { ok: false };
  for (const [runId, rs] of _runStates.entries()) {
    if (rs.tabId === tabId && rs.active && rs.enableSniffer) {
      // Filtered before it is stored, not after: the capture buffer is bounded
      // (D-10), so on a busy site the analytics beacons, fonts and ad auctions
      // could push the four calls you wanted out of it before the run ended.
      try {
        if (
          !matchesSnifferFilter(
            { url: payload.url, method: payload.method },
            rs.snifferFilter ?? {},
          )
        ) {
          break;
        }
      } catch (err) {
        if (!_snifferFilterWarned.has(runId)) {
          _snifferFilterWarned.add(runId);
          _broadcastLog(
            "warn-log",
            `API_SNIFFER: ${err.message} — recording everything instead.`,
            runId,
          );
        }
      }

      const entry = {
        timestamp: Date.now(),
        method: payload.method,
        url: payload.url,
        status: payload.status,
        requestBody: payload.reqBody || "",
        responseBody: payload.resBody || "",
        type: payload.apiType,
      };
      // Announced, but only every so often: a busy page makes hundreds of
      // requests and one line each would bury the run's own messages.
      const n = (rs.networks?.length ?? 0) + 1;
      if (n <= 3 || n % 25 === 0) {
        _broadcastLog(
          "info-log",
          `Sniffer: ${n} request${n === 1 ? "" : "s"} captured (latest: ${entry.method} ${String(entry.url).slice(0, 80)})`,
          runId,
        );
      }
      _pushCapture(
        rs,
        "networks",
        entry,
        (entry.url?.length || 0) +
          entry.requestBody.length +
          entry.responseBody.length,
        CAPTURE_LIMITS.networkBytes,
        CAPTURE_LIMITS.networkCount,
        runId,
      );
      break;
    }
  }
  return { ok: true };
});

// ── Step execution helpers ─────────────────────────────────────────────────────

/**
 * How tall a stitched full-page shot may get, in CSS pixels.
 *
 * An infinite feed has no bottom, so "capture until the page ends" is a loop
 * that never returns. Past this the shot is truncated and says so.
 */
const FULL_PAGE_MAX_HEIGHT = 20000;

/**
 * Chrome caps captureVisibleTab at MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND,
 * which is 2 — a limit found by taking a full-page screenshot in a real
 * browser, where the second strip came back
 * "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota."
 * Nothing in the unit suite could see it: the mocked captureVisibleTab has no
 * quota, so stitching four strips looked instantaneous and free.
 */
const CAPTURE_MIN_INTERVAL_MS = 550;
let _lastCaptureAt = 0;

/** Take one photograph of whatever is currently on screen. */
async function _captureViewport(windowId, config) {
  // Paced rather than retried-on-failure: a quota error costs a round trip and
  // the retry has to wait anyway, so waiting first is strictly cheaper. It does
  // mean a tall page takes about half a second per screenful, which the panel
  // says.
  const since = Date.now() - _lastCaptureAt;
  if (since < CAPTURE_MIN_INTERVAL_MS) {
    await _sleep(CAPTURE_MIN_INTERVAL_MS - since);
  }
  // format decides whether quality means anything: Chrome ignores it for PNG,
  // so the UI's quality control did nothing at all (B-30). Anything below 100
  // now selects JPEG, where the number is real; 100 keeps lossless PNG.
  const rawQuality = Number(config.quality);
  const quality = Number.isFinite(rawQuality)
    ? Math.max(1, Math.min(100, Math.round(rawQuality)))
    : 100;
  const format = quality >= 100 ? "png" : "jpeg";
  const opts = format === "png" ? { format } : { format, quality };
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts);
  } catch (err) {
    // Another extension, or another run, can have spent the quota in the same
    // second. One patient retry rather than failing the step.
    if (!/quota|MAX_CAPTURE/i.test(err.message)) throw err;
    await _sleep(CAPTURE_MIN_INTERVAL_MS);
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts);
  }
  _lastCaptureAt = Date.now();
  return { dataUrl, format, quality };
}

/**
 * Join captured strips into one tall image, and optionally crop it.
 *
 * Needs OffscreenCanvas and createImageBitmap, which a service worker has and
 * Node does not — so this path is proven in the e2e suite against a real
 * Chromium rather than in the unit tests. Mocking a canvas would mean asserting
 * against something more capable than the runtime, which is exactly what hid
 * A-12 for four hundred tests.
 *
 * @param {{dataUrl: string, top: number}[]} strips - `top` in device pixels
 * @param {{width: number, height: number, mime: string, crop?: object}} out
 * @returns {Promise<string>} a data: URL
 */
async function _stitchStrips(strips, out) {
  if (
    typeof OffscreenCanvas !== "function" ||
    typeof createImageBitmap !== "function"
  ) {
    throw new Error("This browser cannot join screenshots together.");
  }
  const canvas = new OffscreenCanvas(out.width, out.height);
  const ctx = canvas.getContext("2d");

  for (const strip of strips) {
    const blob = await (await fetch(strip.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    // Drawn at its scroll offset. The last strip overlaps the one before it
    // wherever the page did not have a full viewport left to scroll — which is
    // most pages — so it must be drawn over, not appended.
    ctx.drawImage(bitmap, 0, strip.top);
    bitmap.close?.();
  }

  let surface = canvas;
  if (out.crop) {
    const { x, y, width, height } = out.crop;
    const cropped = new OffscreenCanvas(
      Math.max(1, width),
      Math.max(1, height),
    );
    cropped
      .getContext("2d")
      .drawImage(canvas, x, y, width, height, 0, 0, width, height);
    surface = cropped;
  }

  const blob = await surface.convertToBlob({ type: out.mime });
  return _bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), out.mime);
}

/**
 * Capture the tab: the visible area, the whole page, or one element.
 *
 * `captureVisibleTab` photographs the viewport and nothing else, which is all
 * this step could ever do. So "screenshot the page" gave you the top of it, and
 * photographing one element was impossible — both under a control that said
 * only "quality".
 */
async function _takeShot(tabId, config = {}, runId) {
  const area = config.area || "viewport";
  try {
    // captureVisibleTab photographs whichever tab is active in the window, so
    // the target has to be the active one. It used to be activated
    // unconditionally, yanking focus away from whatever the user was doing on
    // every screenshot in a loop (B-29). Check first: when the tab is already
    // active — the common case, since the run is driving it — do nothing.
    const before = await chrome.tabs.get(tabId);
    if (!before.active) {
      await chrome.tabs.update(tabId, { active: true });
      await _sleep(400);
    }
    const tab = await chrome.tabs.get(tabId);

    if (area === "full")
      return { ...(await _captureFullPage(tab, config, runId)), area };
    if (area === "element") {
      return { ...(await _captureElement(tab, config, runId)), area };
    }
    const { dataUrl, format } = await _captureViewport(tab.windowId, config);
    return { dataUrl, ext: format === "png" ? "png" : "jpg", area };
  } catch (err) {
    throw new Error(`Screenshot failed: ${err.message}`);
  }
}

/**
 * Take a screenshot and keep it with the run.
 *
 * Split from _takeShot so that testing a single SCREENSHOT step can hand the
 * image straight back. It could not be tested at all before: the step runs in
 * the worker, but the test path forwarded everything it did not special-case
 * to the page, where injector.js rejects SCREENSHOT by design (B-32). Pressing
 * "Test" on a screenshot step therefore always failed.
 */
async function _captureScreenshot(tabId, config = {}, runId) {
  const runState = _runStates.get(runId);
  if (!runState) return;
  const shot = await _takeShot(tabId, config, runId);

  // Held in memory until export, so it is bounded (D-10).
  const kept = _pushCapture(
    runState,
    "screenshots",
    { dataUrl: shot.dataUrl, ts: Date.now(), ext: shot.ext, area: shot.area },
    shot.dataUrl.length,
    CAPTURE_LIMITS.screenshotBytes,
    CAPTURE_LIMITS.screenshotCount,
    runId,
  );
  if (kept) {
    _broadcastLog(
      "info-log",
      `Screenshot #${runState.screenshots.length} captured (${shot.area}).`,
      runId,
    );
  }
}

/** Walk the page a viewport at a time and join the strips. */
async function _captureFullPage(tab, config, runId) {
  const m = await _sendToPage(tab.id, { type: "PAGE_METRICS", config: {} });
  if (!m?.ok) throw new Error(m?.error || "Could not measure the page");
  const {
    scrollHeight,
    viewportHeight,
    width,
    dpr = 1,
    scrollY = 0,
  } = m.result;

  let height = scrollHeight;
  if (height > FULL_PAGE_MAX_HEIGHT) {
    height = FULL_PAGE_MAX_HEIGHT;
    _broadcastLog(
      "warn-log",
      `Screenshot: the page is ${scrollHeight}px tall — truncated to ${FULL_PAGE_MAX_HEIGHT}px. ` +
        `An endless feed has no bottom to reach.`,
      runId,
    );
  }

  const shots = Math.ceil(height / viewportHeight);
  if (shots > 4) {
    _broadcastLog(
      "info-log",
      `Screenshot: ${shots} screenfuls to capture — Chrome allows about two a ` +
        `second, so this will take roughly ${Math.ceil((shots * CAPTURE_MIN_INTERVAL_MS) / 1000)}s.`,
      runId,
    );
  }

  const strips = [];
  let format = "png";
  for (let top = 0; top < height; top += viewportHeight) {
    const moved = await _sendToPage(tab.id, {
      type: "SCROLL_TO",
      config: { top },
    });
    if (!moved?.ok)
      throw new Error(moved?.error || "Could not scroll the page");
    // Where the page ran out of scroll, the strip shows a lower offset than
    // asked for — draw it where it actually landed or the join is doubled.
    const landed = Number(moved.result?.top ?? top);
    const cap = await _captureViewport(tab.windowId, config);
    format = cap.format;
    strips.push({ dataUrl: cap.dataUrl, top: Math.round(landed * dpr) });
  }

  // Put the page back where the run had it: leaving it at the bottom breaks
  // every step after this one that depends on what is on screen.
  await _sendToPage(tab.id, {
    type: "SCROLL_TO",
    config: { top: scrollY },
  }).catch(() => {});

  const ext = format === "png" ? "png" : "jpg";
  const mime = format === "png" ? "image/png" : "image/jpeg";
  try {
    const dataUrl = await _stitchStrips(strips, {
      width: Math.round(width * dpr),
      height: Math.round(height * dpr),
      mime,
    });
    return { dataUrl, ext };
  } catch (err) {
    // Said plainly rather than passed off as a full-page shot: the first strip
    // is the top of the page, which is what the old behaviour already gave.
    _broadcastLog(
      "warn-log",
      `Screenshot: ${err.message} Keeping the first screenful only.`,
      runId,
    );
    return { dataUrl: strips[0]?.dataUrl ?? "", ext };
  }
}

/** Photograph one element, by cropping a capture to its box. */
async function _captureElement(tab, config, runId) {
  const box = await _sendToPage(tab.id, {
    type: "ELEMENT_BOX",
    config: { selector: config.selector || "" },
  });
  if (!box?.ok) throw new Error(box?.error || "Could not find that element");
  const { x, y, width, height, dpr = 1 } = box.result;
  if (!(width > 0 && height > 0)) {
    throw new Error(
      `The element matching "${config.selector}" has no size on screen.`,
    );
  }

  const cap = await _captureViewport(tab.windowId, config);
  const ext = cap.format === "png" ? "png" : "jpg";
  const mime = cap.format === "png" ? "image/png" : "image/jpeg";
  const view = box.result.viewport ?? {};
  try {
    const dataUrl = await _stitchStrips([{ dataUrl: cap.dataUrl, top: 0 }], {
      // The canvas the crop is taken *from* is the whole capture, not the
      // element: sizing it to the element would leave everything but the
      // top-left corner of the viewport outside it, and the crop would come
      // back blank for any element not at the very top of the page.
      width: Math.round((view.width ?? width + x) * dpr),
      height: Math.round((view.height ?? height + y) * dpr),
      mime,
      crop: {
        x: Math.round(x * dpr),
        y: Math.round(y * dpr),
        width: Math.round(width * dpr),
        height: Math.round(height * dpr),
      },
    });
    return { dataUrl, ext };
  } catch (err) {
    _broadcastLog(
      "warn-log",
      `Screenshot: ${err.message} Keeping the whole visible area instead.`,
      runId,
    );
    return { dataUrl: cap.dataUrl, ext };
  }
}

async function _executePdfExtraction(config = {}, runId) {
  const source = String(config.source || "url").trim();
  const maxPages = Number(config.maxPages) || 50;
  const storeAs = String(config.storeAs || "pdf_text").trim() || "pdf_text";

  let bytes;

  if (source === "file") {
    const fileId = String(config.fileId || "").trim();
    const stored = await chrome.storage.local.get(STORAGE_FILES_KEY);
    const library = Array.isArray(stored?.[STORAGE_FILES_KEY])
      ? stored[STORAGE_FILES_KEY]
      : [];
    const file = library.find((f) => f.id === fileId);
    if (!file) throw new Error(`PDF file not found in storage: ${fileId}`);
    bytes = _dataUrlToBytes(file.dataUrl);
  } else {
    const fileUrl = String(config.url || "").trim();
    if (!fileUrl) {
      throw new Error("PDF_EXTRACTION requires a PDF URL or file selection");
    }
    // Same origin rules as any other fetch the run makes.
    await _assertOriginAllowed(
      fileUrl,
      _runStates.get(runId),
      "PDF_EXTRACTION",
    );
    const res = await fetch(fileUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch PDF: ${res.status} ${res.statusText}`);
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  }

  // This used to log "use MCP tool pdf_extract_text" and store
  // {status: "pending"} — an instruction the user cannot act on, because there
  // is no bridge from the extension to the MCP server (B-28, G-05). It extracts
  // now, in the worker, with no dependencies.
  const result = await extractPdfText(bytes, { maxPages });

  for (const warning of result.warnings) {
    _broadcastLog("warn-log", `PDF_EXTRACTION: ${warning}`, runId);
  }
  if (result.truncated) {
    _broadcastLog(
      "warn-log",
      `PDF_EXTRACTION: read ${result.pages.length} of ${result.pageCount} pages (maxPages is ${maxPages}).`,
      runId,
    );
  }
  _broadcastLog(
    "info-log",
    `PDF_EXTRACTION: ${result.text.length} characters from ${result.pages.length} page(s).`,
    runId,
  );

  return {
    [storeAs]: {
      text: result.text,
      pages: result.pages,
      pageCount: result.pageCount,
      truncated: result.truncated,
      warnings: result.warnings,
      source,
    },
  };
}

// ── AUTO_EXTRACT orchestrator ──────────────────────────────────────────────────
/**
 * Runs the full cascading extraction pipeline for a single page:
 *   1. Triggers smart-extractor.js (Layers 1 & 2) inside the tab.
 *   2. If confidence is too low and a Gemini key is present, runs Layer 3 LLM.
 *   3. Merges results, returns a single product row.
 *
 * @param {object} config   - Step config ({ confidenceThreshold, useLlm })
 * @param {number} tabId    - Target Chrome tab ID
 * @param {string} runId    - Pipeline run identifier
 * @param {object} ctx      - Runtime context for template resolution
 * @returns {Promise<object>} - Product row with _confidence and _method meta fields
 */
async function _executeAutoExtract(config = {}, tabId, runId, ctx = {}) {
  const threshold = Number(config.confidenceThreshold ?? 70);
  // Default on for pipelines saved before the toggle was honoured.
  const useLlm = config.useLlm !== false;

  // ── Layer 1 & 2: run in-page smart-extractor ──────────────────────────────
  const l12Resp = await _sendToPage(tabId, {
    type: "AUTO_EXTRACT",
    config: { confidenceThreshold: threshold },
  }).catch((err) => ({ ok: false, error: err.message }));

  if (!l12Resp?.ok) {
    throw new Error(
      `AUTO_EXTRACT (L1/L2) failed: ${l12Resp?.error || "No response"}`,
    );
  }

  let extraction = l12Resp.result;

  // ── Layer 3: LLM fallback if confidence is still low ──────────────────────
  if (extraction.needsLlm && !useLlm) {
    // The step's "Enable AI fallback" toggle used to be ignored entirely, so
    // turning it off did not stop the page being sent to Gemini.
    _broadcastLog(
      "warn-log",
      `AUTO_EXTRACT: confidence ${extraction.overallConfidence}% is below ${threshold}%, but AI fallback is off — keeping the L1/L2 result.`,
      runId,
    );
  } else if (extraction.needsLlm && extraction.simplifiedDom) {
    _broadcastLog(
      "info-log",
      `AUTO_EXTRACT: L1/L2 confidence ${extraction.overallConfidence}% — escalating to LLM...`,
      runId,
    );

    // Report *why* the layer produced nothing. This used to be
    // .catch(() => null) with a "skipped or failed" message that covered a
    // missing key, a network error and a malformed response alike.
    let llmResult = null;
    let llmError = null;
    try {
      llmResult = await runLlmLayer(extraction.simplifiedDom);
    } catch (err) {
      llmError = err.message;
    }

    if (llmResult) {
      // LLM wins field-by-field where it has higher confidence
      extraction = _mergeLlmOverL12(extraction, llmResult);
      _broadcastLog(
        "info-log",
        `AUTO_EXTRACT: LLM merged — overall confidence now ${extraction.overallConfidence}%.`,
        runId,
      );
    } else if (llmError) {
      _broadcastLog(
        "warn-log",
        `AUTO_EXTRACT: LLM layer failed (${llmError}) — using L1/L2 result (confidence: ${extraction.overallConfidence}%).`,
        runId,
      );
    } else {
      _broadcastLog(
        "warn-log",
        `AUTO_EXTRACT: no Gemini API key stored, so the AI fallback was skipped — using L1/L2 result (confidence: ${extraction.overallConfidence}%). Add a key in Settings.`,
        runId,
      );
    }
  } else if (!extraction.needsLlm) {
    _broadcastLog(
      "info-log",
      `AUTO_EXTRACT: finished via ${extraction.method} (confidence: ${extraction.overallConfidence}%).`,
      runId,
    );
  }

  // Emit per-field warnings to pipeline log
  for (const warning of extraction.warnings || []) {
    _broadcastLog("warn-log", warning, runId);
  }

  // Build the final row — include confidence metadata as hidden fields
  const row = {
    ...extraction.result,
    _confidence: extraction.overallConfidence,
    _extractionMethod: extraction.method,
  };

  return row;
}

/**
 * Field-level merge: for each field, pick whichever source (L1/L2 or LLM)
 * has higher per-field confidence.
 */
function _mergeLlmOverL12(l12, llm) {
  const fieldList = [
    "name",
    "price",
    "originalPrice",
    "currency",
    "brand",
    "description",
    "sku",
    "availability",
    "rating",
    "reviewCount",
    "images",
  ];

  const mergedResult = { ...(l12.result || {}) };
  const mergedPerField = { ...(l12.perField || {}) };
  const mergedWarnings = [...(l12.warnings || []), ...(llm.warnings || [])];

  for (const field of fieldList) {
    const l12Conf = l12.perField?.[field] ?? 0;
    const llmConf = llm.perField?.[field] ?? 0;
    const llmVal = llm.result?.[field];

    const isEmpty = (v) =>
      v === null ||
      v === undefined ||
      v === "" ||
      (Array.isArray(v) && v.length === 0);

    // LLM wins if: it has a value AND either L1/L2 is empty OR LLM has higher confidence
    if (
      !isEmpty(llmVal) &&
      (isEmpty(mergedResult[field]) || llmConf > l12Conf)
    ) {
      mergedResult[field] = llmVal;
      mergedPerField[field] = llmConf;
    }
  }

  // Recompute overall confidence after merge
  const weights = {
    name: 30,
    price: 25,
    images: 15,
    brand: 10,
    description: 10,
    sku: 5,
    availability: 5,
  };
  let totalWeight = 0,
    weightedSum = 0;
  for (const [field, weight] of Object.entries(weights)) {
    totalWeight += weight;
    weightedSum += (mergedPerField[field] || 0) * weight;
  }
  const overallConfidence = Math.round(weightedSum / totalWeight);

  return {
    result: mergedResult,
    perField: mergedPerField,
    overallConfidence,
    method: llm.method || l12.method,
    warnings: mergedWarnings,
    needsLlm: false,
    simplifiedDom: "",
  };
}

// ── Minimal pure-JS ZIP creator (store, no compression) ───────────────────────
function _buildZip(files) {
  // files: [{name: string, bytes: Uint8Array}]
  const u16 = (n) => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    return b;
  };
  const u32 = (n) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const cat = (...arrays) => {
    const t = arrays.reduce((s, a) => s + a.length, 0),
      r = new Uint8Array(t);
    let o = 0;
    arrays.forEach((a) => {
      r.set(a, o);
      o += a.length;
    });
    return r;
  };
  function crc32(d) {
    let c = -1;
    for (const b of d) {
      c ^= b;
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return ~c >>> 0;
  }
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    const nb = enc.encode(name),
      crc = crc32(bytes),
      sz = bytes.length;
    const lh = cat(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(sz),
      u32(sz),
      u16(nb.length),
      u16(0),
      nb,
      bytes,
    );
    locals.push(lh);
    centrals.push(
      cat(
        new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(sz),
        u32(sz),
        u16(nb.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nb,
      ),
    );
    offset += lh.length;
  }
  const cs = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = cat(
    new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]),
    u16(files.length),
    u16(files.length),
    u32(cs),
    u32(offset),
    u16(0),
  );
  return cat(...locals, ...centrals, eocd);
}

function _dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(",")[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * A stable identity for a row, independent of key order.
 * @param {object} row
 * @returns {string}
 */
function _rowKey(row) {
  if (!row || typeof row !== "object") return JSON.stringify(row);
  return JSON.stringify(
    Object.keys(row)
      .sort()
      .map((k) => [k, row[k]]),
  );
}

/**
 * Bytes to a `data:` URL the downloads API can fetch.
 *
 * A service worker has `Blob` but **not** `URL.createObjectURL` — MV3 removed
 * it from worker contexts. So every EXPORT failed with "URL.createObjectURL is
 * not a function" and downloaded nothing, in every real browser, while the unit
 * tests passed because the worker harness stubs that function (A-12).
 *
 * The comment this replaces argued for Blob URLs on the grounds that "a large
 * export could exceed what a data: URL can carry". The downloads API takes them
 * at least into the tens of megabytes — verified at 20 MB in e2e — and a Blob
 * URL that cannot be created carries nothing at all.
 *
 * @param {Uint8Array} bytes
 * @param {string} mime
 * @returns {string}
 */
function _bytesToDataUrl(bytes, mime) {
  if (bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Export is ${Math.round(bytes.length / 1048576)} MB, over the ` +
        `${Math.round(MAX_DOWNLOAD_BYTES / 1048576)} MB limit for a single download. ` +
        `Export fewer rows, or split the run.`,
    );
  }
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on anything
  // of real size, which is exactly the case that matters here.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Ceiling on one download. Above this the base64 string itself is the problem. */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

async function _doExport(runId, config) {
  const runState = _runStates.get(runId);
  if (!runState) return;
  const idbRows = await readAllRows(runId).catch(() => []);
  const allRows = [...runState.results];
  // Dedup by a key that does not depend on insertion order. JSON.stringify was
  // used directly, so a row read back from IndexedDB with its properties in a
  // different order never matched its in-memory twin and every row came out
  // twice (D-07). Sorting the keys makes the two comparable.
  const seen = new Set(allRows.map(_rowKey));
  for (const r of idbRows) {
    const { runId: _, ...clean } = r;
    const key = _rowKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    allRows.push(clean);
  }

  const screenshots = runState.screenshots || [];
  const enc = new TextEncoder();
  const ts = Date.now();

  // Formatting lives in exporters/row-formatters.js so the service worker, the
  // side panel's partial download and the MCP server all produce identical
  // output. The three inline implementations disagreed: this one turned a
  // legitimate 0 or false into an empty cell, and quoted every CSV field.
  const fmt = ROW_FORMATS.includes(config.format) ? config.format : "csv";
  const { mime: dataMime, ext: dataExt } = formatMeta(fmt);
  const dataContent = formatRows(allRows, fmt);

  const networks = runState.networks || [];
  if (screenshots.length > 0 || networks.length > 0) {
    // Bundle everything into a ZIP
    const zipFiles = [];
    if (allRows.length > 0) {
      zipFiles.push({
        name: `data.${dataExt}`,
        bytes: enc.encode("\uFEFF" + dataContent),
      });
    }
    screenshots.forEach((s, i) => {
      zipFiles.push({
        name: `screenshot_${i + 1}_${s.ts}.${s.ext || "png"}`,
        bytes: _dataUrlToBytes(s.dataUrl),
      });
    });

    if (networks.length > 0) {
      // Same formatter as the data file, so the sniffer log is not a fourth
      // hand-rolled CSV with its own quoting rules.
      const netFormat = fmt === "json" || fmt === "jsonl" ? fmt : "csv";
      zipFiles.push({
        name: `api-sniffer.${formatMeta(netFormat).ext}`,
        bytes: enc.encode(
          netFormat === "csv"
            ? "\uFEFF" + formatRows(networks, netFormat)
            : formatRows(networks, netFormat),
        ),
      });
    }

    const zipBytes = _buildZip(zipFiles);
    await chrome.downloads.download({
      url: _bytesToDataUrl(zipBytes, "application/zip"),
      filename: `flowscrape_export_${ts}.zip`,
      saveAs: false,
    });
    // A short export is never silent: if the capture buffers filled, the count
    // that did not make it is part of the result.
    const dropped =
      (runState.screenshotsDropped || 0) +
      (runState.networksDropped || 0) +
      droppedRowCount(runId);
    _broadcastLog(
      dropped ? "warn-log" : "info-log",
      `Exported ZIP: ${allRows.length} rows, ${screenshots.length} screens, ${networks.length} APIs` +
        (dropped
          ? ` — ${dropped} capture(s) dropped when the buffer filled.`
          : "."),
      runId,
    );
  } else if (allRows.length > 0) {
    // The BOM goes through the encoder with the rest of the content, so it is
    // base64 of real UTF-8 bytes rather than a character dropped into a URL and
    // mangled — which is what the original data: URL build got wrong.
    await chrome.downloads.download({
      url: _bytesToDataUrl(enc.encode("\uFEFF" + dataContent), dataMime),
      filename: `flowscrape_export_${ts}.${dataExt}`,
      saveAs: false,
    });
    _broadcastLog(
      "info-log",
      `Exported ${allRows.length} rows as ${fmt.toUpperCase()}.`,
      runId,
    );
  } else {
    _broadcastLog("warn-log", "Export: no data collected.", runId);
  }
}

// ── Template resolver ── {{loop.index}}, {{item.href}}, {{extracted.name}} ────
function _resolvePath(ctx, expr) {
  const parts = expr.trim().split(".");
  let val = ctx;

  for (let part of parts) {
    if (val === undefined || val === null) return undefined;

    // support data[] indexing and numeric indexing
    const arrayMatch = part.match(/^(.+?)\[(\d+)\]$/);
    if (arrayMatch) {
      const key = arrayMatch[1];
      const idx = Number(arrayMatch[2]);
      val = val?.[key];
      if (!Array.isArray(val)) return undefined;
      val = val[idx];
      continue;
    }

    if (/^\d+$/.test(part)) {
      const idx = Number(part);
      if (!Array.isArray(val)) return undefined;
      val = val[idx];
      continue;
    }

    val = val[part];
  }
  return val;
}

function _resolveStr(s, ctx) {
  if (!s || typeof s !== "string" || !s.includes("{{")) return s;
  return s.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const val = _resolvePath(ctx, expr);
    return val !== undefined && val !== null ? String(val) : "";
  });
}
function _resolveConfig(step, ctx) {
  if (!ctx || !Object.keys(ctx).length) return step;
  // Every string, at any depth. This used to map top-level values only, so a
  // template inside FILL.fields[].value or an EXTRACT field passed through
  // literally and got typed into the page as "{{item.href}}" (B-11).
  // EXTRACT selectors survived by accident, because injector.js re-renders them
  // from __fsContext; resolving here first is a no-op for those.
  return {
    ...step,
    config: _resolveAny(step.config || {}, ctx),
    __fsContext: ctx,
  };
}

function _resolveAny(value, ctx) {
  if (typeof value === "string") return _resolveStr(value, ctx);
  if (Array.isArray(value)) return value.map((v) => _resolveAny(v, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = _resolveAny(v, ctx);
    return out;
  }
  return value;
}

function _parseApiHeaders(rawHeaders, ctx) {
  if (!rawHeaders) return {};
  if (typeof rawHeaders === "string") {
    const rendered = _resolveStr(rawHeaders, ctx);
    try {
      const parsed = JSON.parse(rendered);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return _resolveAny(parsed, ctx);
      }
      return {};
    } catch {
      return {};
    }
  }
  if (
    rawHeaders &&
    typeof rawHeaders === "object" &&
    !Array.isArray(rawHeaders)
  ) {
    return _resolveAny(rawHeaders, ctx);
  }
  return {};
}

async function _executeApiStep(config = {}, ctx = {}) {
  const method = String(config.method || "GET").toUpperCase();
  const url = _resolveStr(config.url || config.endpoint || "", ctx);
  if (!url) throw new Error("API step missing URL");

  const headers = _parseApiHeaders(config.headers, ctx);
  const timeoutMs = Math.max(500, Number(config.timeoutMs ?? 15000));
  const responseType = String(config.responseType || "auto").toLowerCase();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init = {
      method,
      headers,
      signal: controller.signal,
    };

    if (!["GET", "HEAD"].includes(method)) {
      const bodyText = _resolveStr(config.body || "", ctx);
      if (bodyText) {
        if (
          (headers["Content-Type"] || headers["content-type"] || "").includes(
            "application/json",
          )
        ) {
          try {
            init.body = JSON.stringify(JSON.parse(bodyText));
          } catch {
            init.body = bodyText;
          }
        } else {
          init.body = bodyText;
        }
      }
    }

    const startedAt = Date.now();
    const resp = await fetch(url, init);
    const contentType = resp.headers.get("content-type") || "";
    let body;

    if (
      responseType === "json" ||
      (responseType === "auto" && contentType.includes("application/json"))
    ) {
      try {
        body = await resp.json();
      } catch {
        body = await resp.text();
      }
    } else {
      body = await resp.text();
    }

    const result = {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      url: resp.url,
      method,
      elapsedMs: Date.now() - startedAt,
      headers: Object.fromEntries(resp.headers.entries()),
      body,
    };

    if (!resp.ok && config.failOnHttpError !== false) {
      throw new Error(
        `API ${method} ${url} failed: ${resp.status} ${resp.statusText}`,
      );
    }

    return result;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`API ${method} ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function _executeUploadActivityStep(config = {}, tabId, runId = null) {
  const tabData = await chrome.tabs.get(tabId);
  const tabUrl = tabData?.url || "";
  const domain = new URL(tabUrl).hostname;

  const stored = await chrome.storage.local.get(STORAGE_FILES_KEY);
  const library = Array.isArray(stored?.[STORAGE_FILES_KEY])
    ? stored[STORAGE_FILES_KEY]
    : [];

  const selector = String(config.selector || "").trim();
  if (!selector) {
    throw new Error("UPLOAD_ACTIVITY requires a file input selector.");
  }

  const wantedIds = Array.isArray(config.fileIds) ? config.fileIds : [];
  const selected = wantedIds.length
    ? library.filter((f) => wantedIds.includes(f.id))
    : library;

  if (!selected.length) {
    throw new Error(
      "UPLOAD_ACTIVITY has no files selected. Add files in Storage and select them in step config.",
    );
  }

  if (!tabId) {
    throw new Error("No target tab for UPLOAD_ACTIVITY.");
  }

  // This used to say to use MCP tool "upload_file_to_site", which is not one of
  // the server's registered tools and never was — and there is no bridge from
  // the extension to the MCP server anyway, so it was an instruction nobody
  // could act on (G-05). Say what is actually true instead.
  if (RESTRICTED_UPLOAD_SITES[domain]) {
    _broadcastLog(
      "warn-log",
      `⚠️ ${domain} blocks script-driven file uploads. The step will try anyway; ` +
        `if it fails, the file has to be attached by hand.`,
      runId,
    );
  }

  _broadcastLog(
    "info-log",
    `Upload Activity: uploading ${selected.length} file(s) to ${selector}`,
    runId,
  );

  const resp = await chrome.tabs
    .sendMessage(tabId, {
      type: "step:execute",
      payload: {
        type: "UPLOAD_ACTIVITY",
        config: {
          selector,
          files: selected.map((file) => ({
            name: file.name,
            type: file.type || "application/octet-stream",
            dataUrl: file.dataUrl,
          })),
        },
      },
    })
    .catch((err) => ({ ok: false, error: err?.message }));

  if (!resp?.ok) {
    throw new Error(resp?.error || "Upload failed in page context.");
  }

  _broadcastLog(
    "info-log",
    `Upload Activity complete: ${selected.length} file(s) staged in target input.`,
    runId,
  );

  return {
    uploaded: selected.length,
    fileNames: selected.map((f) => f.name),
  };
}

/**
 * Ceiling on any single loop, whatever the page reports. A selector that
 * matches thousands of nodes should not be able to wedge the worker in a loop
 * no one can see the end of.
 */
const LOOP_HARD_CAP = 10000;

async function _executeLoop(step, tabId, runId, parentCtx = {}) {
  const {
    type: ltype = "count",
    selector = "",
    max = 10,
    onFail = "skip",
  } = step.config;
  const children = step.children || [];
  const limit = Number(max);
  let iters;
  let elementsData = null;

  if (ltype === "elements" && selector) {
    let found = null;
    try {
      // Pre-collect ALL element data upfront so templates can use {{item.href}}, {{item.text}} etc.
      const r = await _sendToPage(tabId, {
        type: "QUERY_ELEMENTS",
        config: { selector },
      });
      if (r?.ok && Array.isArray(r.result)) found = r.result;
    } catch (e) {
      // Falling through with elementsData still null used to leave iters at
      // `max`, so a failed query quietly ran the body N times against empty
      // items instead of skipping the loop.
      _broadcastLog(
        "warn-log",
        `Loop: element query failed: ${e.message}`,
        runId,
      );
      return;
    }

    if (!found || found.length === 0) {
      _broadcastLog(
        "warn-log",
        `Loop: no elements matched "${selector}" — skipping.`,
        runId,
      );
      return;
    }

    elementsData = found;
    // Here 0 really does mean unlimited, as the UI says — bounded only by how
    // many elements the page has, and by the hard cap below.
    iters = limit > 0 ? Math.min(found.length, limit) : found.length;
    _broadcastLog(
      "info-log",
      `Loop: found ${found.length} elements for "${selector}"`,
      runId,
    );
  } else {
    // count and paginate. There is nothing to derive a bound from here, so 0 is
    // not "unlimited" — it is a loop that runs zero times and says nothing,
    // which is what it silently did (B-22).
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(
        `Loop in "${ltype}" mode needs a repeat count of at least 1 (got ${max}). ` +
          `Only "elements" mode treats 0 as unlimited, because the page supplies the bound.`,
      );
    }
    iters = limit;
  }

  if (iters > LOOP_HARD_CAP) {
    _broadcastLog(
      "warn-log",
      `Loop: ${iters} iterations exceeds the ${LOOP_HARD_CAP} cap — running ${LOOP_HARD_CAP}.`,
      runId,
    );
    iters = LOOP_HARD_CAP;
  }

  const runState = _runStates.get(runId);
  for (let i = 0; i < iters && runState?.active; i++) {
    const item = elementsData?.[i] ?? {
      index: i + 1,
      index0: i,
      text: "",
      href: "",
      src: "",
      value: "",
    };
    const isFirst = i === 0;
    const isLast = i === iters - 1;

    const loopCtx = {
      ...parentCtx,
      loop: {
        index: i + 1,
        index0: i,
        count: iters,
        selector,
        items: elementsData || [],
        first: isFirst,
        last: isLast,
        current: item,
      },
      item,
    };

    if (ltype === "paginate" && i > 0 && selector) {
      // PAGINATE, not CLICK. A click past the last page matches nothing and
      // reports success, so the loop used to re-scrape the final page until
      // "max pages" ran out — duplicate rows, and no sign of a problem (the
      // dedup in the exporter hid the evidence too). PAGINATE says whether
      // there was another page.
      let paged;
      try {
        paged = await _executePaginate(tabId, {
          selector,
          settleMs: step.config.settleMs,
          requireChange: step.config.requireChange,
        });
      } catch (e) {
        _broadcastLog(
          "warn-log",
          `Loop: pagination failed on page ${i + 1} — ${e.message}`,
          runId,
        );
        break;
      }
      if (paged.exhausted) {
        const why = paged.reason || "no further pages";
        _broadcastLog(
          "info-log",
          `Loop: stopped after ${i} page${i === 1 ? "" : "s"} — ${why}.`,
          runId,
        );
        break;
      }
    }
    try {
      await _executeStepList(children, tabId, runId, loopCtx);
      _broadcastLog("info-log", `Loop [${i + 1}/${iters}] done.`, runId);
    } catch (e) {
      _broadcastLog(
        "warn-log",
        `Loop [${i + 1}/${iters}] — ${e.message}`,
        runId,
      );
      if (onFail === "stop") break;
    }
  }
}

async function _executeIfElse(step, tabId, runId, parentCtx = {}) {
  const resolved = _resolveConfig(step, parentCtx);
  const condition = resolved.config.condition || "exists";
  let met = false;

  try {
    // The page reports what it saw; the comparison happens here, against the
    // one shared definition, so a numeric branch uses the same number reader
    // EXTRACT does.
    const r = await _sendToPage(tabId, resolved);
    if (!r?.ok) throw new Error(r?.error || "could not read the page");
    met = evaluateCondition(condition, r.result, resolved.config);
  } catch (err) {
    // This used to swallow everything into `met = false` and take ELSE, so a
    // broken condition — a bad pattern, a non-numeric comparison value, a dead
    // tab — was indistinguishable from an unmet one.
    _broadcastLog(
      "warn-log",
      `IF_ELSE (${condition}) could not be evaluated: ${err.message} — taking the ELSE branch.`,
      runId,
    );
    met = false;
  }

  _broadcastLog(
    "info-log",
    `IF_ELSE: condition ${met ? "met → IF" : "not met → ELSE"} branch.`,
    runId,
  );
  await _executeStepList(
    met ? step.ifBranch || [] : step.elseBranch || [],
    tabId,
    runId,
    parentCtx,
  );
}

/**
 * Apply each EXTRACT field's transforms to the rows the page produced.
 *
 * Here rather than in the content script for three reasons: the transforms are
 * an ES module and a classic content script cannot import one, so doing it in
 * the page would mean a second copy that drifts (G-01); the worker knows the
 * tab's URL, which is what a relative link has to be resolved against; and a
 * failing transform can then name the field it failed on, rather than surfacing
 * as a column quietly full of nulls.
 *
 * @param {object[]} rows
 * @param {object} config - the EXTRACT step's config, for its `fields`
 * @param {number} tabId
 * @returns {Promise<object[]>}
 */
async function _transformRows(rows, config = {}, tabId) {
  const fields = (config.fields ?? []).filter(
    (f) => Array.isArray(f.transform) && f.transform.length > 0,
  );
  if (fields.length === 0) return rows;

  // Only fetched when something actually needs it.
  let base = "";
  if (fields.some((f) => f.transform.includes("url"))) {
    base = (await chrome.tabs.get(tabId).catch(() => null))?.url || "";
  }

  return rows.map((row) => {
    const out = { ...row };
    for (const field of fields) {
      const name = field.name || "data";
      if (!(name in out)) continue;
      try {
        out[name] = applyTransforms(out[name], field.transform, {
          base,
          pattern: field.regexPattern,
        });
      } catch (err) {
        throw new Error(`EXTRACT field "${name}": ${err.message}`);
      }
    }
    return out;
  });
}

/** How long a navigation may take before the run stops waiting for it. */
const NAV_TIMEOUT_MS = 30000;

/**
 * Wait for a tab to finish loading.
 *
 * NAVIGATE used to `_sleep(3000)` and hope. On a slow site the next step ran
 * against a blank page and extracted nothing; on a fast one every navigation
 * cost three seconds, which inside a loop over 200 links is ten minutes of
 * doing nothing.
 *
 * Polling rather than chrome.tabs.onUpdated: the listener has to be added
 * before the navigation and removed on every exit path, and a service worker
 * that is torn down mid-wait leaks it. A poll has no such state.
 *
 * @returns {Promise<boolean>} false if the timeout was reached first
 */
async function _waitForTabLoad(tabId, timeoutMs = NAV_TIMEOUT_MS) {
  // Chrome does not flip `status` to "loading" synchronously with the
  // tabs.update call, so an immediate first poll can still see the *previous*
  // page sitting at "complete" and return before anything has moved.
  await _sleep(150);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false; // the tab is gone; the caller's next step will say so
    }
    if (tab?.status === "complete") return true;
    await _sleep(150);
  }
  return false;
}

/**
 * Turn to the next page, and report whether there was one.
 *
 * Split across two messages on purpose. Clicking a real `<a href>` navigates
 * the tab: the content script is destroyed with the document, its reply is
 * never delivered, and Chrome surfaces "the message channel closed before a
 * response was received". A page-side step that both decides and clicks
 * therefore fails on exactly the sites pagination is for. So the page answers
 * the question first, the worker performs the click, and losing the page after
 * it is the expected outcome rather than an error.
 *
 * @returns {Promise<{paginated: boolean, exhausted: boolean, reason: string}>}
 */
async function _executePaginate(tabId, config = {}) {
  const selector = String(config.selector || "").trim();
  if (!selector) throw new Error("Paginate: no Next selector configured.");
  const settleMs =
    Number(config.settleMs) >= 0 ? Number(config.settleMs) : 1500;

  const probe = await _sendToPage(tabId, {
    type: "PAGINATE_PROBE",
    config: { selector },
  });
  if (!probe?.ok) throw new Error(probe?.error || "Paginate: probe failed");
  if (probe.result.exhausted) {
    return { paginated: false, exhausted: true, reason: probe.result.reason };
  }
  const before = probe.result.fingerprint;

  try {
    // Deliberately not _sendToPage: a lost reply here means the click
    // navigated, and re-sending it would turn a second page.
    await chrome.tabs.sendMessage(tabId, {
      type: "step:execute",
      payload: { type: "PAGINATE", config: { selector } },
    });
  } catch (err) {
    // The click took the content script with it, which is success. Anything
    // else is not.
    if (!_GONE.test(err.message)) throw err;
  }

  await _waitForTabLoad(tabId, NAV_TIMEOUT_MS);
  if (settleMs > 0) await _sleep(settleMs);

  if (config.requireChange) {
    // For a paginator whose Next button is always present and always enabled —
    // a common single-page-app shape — an unchanged page is the only signal
    // that the pages have run out.
    const after = await _sendToPage(tabId, {
      type: "PAGINATE_PROBE",
      config: { selector },
    }).catch(() => null);
    if (after?.ok && after.result.fingerprint === before) {
      return {
        paginated: false,
        exhausted: true,
        reason: "the page did not change after clicking Next",
      };
    }
  }

  return { paginated: true, exhausted: false, reason: "" };
}

/**
 * Execute one already-resolved step.
 *
 * This chain used to exist twice — once in _executeStepList for loop and branch
 * bodies, once inline in _executePipeline for top-level steps — and the copies
 * had already drifted: only the nested one flushed the row buffer before an
 * EXPORT. Adding the B-03 origin check meant patching four call sites instead
 * of two, which is what prompted merging them.
 *
 * @param {object} step     - resolved step (templates already applied)
 * @param {number} tabId
 * @param {string} runId
 * @param {object} ctx      - mutable run context; EXTRACT and API results land here
 */
async function _dispatchStep(step, tabId, runId, ctx) {
  const runState = _runStates.get(runId);

  switch (step.type) {
    case "WEBSITE":
    case "NAVIGATE": {
      _assertOriginAllowed(step.config.url, runState, step.type);
      await chrome.tabs.update(tabId, { url: step.config.url });
      if (step.config.wait === false) {
        // The user asked not to wait; still give the navigation a beat to
        // commit, or the next step runs against the page being replaced.
        await _sleep(400);
        return;
      }
      const timeoutMs = Number(step.config.timeoutMs) || NAV_TIMEOUT_MS;
      const loaded = await _waitForTabLoad(tabId, timeoutMs);
      if (!loaded) {
        _broadcastLog(
          "warn-log",
          `${step.type}: the page was still loading after ${Math.round(timeoutMs / 1000)}s — continuing anyway.`,
          runId,
        );
      }
      return;
    }

    case "WAIT": {
      const waitMode = step.config.mode || "fixed";
      if (waitMode === "fixed") {
        await _sleep(Number(step.config.ms) || 1000);
        return;
      }
      // Every other mode needs to watch the DOM, so it belongs to the page.
      // The content script has implemented them since the beginning; nothing
      // had ever sent them there, which made them unreachable.
      await _ensureInjected(tabId);
      const waitResp = await _sendToPage(tabId, step);
      if (!waitResp?.ok) {
        throw new Error(waitResp?.error || `WAIT (${waitMode}) failed`);
      }
      return;
    }

    case "SCREENSHOT":
      await _captureScreenshot(tabId, step.config, runId);
      return;

    case "API": {
      _assertOriginAllowed(step.config.url, runState, "API");
      const apiResult = await _executeApiStep(step.config, ctx);
      const storeAs = String(step.config.storeAs || "api").trim() || "api";
      ctx[storeAs] = apiResult;
      ctx.api = apiResult;
      if (
        step.config.exposeBodyAsExtracted === true &&
        apiResult.body &&
        typeof apiResult.body === "object" &&
        !Array.isArray(apiResult.body)
      ) {
        Object.assign(ctx.extracted, apiResult.body);
      }
      _broadcastLog(
        "info-log",
        `API ${apiResult.method} ${apiResult.url} → ${apiResult.status}`,
        runId,
      );
      return;
    }

    case "API_SNIFFER":
      // Capture is set up when the run starts; nothing to do per step.
      await _sleep(50);
      return;

    case "PDF_EXTRACTION": {
      const pdfResult = await _executePdfExtraction(step.config, runId);
      const storeAs = Object.keys(pdfResult)[0] || "pdf_text";
      ctx[storeAs] = pdfResult[storeAs];
      return;
    }

    case "UPLOAD_ACTIVITY":
      await _executeUploadActivityStep(step.config, tabId, runId);
      return;

    case "AUTO_EXTRACT": {
      const row = await _executeAutoExtract(step.config, tabId, runId, ctx);
      runState.results.push(row);
      await pushRow(runId, row);
      Object.assign(ctx.extracted, row);
      _broadcastLog(
        "info-log",
        `AUTO_EXTRACT: product row saved (confidence: ${row._confidence}%).`,
        runId,
      );
      return;
    }

    case "EXPORT":
      // Flush buffered rows first, or the export misses anything still in
      // memory. The top-level copy of this chain did not do it.
      await finalizeBuffer(runId).catch(() => {});
      initBuffer(runId);
      await _doExport(runId, step.config);
      return;

    case "PAGE_DATA": {
      const resp = await _sendToPage(tabId, step);
      if (!resp?.ok) throw new Error(resp?.error || "PAGE_DATA failed");
      const data = resp.result;
      const storeAs = String(step.config.storeAs || "pageData").trim();
      ctx[storeAs || "pageData"] = data;

      for (const warning of data.warnings ?? []) {
        _broadcastLog("warn-log", `PAGE_DATA: ${warning}`, runId);
      }

      if (!data.found) {
        // Not an error: a pipeline reading many pages should not stop because
        // one of them carries no markup. But it must not be silent either —
        // an empty export with no explanation is the thing this step exists
        // to replace.
        _broadcastLog("warn-log", `PAGE_DATA: ${data.reason}`, runId);
        return;
      }

      const rows = data.records ?? [];
      runState.results.push(...rows);
      for (const row of rows) await pushRow(runId, row);
      if (rows.length > 0) {
        Object.assign(ctx.extracted, rows[rows.length - 1]);
      }
      _broadcastLog(
        "info-log",
        rows.length
          ? `PAGE_DATA: read ${rows.length} record${rows.length === 1 ? "" : "s"} from ${data.sources.join(" + ")}.`
          : `PAGE_DATA: no records, but ${Object.keys(data.meta ?? {}).length} page tags read.`,
        runId,
      );
      return;
    }

    case "PAGINATE": {
      const paged = await _executePaginate(tabId, step.config);
      if (paged.exhausted) {
        _broadcastLog("info-log", `Paginate: ${paged.reason}`, runId);
      }
      return;
    }

    case "LOOP":
      await _executeLoop(step, tabId, runId, ctx);
      return;

    case "IF_ELSE":
      await _executeIfElse(step, tabId, runId, ctx);
      return;

    default: {
      const resp = await _sendToPage(tabId, step);
      if (!resp?.ok) throw new Error(resp?.error || "Step failed");

      if (step.type === "EXTRACT" && Array.isArray(resp.result)) {
        const rows = await _transformRows(resp.result, step.config, tabId);
        runState.results.push(...rows);
        for (const row of rows) await pushRow(runId, row);
        _broadcastLog(
          "info-log",
          `Extracted ${rows.length} rows (total: ${runState.results.length}).`,
          runId,
        );
        // Without this the count only moves on the next step's status message,
        // so the last EXTRACT of a run never showed its rows at all.
        chrome.runtime
          .sendMessage({
            type: "pipeline:status",
            payload: {
              state: "running",
              rows: runState.results.length,
              runId,
              tabId: runState.tabId,
            },
          })
          .catch(() => {});
        // So later steps can reference {{extracted.fieldName}}
        if (rows.length > 0) {
          Object.assign(ctx.extracted, rows[rows.length - 1]);
        }
      }
    }
  }
}

/**
 * Step types that touch the page or the network, and so should be paced.
 *
 * WAIT, EXPORT and the two containers are excluded: WAIT is already a delay,
 * EXPORT is local, and LOOP and IF_ELSE recurse into this same loop, so their
 * children are paced individually and charging the container too would
 * double-count.
 */
const RATE_LIMITED_STEPS = new Set(
  ALL_STEP_TYPES.filter(
    (t) => !["WAIT", "EXPORT", "LOOP", "IF_ELSE"].includes(t),
  ),
);

/** The bucket key for a run: its target host, or one shared default. */
function _runDomain(runState) {
  try {
    return new URL(runState?.targetOrigin ?? "").hostname || "default";
  } catch {
    return "default";
  }
}

/**
 * Run a list of steps in order.
 *
 * @param {object[]} steps
 * @param {number} tabId
 * @param {string} runId
 * @param {object} ctx
 * @param {{ total: number, count: number }} [progress] - present only for the
 *   top-level list. Its presence also selects the error policy: at the top
 *   level a non-optional failure stops the run, whereas nested it propagates so
 *   the enclosing LOOP can apply its own onFail setting.
 */
async function _executeSteps(steps, tabId, runId, ctx, progress = null) {
  const runState = _runStates.get(runId);

  for (const step of steps) {
    if (!runState || !runState.active) break;

    // Hold here while paused. The old _executePipeline loop did this and the
    // merge in B-27 dropped it, so pause silently stopped working — it lives
    // here now, which also means it applies inside loops and branches for the
    // first time.
    while (runState.paused && runState.active) {
      await _sleep(500);
    }
    if (!runState.active) break;

    const resolvedStep = _resolveConfig(step, ctx);

    // Pace the run. Ethics gate 3 warns about request volume and nothing
    // enforced it — rate-limiter.js was imported for two form-fill handlers
    // that are themselves unreachable (audit F-09), while the emitted Python
    // told the reader "MIN_DELAY_MS = 800  # Floor enforced by FlowScrape
    // ethics engine", which was not true of the extension. It is now.
    if (RATE_LIMITED_STEPS.has(resolvedStep.type)) {
      await acquire(_runDomain(runState));
    }

    chrome.runtime
      .sendMessage({
        type: "pipeline:status",
        payload: {
          state: "running",
          currentStepId: step.id,
          progress: progress
            ? { current: progress.count, total: progress.total }
            : {},
          // Rows collected so far. The panel's "Processed" card used to show
          // progress.current, which counts steps — next to a Download Data
          // button, so it read as a row count and was not one (E-04).
          rows: runState?.results.length ?? 0,
          runId,
          tabId: runState?.tabId,
        },
      })
      .catch(() => {});

    try {
      await _dispatchStep(resolvedStep, tabId, runId, ctx);
    } catch (err) {
      const optional = Boolean(resolvedStep.config?.optional);
      _broadcastLog(
        optional ? "warn-log" : "error-log",
        `[${resolvedStep.type}] ${err.message}${optional ? " (optional, skipping)" : ""}`,
        runId,
      );

      if (!optional) {
        if (!progress) throw err; // nested: the LOOP decides what to do
        runState.active = false;
        break;
      }
    }

    if (progress) {
      progress.count += 1;
      await saveCursor({
        runId,
        rowIndex: progress.count,
        stepIndex: progress.count,
      }).catch(() => {});
    }
  }
}

/** Loop and branch bodies. */
function _executeStepList(steps, tabId, runId, ctx = {}) {
  // A child list gets its own `extracted` layer so a nested EXTRACT does not
  // leak back into the parent's context.
  return _executeSteps(
    steps,
    tabId,
    runId,
    { ...ctx, extracted: { ...(ctx.extracted || {}) } },
    null,
  );
}

// ── Background Execution Orchestrator ─────────────────────────────────────────
async function _executePipeline(runId, pipeline, targetTabId) {
  const progress = { count: 0, total: pipeline.steps.length };
  const runtimeCtx = { extracted: {} };
  initBuffer(runId);

  try {
    await _executeSteps(
      pipeline.steps,
      targetTabId,
      runId,
      runtimeCtx,
      progress,
    );
  } catch (err) {
    // _executeSteps handles per-step failures at the top level; anything
    // reaching here is the orchestration itself failing.
    logger.error(MODULE, "pipeline-crash", { runId, error: err.message });
    _broadcastLog("error-log", `Pipeline stopped: ${err.message}`, runId);
    const rs = _runStates.get(runId);
    if (rs) rs.active = false;
  }

  await finalizeBuffer(runId).catch(() => {});
  await _disableSniffer(runId);

  const endRunState = _runStates.get(runId);
  const stateStr = endRunState?.active ? "completed" : "stopped";

  chrome.runtime
    .sendMessage({
      type: "pipeline:status",
      payload: {
        state: stateStr,
        currentStepId: null,
        progress: { current: progress.count, total: progress.total },
        runId,
      },
    })
    .catch(() => {});

  // A finished run is not resumable. markRunCompleted was exported and called
  // from nowhere, so cursors accumulated forever and every completed run kept
  // showing up in the resume banner (audit B-26). A run the user stopped keeps
  // its cursor, because its rows are still worth recovering.
  if (stateStr === "completed") {
    await markRunCompleted(runId).catch(() => {});
  }

  // Keep what the run captured. Rows survive in IndexedDB; screenshots and
  // sniffed requests lived only on the run state, so deleting it threw them
  // away at the exact moment the user goes looking for them — which is why
  // the sniffer appeared to capture nothing when it had captured plenty.
  _keepCaptures(runId, _runStates.get(runId));
  _runStates.delete(runId);
  if (_runStates.size === 0) {
    _stopHeartbeat();
  }
}

// The picker is driven straight from the panel with chrome.tabs.sendMessage, so
// it needs its own way to make sure the page is ready first (C-09).
/**
 * Read the repeating structures on a page.
 *
 * The panel drives this: rather than the user naming and picking each field,
 * the page is read and offered as tables to choose from.
 */
_registerHandler("content:detect", async (payload, sender) => {
  const tabId = payload?.tabId ?? sender.tab?.id;
  if (!tabId) throw new Error("No tab to read");
  await _ensureInjected(tabId);
  const resp = await chrome.tabs.sendMessage(tabId, {
    type: "FS_DETECT_STRUCTURE",
    payload: {},
  });
  if (!resp?.ok) throw new Error(resp?.error || "Could not read the page");
  return resp.result;
});

_registerHandler("content:ensure", async (payload, sender) => {
  const tabId = payload?.tabId ?? sender.tab?.id;
  await _ensureInjected(tabId);
  return { ready: true };
});

/**
 * Steps that only mean something inside a run.
 *
 * A LOOP has nothing to iterate, an EXPORT has no rows, and API_SNIFFER is a
 * run-wide capture that does nothing as a step. Saying so is the point: these
 * used to be forwarded to the page, which answered "Unknown step type: LOOP"
 * — a message that reads like the step is broken.
 *
 * @type {Record<string, string>}
 */
const RUN_ONLY_STEPS = {
  LOOP: "A loop needs a pipeline to iterate. Press Run to see it work — its steps can be tested one at a time.",
  EXPORT:
    "An export needs the rows a run collected. Press Run; the file is written when the run reaches this step.",
  API_SNIFFER:
    "The sniffer records network traffic for the whole run rather than doing anything at this point in it. Press Run, then look at the monitor.",
};

_registerHandler(MSG.STEP_EXECUTE, async (payload, sender) => {
  const { step, tabId } = payload;
  const targetTabId = tabId ?? sender.tab?.id;
  const testCtx = payload?.context || {};
  const resolvedStep = _resolveConfig(step, testCtx);
  const type = resolvedStep.type;

  if (RUN_ONLY_STEPS[type]) throw new Error(RUN_ONLY_STEPS[type]);

  if (type === "API") return _executeApiStep(resolvedStep.config, testCtx);

  if (type === "PDF_EXTRACTION") {
    return _executePdfExtraction(resolvedStep.config, null);
  }

  if (!targetTabId) {
    throw new Error("No target tab specified for execution test");
  }

  if (type === "UPLOAD_ACTIVITY") {
    return _executeUploadActivityStep(resolvedStep.config, targetTabId, null);
  }

  // Testing a single step is the other path that needs the page set up (C-09).
  await _ensureInjected(targetTabId);

  if (type === "SCREENSHOT") {
    return _takeShot(targetTabId, resolvedStep.config, null);
  }

  if (type === "PAGINATE") {
    // The same helper the run uses, rather than a second copy that drifts.
    return _executePaginate(targetTabId, resolvedStep.config);
  }

  if (type === "AUTO_EXTRACT") {
    return _executeAutoExtract(resolvedStep.config, targetTabId, null, {
      extracted: {},
    });
  }

  if (type === "WEBSITE" || type === "NAVIGATE") {
    await chrome.tabs.update(targetTabId, { url: resolvedStep.config.url });
    // Wait the same way a run does. Returning the moment the tab was told to
    // navigate meant testing a step reported success against the page being
    // replaced, so "Test step" and "Run" disagreed about what the step did.
    const loaded =
      resolvedStep.config.wait === false
        ? false
        : await _waitForTabLoad(
            targetTabId,
            Number(resolvedStep.config.timeoutMs) || NAV_TIMEOUT_MS,
          );
    return { navigated: true, url: resolvedStep.config.url, loaded };
  }

  // WAIT is the one type that runs in both places: a fixed wait needs no page,
  // and every other mode watches the DOM. Mirrors _dispatchStep.
  const isPageWait =
    type === "WAIT" && (resolvedStep.config.mode || "fixed") !== "fixed";
  if (type === "WAIT" && !isPageWait) {
    await _sleep(Number(resolvedStep.config.ms) || 1000);
    return { waited: true, mode: "fixed" };
  }

  // Everything left should be a page step. Checked against the registry rather
  // than assumed: a background type reaching injector.js gets "Unknown step
  // type", which is how testing LOOP, API_SNIFFER and PDF_EXTRACTION all
  // failed with a message that read like the step was broken. A hand-kept list
  // of exceptions is what drifted; the registry already knows (G-01).
  if (STEP_TYPES[type]?.runsIn === "background" && !isPageWait) {
    throw new Error(
      `${type} runs in the extension, not in the page, and testing it on its own is not wired up. Please report this.`,
    );
  }

  // _sendToPage puts the content script back if the page has navigated since
  // it was injected; only a tab that refuses injection outright reaches the
  // message below.
  let resp;
  try {
    resp = await _sendToPage(targetTabId, resolvedStep);
  } catch (err) {
    if (_GONE.test(err.message)) {
      throw new Error(
        "Could not reach this page. Reload the tab and try again.",
      );
    }
    throw err;
  }

  if (!resp || !resp.ok) {
    throw new Error(resp?.error || "Test failed inside content environment");
  }
  return resp.result;
});

_registerHandler(MSG.PIPELINE_PAUSE, async (payload) => {
  const rs = _runStates.get(payload?.runId);
  if (!rs) return { ok: false, paused: false };
  rs.paused = true;
  logger.info(MODULE, "pipeline-paused", { runId: rs.runId });
  _broadcastLog(
    "warn-log",
    "Paused. The current step finishes first.",
    rs.runId,
  );
  return { ok: true, paused: true };
});

// There was no resume: PIPELINE_PAUSE could set the flag and only PIPELINE_STOP
// ever cleared it, so pausing a run meant ending it.
_registerHandler(MSG.PIPELINE_RESUME, async (payload) => {
  const rs = _runStates.get(payload?.runId);
  if (!rs) return { ok: false, paused: false };
  rs.paused = false;
  logger.info(MODULE, "pipeline-resumed", { runId: rs.runId });
  _broadcastLog("info-log", "Resumed.", rs.runId);
  return { ok: true, paused: false };
});

_registerHandler(MSG.PIPELINE_STOP, async (payload) => {
  const rs = _runStates.get(payload?.runId);
  if (rs) {
    rs.active = false;
    rs.paused = false;
    logger.info(MODULE, "pipeline-stopped", { runId: rs.runId });
  }
  if (_runStates.size === 0) _stopHeartbeat();
  return { ok: true };
});

_registerHandler(MSG.PIPELINE_STATUS, async (payload) => {
  const runState = _runStates.get(payload?.runId);

  // `known` separates "that run finished" from "this worker has no memory of
  // that run". _runStates is in-memory only, so an MV3 termination mid-run
  // leaves the side panel showing a Stop button for something that no longer
  // exists. The panel polls this and can tell the difference.
  if (!runState) {
    return {
      known: false,
      active: false,
      paused: false,
      runId: payload?.runId,
    };
  }

  return {
    known: true,
    active: runState.active,
    paused: runState.paused,
    runId: runState.runId,
    rowCount: runState.results.length,
  };
});

_registerHandler(MSG.PROXY_SELECT, async (payload) => {
  const proxy = selectProxy(payload?.context ?? {});
  if (!proxy) throw new Error("No alive proxies");
  // Strip credentials from response — content script does not need them
  const { user, pass, ...safe } = proxy;
  return safe;
});

_registerHandler(MSG.PROXY_ROTATE, async (payload) => {
  const proxy = await rotateProxy(payload?.context ?? {});
  if (!proxy) throw new Error("Proxy rotation failed");
  const { user, pass, ...safe } = proxy;
  return safe;
});

_registerHandler(MSG.PROXY_TEST, async (payload) => {
  const { autoRemoveDead = false, retryCount = 3 } = payload ?? {};
  await testAllProxies({ autoRemoveDead, retryCount });
  return { ok: true };
});

_registerHandler(MSG.CAPTCHA_SOLVE, async (payload) => {
  const { solveCaptcha } = await import("./api-key-manager.js");
  const token = await solveCaptcha(payload);
  return { token };
});

// Never returns key values — only which providers have one stored and, on
// request, whether that key actually works.
//
// This handler used to import getApiKey and validateApiKey (and import the
// module twice), use neither, and return the provider list alone. So no key was
// ever validated: all six _validate* functions in api-key-manager.js were
// unreachable, and saving a bad key gave the same "saved" as a good one (F-03).
_registerHandler(MSG.KEY_GET, async (payload) => {
  const { listProviders, validateApiKey } =
    await import("./api-key-manager.js");
  const providers = await listProviders();
  if (!payload?.validate) return { providers };

  // Validation makes a network call per provider, so it is opt-in.
  const only = payload.provider ? [payload.provider] : providers;
  const results = {};
  for (const provider of only) {
    if (!providers.includes(provider)) {
      results[provider] = { valid: false, error: "No key stored" };
      continue;
    }
    try {
      results[provider] = await validateApiKey(provider);
    } catch (err) {
      results[provider] = { valid: null, error: err.message };
    }
  }
  return { providers, validation: results };
});

_registerHandler(MSG.FORM_ROW_START, async (payload) => {
  const { rowIndex, domain } = payload;
  // Rate limit acquisition
  await acquire(domain ?? "default", 1);
  logger.info(MODULE, "form-row-start", { rowIndex });
  return { ok: true };
});

_registerHandler(MSG.FORM_ROW_RESULT, async (payload) => {
  const { rowIndex, status, error } = payload;
  logger.info(MODULE, "form-row-result", { rowIndex, status });
  // Reset retry state on success
  if (status === "success") resetRetry(payload.domain ?? "default");
  return { ok: true };
});

_registerHandler(MSG.CHECKPOINT_SAVE, async (payload) => {
  const { runId, cursorData } = payload;
  await chrome.storage.local.set({
    [`fs_checkpoint_${runId}`]: { ...cursorData, savedAt: Date.now() },
  });
  logger.info(MODULE, "checkpoint-saved", { runId });
  return { ok: true };
});

// ── New handlers: wire up previously dead UI buttons ──────────────────────────

// Wire up API key save buttons
_registerHandler("key:set", async (payload) => {
  const { setApiKey } = await import("./api-key-manager.js");
  await setApiKey(payload.provider, payload.value);
  return { ok: true };
});

// Wire up proxy update button
_registerHandler("proxy:update", async (payload) => {
  const entries = parseProxyText(payload.text);
  addToPool(entries);
  if (payload.mode) setRotationMode(payload.mode);
  await savePool();
  return { ok: true, count: entries.length };
});

// Wire up script export button
_registerHandler("script:export", async (payload) => {
  try {
    const { ast } = compilePipeline(payload.pipeline);
    if (!ast) throw new Error("Pipeline compilation returned empty AST");

    // Steps the emitters cannot express are reported alongside the code. They
    // used to become a `# TODO` comment, so the exported script looked
    // complete, ran, and silently did less than the pipeline.
    const unexportable = findUnexportableSteps(ast);

    // Templates are resolved by this executor at run time; a standalone script
    // has nothing to resolve them with, so they are named before download
    // rather than shipped as literal braces in a URL (B-16).
    const templates = findUnresolvedTemplates(ast);

    // Credentials become __FS_ENV__NAME__ markers that both emitters resolve
    // from the environment. Only proxy credentials were handled before, so a
    // password or an Authorization header went into the file in plaintext
    // (B-14). Must run after the two scans, which read the original values.
    const secrets = redactSecrets(ast);

    const code = payload.format === "node" ? emitNode(ast) : emitPython(ast);

    return { code, unexportable, templates, secrets };
  } catch (err) {
    throw new Error(`Script export failed: ${err.message}`);
  }
});

// Wire up checkpoint/resume check
_registerHandler("checkpoint:check", async () => {
  return await getResumePayload();
});

// Wire up partial data download
_registerHandler("data:download", async (payload) => {
  const runId = payload?.runId;
  if (!runId) {
    // The caller used to pass the string "latest" as a sentinel, which matched
    // no index key, so the download reported "no data" rather than an error.
    throw new Error("data:download requires a runId");
  }
  const rows = await readAllRows(runId);
  // Screenshots and captured requests too. They were reachable only inside the
  // export archive, so a run with the sniffer on looked as though it had done
  // nothing at all — which is how "the API sniffer is not working" was
  // reported for a sniffer that was working and had nowhere to put its answer.
  const { networks, screenshots } = _capturesFor(runId);
  return { runId, rows, networks, screenshots };
});

// ── Side panel connection ───────────────────────────────────────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// ── Test surface ──────────────────────────────────────────────────────────────
// The executor is the heart of the product and had no behavioural coverage,
// because this module has no exports and registers listeners at import. ES
// module exports are inert in a service worker and nothing in the extension
// imports these; they exist so tests/executor.test.mjs can drive the step
// chain directly. Keep this list minimal.
export const __testing = {
  _dispatchStep,
  _executeSteps,
  _executeStepList,
  _executePipeline,
  _assertOriginAllowed,
  _resolveStr,
  _resolveConfig,
  _runStates,
};

// === END service-worker.js ===
