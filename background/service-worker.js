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
      await chrome.scripting.unregisterContentScripts({ ids: [SNIFFER_SCRIPT_ID] });
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
    _broadcastLog("error-log", `API Sniffer could not start: ${err.message}`, runId);
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
    .catch((err) => logger.warn(MODULE, "sniffer-unregister-fail", { error: err.message }));
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

// ── Heartbeat alarm (keeps SW alive) ──────────────────────────────────────────
function _startHeartbeat() {
  chrome.alarms.create("fs_sw_heartbeat", { periodInMinutes: 0.33 }); // ~20s
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "fs_sw_heartbeat") {
    // Just touching this listener keeps the SW alive
    logger.debug(MODULE, "heartbeat", { active: _runStates.size > 0 });
  }
});

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

  const enableSniffer = (pipeline.steps || []).some(
    (s) => s.type === "API_SNIFFER",
  );

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runState = {
    active: true,
    paused: false,
    runId,
    tabId: tabId ?? sender.tab?.id,
    enableSniffer,
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
    _broadcastLog("warn-log", `Ethics · ${warning.code}: ${warning.message}`, runId);
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

_registerHandler("network:sniff", async (payload, sender) => {
  const tabId = sender.tab?.id;
  if (!tabId) return { ok: false };
  for (const [runId, rs] of _runStates.entries()) {
    if (rs.tabId === tabId && rs.active && rs.enableSniffer) {
      if (!Array.isArray(rs.networks)) rs.networks = [];
      rs.networks.push({
        timestamp: Date.now(),
        method: payload.method,
        url: payload.url,
        status: payload.status,
        requestBody: payload.reqBody || "",
        responseBody: payload.resBody || "",
        type: payload.apiType,
      });
      break;
    }
  }
  return { ok: true };
});

// ── Step execution helpers ─────────────────────────────────────────────────────

async function _captureScreenshot(tabId, config = {}, runId) {
  const runState = _runStates.get(runId);
  if (!runState) return;
  try {
    const rawQuality = Number(config.quality);
    const quality = Number.isFinite(rawQuality)
      ? Math.max(0, Math.min(100, Math.round(rawQuality)))
      : 100;

    // Focus the tab so captureVisibleTab can see it
    await chrome.tabs.update(tabId, { active: true });
    await _sleep(400);
    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
      quality,
    });
    // Store in memory for ZIP export
    if (!Array.isArray(runState.screenshots)) runState.screenshots = [];
    runState.screenshots.push({ dataUrl, ts: Date.now() });
    _broadcastLog(
      "info-log",
      `Screenshot #${runState.screenshots.length} captured.`,
      runId,
    );
  } catch (err) {
    throw new Error(`Screenshot failed: ${err.message}`);
  }
}

