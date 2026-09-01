// === service-worker.js ===
/**
 * @module service-worker
 * @description MV3 Service Worker: pipeline orchestrator, message bus, and
 *   SW lifecycle manager. All state is persisted to storage before every await
 *   to survive SW termination.
 *
 *   Design decision: The SW uses a message-handler registry pattern (Map of
 *   handlers keyed by message name) instead of a giant switch statement. This
 *   keeps the bus extensible and each handler independently testable.
 *   All inbound message names must match the canonical registry.
 *
 *   SW lifecycle: We keep the SW alive during a pipeline run via chrome.alarms
 *   (heartbeat every 20s). On activation, the session key is re-initialized
 *   because the module scope is fresh. We resume any incomplete runs detected
 *   in storage.
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
import { runEthicsGates, EthicsBlock } from "./ethics-engine.js";
import {
  initBuffer,
  pushRow,
  flush,
  finalizeBuffer,
  readAllRows,
} from "../checkpoint/row-buffer.js";
import { saveCursor } from "../checkpoint/cursor-store.js";
import { getResumePayload } from "../checkpoint/resume-manager.js";
import { compilePipeline } from "../script-gen/pipeline-compiler.js";
import { emitPython } from "../script-gen/python-emitter.js";
import { emitNode } from "../script-gen/node-emitter.js";
import { runLlmLayer } from "./llm-extractor.js";

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
    results: [],
    screenshots: [],
  };
  _runStates.set(runId, runState);
  _startHeartbeat(); // only needed while a run is in flight

  // Persist state before any await
  await chrome.storage.local.set({
    fs_run_log: { runId, startedAt: Date.now(), status: "running" },
  });

  // Run ethics gates first
  const { targetOrigin, targetPath, captchaEnabled, captchaAuthorized } =
    payload;
  const ethicsResult = await runEthicsGates({
    steps: pipeline.steps ?? [],
    targetOrigin,
    targetPath: targetPath ?? "/",
    timing: payload.timing ?? {},
    captcha: { enabled: captchaEnabled, authorized: captchaAuthorized },
    tabId: runState.tabId,
    confirmed: payload.confirmed ?? false,
    rowCount: payload.rowCount ?? 0,
  });

  // If ethics gates hard-blocked, abort the run
  if (ethicsResult.blocked) {
    _runStates.delete(runId);
    throw new EthicsBlock(
      ethicsResult.blocker.code,
      ethicsResult.blocker.message,
    );
  }

  const warnings = ethicsResult.warnings;
  logger.info(MODULE, "pipeline-start", { runId, warnings: warnings.length });

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
    "warning-log",
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
 * @param {object} config   - Step config ({ confidenceThreshold, extractType })
 * @param {number} tabId    - Target Chrome tab ID
 * @param {string} runId    - Pipeline run identifier
 * @param {object} ctx      - Runtime context for template resolution
 * @returns {Promise<object>} - Product row with _confidence and _method meta fields
 */
async function _executeAutoExtract(config = {}, tabId, runId, ctx = {}) {
  const threshold = Number(config.confidenceThreshold ?? 70);

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
  if (extraction.needsLlm && extraction.simplifiedDom) {
    _broadcastLog(
      "info-log",
      `AUTO_EXTRACT: L1/L2 confidence ${extraction.overallConfidence}% — escalating to LLM...`,
      runId,
    );
    const llmResult = await runLlmLayer(extraction.simplifiedDom).catch(() => null);
    if (llmResult) {
      // LLM wins field-by-field where it has higher confidence
      extraction = _mergeLlmOverL12(extraction, llmResult);
      _broadcastLog(
        "info-log",
        `AUTO_EXTRACT: LLM merged — overall confidence now ${extraction.overallConfidence}%.`,
        runId,
      );
    } else {
      _broadcastLog(
        "warn-log",
        `AUTO_EXTRACT: LLM layer skipped or failed — using L1/L2 result (confidence: ${extraction.overallConfidence}%).`,
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
  const fmt = config.format || "csv";
  const ts = Date.now();

  // Build data file content
  let dataContent, dataMime, dataExt;
  const headers = Array.from(new Set(allRows.flatMap(Object.keys)));
  if (fmt === "json") {
    dataContent = JSON.stringify(allRows, null, 2);
    dataMime = "application/json";
    dataExt = "json";
  } else if (fmt === "jsonl") {
    dataContent = allRows.map((r) => JSON.stringify(r)).join("\n");
    dataMime = "application/jsonl";
    dataExt = "jsonl";
  } else if (fmt === "tsv") {
    dataContent =
      headers.join("\t") +
      "\n" +
      allRows
        .map((r) =>
          headers.map((h) => String(r[h] || "").replace(/\t/g, " ")).join("\t"),
        )
        .join("\n");
    dataMime = "text/tab-separated-values";
    dataExt = "tsv";
  } else {
    dataContent =
      headers.join(",") +
      "\n" +
      allRows
        .map((r) =>
          headers
            .map((h) => `"${String(r[h] || "").replace(/"/g, '""')}"`)
            .join(","),
        )
        .join("\n");
    dataMime = "text/csv";
    dataExt = "csv";
  }

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
      const netHeaders = [
        "timestamp",
        "method",
        "url",
        "status",
        "type",
        "requestBody",
        "responseBody",
      ];
      let netContent = "";
      if (fmt === "json" || fmt === "jsonl") {
        netContent = JSON.stringify(networks, null, 2);
        zipFiles.push({
          name: `api-sniffer.json`,
          bytes: enc.encode(netContent),
        });
      } else {
        netContent =
          netHeaders.join(",") +
          "\n" +
          networks
            .map((n) =>
              netHeaders
                .map((h) => `"${String(n[h] || "").replace(/"/g, '""')}"`)
                .join(","),
            )
            .join("\n");
        zipFiles.push({
          name: `api-sniffer.csv`,
          bytes: enc.encode("\uFEFF" + netContent),
        });
      }
    }

    const zipBytes = _buildZip(zipFiles);
    const blob = new Blob([zipBytes], { type: "application/zip" });
    const zipUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url: zipUrl,
      filename: `flowscrape_export_${ts}.zip`,
      saveAs: false,
    });
    _broadcastLog(
      "info-log",
      `Exported ZIP: ${allRows.length} rows, ${screenshots.length} screens, ${networks.length} APIs.`,
      runId,
    );
  } else if (allRows.length > 0) {
    const dataUrl = `data:${dataMime};charset=utf-8,\uFEFF${encodeURIComponent(dataContent)}`;
    await chrome.downloads.download({
      url: dataUrl,
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
      "warning-log",
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

async function _executeStepList(steps, tabId, runId, ctx = {}) {
  // ctx is mutable — EXTRACT results update it so later steps can use {{extracted.field}}
  const liveCtx = { ...ctx, extracted: { ...(ctx.extracted || {}) } };

  const runState = _runStates.get(runId);
  for (const step of steps) {
    if (!runState || !runState.active) break;

    // Resolve template variables in this step's config
    const resolvedStep = _resolveConfig(step, liveCtx);

    chrome.runtime
      .sendMessage({
        type: "pipeline:status",
        payload: {
          state: "running",
          currentStepId: step.id,
          progress: {},
          runId,
          tabId: runState?.tabId,
        },
      })
      .catch(() => {});

    if (resolvedStep.type === "WEBSITE" || resolvedStep.type === "NAVIGATE") {
      await chrome.tabs.update(tabId, { url: resolvedStep.config.url });
      await _sleep(resolvedStep.config.wait ? 3000 : 800);
    } else if (resolvedStep.type === "WAIT") {
      await _sleep(resolvedStep.config.ms || 1000);
    } else if (resolvedStep.type === "SCREENSHOT") {
      await _captureScreenshot(tabId, resolvedStep.config, runId);
    } else if (resolvedStep.type === "API") {
      const apiResult = await _executeApiStep(resolvedStep.config, liveCtx);
      const storeAs =
        String(resolvedStep.config.storeAs || "api").trim() || "api";
      liveCtx[storeAs] = apiResult;
      liveCtx.api = apiResult;
      if (
        resolvedStep.config.exposeBodyAsExtracted === true &&
        apiResult.body &&
        typeof apiResult.body === "object" &&
        !Array.isArray(apiResult.body)
      ) {
        Object.assign(liveCtx.extracted, apiResult.body);
      }
      _broadcastLog(
        "info-log",
        `API ${apiResult.method} ${apiResult.url} → ${apiResult.status}`,
        runId,
      );
    } else if (resolvedStep.type === "API_SNIFFER") {
      await _sleep(50);
    } else if (resolvedStep.type === "PDF_EXTRACTION") {
      const pdfResult = await _executePdfExtraction(resolvedStep.config, runId);
      const storeAs = Object.keys(pdfResult)[0] || "pdf_text";
      liveCtx[storeAs] = pdfResult[storeAs];
      _broadcastLog(
        "info-log",
        `PDF extraction queued: use MCP tool to extract text from PDF.`,
        runId,
      );
    } else if (resolvedStep.type === "UPLOAD_ACTIVITY") {
      await _executeUploadActivityStep(resolvedStep.config, tabId, runId);
    } else if (resolvedStep.type === "AUTO_EXTRACT") {
      const row = await _executeAutoExtract(resolvedStep.config, tabId, runId, liveCtx);
      runState.results.push(row);
      await pushRow(runId, row);
      Object.assign(liveCtx.extracted, row);
      _broadcastLog(
        "info-log",
        `AUTO_EXTRACT: product row saved (confidence: ${row._confidence}%).`,
        runId,
      );
    } else if (resolvedStep.type === "EXPORT") {
      await finalizeBuffer(runId).catch(() => {});
      initBuffer(runId);
      await _doExport(runId, resolvedStep.config);
    } else if (resolvedStep.type === "LOOP") {
      await _executeLoop(resolvedStep, tabId, runId, liveCtx);
    } else if (resolvedStep.type === "IF_ELSE") {
      await _executeIfElse(resolvedStep, tabId, runId, liveCtx);
    } else {
      const resp = await chrome.tabs.sendMessage(tabId, {
        type: "step:execute",
        payload: resolvedStep,
      });
      if (!resp?.ok) throw new Error(resp?.error || "Step failed");
      if (resolvedStep.type === "EXTRACT" && Array.isArray(resp.result)) {
        runState.results.push(...resp.result);
        for (const row of resp.result) await pushRow(runId, row);
        _broadcastLog(
          "info-log",
          `Extracted ${resp.result.length} rows (total: ${runState.results.length}).`,
          runId,
        );
        // Update live context so next steps can reference {{extracted.fieldName}}
        if (resp.result.length > 0)
          Object.assign(liveCtx.extracted, resp.result[resp.result.length - 1]);
      }
    }
  }
}

// ── Background Execution Orchestrator ─────────────────────────────────────────
async function _executePipeline(runId, pipeline, targetTabId) {
  let stepIndex = 0,
    progressCount = 0;
  const total = pipeline.steps.length;
  const runtimeCtx = { extracted: {} };
  initBuffer(runId);

  while (
    _runStates.has(runId) &&
    _runStates.get(runId).active &&
    stepIndex < pipeline.steps.length
  ) {
    const runState = _runStates.get(runId);
    if (runState.paused) {
      await _sleep(1000);
      continue;
    }

    const step = pipeline.steps[stepIndex];
    const resolvedStep = _resolveConfig(step, runtimeCtx);
    chrome.runtime
      .sendMessage({
        type: "pipeline:status",
        payload: {
          state: "running",
          currentStepId: step.id,
          progress: { current: progressCount, total },
          runId,
        },
      })
      .catch(() => {});

    try {
      if (resolvedStep.type === "WEBSITE" || resolvedStep.type === "NAVIGATE") {
        await chrome.tabs.update(targetTabId, { url: resolvedStep.config.url });
        await _sleep(resolvedStep.config.wait ? 3000 : 800);
      } else if (resolvedStep.type === "WAIT") {
        await _sleep(resolvedStep.config.ms || 1000);
      } else if (resolvedStep.type === "SCREENSHOT") {
        await _captureScreenshot(targetTabId, resolvedStep.config, runId);
      } else if (resolvedStep.type === "API") {
        const apiResult = await _executeApiStep(
          resolvedStep.config,
          runtimeCtx,
        );
        const storeAs =
          String(resolvedStep.config.storeAs || "api").trim() || "api";
        runtimeCtx[storeAs] = apiResult;
        runtimeCtx.api = apiResult;
        if (
          resolvedStep.config.exposeBodyAsExtracted === true &&
          apiResult.body &&
          typeof apiResult.body === "object" &&
          !Array.isArray(apiResult.body)
        ) {
          Object.assign(runtimeCtx.extracted, apiResult.body);
        }
        _broadcastLog(
          "info-log",
          `API ${apiResult.method} ${apiResult.url} → ${apiResult.status}`,
        );
      } else if (resolvedStep.type === "EXPORT") {
        await _doExport(runId, resolvedStep.config);
      } else if (resolvedStep.type === "API_SNIFFER") {
        await _sleep(50);
      } else if (resolvedStep.type === "UPLOAD_ACTIVITY") {
        await _executeUploadActivityStep(
          resolvedStep.config,
          targetTabId,
          runId,
        );
      } else if (resolvedStep.type === "AUTO_EXTRACT") {
        const row = await _executeAutoExtract(resolvedStep.config, targetTabId, runId, runtimeCtx);
        runState.results.push(row);
        await pushRow(runId, row);
        Object.assign(runtimeCtx.extracted, row);
        _broadcastLog(
          "info-log",
          `AUTO_EXTRACT: product row saved (confidence: ${row._confidence}%).`,
          runId,
        );
      } else if (resolvedStep.type === "LOOP") {
        await _executeLoop(resolvedStep, targetTabId, runId, runtimeCtx);
      } else if (resolvedStep.type === "IF_ELSE") {
        await _executeIfElse(resolvedStep, targetTabId, runId, runtimeCtx);
      } else {
        const resp = await chrome.tabs.sendMessage(targetTabId, {
          type: "step:execute",
          payload: resolvedStep,
        });
        if (!resp?.ok) throw new Error(resp?.error || "Execution rejected");
        if (resolvedStep.type === "EXTRACT" && Array.isArray(resp.result)) {
          runState.results.push(...resp.result);
          for (const row of resp.result) await pushRow(runId, row);
          _broadcastLog(
            "info-log",
            `Extracted ${resp.result.length} rows. (auto-saved)`,
          );
          if (resp.result.length > 0) {
            Object.assign(
              runtimeCtx.extracted,
              resp.result[resp.result.length - 1],
            );
          }
        }
      }
      progressCount++;
      stepIndex++;
      await saveCursor({ runId, rowIndex: progressCount, stepIndex }).catch(
        () => {},
      );
    } catch (err) {
      const isCritical = !resolvedStep.config.optional;
      _broadcastLog(
        isCritical ? "error-log" : "warn-log",
        `[${resolvedStep.type}] ${err.message}${isCritical ? "" : " (optional, skipping)"}`,
        runId,
      );
      if (isCritical) {
        runState.active = false;
        break;
      }
      progressCount++;
      stepIndex++;
    }
  }

  await finalizeBuffer(runId).catch(() => {});
  const endRunState = _runStates.get(runId);
  const stateStr = endRunState?.active ? "completed" : "stopped";
  chrome.runtime
    .sendMessage({
      type: "pipeline:status",
      payload: {
        state: stateStr,
        currentStepId: null,
        progress: { current: progressCount, total },
        runId,
      },
    })
    .catch(() => {});
  _runStates.delete(runId);
  if (_runStates.size === 0) await chrome.alarms.clear("fs_sw_heartbeat").catch(() => {});
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
  if (rs) {
    rs.paused = true;
    logger.info(MODULE, "pipeline-paused", { runId: rs.runId });
  }
  return { ok: true };
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
  return {
    ...(_runStates.get(payload?.runId) || {
      active: false,
      paused: false,
      runId: payload?.runId,
    }),
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
    if (payload.format === "python") {
      return { code: emitPython(ast) };
    } else {
      return { code: emitNode(ast) };
    }
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
  const rows = await readAllRows(payload?.runId ?? "latest");
  return { rows };
});

// ── Side panel connection ───────────────────────────────────────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// === END service-worker.js ===