async function _executePdfExtraction(config = {}, runId) {
  const source = String(config.source || "url").trim();
  const maxPages = Number(config.maxPages) || 50;
  const storeAs = String(config.storeAs || "pdf_text").trim() || "pdf_text";

  let fileBase64;
  let fileUrl;

  if (source === "file") {
    // Load from storage files
    const fileId = String(config.fileId || "").trim();
    const stored = await chrome.storage.local.get(STORAGE_FILES_KEY);
    const library = Array.isArray(stored?.[STORAGE_FILES_KEY])
      ? stored[STORAGE_FILES_KEY]
      : [];
    const file = library.find((f) => f.id === fileId);
    if (!file) {
      throw new Error(`PDF file not found in storage: ${fileId}`);
    }
    fileBase64 = file.dataUrl;
  } else {
    // Use URL
    fileUrl = String(config.url || "").trim();
    if (!fileUrl) {
      throw new Error("PDF_EXTRACTION requires a PDF URL or file selection");
    }
  }

  // Call MCP pdf_extract_text tool via sendMessage to a background context
  // We use chrome.runtime.sendMessage to notify any listening context
  // In practice, this would be handled by an external MCP call or built-in PDF parser

  // For now, return a placeholder that says to use the MCP tool
  _broadcastLog(
    "warn-log",
    `PDF_EXTRACTION: Use MCP tool "pdf_extract_text" with source="${source}" to extract from PDF.`,
    runId,
  );

  return {
    [storeAs]: {
      status: "pending",
      message: "Use MCP pdf_extract_text tool for extraction",
      source,
      maxPages,
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
  const l12Resp = await chrome.tabs.sendMessage(tabId, {
    type: "step:execute",
    payload: { type: "AUTO_EXTRACT", config: { confidenceThreshold: threshold } },
  }).catch(err => ({ ok: false, error: err.message }));

  if (!l12Resp?.ok) {
    throw new Error(`AUTO_EXTRACT (L1/L2) failed: ${l12Resp?.error || "No response"}`);
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
  for (const warning of (extraction.warnings || [])) {
    _broadcastLog("warn-log", warning, runId);
  }

  // Build the final row — include confidence metadata as hidden fields
  const row = {
    ...extraction.result,
    _confidence:       extraction.overallConfidence,
    _extractionMethod: extraction.method,
  };

  return row;
}

/**
 * Field-level merge: for each field, pick whichever source (L1/L2 or LLM)
 * has higher per-field confidence.
 */
function _mergeLlmOverL12(l12, llm) {
  const fieldList = ["name", "price", "originalPrice", "currency", "brand",
    "description", "sku", "availability", "rating", "reviewCount", "images"];

  const mergedResult   = { ...(l12.result   || {}) };
  const mergedPerField = { ...(l12.perField  || {}) };
  const mergedWarnings = [...(l12.warnings   || []), ...(llm.warnings || [])];

  for (const field of fieldList) {
    const l12Conf = l12.perField?.[field]  ?? 0;
    const llmConf = llm.perField?.[field]  ?? 0;
    const llmVal  = llm.result?.[field];

    const isEmpty = v => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

    // LLM wins if: it has a value AND either L1/L2 is empty OR LLM has higher confidence
    if (!isEmpty(llmVal) && (isEmpty(mergedResult[field]) || llmConf > l12Conf)) {
      mergedResult[field]   = llmVal;
      mergedPerField[field] = llmConf;
    }
  }

  // Recompute overall confidence after merge
  const weights = { name: 30, price: 25, images: 15, brand: 10, description: 10, sku: 5, availability: 5 };
  let totalWeight = 0, weightedSum = 0;
  for (const [field, weight] of Object.entries(weights)) {
    totalWeight += weight;
    weightedSum += (mergedPerField[field] || 0) * weight;
  }
  const overallConfidence = Math.round(weightedSum / totalWeight);

  return {
    result:            mergedResult,
    perField:          mergedPerField,
    overallConfidence,
    method:            llm.method || l12.method,
    warnings:          mergedWarnings,
    needsLlm:          false,
    simplifiedDom:     "",
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

async function _doExport(runId, config) {
  const runState = _runStates.get(runId);
  if (!runState) return;
  const idbRows = await readAllRows(runId).catch(() => []);
  const allRows = [...runState.results];
  const seen = new Set(allRows.map((r) => JSON.stringify(r)));
  for (const r of idbRows) {
    const { runId: _, ...clean } = r;
    if (!seen.has(JSON.stringify(clean))) allRows.push(clean);
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
        name: `screenshot_${i + 1}_${s.ts}.png`,
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
    const blob = new Blob([zipBytes], { type: "application/zip" });
    const zipUrl = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url: zipUrl,
        filename: `flowscrape_export_${ts}.zip`,
        saveAs: false,
      });
    } finally {
      // Never revoked before, so every export leaked its whole payload for the
      // lifetime of the worker.
      URL.revokeObjectURL(zipUrl);
    }
    _broadcastLog(
      "info-log",
      `Exported ZIP: ${allRows.length} rows, ${screenshots.length} screens, ${networks.length} APIs.`,
      runId,
    );
  } else if (allRows.length > 0) {
    // A Blob URL, not a data: URL. The BOM used to sit outside
    // encodeURIComponent, so it went into the URL raw and was mangled; and a
    // large export could exceed what a data: URL can carry.
    const blob = new Blob(["\uFEFF" + dataContent], { type: dataMime });
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url,
        filename: `flowscrape_export_${ts}.${dataExt}`,
        saveAs: false,
      });
    } finally {
      URL.revokeObjectURL(url);
    }
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
  const cfg = {};
  for (const [k, v] of Object.entries(step.config || {})) {
    cfg[k] = typeof v === "string" ? _resolveStr(v, ctx) : v;
  }
  return { ...step, config: cfg, __fsContext: ctx };
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

  // Warn if restricted site - use MCP tool instead
  if (RESTRICTED_UPLOAD_SITES[domain]) {
    _broadcastLog(
      "warn-log",
      `⚠️ ${domain} blocks script-driven uploads. Use MCP tool "upload_file_to_site" for automation support.`,
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

async function _executeLoop(step, tabId, runId, parentCtx = {}) {
  const {
    type: ltype = "count",
    selector = "",
    max = 10,
    onFail = "skip",
  } = step.config;
  const children = step.children || [];
  let iters = max;
  let elementsData = null;

  if (ltype === "elements" && selector) {
    try {
      // Pre-collect ALL element data upfront so templates can use {{item.href}}, {{item.text}} etc.
      const r = await chrome.tabs.sendMessage(tabId, {
        type: "step:execute",
        payload: { type: "QUERY_ELEMENTS", config: { selector } },
      });
      if (r?.ok && Array.isArray(r.result) && r.result.length > 0) {
        elementsData = r.result;
        iters = Math.min(elementsData.length, max || 9999);
        _broadcastLog(
          "info-log",
          `Loop: found ${elementsData.length} elements for "${selector}"`,
          runId,
        );
      } else {
        _broadcastLog(
          "warn-log",
          `Loop: no elements matched "${selector}" — skipping.`,
          runId,
        );
        return;
      }
    } catch (e) {
      _broadcastLog(
        "warn-log",
        `Loop: element query failed: ${e.message}`,
        runId,
      );
    }
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
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: "step:execute",
          payload: { type: "CLICK", config: { selector, retries: 3 } },
        });
        await _sleep(1500);
      } catch {
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
  let met = false;
  try {
    const resolved = _resolveConfig(step, parentCtx);
    const r = await chrome.tabs.sendMessage(tabId, {
      type: "step:execute",
      payload: resolved,
    });
    met = r?.result?.conditionMet === true;
  } catch {}
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
      await _sleep(step.config.wait ? 3000 : 800);
      return;
    }

    case "WAIT":
      await _sleep(step.config.ms || 1000);
      return;

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

    case "LOOP":
      await _executeLoop(step, tabId, runId, ctx);
      return;

    case "IF_ELSE":
      await _executeIfElse(step, tabId, runId, ctx);
      return;

    default: {
      const resp = await chrome.tabs.sendMessage(tabId, {
        type: "step:execute",
        payload: step,
      });
      if (!resp?.ok) throw new Error(resp?.error || "Step failed");

      if (step.type === "EXTRACT" && Array.isArray(resp.result)) {
        runState.results.push(...resp.result);
        for (const row of resp.result) await pushRow(runId, row);
        _broadcastLog(
          "info-log",
          `Extracted ${resp.result.length} rows (total: ${runState.results.length}).`,
          runId,
        );
        // So later steps can reference {{extracted.fieldName}}
        if (resp.result.length > 0) {
          Object.assign(ctx.extracted, resp.result[resp.result.length - 1]);
        }
      }
    }
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

    chrome.runtime
      .sendMessage({
        type: "pipeline:status",
        payload: {
          state: "running",
          currentStepId: step.id,
          progress: progress
            ? { current: progress.count, total: progress.total }
            : {},
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

  _runStates.delete(runId);
  if (_runStates.size === 0) {
    await chrome.alarms.clear("fs_sw_heartbeat").catch(() => {});
  }
}

_registerHandler(MSG.STEP_EXECUTE, async (payload, sender) => {
  const { step, tabId } = payload;
  const targetTabId = tabId ?? sender.tab?.id;
  const testCtx = payload?.context || {};
  const resolvedStep = _resolveConfig(step, testCtx);

  if (resolvedStep.type === "API") {
    return _executeApiStep(resolvedStep.config, testCtx);
  }

  if (resolvedStep.type === "UPLOAD_ACTIVITY") {
    if (!targetTabId) {
      throw new Error("No target tab specified for UPLOAD_ACTIVITY test");
    }
    return _executeUploadActivityStep(resolvedStep.config, targetTabId, null);
  }

  if (!targetTabId)
    throw new Error("No target tab specified for execution test");

  if (resolvedStep.type === "WEBSITE" || resolvedStep.type === "NAVIGATE") {
    await chrome.tabs.update(targetTabId, { url: resolvedStep.config.url });
    return { navigated: true, url: resolvedStep.config.url };
  }

  // Suppress the giant red error log output natively by catching the error locally and wrapping it nicely!
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(targetTabId, {
      type: "step:execute",
      payload: resolvedStep,
    });
  } catch (err) {
    if (err.message.includes("Receiving end does not exist")) {
      throw new Error(
        "Receiving end does not exist. Please refresh the web page.",
      );
    }
    throw err;
  }

  if (!resp || !resp.ok)
    throw new Error(resp?.error || "Test failed inside content environment");
  return resp.result;
});

_registerHandler(MSG.PIPELINE_PAUSE, async (payload) => {
  const rs = _runStates.get(payload?.runId);
  if (!rs) return { ok: false, paused: false };
  rs.paused = true;
  logger.info(MODULE, "pipeline-paused", { runId: rs.runId });
  _broadcastLog("warn-log", "Paused. The current step finishes first.", rs.runId);
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
  if (_runStates.size === 0) await chrome.alarms.clear("fs_sw_heartbeat");
  return { ok: true };
});

_registerHandler(MSG.PIPELINE_STATUS, async (payload) => {
  const runState = _runStates.get(payload?.runId);

  // `known` separates "that run finished" from "this worker has no memory of
  // that run". _runStates is in-memory only, so an MV3 termination mid-run
  // leaves the side panel showing a Stop button for something that no longer
  // exists. The panel polls this and can tell the difference.
  if (!runState) {
    return { known: false, active: false, paused: false, runId: payload?.runId };
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

_registerHandler(MSG.KEY_GET, async (payload) => {
  const { getApiKey } = await import("./api-key-manager.js");
  // Only serves non-secret validation status — never key values to content scripts
  const { listProviders, validateApiKey } =
    await import("./api-key-manager.js");
  const providers = await listProviders();
  return { providers };
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
    const code = payload.format === "python" ? emitPython(ast) : emitNode(ast);

    return { code, unexportable };
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
  return { runId, rows };
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
