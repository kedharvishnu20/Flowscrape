// === sidepanel/pipeline-builder.js ===
"use strict";

import {
  STEP_TYPES,
  USER_STEP_TYPES,
  defaultConfig,
  isKnownStepType,
} from "../utils/step-types.js";
import { TRANSFORMS, isValidRegex } from "../utils/value-transforms.js";
import { CONDITIONS } from "../utils/conditions.js";
import { snifferFilterError } from "../utils/sniffer-filter.js";
import {
  formatRows,
  formatMeta,
  ROW_FORMATS,
} from "../exporters/row-formatters.js";
import { exportRows } from "../exporters/text-exporters.js";

const MSG = {
  PIPELINE_START: "pipeline:start",
  PIPELINE_STOP: "pipeline:stop",
  PIPELINE_PAUSE: "pipeline:pause",
  PIPELINE_RESUME: "pipeline:resume",
};
let SK = { PIPELINE: "fs_active_pipeline" };
SK.STORAGE_FILES = "fs_storage_files_v1";
SK.UPLOAD_ACTIVITIES = "fs_upload_activities_v1";

let _tabId = null;

// ── Step Registry ─────────────────────────────────────────────────────────────
// The vocabulary lives in utils/step-types.js so the panel, the script emitters
// and the MCP server cannot drift apart again. Only user-selectable steps
// appear in the palette.
const STEP_REGISTRY = Object.fromEntries(
  USER_STEP_TYPES.map((type) => [type, STEP_TYPES[type]]),
);

// ── State ─────────────────────────────────────────────────────────────────────
let _pipeline = { steps: [] };
let _expandedNodeId = null;
let _insertCtx = { index: -1, parentId: "", branchKey: "" };
let _runState = {
  active: false,
  paused: false,
  timer: null,
  startTs: 0,
  runId: null,
};
/** The most recent run, kept after it ends so its rows stay downloadable. */
let _lastRunId = null;
let _storageFiles = [];
let _uploadActivities = [];
let _dragSourceId = null;
let _keyListening = false;
let _boardState = {
  scale: 1,
  x: 24,
  y: 24,
  minScale: 0.35,
  maxScale: 2.6,
  panning: false,
  startX: 0,
  startY: 0,
  originX: 0,
  originY: 0,
  fittedOnce: false,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const elCanvas = document.getElementById("pipeline-canvas");
const elPalette = document.getElementById("step-palette-overlay");
const elPaletteSearch = document.getElementById("palette-search");
const elPaletteContent = document.getElementById("palette-content");
const elBoardViewport = document.getElementById("board-viewport");
const elBoardStage = document.getElementById("board-stage");
const elPipelineWires = document.getElementById("pipeline-wires");
const elBoardZoomLabel = document.getElementById("board-zoom-label");

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  _tabId = tab ? tab.id : null;
  if (_tabId) {
    SK.PIPELINE = `fs_active_pipeline_${_tabId}`;
  }

  // Also listen for tab changes within the sidepanel to swap state
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    // A run belongs to the tab it started on. Swapping the board out from under
    // a live run left Stop pointing at the right runId while the canvas showed
    // an unrelated pipeline, and the monitor kept filling with log lines the
    // visible steps had nothing to do with (E-13).
    if (_runState.active && activeInfo.tabId !== _tabId) {
      notify(
        "warn-log",
        "A run is in flight on another tab. The board stays on it until the run ends.",
      );
      return;
    }

    _tabId = activeInfo.tabId;
    SK.PIPELINE = `fs_active_pipeline_${_tabId}`;
    const saved = (await chrome.storage.local.get(SK.PIPELINE))[SK.PIPELINE];
    _pipeline = saved?.steps ? saved : { steps: [] };
    _expandedNodeId = null;
    _boardState.fittedOnce = false;
    renderPipeline();
    // The storage library and the upload activity list are not tab-scoped —
    // only SK.PIPELINE is — so there is nothing there to re-render. The audit
    // (E-13) said otherwise; entry corrected.
  });

  bindNavTabs();
  bindGlobalControls();
  bindStorageControls();
  bindPalette();
  bindDelegatedEvents();
  bindKeyboardActivation();
  initBoardSurface();

  const savedState = await chrome.storage.local.get([
    SK.PIPELINE,
    SK.STORAGE_FILES,
    SK.UPLOAD_ACTIVITIES,
  ]);
  if (savedState?.[SK.PIPELINE]?.steps) _pipeline = savedState[SK.PIPELINE];

  _storageFiles = Array.isArray(savedState?.[SK.STORAGE_FILES])
    ? savedState[SK.STORAGE_FILES]
    : [];

  _uploadActivities = Array.isArray(savedState?.[SK.UPLOAD_ACTIVITIES])
    ? savedState[SK.UPLOAD_ACTIVITIES]
    : [];

  // Running activities cannot survive a sidepanel reload; mark them interrupted.
  let touchedActivities = false;
  _uploadActivities = _uploadActivities.map((activity) => {
    if (activity.status !== "running") return activity;
    touchedActivities = true;
    return {
      ...activity,
      status: "interrupted",
      updatedAt: Date.now(),
      message: "Interrupted (panel reloaded)",
    };
  });
  if (touchedActivities) {
    await _saveUploadActivities();
  }

  renderPipeline();
  renderStoragePanel();
  renderUploadActivities();
  populatePalette();
  listenToSystem();

  await _showResumeBanner();
}

/**
 * Offer the rows from runs that never finished.
 *
 * The banner used to delegate to the "Download Data" button, which passed
 * `_runState.runId || "latest"` — and on a fresh panel there is no runId, so
 * the sentinel matched nothing and the download reported no data. Each run is
 * now downloaded by its own id.
 */
async function _showResumeBanner() {
  const res = await chrome.runtime
    .sendMessage({ type: "checkpoint:check" })
    .catch(() => null);

  const runs = res?.ok ? (res.result?.runs ?? []) : [];
  if (runs.length === 0) return;

  const view = document.getElementById("view-monitor");
  if (!view) return;

  document.querySelector(".resume-banner")?.remove();

  const banner = document.createElement("div");
  banner.className = "resume-banner";

  const label = document.createElement("span");
  label.textContent =
    runs.length === 1
      ? "⟳ A previous run did not finish"
      : `⟳ ${runs.length} previous runs did not finish`;
  banner.appendChild(label);

  for (const run of runs) {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.style.fontSize = "11px";
    btn.textContent =
      runs.length === 1 ? "Download data" : `Download ${run.runId.slice(-6)}`;
    btn.addEventListener("click", () => _downloadRunRows(run.runId));
    banner.appendChild(btn);
  }

  view.prepend(banner);
}

/**
 * Download every row stored for a run.
 * @param {string} runId
 */
async function _downloadRunRows(runId) {
  if (!runId) {
    logToMonitor("warn-log", "No run selected to download.");
    return;
  }

  const res = await chrome.runtime
    .sendMessage({ type: "data:download", payload: { runId } })
    .catch(() => null);

  if (!res?.ok) {
    logToMonitor(
      "error-log",
      `Download failed: ${res?.error ?? "no response"}`,
    );
    return;
  }

  const rows = (res.result?.rows ?? []).map(
    ({ runId: _runId, ...rest }) => rest,
  );
  if (rows.length === 0) {
    logToMonitor("warn-log", "That run stored no rows.");
    return;
  }

  // exporters/text-exporters.js was written for exactly this and nothing
  // imported it (F-01). It uses the File System Access API's save dialog where
  // the browser has one — which a service worker cannot show, but the side
  // panel can — and falls back to a Blob download everywhere else.
  try {
    await exportRows(rows, "csv", `flowscrape_${runId}.csv`);
  } catch (err) {
    // A cancelled save dialog is a choice, not a failure.
    if (err?.name === "AbortError") return;
    notify("error-log", `Download failed: ${err.message}`);
    return;
  }
  logToMonitor("info-log", `Downloaded ${rows.length} rows from ${runId}.`);
}

async function saveState() {
  await chrome.storage.local.set({ [SK.PIPELINE]: _pipeline });
}

async function _saveStorageFiles() {
  const snapshot = _storageFiles;
  try {
    await chrome.storage.local.set({ [SK.STORAGE_FILES]: _storageFiles });
  } catch (error) {
    // The pre-check should make this unreachable, but a quota is a quota: if
    // the write is refused, drop back to what is actually on disk rather than
    // leaving the panel showing files that were never saved.
    const onDisk = (await chrome.storage.local.get(SK.STORAGE_FILES))[
      SK.STORAGE_FILES
    ];
    _storageFiles = Array.isArray(onDisk) ? onDisk : [];
    notify(
      "error-log",
      `Storage save refused (${snapshot.length} files, ${_mb(_storageBytesUsed())} on disk). ` +
        `Remove large files and retry. ${error?.message || ""}`,
    );
    renderStoragePanel();
    throw error;
  }
}

async function _saveUploadActivities() {
  await chrome.storage.local.set({ [SK.UPLOAD_ACTIVITIES]: _uploadActivities });
}

function bindStorageControls() {
  const storageInput = document.getElementById("input-storage-files");

  document
    .getElementById("btn-storage-add-files")
    ?.addEventListener("click", () => storageInput?.click());

  storageInput?.addEventListener("change", async (event) => {
    const files = Array.from(event.target?.files || []);
    if (!files.length) return;
    await _stageFilesInStorage(files);
    event.target.value = "";
  });

  document
    .getElementById("btn-storage-clear")
    ?.addEventListener("click", async () => {
      const n = _storageFiles.length;
      if (!n) return;
      const ok = await _confirmDestructive({
        title: "Clear the file library?",
        body: `${n} stored file${n === 1 ? "" : "s"} will be deleted. This cannot be undone, and any UPLOAD_ACTIVITY step referencing them will stop working.`,
        confirmLabel: "Delete all",
      });
      if (!ok) return;

      _storageFiles = [];
      await _saveStorageFiles();
      renderStoragePanel();
      logToMonitor("warn-log", `Storage library cleared (${n} files).`);
    });

  document
    .getElementById("storage-file-list")
    ?.addEventListener("click", async (event) => {
      const btn = event.target.closest("[data-action='storage-remove-file']");
      if (!btn) return;
      const fileId = btn.dataset.fileId;
      if (!fileId) return;

      _storageFiles = _storageFiles.filter((f) => f.id !== fileId);
      await _saveStorageFiles();
      renderStoragePanel();
    });
}

/**
 * chrome.storage.local is capped at about 10 MB without the `unlimitedStorage`
 * permission, which this extension deliberately does not request. Files are
 * held as base64 data URLs, which inflates them by roughly a third, so two 4 MB
 * PDFs are already over the line. There was a try/catch that logged a quota
 * message after the fact, but nothing checked before writing, and the failed
 * write left the in-memory list holding files that were not persisted (C-12).
 */
const STORAGE_QUOTA_BYTES = 10 * 1024 * 1024;
/** Leave room for pipelines, overlay prefs and the proxy pool. */
const STORAGE_BUDGET_BYTES = Math.floor(STORAGE_QUOTA_BYTES * 0.8);
/** base64 costs 4 bytes per 3, plus the data: prefix. */
const BASE64_OVERHEAD = 4 / 3;

/** Bytes the library currently occupies once encoded. */
function _storageBytesUsed() {
  return _storageFiles.reduce(
    (n, f) => n + (f.dataUrl?.length ?? Math.ceil(f.size * BASE64_OVERHEAD)),
    0,
  );
}

/** @param {number} n @returns {string} */
function _mb(n) {
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function _stageFilesInStorage(files) {
  const activityId = _createActivity({
    kind: "storage-stage",
    fileIds: [],
    fileNames: files.map((f) => f.name),
    totalFiles: files.length,
    message: "Staging files in storage library",
  });

  const existing = new Set(
    _storageFiles.map((f) => `${f.name}::${f.size}::${f.lastModified}`),
  );

  let processed = 0;
  let used = _storageBytesUsed();
  const rejected = [];

  for (const file of files) {
    const sig = `${file.name}::${file.size}::${file.lastModified}`;
    if (!existing.has(sig)) {
      // Checked before reading the file, not after the write fails: a rejected
      // write used to leave the in-memory list holding a file that was never
      // persisted, so the panel showed it and the next reload did not.
      const projected = Math.ceil(file.size * BASE64_OVERHEAD);
      if (used + projected > STORAGE_BUDGET_BYTES) {
        rejected.push(file.name);
        processed += 1;
        continue;
      }

      const dataUrl = await _readFileAsDataUrl(file);
      used += dataUrl.length;
      const item = {
        id: `sf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        lastModified: file.lastModified,
        addedAt: Date.now(),
        dataUrl,
      };
      _storageFiles.unshift(item);
      existing.add(sig);
    }
    processed += 1;
    _updateActivity(activityId, {
      processedFiles: processed,
      progress: Math.round((processed / files.length) * 100),
      status: "running",
      message: `Staging ${processed}/${files.length}`,
    });
  }

  await _saveStorageFiles();

  if (rejected.length) {
    notify(
      "error-log",
      `${rejected.length} file(s) not added — the library would exceed its ` +
        `${_mb(STORAGE_BUDGET_BYTES)} budget (${_mb(used)} in use): ${rejected.join(", ")}. ` +
        `Remove something first.`,
    );
  }

  _updateActivity(activityId, {
    processedFiles: files.length,
    progress: 100,
    status: rejected.length ? "partial" : "completed",
    completedAt: Date.now(),
    message: rejected.length
      ? `${files.length - rejected.length} of ${files.length} staged; ${rejected.length} over quota`
      : "Files staged in storage",
  });

  renderStoragePanel();
  renderUploadActivities();
}

function _createActivity({ kind, fileIds, fileNames, totalFiles, message }) {
  const activity = {
    id: `ua_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    status: "running",
    fileIds,
    fileNames,
    totalFiles,
    processedFiles: 0,
    progress: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    message,
  };
  _uploadActivities.unshift(activity);
  _uploadActivities = _uploadActivities.slice(0, 120);
  _saveUploadActivities();
  renderUploadActivities();
  return activity.id;
}

function _updateActivity(activityId, patch) {
  const idx = _uploadActivities.findIndex((a) => a.id === activityId);
  if (idx === -1) return;
  _uploadActivities[idx] = {
    ..._uploadActivities[idx],
    ...patch,
    updatedAt: Date.now(),
  };
  _saveUploadActivities();
  renderUploadActivities();
}

function renderStoragePanel() {
  const listEl = document.getElementById("storage-file-list");

  // How full the library is. Files are base64 in chrome.storage.local against a
  // fixed budget, and there was no aggregate anywhere — the first sign of
  // trouble was a save being refused (E-20).
  const usageEl = document.getElementById("storage-usage");
  if (usageEl) {
    const used = _storageBytesUsed();
    const pct = Math.min(100, Math.round((used / STORAGE_BUDGET_BYTES) * 100));
    usageEl.textContent = _storageFiles.length
      ? `${_storageFiles.length} file${_storageFiles.length === 1 ? "" : "s"} · ${_mb(used)} of ${_mb(STORAGE_BUDGET_BYTES)} (${pct}%)`
      : `0 files · ${_mb(STORAGE_BUDGET_BYTES)} available`;
    usageEl.style.color =
      pct >= 90
        ? "var(--red)"
        : pct >= 70
          ? "var(--yellow)"
          : "var(--text-dim)";
  }

  if (listEl) {
    if (!_storageFiles.length) {
      listEl.innerHTML = `<div class="empty-inline">No files in storage yet. Add files to build your reusable library.</div>`;
    } else {
      listEl.innerHTML = _storageFiles
        .map(
          (file) => `<div class="storage-item">
          <div class="storage-item-head">
            <div class="mono" style="font-size:12px;">${esc(file.name)}</div>
            <button class="btn btn-icon" data-action="storage-remove-file" data-file-id="${file.id}" title="Remove">✕</button>
          </div>
          <div class="storage-meta">${esc(file.type || "application/octet-stream")} · ${_formatBytes(file.size)} · Added ${_formatTime(file.addedAt)}</div>
        </div>`,
        )
        .join("");
    }
  }
}

function renderUploadActivities() {
  const target = document.getElementById("upload-activity-list-monitor");
  if (!target) return;

  const html = !_uploadActivities.length
    ? `<div class="empty-inline">No upload activity yet.</div>`
    : _uploadActivities
        .map((activity) => {
          const statusClass =
            activity.status === "completed"
              ? "pill pill-completed"
              : activity.status === "running"
                ? "pill pill-running"
                : "pill pill-interrupted";
          return `<div class="upload-item">
          <div class="upload-item-head">
            <div style="font-size:12px;"><b>${activity.kind === "storage-stage" ? "Storage Intake" : "Activity"}</b></div>
            <span class="${statusClass}">${activity.status}</span>
          </div>
          <div class="upload-meta">${activity.message || ""}</div>
          <div class="upload-meta">Files: ${activity.processedFiles || 0}/${activity.totalFiles || 0} · Progress: ${activity.progress || 0}%</div>
          <div class="upload-meta">${(activity.fileNames || []).map((n) => esc(n)).join(", ")}</div>
          <div class="upload-meta">Started ${_formatTime(activity.startedAt)}</div>
        </div>`;
        })
        .join("");

  target.innerHTML = html;
}

function _readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function _formatBytes(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function _formatTime(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

// ── Nav tabs ──────────────────────────────────────────────────────────────────
function bindNavTabs() {
  document.querySelectorAll(".nav-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".nav-pill")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelectorAll(".view")
        .forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      document
        .getElementById(`view-${btn.dataset.tab}`)
        ?.classList.add("active");
    });
  });
}

// ── Global controls ───────────────────────────────────────────────────────────
function bindGlobalControls() {
  document
    .getElementById("btn-clear-pipeline")
    .addEventListener("click", async () => {
      const n = _pipeline.steps.length;
      if (!n) return;
      const ok = await _confirmDestructive({
        title: "Clear the pipeline?",
        body: `${n} step${n === 1 ? "" : "s"} will be deleted. This cannot be undone.`,
        confirmLabel: "Clear",
      });
      if (!ok) return;

      _pipeline.steps = [];
      _expandedNodeId = null;
      _boardState.fittedOnce = false;
      await chrome.storage.local.remove(SK.PIPELINE);
      saveState();
      renderPipeline();
      logToMonitor("warn-log", `Pipeline cleared (${n} steps).`);
    });

  const btnRun = document.getElementById("btn-master-run");
  const btnStop = document.getElementById("btn-master-stop");
  const btnPause = document.getElementById("btn-master-pause");

  // The service worker has always had a pause flag and the executor waits on
  // it, but nothing in the UI could set it — and there was no resume message at
  // all, so pausing a run would have meant ending it.
  btnPause?.addEventListener("click", async () => {
    if (!_runState.active || !_runState.runId) return;

    const next = !_runState.paused;
    const res = await chrome.runtime
      .sendMessage({
        type: next ? MSG.PIPELINE_PAUSE : MSG.PIPELINE_RESUME,
        payload: { runId: _runState.runId },
      })
      .catch(() => null);

    if (!res?.ok || res.result?.ok === false) {
      logToMonitor("warn-log", "That run is no longer active.");
      return;
    }
    _setPausedUI(next);
  });

  btnRun.addEventListener("click", async () => {
    if (!_pipeline.steps.length) {
      logToMonitor("warn-log", "Pipeline is empty.");
      return;
    }
    const targetTabId = _tabId;
    if (!targetTabId) {
      logToMonitor("warn-log", "No active tab found.");
      return;
    }
    let tab;
    try {
      tab = await chrome.tabs.get(targetTabId);
    } catch {
      logToMonitor("warn-log", "Active tab is inaccessible.");
      return;
    }

    const bypassRobots =
      document.getElementById("bypass-robots")?.checked || false;
    let urlObj = null;
    try {
      urlObj = new URL(tab.url);
    } catch {}

    document.getElementById("mon-errs").textContent = "0";
    document.getElementById("mon-rows").textContent = "0";
    document.getElementById("mon-progress-fill").style.width = "0%";
    document.getElementById("mon-progress-text").textContent = "0%";

    const runPayload = {
      pipeline: _pipeline,
      tabId: targetTabId,
      targetOrigin: urlObj ? urlObj.origin : null,
      targetPath: urlObj ? urlObj.pathname : "/",
      bypassRobots,
    };

    // Pre-flight: run the ethics gates and show the user what they found before
    // anything executes. The background re-runs them at start, so this is for
    // visibility and consent, not enforcement.
    const pre = await chrome.runtime.sendMessage({
      type: "pipeline:preflight",
      payload: runPayload,
    });

    if (!pre?.ok) {
      logToMonitor(
        "error-log",
        `Pre-flight check failed: ${pre?.error || "Unknown error"}`,
      );
      return;
    }

    const { blocked, blocker, warnings = [] } = pre.result ?? {};

    if (blocked) {
      document.querySelector('[data-tab="monitor"]').click();
      logToMonitor(
        "error-log",
        `Blocked · ${blocker?.code}: ${blocker?.message}`,
      );
      return;
    }

    if (warnings.length) {
      document.querySelector('[data-tab="monitor"]').click();
      for (const w of warnings) {
        logToMonitor("warn-log", `Ethics · ${w.code}: ${w.message}`);
      }
      const proceed = await _confirmEthicsWarnings(warnings);
      if (!proceed) {
        logToMonitor("warn-log", "Run cancelled at the ethics check.");
        return;
      }
      runPayload.confirmed = true;
    }

    const res = await chrome.runtime.sendMessage({
      type: MSG.PIPELINE_START,
      payload: runPayload,
    });
    if (res?.ok) {
      _runState = {
        active: true,
        startTs: Date.now(),
        runId: res.result?.runId,
        timer: null,
      };
      btnRun.classList.add("hidden");
      document.getElementById("run-controls")?.classList.remove("hidden");
      _setPausedUI(false);
      document.querySelector('[data-tab="monitor"]').click();
      startMonitorTimer();
      logToMonitor("info-log", "Pipeline started.");
    } else {
      logToMonitor(
        "error-log",
        `Failed to start: ${res?.error || "Unknown error"}`,
      );
    }
  });

  btnStop.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({
      type: "pipeline:stop",
      payload: { runId: _runState.runId, tabId: _tabId },
    });
    stopRunUI();
    logToMonitor("warn-log", "Pipeline stopped by user.");
  });

  document.getElementById("btn-clear-logs").addEventListener("click", () => {
    document.getElementById("mon-logs").innerHTML = "";
  });

  document
    .getElementById("btn-save-key-2captcha")
    ?.addEventListener("click", () =>
      _saveAndValidateKey("2captcha", "2Captcha", "key-2captcha"),
    );
  document
    .getElementById("btn-save-key-openai")
    ?.addEventListener("click", () =>
      _saveAndValidateKey("openai", "OpenAI", "key-openai"),
    );
  document
    .getElementById("btn-save-key-gemini")
    ?.addEventListener("click", () =>
      _saveAndValidateKey("gemini", "Gemini", "key-gemini"),
    );
  document
    .getElementById("btn-update-proxies")
    ?.addEventListener("click", async () => {
      const text = document.getElementById("config-proxy-text").value.trim();
      const mode = document.getElementById("config-proxy-mode").value;
      if (!text) return logToMonitor("warn-log", "Paste proxy list first.");
      const res = await chrome.runtime.sendMessage({
        type: "proxy:update",
        payload: { text, mode },
      });
      logToMonitor(
        res?.ok ? "info-log" : "error-log",
        res?.ok
          ? `Proxy pool updated: ${res.result?.count || 0} entries.`
          : "Failed to update proxy pool.",
      );
    });
  document
    .getElementById("btn-detect-structure")
    ?.addEventListener("click", () => _detectStructure());

  document
    .getElementById("btn-export-script")
    ?.addEventListener("click", async () => {
      if (!_pipeline.steps.length)
        return logToMonitor("warn-log", "Pipeline is empty.");
      // prompt() is blocked in the side panel, which is why this was hardcoded
      // to python and the Node emitter was unreachable (B-12). A select is not.
      const format =
        document.getElementById("sel-export-format")?.value === "node"
          ? "node"
          : "python";
      const res = await chrome.runtime.sendMessage({
        type: "script:export",
        payload: { pipeline: _pipeline, format },
      });
      if (res?.ok && res.result?.code) {
        // Say what the script will not do before handing it over.
        for (const step of res.result.unexportable ?? []) {
          logToMonitor(
            "warn-log",
            `Not exported: ${step.type} — ${step.reason}. The script will throw if it reaches that step.`,
          );
        }

        // Templates are a runtime feature of the executor. A standalone script
        // has nothing to resolve them with, so it would request a URL with
        // braces in it (B-16).
        for (const t of res.result.templates ?? []) {
          logToMonitor(
            "warn-log",
            `Unresolved template in ${t.type} ${t.where}: ${t.template} — the script uses it literally.`,
          );
        }

        // Credentials are replaced with environment lookups (B-14), which the
        // user has to set before the script will work.
        const secrets = res.result.secrets ?? [];
        if (secrets.length) {
          logToMonitor(
            "info-log",
            `${secrets.length} credential(s) replaced with environment variables: ${secrets
              .map((x) => x.env)
              .join(", ")}. Set them before running the script.`,
          );
        }

        const blob = new Blob([res.result.code], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `flowscrape_${format}.${format === "python" ? "py" : "mjs"}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        logToMonitor("info-log", `Exported as ${format} script.`);
      } else {
        logToMonitor(
          "error-log",
          `Export failed: ${res?.error || "Unknown error"}`,
        );
      }
    });

  const uploadPipelineInput = document.getElementById("input-upload-pipeline");

  document
    .getElementById("btn-upload-pipeline")
    ?.addEventListener("click", () => {
      uploadPipelineInput?.click();
    });

  uploadPipelineInput?.addEventListener("change", async (event) => {
    const file = event.target?.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const normalized = _normalizeImportedPipeline(parsed);

      _pipeline = normalized;
      _expandedNodeId = null;
      _boardState.fittedOnce = false;
      await saveState();
      renderPipeline();
      logToMonitor(
        "info-log",
        `Loaded pipeline from ${file.name} (${normalized.steps.length} top-level steps).`,
      );
    } catch (error) {
      logToMonitor(
        "error-log",
        `Upload failed: ${error?.message || "Invalid pipeline JSON file."}`,
      );
    } finally {
      event.target.value = "";
    }
  });

  document
    .getElementById("btn-download-pipeline")
    ?.addEventListener("click", async () => {
      if (!_pipeline.steps.length) {
        logToMonitor("warn-log", "Pipeline is empty.");
        return;
      }

      const payload = {
        ..._pipeline,
        meta: {
          exportedAt: new Date().toISOString(),
          source: "flowscrape-sidepanel",
        },
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `flowscrape_pipeline_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      logToMonitor("info-log", "Pipeline JSON downloaded.");
    });

  document
    .getElementById("btn-download-partial")
    ?.addEventListener("click", () =>
      _downloadRunRows(_runState.runId ?? _lastRunId),
    );
}

function startMonitorTimer() {
  if (_runState.timer) clearInterval(_runState.timer);

  let ticks = 0;
  _runState.timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - _runState.startTs) / 1000);
    document.getElementById("mon-time").textContent =
      `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

    // Every 5s, check the run still exists. _runStates in the service worker is
    // in-memory only, so an MV3 termination mid-run leaves this panel showing a
    // Stop button for a run that no longer exists and will never report
    // finishing. Polling also wakes the worker, so a run that is merely idle
    // between steps answers normally.
    if (++ticks % 5 === 0) _checkRunAlive();
  }, 1000);
}

/** Notice a run that the service worker has forgotten. */
async function _checkRunAlive() {
  if (!_runState.active || !_runState.runId) return;

  const res = await chrome.runtime
    .sendMessage({
      type: "pipeline:status",
      payload: { runId: _runState.runId },
    })
    .catch(() => null);

  // No answer at all: the worker is starting up. Try again on the next tick
  // rather than declaring the run dead.
  if (!res?.ok) return;
  if (res.result?.known) return;

  const lostRunId = _runState.runId;
  stopRunUI();
  document.getElementById("mon-state").textContent = "Interrupted";
  document.getElementById("mon-state").style.color = "var(--red)";
  logToMonitor(
    "error-log",
    "The background worker was shut down mid-run, so the pipeline stopped. " +
      "Rows collected up to that point are still recoverable.",
  );
  await _showResumeBanner();
  logToMonitor("info-log", `Interrupted run: ${lostRunId}`);
}
/** Reflect paused state in the button and the status card. */
function _setPausedUI(paused) {
  _runState.paused = paused;
  const btn = document.getElementById("btn-master-pause");
  if (btn) btn.textContent = paused ? "▶ Resume" : "⏸ Pause";

  const state = document.getElementById("mon-state");
  if (state && paused) {
    state.textContent = "Paused";
    state.style.color = "var(--yellow, #FACC15)";
  }
}

function stopRunUI() {
  _runState.active = false;
  _runState.paused = false;
  // The listener filters by runId, so leaving the finished run's id here meant
  // a late pipeline:log for it was still accepted and appended to a pane that
  // now describes nothing (E-19). The id is kept separately, because the rows
  // stay downloadable after the run ends and the button needs to name them.
  _lastRunId = _runState.runId ?? _lastRunId;
  _runState.runId = null;
  clearInterval(_runState.timer);
  _runState.timer = null;
  document.getElementById("btn-master-run").classList.remove("hidden");
  document.getElementById("run-controls")?.classList.add("hidden");
  _setPausedUI(false);
  document.getElementById("mon-state").textContent = "Stopped";
  document.getElementById("mon-state").style.color = "var(--text-dim)";
  document
    .querySelectorAll(".node-card")
    .forEach((n) => n.classList.remove("running"));
}

// ── Board surface (fabric-style pan/zoom + wires) ───────────────────────────
function initBoardSurface() {
  if (!elBoardViewport || !elBoardStage) return;

  document
    .getElementById("btn-board-zoom-in")
    ?.addEventListener("click", () => {
      const cx = elBoardViewport.clientWidth / 2;
      const cy = elBoardViewport.clientHeight / 2;
      _zoomBoard(1.15, cx, cy);
    });
  document
    .getElementById("btn-board-zoom-out")
    ?.addEventListener("click", () => {
      const cx = elBoardViewport.clientWidth / 2;
      const cy = elBoardViewport.clientHeight / 2;
      _zoomBoard(1 / 1.15, cx, cy);
    });
  document
    .getElementById("btn-board-zoom-reset")
    ?.addEventListener("click", () => {
      _boardState.scale = 1;
      _boardState.x = 24;
      _boardState.y = 24;
      _applyBoardTransform();
    });
  document.getElementById("btn-board-fit")?.addEventListener("click", () => {
    _fitBoardToContent();
  });

  elBoardViewport.addEventListener(
    "wheel",
    (e) => {
      if (!elBoardViewport) return;
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
        // A plain wheel scrolls the board rather than zooming, which is what a
        // long pipeline needs. Saying so once beats leaving trackpad users to
        // conclude zoom is broken (E-12).
        _hintZoomModifier();
        return;
      }
      e.preventDefault();
      const rect = elBoardViewport.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      _zoomBoard(e.deltaY < 0 ? 1.12 : 1 / 1.12, cx, cy);
    },
    { passive: false },
  );

  elBoardViewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    const interactive =
      e.target.closest(".node-card") ||
      e.target.closest(".insert-step") ||
      e.target.closest(".insert-inner") ||
      e.target.closest("input,textarea,select,button,.btn");
    if (interactive) return;
    _boardState.panning = true;
    _boardState.startX = e.clientX;
    _boardState.startY = e.clientY;
    _boardState.originX = _boardState.x;
    _boardState.originY = _boardState.y;
    elBoardViewport.classList.add("panning");
    elBoardViewport.setPointerCapture(e.pointerId);
  });

  elBoardViewport.addEventListener("pointermove", (e) => {
    if (!_boardState.panning) return;
    _boardState.x = _boardState.originX + (e.clientX - _boardState.startX);
    _boardState.y = _boardState.originY + (e.clientY - _boardState.startY);
    _applyBoardTransform();
  });

  const stopPan = () => {
    _boardState.panning = false;
    elBoardViewport.classList.remove("panning");
  };
  elBoardViewport.addEventListener("pointerup", stopPan);
  elBoardViewport.addEventListener("pointercancel", stopPan);
  window.addEventListener("resize", () => _scheduleWireRender());

  _applyBoardTransform();
}

function _zoomBoard(factor, cx, cy) {
  const prev = _boardState.scale;
  const next = Math.min(
    _boardState.maxScale,
    Math.max(_boardState.minScale, prev * factor),
  );
  if (next === prev) return;

  const localX = (cx - _boardState.x) / prev;
  const localY = (cy - _boardState.y) / prev;
  _boardState.scale = next;
  _boardState.x = cx - localX * next;
  _boardState.y = cy - localY * next;
  _applyBoardTransform();
}

function _applyBoardTransform() {
  if (!elBoardStage) return;
  elBoardStage.style.transform = `translate(${_boardState.x}px, ${_boardState.y}px) scale(${_boardState.scale})`;
  if (elBoardZoomLabel) {
    elBoardZoomLabel.textContent = `${Math.round(_boardState.scale * 100)}%`;
  }
  _scheduleWireRender();
}

/** Pending rAF handle for the wire redraw. */
let _wireFrame = null;

/**
 * Redraw the wires at most once per frame.
 *
 * _renderBoardWires regenerates the entire SVG as a string and assigns it to
 * innerHTML — measuring every node, re-parsing the markup, rebuilding the whole
 * subtree. Pointer-move panning called it on every single move event, with no
 * throttle, so a drag across the board did that work dozens of times per frame
 * (E-11). Coalescing to one redraw per animation frame is the entire fix; the
 * transform itself is a CSS property and stays synchronous, so panning still
 * tracks the pointer exactly.
 */
function _scheduleWireRender() {
  if (_wireFrame !== null) return;
  _wireFrame = requestAnimationFrame(() => {
    _wireFrame = null;
    _renderBoardWires();
  });
}

function _fitBoardToContent() {
  if (!elBoardViewport || !elCanvas) return;
  const wrappers = Array.from(elCanvas.querySelectorAll(".node-wrapper"));
  if (!wrappers.length) {
    _boardState.scale = 1;
    _boardState.x = 24;
    _boardState.y = 24;
    _applyBoardTransform();
    return;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  wrappers.forEach((w) => {
    minX = Math.min(minX, w.offsetLeft);
    minY = Math.min(minY, w.offsetTop);
    maxX = Math.max(maxX, w.offsetLeft + w.offsetWidth);
    maxY = Math.max(maxY, w.offsetTop + w.offsetHeight);
  });

  const boundsW = Math.max(1, maxX - minX);
  const boundsH = Math.max(1, maxY - minY);
  const pad = 120;
  const vw = elBoardViewport.clientWidth;
  const vh = elBoardViewport.clientHeight;
  const fitScale = Math.min((vw - pad) / boundsW, (vh - pad) / boundsH, 1.12);

  _boardState.scale = Math.min(
    _boardState.maxScale,
    Math.max(_boardState.minScale, fitScale),
  );
  _boardState.x =
    (vw - boundsW * _boardState.scale) / 2 - minX * _boardState.scale;
  _boardState.y =
    (vh - boundsH * _boardState.scale) / 2 - minY * _boardState.scale;
  _boardState.fittedOnce = true;
  _applyBoardTransform();
}

function _collectPipelineLinks(steps, bucket = []) {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const next = steps[i + 1];
    if (next) bucket.push({ from: step.id, to: next.id, kind: "chain" });

    if (
      step.type === "LOOP" &&
      Array.isArray(step.children) &&
      step.children.length
    ) {
      bucket.push({ from: step.id, to: step.children[0].id, kind: "loop" });
      _collectPipelineLinks(step.children, bucket);
    }
    if (step.type === "IF_ELSE") {
      if (Array.isArray(step.ifBranch) && step.ifBranch.length) {
        bucket.push({ from: step.id, to: step.ifBranch[0].id, kind: "if" });
        _collectPipelineLinks(step.ifBranch, bucket);
      }
      if (Array.isArray(step.elseBranch) && step.elseBranch.length) {
        bucket.push({ from: step.id, to: step.elseBranch[0].id, kind: "else" });
        _collectPipelineLinks(step.elseBranch, bucket);
      }
    }
  }
  return bucket;
}

function _nodeAnchor(stepId, edge = "bottom") {
  if (!elBoardStage) return null;
  const port = document.querySelector(
    `.node-wrapper[data-id="${stepId}"] .node-card .node-port.${edge === "bottom" ? "out" : "in"}`,
  );
  if (port) {
    const stageRect = elBoardStage.getBoundingClientRect();
    const r = port.getBoundingClientRect();
    const x = (r.left + r.width / 2 - stageRect.left) / _boardState.scale;
    const y = (r.top + r.height / 2 - stageRect.top) / _boardState.scale;
    return { x, y };
  }

  const card = document.querySelector(
    `.node-wrapper[data-id="${stepId}"] .node-card`,
  );
  if (!card) return null;
  const stageRect = elBoardStage.getBoundingClientRect();
  const r = card.getBoundingClientRect();
  const x = (r.left + r.width / 2 - stageRect.left) / _boardState.scale;
  const yRaw = edge === "bottom" ? r.bottom : r.top;
  const y = (yRaw - stageRect.top) / _boardState.scale;
  return { x, y };
}

function _buildWirePath(a, b, kind = "chain") {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const pull = Math.max(30, Math.abs(dy) * 0.45);

  // For chain steps directly below each other, this creates a perfectly straight line or smooth S-curve.
  const c1x = a.x;
  const c1y = a.y + pull;
  const c2x = b.x;
  const c2y = b.y - pull;

  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

function _renderBoardWires() {
  if (!elPipelineWires || !elCanvas || !elBoardViewport) return;
  const links = _collectPipelineLinks(_pipeline.steps, []);

  const paths = [
    `<defs>
      <marker id="wire-arrow-chain" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L6,3 L0,6 Z" fill="rgba(255, 255, 255, 0.4)"></path>
      </marker>
      <marker id="wire-arrow-loop" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L6,3 L0,6 Z" fill="rgba(129, 140, 248, 0.7)"></path>
      </marker>
      <marker id="wire-arrow-if" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L6,3 L0,6 Z" fill="rgba(74, 222, 128, 0.7)"></path>
      </marker>
      <marker id="wire-arrow-else" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L6,3 L0,6 Z" fill="rgba(251, 113, 133, 0.7)"></path>
      </marker>
    </defs>`,
  ];

  for (const link of links) {
    const a = _nodeAnchor(link.from, "bottom");
    const b = _nodeAnchor(link.to, "top");
    if (!a || !b) continue;

    const d = _buildWirePath(a, b, link.kind);
    const klass =
      link.kind === "chain" ? "wire-path" : `wire-path ${link.kind}`;
    const markerId =
      link.kind === "chain" ? "wire-arrow-chain" : `wire-arrow-${link.kind}`;
    const dotClass =
      link.kind === "chain" ? "wire-dot" : `wire-dot ${link.kind}`;

    paths.push(
      `<path class="wire-path-glow ${link.kind === "chain" ? "" : link.kind}" d="${d}"></path>`,
    );
    // Add the tracer path (hidden normally)
    paths.push(
      `<path class="wire-path-tracer hidden-tracer" data-to="${link.to}" d="${d}"></path>`,
    );
    paths.push(
      `<path class="${klass}" d="${d}" marker-end="url(#${markerId})"></path>`,
    );
    paths.push(
      `<circle class="${dotClass}" cx="${a.x.toFixed(2)}" cy="${a.y.toFixed(2)}" r="2.4"></circle>`,
    );
    paths.push(
      `<circle class="${dotClass}" cx="${b.x.toFixed(2)}" cy="${b.y.toFixed(2)}" r="3.2"></circle>`,
    );
  }
  elPipelineWires.innerHTML = paths.join("");
}

function _focusNodeOnBoard(card) {
  if (!card || !elBoardViewport) return;
  const vr = elBoardViewport.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  const margin = 80;

  let dx = 0;
  let dy = 0;
  if (cr.left < vr.left + margin) dx = vr.left + margin - cr.left;
  if (cr.right > vr.right - margin) dx = vr.right - margin - cr.right;
  if (cr.top < vr.top + margin) dy = vr.top + margin - cr.top;
  if (cr.bottom > vr.bottom - margin) dy = vr.bottom - margin - cr.bottom;

  if (dx || dy) {
    _boardState.x += dx;
    _boardState.y += dy;
    _applyBoardTransform();
  }
}

// ── Palette ───────────────────────────────────────────────────────────────────
function bindPalette() {
  document
    .getElementById("btn-close-palette")
    .addEventListener("click", () => elPalette.classList.remove("open"));
  elPaletteSearch.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    document
      .querySelectorAll(".palette-category")
      .forEach((c) => (c.style.display = "none"));
    document.querySelectorAll(".palette-item").forEach((item) => {
      const match =
        item.dataset.type.toLowerCase().includes(q) ||
        item.dataset.desc.toLowerCase().includes(q);
      item.style.display = match ? "flex" : "none";
      if (match)
        item
          .closest(".palette-group")
          .querySelector(".palette-category").style.display = "block";
    });
  });
}
function populatePalette() {
  const cats = { Action: [], Flow: [], Data: [] };
  for (const [type, data] of Object.entries(STEP_REGISTRY))
    cats[data.cat].push({ type, ...data });
  let html = "";
  for (const [cat, items] of Object.entries(cats)) {
    html += `<div class="palette-group"><div class="palette-category">${cat}</div><div class="palette-grid">`;
    html += items
      .map(
        (
          i,
        ) => `<div class="palette-item" data-action="add-step" data-type="${i.type}" data-desc="${i.desc}">
      <div class="palette-item-icon" style="background:var(--step-${i.type});">${i.icon}</div>
      <div class="palette-item-label">${i.type}</div></div>`,
      )
      .join("");
    html += `</div></div>`;
  }
  elPaletteContent.innerHTML = html;
  _makeKeyboardAccessible(elPaletteContent);
}

// ── Deep step helpers ─────────────────────────────────────────────────────────
function _findStepDeep(steps, id) {
  for (const s of steps) {
    if (s.id === id) return s;
    let found = null;
    if (s.children) found = _findStepDeep(s.children, id);
    if (!found && s.ifBranch) found = _findStepDeep(s.ifBranch, id);
    if (!found && s.elseBranch) found = _findStepDeep(s.elseBranch, id);
    if (found) return found;
  }
  return null;
}
function _removeStepDeep(steps, id) {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].id === id) {
      steps.splice(i, 1);
      return true;
    }
    if (steps[i].children && _removeStepDeep(steps[i].children, id))
      return true;
    if (steps[i].ifBranch && _removeStepDeep(steps[i].ifBranch, id))
      return true;
    if (steps[i].elseBranch && _removeStepDeep(steps[i].elseBranch, id))
      return true;
  }
  return false;
}

function _nextStepId() {
  return `s_${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function _normalizeImportedPipeline(source) {
  const input = source?.pipeline?.steps ? source.pipeline : source;
  if (!input || typeof input !== "object" || !Array.isArray(input.steps)) {
    throw new Error("Pipeline file must contain an object with a steps array.");
  }

  const seenIds = new Set();
  const steps = input.steps.map((step, index) =>
    _normalizeImportedStep(step, `steps[${index}]`, seenIds),
  );

  return {
    name: typeof input.name === "string" ? input.name : "Imported Pipeline",
    version: typeof input.version === "string" ? input.version : "1.0.0",
    targetOrigin:
      typeof input.targetOrigin === "string" ? input.targetOrigin : "",
    steps,
  };
}

function _normalizeImportedStep(step, where, seenIds) {
  if (!step || typeof step !== "object") {
    throw new Error(`${where} is not a valid step object.`);
  }

  const type = String(step.type || "")
    .trim()
    .toUpperCase();
  if (!type) {
    throw new Error(`${where} is missing a step type.`);
  }
  // Any uppercase string used to be accepted. It rendered with a "?" icon and
  // an undefined CSS colour, then failed at run time with "Unknown step type"
  // — long after the import said it had worked (D-09).
  if (!isKnownStepType(type)) {
    throw new Error(
      `${where} has an unknown step type "${type}". Known types: ${USER_STEP_TYPES.join(", ")}.`,
    );
  }
  if (STEP_TYPES[type].internal) {
    throw new Error(
      `${where} uses "${type}", which the executor dispatches internally and cannot be placed in a pipeline.`,
    );
  }

  let id = typeof step.id === "string" && step.id.trim() ? step.id.trim() : "";
  if (!id || seenIds.has(id)) {
    id = _nextStepId();
  }
  seenIds.add(id);

  // Registry defaults first, then whatever the file supplied. An imported step
  // missing keys used to render a half-empty config form and hit undefined at
  // run time; now it looks exactly like one built in the palette (D-09).
  const normalized = {
    id,
    type,
    config: {
      ...defaultConfig(type),
      ...(step.config && typeof step.config === "object"
        ? JSON.parse(JSON.stringify(step.config))
        : {}),
    },
  };

  if (Array.isArray(step.children) || type === "LOOP") {
    normalized.children = Array.isArray(step.children)
      ? step.children.map((child, idx) =>
          _normalizeImportedStep(child, `${where}.children[${idx}]`, seenIds),
        )
      : [];
  }

  if (
    Array.isArray(step.ifBranch) ||
    Array.isArray(step.elseBranch) ||
    type === "IF_ELSE"
  ) {
    normalized.ifBranch = Array.isArray(step.ifBranch)
      ? step.ifBranch.map((child, idx) =>
          _normalizeImportedStep(child, `${where}.ifBranch[${idx}]`, seenIds),
        )
      : [];
    normalized.elseBranch = Array.isArray(step.elseBranch)
      ? step.elseBranch.map((child, idx) =>
          _normalizeImportedStep(child, `${where}.elseBranch[${idx}]`, seenIds),
        )
      : [];
  }

  return normalized;
}

// ── Add / remove / open palette ───────────────────────────────────────────────
function _addStep(type) {
  const newStep = {
    id: "s_" + Date.now() + Math.floor(Math.random() * 1000),
    type,
    config: { ...defaultConfig(type), optional: false },
  };
  if (type === "LOOP") {
    newStep.children = [];
  }
  if (type === "IF_ELSE") {
    newStep.ifBranch = [];
    newStep.elseBranch = [];
  }

  const { index, parentId, branchKey } = _insertCtx;
  if (parentId) {
    const parent = _findStepDeep(_pipeline.steps, parentId);
    if (parent && Array.isArray(parent[branchKey])) {
      index === -1
        ? parent[branchKey].push(newStep)
        : parent[branchKey].splice(index, 0, newStep);
    }
  } else {
    index === -1 || index >= _pipeline.steps.length
      ? _pipeline.steps.push(newStep)
      : _pipeline.steps.splice(Math.max(0, index), 0, newStep);
  }
  elPalette.classList.remove("open");
  _expandedNodeId = newStep.id;
  saveState();
  renderPipeline();
}

function _openPalette(index, parentId = "", branchKey = "") {
  _insertCtx = { index, parentId, branchKey };
  elPaletteSearch.value = "";
  populatePalette();
  elPalette.classList.add("open");
  elPaletteSearch.focus();
}

// ── Pipeline renderer ─────────────────────────────────────────────────────────
function renderPipeline() {
  if (!_pipeline.steps.length) {
    elCanvas.innerHTML = `<div class="empty-state"><div style="font-size:32px;margin-bottom:16px;">✨</div>
      <div>Start building your flow.</div>
      <button class="btn btn-primary" style="margin-top:16px;" data-action="open-palette" data-index="-1" data-parent-id="" data-branch="">+ Add First Step</button></div>`;
    if (elPipelineWires) elPipelineWires.innerHTML = "";
    _makeKeyboardAccessible(elCanvas);
    _applyBoardTransform();
    return;
  }
  let html = `<div class="insert-step top-insert" data-action="open-palette" data-index="0" data-parent-id="" data-branch="">+</div>`;
  _pipeline.steps.forEach((step, i) => {
    html += renderStepNode(step, i, _pipeline.steps.length, "", "");
  });
  elCanvas.innerHTML = html;
  bindConfigInputs();
  bindDragAndDrop();
  _makeKeyboardAccessible(elCanvas);
  requestAnimationFrame(() => {
    if (!_boardState.fittedOnce) _fitBoardToContent();
    else _applyBoardTransform();
  });
}

function renderStepNode(step, index, total, parentId, branchKey) {
  const reg = STEP_REGISTRY[step.type] || { icon: "?", desc: "" };
  const isExpanded = _expandedNodeId === step.id;

  let html = `<div class="node-wrapper" data-index="${index}" data-id="${step.id}" data-parent-id="${parentId}" data-branch="${branchKey}">`;
  html += `<div class="node-card ${isExpanded ? "expanded" : ""}" style="--node-step-color:var(--step-${step.type},#64748B);border-left:4px solid var(--node-step-color);" draggable="true" data-drag-id="${step.id}" data-step-type="${step.type}">`;
  html += `<div class="node-port in" aria-hidden="true"></div>`;
  html += `<div class="node-header" data-action="toggle-expand" data-id="${step.id}">
    <div class="node-icon-box" style="background:var(--step-${step.type},#64748B);">${reg.icon}</div>
    <div class="node-title-group">
      <div class="node-title">${step.type} <span class="node-status-icon running-spinner">⏳</span></div>
      <div class="node-subtitle">${getStepSubtitle(step)}</div>
    </div>
    <div class="node-actions">
      <button class="btn-icon action-btn" data-action="test-step" data-id="${step.id}" title="Test Step">▶</button>
      <button class="btn-icon action-btn" style="color:var(--red);" data-action="remove-step" data-id="${step.id}" title="Remove">✕</button>
    </div>
  </div>`;
  html += `<div class="node-config">${generateConfigHtml(step)}</div>`;
  html += `<div class="node-port out" aria-hidden="true"></div>`;
  html += `</div>`; // end .node-card

  // LOOP container body
  if (step.type === "LOOP") {
    html += `<div class="loop-body">
      <div class="loop-scope-bar"></div>
      <div class="loop-body-inner" data-parent-id="${step.id}" data-branch="children">`;
    const children = step.children || [];
    children.forEach((child, ci) => {
      html += renderStepNode(child, ci, children.length, step.id, "children");
    });
    html += `<div class="insert-inner" data-action="open-palette" data-index="-1" data-parent-id="${step.id}" data-branch="children" title="Add step inside loop">+</div>`;
    html += `</div></div>`;
    html += `<div class="loop-end-marker">↩ LOOP END</div>`;
  }

  // IF_ELSE container branches
  if (step.type === "IF_ELSE") {
    html += `<div class="if-branches">`;
    for (const bk of ["ifBranch", "elseBranch"]) {
      const isIf = bk === "ifBranch";
      const branch = step[bk] || [];
      html += `<div class="if-branch ${isIf ? "if-true" : "if-false"}">`;
      html += `<div class="branch-header">${isIf ? "IF ✓ (met)" : "ELSE ✗ (not met)"}</div>`;
      html += `<div class="loop-body-inner" data-parent-id="${step.id}" data-branch="${bk}">`;
      branch.forEach((child, ci) => {
        html += renderStepNode(child, ci, branch.length, step.id, bk);
      });
      html += `<div class="insert-inner" data-action="open-palette" data-index="-1" data-parent-id="${step.id}" data-branch="${bk}" title="Add step in branch">+</div>`;
      html += `</div></div>`;
    }
    html += `</div>`;
    html += `<div class="ifelse-end-marker">↩ IF END</div>`;
  }

  // Bottom insert between steps
  html += `<div class="insert-step" data-action="open-palette" data-index="${index + 1}" data-parent-id="${parentId}" data-branch="${branchKey}">+</div>`;
  html += `</div>`; // end .node-wrapper
  return html;
}

function getStepSubtitle(step) {
  const c = step.config;
  switch (step.type) {
    case "WEBSITE":
      return c.url || "No URL";
    case "NAVIGATE":
      return c.url || "No URL";
    case "API":
      return `${(c.method || "GET").toUpperCase()} ${c.url || "No URL"}`;
    case "CLICK":
      return c.selector
        ? `${c.all ? "All: " : ""}${c.selector}`
        : "No selector";
    case "FILL":
      return c.mode === "multi"
        ? `${(c.fields || []).length} fields`
        : c.selector || "No selector";
    case "WAIT":
      return `Wait ${c.ms}ms`;
    case "LOOP":
      return c.type === "elements" && !(c.max > 0)
        ? "elements mode · every match"
        : `${c.type} mode · max ${c.max}`;
    case "IF_ELSE":
      return `${c.condition}: ${c.selector || "?"}`;
    case "UPLOAD_ACTIVITY": {
      const validIds = new Set(_storageFiles.map((f) => f.id));
      const selected = (c.fileIds || []).filter((id) => validIds.has(id));
      return `${selected.length} file(s) -> ${c.selector || "input[type=file]"}`;
    }
    case "AUTO_EXTRACT":
      return `🤖 AI Extract • conf≥${c.confidenceThreshold ?? 70}%`;
    default:
      return STEP_REGISTRY[step.type]?.desc || "";
  }
}

// ── Config HTML generators ────────────────────────────────────────────────────
/**
 * The config panel for one step: its own fields, then the options every page
 * step shares.
 *
 * The shared part is appended here rather than inside each of the twenty
 * type-specific blocks, because twenty copies of a toggle is twenty places for
 * one of them to be forgotten — which is precisely how IF_ELSE shipped without
 * the "optional" toggle (E-15).
 */
function generateConfigHtml(step) {
  let html = _configFields(step);
  if (STEP_TYPES[step.type]?.runsIn === "page") {
    html += toggle(step, "inFrame", "Look inside iframes as well");
    html += hint(
      "An iframe is a separate page embedded in this one, and its contents " +
        "are invisible to a selector by default — which is why nothing could " +
        "reach them. With this on, the step tries the page first and then each " +
        "frame, and uses the first one where the selector matches.",
    );
  }
  return html;
}

function _configFields(step) {
  const c = step.config;
  let html = "";

  // ── WEBSITE / NAVIGATE ──
  if (step.type === "WEBSITE" || step.type === "NAVIGATE") {
    html += field(
      step,
      "url",
      step.type === "WEBSITE" ? "Website URL" : "URL",
      "text",
      c.url || "",
    );
    html += toggle(step, "wait", "Wait for page load");
    if (c.wait !== false) {
      html += field(
        step,
        "timeoutMs",
        "Give up waiting after (ms)",
        "number",
        c.timeoutMs ?? 30000,
      );
      html += hint(
        "The run polls until the tab reports it has finished loading, then " +
          "moves on. Past this it continues anyway and says so in the log.",
      );
    }
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── API ──
  if (step.type === "API") {
    html += field(step, "url", "API URL", "text", c.url || "");
    html += `<label>Method</label><select id="cfg-${step.id}-method" data-id="${step.id}" data-key="method" class="cfg-bind" style="margin-bottom:8px;">
      <option value="GET" ${(c.method || "GET") === "GET" ? "selected" : ""}>GET</option>
      <option value="POST" ${c.method === "POST" ? "selected" : ""}>POST</option>
      <option value="PUT" ${c.method === "PUT" ? "selected" : ""}>PUT</option>
      <option value="PATCH" ${c.method === "PATCH" ? "selected" : ""}>PATCH</option>
      <option value="DELETE" ${c.method === "DELETE" ? "selected" : ""}>DELETE</option>
    </select>`;
    html += `<label>Headers (JSON)</label>
      <textarea id="cfg-${step.id}-headers" data-id="${step.id}" data-key="headers" class="cfg-bind" rows="3" style="margin-bottom:8px;">${esc(c.headers || '{"Accept":"application/json"}')}</textarea>`;
    html += `<label>Body (JSON or text)</label>
      <textarea id="cfg-${step.id}-body" data-id="${step.id}" data-key="body" class="cfg-bind" rows="3" style="margin-bottom:8px;">${esc(c.body || "")}</textarea>`;
    html += field(
      step,
      "timeoutMs",
      "Timeout (ms)",
      "number",
      c.timeoutMs ?? 15000,
    );
    html += `<label>Response Type</label><select id="cfg-${step.id}-responseType" data-id="${step.id}" data-key="responseType" class="cfg-bind" style="margin-bottom:8px;">
      <option value="auto" ${(c.responseType || "auto") === "auto" ? "selected" : ""}>Auto</option>
      <option value="json" ${c.responseType === "json" ? "selected" : ""}>JSON</option>
      <option value="text" ${c.responseType === "text" ? "selected" : ""}>Text</option>
    </select>`;
    html += field(
      step,
      "storeAs",
      "Store Result As",
      "text",
      c.storeAs || "api",
    );
    html += toggle(step, "failOnHttpError", "Fail on non-2xx status");
    html += toggle(
      step,
      "exposeBodyAsExtracted",
      "Merge JSON body into extracted context",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── CLICK ──
  if (step.type === "CLICK") {
    html += selectorRow(step, "selector");
    html += toggle(step, "all", "Click ALL matching elements");
    html += toggle(
      step,
      "fallbackToLoopItem",
      "Inside a loop, click the item itself if the selector misses",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── FILL (single + multi) ──
  if (step.type === "FILL") {
    const mode = c.mode || "single";
    html += `<div class="mode-toggle" style="margin-bottom:8px;">
      <button class="btn ${mode === "single" ? "btn-primary" : ""}" data-action="set-fill-mode" data-id="${step.id}" data-mode="single">Single Field</button>
      <button class="btn ${mode === "multi" ? "btn-primary" : ""}" data-action="set-fill-mode" data-id="${step.id}" data-mode="multi">Multi Fields</button>
    </div>`;
    if (mode === "single") {
      html += selectorRow(step, "selector");
      html += field(step, "text", "Text to type", "text", c.text || "");
      html += field(
        step,
        "delayMs",
        "Delay per char (ms)",
        "number",
        c.delayMs ?? 50,
      );
      html += toggle(step, "append", "Append (don't clear field)");
    } else {
      // multi mode
      html += toggle(step, "append", "Append to ALL fields (don't clear)");
      html += `<div id="fill-fields-${step.id}" style="margin-bottom:8px;">`;
      (c.fields || []).forEach((f, fi) => {
        html += `<div class="fill-field-row">
          <input type="text" class="field-edit" data-id="${step.id}" data-index="${fi}" data-prop="selector" value="${esc(f.selector || "")}" placeholder="selector" style="flex:1.5;font-size:10px;">
          <input type="text" class="field-edit" data-id="${step.id}" data-index="${fi}" data-prop="value" value="${esc(f.value || "")}" placeholder="value" style="flex:2;">
          <button class="btn btn-icon" style="color:var(--red);" data-action="remove-fill-field" data-id="${step.id}" data-index="${fi}">✕</button>
        </div>`;
      });
      html += `</div>
      <div class="flex gap-2" style="align-items:flex-end;margin-bottom:8px;">
        <div style="flex:1"><label style="margin-top:0;">Value</label><input type="text" id="new-fill-val-${step.id}" placeholder="e.g. John Doe"></div>
        <button class="btn btn-primary" data-action="add-fill-field" data-id="${step.id}" style="height:28px;">🎯 Pick Field</button>
      </div>`;
      html += `<label style="margin-top:6px;">Submit Button Selector (optional)</label>`;
      html += selectorRow(step, "submitSelector");
    }
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── KEYBOARD ──
  if (step.type === "KEYBOARD") {
    html += `<label>Key to Press</label>
    <div class="flex gap-2" style="margin-bottom:6px;align-items:center;">
      <div class="key-display" id="key-disp-${step.id}">${esc(c.key || "Not set")}</div>
      <button class="btn key-register-btn" id="key-reg-${step.id}" data-action="register-key" data-id="${step.id}">🔴 Register Key</button>
    </div>`;
    // Typed as well as captured: Ctrl+W and its friends cannot be pressed here
    // at all — Chrome closes the tab before this page sees the key.
    html += `<div class="flex gap-2" style="margin-bottom:8px;align-items:center;">
      <span style="flex:0 0 auto;font-size:10px;color:var(--text-dim);">or type it instead</span>
      <input type="text" class="key-manual-input" data-id="${step.id}"
        value="${esc(c.key || "")}" placeholder="Ctrl+Shift+K" style="flex:1;font-size:11px;">
    </div>`;
    if (_isBrowserReservedKey(c.key)) {
      html += `<div style="background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.35);border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:11px;color:var(--text-dim);line-height:1.5;">
        <b>${esc(c.key)} is a browser shortcut.</b> Chrome acts on it before the
        page does, so pressing it here would ${esc(c.key).toLowerCase().includes("w") ? "close the tab" : "open a tab or window"}
        rather than register it — type it in the box instead. The step still
        sends it to the page, which works if the page listens for it, but the
        browser's own action cannot be suppressed by any extension.
      </div>`;
    }
    html += `<label>Send it to <span style="color:var(--text-dim);font-weight:400;">(optional)</span></label>`;
    html += selectorRow(step, "selector");
    html += hint(
      "Leave blank to send the key wherever the page currently has focus. " +
        "Naming an element focuses it first — which is what a search box needs " +
        "before it will accept Enter.",
    );
    html += field(
      step,
      "repeat",
      "Press this many times",
      "number",
      c.repeat ?? 1,
    );
    if ((c.repeat ?? 1) > 1) {
      html += field(
        step,
        "delayMs",
        "Wait between presses (ms)",
        "number",
        c.delayMs ?? 50,
      );
    }
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── LOOP ──
  if (step.type === "LOOP") {
    const ltype = c.type || "elements";
    html += `<label>Iteration Mode</label>
    <select id="cfg-${step.id}-type" data-id="${step.id}" data-key="type" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="elements" ${ltype === "elements" ? "selected" : ""}>Loop through Elements (auto-count)</option>
      <option value="count"    ${ltype === "count" ? "selected" : ""}>Fixed Count (N times)</option>
      <option value="paginate" ${ltype === "paginate" ? "selected" : ""}>Paginate (click Next)</option>
    </select>`;
    if (ltype === "elements") {
      html += `<div style="background:rgba(99,102,241,0.08);border:1px solid var(--step-LOOP,#6366F1);border-radius:4px;padding:6px 10px;font-size:11px;color:var(--step-LOOP,#6366F1);margin-bottom:8px;">
        🔁 Iterates over ALL matched elements automatically.</div>`;
      html += selectorRow(step, "selector");
      html += field(
        step,
        "max",
        "Safety max (0 = every match)",
        "number",
        c.max ?? 0,
      );
    } else if (ltype === "count") {
      // 0 is only "unlimited" in elements mode, where the page supplies the
      // bound. Here it means zero iterations, so do not offer it as a default
      // when switching over from elements mode (B-22).
      html += field(
        step,
        "max",
        "Repeat N times (at least 1)",
        "number",
        c.max > 0 ? c.max : 10,
      );
    } else {
      // paginate
      html += selectorRow(step, "selector");
      html += field(step, "max", "Max pages", "number", c.max ?? 10);
    }
    html += `<label>On iteration failure</label>
    <select id="cfg-${step.id}-onFail" data-id="${step.id}" data-key="onFail" class="cfg-bind" style="margin-bottom:8px;">
      <option value="skip" ${(c.onFail || "skip") === "skip" ? "selected" : ""}>Skip and continue</option>
      <option value="stop" ${c.onFail === "stop" ? "selected" : ""}>Stop loop, keep data</option>
    </select>`;
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── IF_ELSE ──
  if (step.type === "IF_ELSE") {
    const cond = c.condition || "exists";
    // Built from the registry, so a condition cannot exist without the panel
    // offering it, and each one says which inputs it needs — which is how
    // "Attr" once shipped with nowhere to type the attribute name (B-07).
    const meta = CONDITIONS[cond] ?? CONDITIONS.exists;
    html += `<label>Condition</label>
    <select id="cfg-${step.id}-condition" data-id="${step.id}" data-key="condition" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      ${Object.entries(CONDITIONS)
        .map(
          ([name, m]) =>
            `<option value="${name}" ${cond === name ? "selected" : ""}>${esc(m.label)}</option>`,
        )
        .join("")}
    </select>`;
    html += selectorRow(step, "selector");

    if (meta.needs === "attr" || meta.needs === "attr+value") {
      html += field(step, "attr", "Attribute name", "text", c.attr || "");
      html += hint("For example href, src, data-id, aria-expanded.");
    }
    if (meta.needs === "value" || meta.needs === "attr+value") {
      const numeric = cond.startsWith("number-");
      html += field(
        step,
        "value",
        numeric ? "Compare against (a number)" : "Value to compare",
        "text",
        c.value || "",
      );
      if (numeric) {
        html += hint(
          'The number is read out of the text around it, so "$25.50" is 25.5. ' +
            "Text with no number in it never matches — it is not treated as zero.",
        );
        if (c.value && !Number.isFinite(Number(String(c.value).trim()))) {
          html += `<p style="font-size:11px;color:var(--red);margin:-4px 0 8px 0;">Not a number — this branch would fail and always take ELSE.</p>`;
        }
      } else if (cond === "text-matches") {
        html += hint(
          "A regular expression, tested against the element's text.",
        );
        if (c.value && !isValidRegex(c.value)) {
          html += `<p style="font-size:11px;color:var(--red);margin:-4px 0 8px 0;">Not a valid pattern — this branch would fail and always take ELSE.</p>`;
        }
      }
    }
    if (meta.needs === "none" && cond !== "exists" && cond !== "not-exists") {
      html += hint(
        cond === "is-empty"
          ? 'True when the element is missing, empty, or holds only whitespace — all three are "there is nothing here".'
          : "True only when the element is there and has some text in it.",
      );
    }

    html += `<p style="font-size:11px;color:var(--text-dim);margin-top:8px;margin-bottom:0;">
      Add steps in the <b>IF ✓</b> and <b>ELSE ✗</b> blocks below the card.</p>`;
    // Every other step type ends with this; IF_ELSE was the only one without it,
    // so a branch whose selector was missing took the whole run down with no way
    // to mark it tolerable (E-15).
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── SCROLL ──
  if (step.type === "SCROLL") {
    html += `<label>Mode</label><select id="cfg-${step.id}-mode" data-id="${step.id}" data-key="mode" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="pixel"   ${(c.mode || "pixel") === "pixel" ? "selected" : ""}>Pixel (scroll by amount)</option>
      <option value="percent" ${c.mode === "percent" ? "selected" : ""}>Percent of page</option>
      <option value="selector"${c.mode === "selector" ? "selected" : ""}>To element (selector)</option>
      <option value="infinite"${c.mode === "infinite" ? "selected" : ""}>Infinite — load everything</option>
    </select>`;
    if (c.mode === "selector") {
      html += selectorRow(step, "selector");
    } else if (c.mode === "infinite") {
      html += hint(
        "Scrolls to the bottom over and over until the page stops growing — " +
          "for feeds and 'load more' lists. One step replaces a stack of them.",
      );
      html += field(
        step,
        "maxScrolls",
        "Stop after this many scrolls",
        "number",
        c.maxScrolls ?? 50,
      );
      html += field(
        step,
        "settleMs",
        "Wait after each scroll (ms)",
        "number",
        c.settleMs ?? 1200,
      );
      html += `<label>Item selector <span style="color:var(--text-dim);font-weight:400;">(optional)</span></label>`;
      html += selectorRow(step, "selector");
      html += hint(
        "Given one, growth is measured in items rather than page height — " +
          "more reliable on a feed that swaps placeholders for cards.",
      );
    } else {
      html += field(step, "amount", "Amount", "number", c.amount ?? 500);
    }
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── EXPORT ──
  if (step.type === "EXPORT") {
    html += `<label>Format</label><select id="cfg-${step.id}-format" data-id="${step.id}" data-key="format" class="cfg-bind" style="margin-bottom:8px;">
      ${ROW_FORMATS.map(
        (f) =>
          `<option value="${f}" ${(c.format || "csv") === f ? "selected" : ""}>${esc(formatMeta(f).label)}</option>`,
      ).join("")}
    </select>`;
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── UPLOAD_ACTIVITY ──
  if (step.type === "UPLOAD_ACTIVITY") {
    const validIds = new Set(_storageFiles.map((f) => f.id));
    const selectedIds = Array.isArray(c.fileIds)
      ? c.fileIds.filter((id) => validIds.has(id))
      : [];

    html += selectorRow(step, "selector");

    html += `<div class="flex gap-2" style="margin-bottom:8px;">
      <button class="btn" data-action="upload-step-select-all" data-id="${step.id}">Select All Storage Files</button>
      <button class="btn" data-action="upload-step-clear" data-id="${step.id}">Clear</button>
    </div>`;

    html += `<div style="margin-bottom:8px; font-size:12px; color: var(--text-dim);">Selected: <span class="mono">${selectedIds.length}</span></div>`;

    if (!_storageFiles.length) {
      html += `<div class="empty-inline">No files in Storage library. Add files in the Storage tab first.</div>`;
    } else {
      html += `<div class="file-selector-list" style="max-height:160px; margin-bottom:8px;">`;
      html += _storageFiles
        .map((file) => {
          const checked = selectedIds.includes(file.id) ? "checked" : "";
          return `<label class="selector-item" style="display:flex; gap:8px; align-items:flex-start;">
            <input class="upload-step-file-check" data-step-id="${step.id}" data-file-id="${file.id}" type="checkbox" ${checked} style="margin-top:3px;" />
            <div>
              <div class="mono" style="font-size:12px;">${esc(file.name)}</div>
              <div class="storage-meta">${esc(file.type || "application/octet-stream")} · ${_formatBytes(file.size)}</div>
            </div>
          </label>`;
        })
        .join("");
      html += `</div>`;
    }

    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── EXTRACT ──
  if (step.type === "EXTRACT") {
    html += `<div id="extract-fields-${step.id}">`;
    (c.fields || []).forEach((f, fi) => {
      html += `<div class="flex gap-2" style="margin-bottom:4px;align-items:center;">
        <input type="text" class="field-edit" data-id="${step.id}" data-index="${fi}" data-prop="name" value="${esc(f.name || "")}" placeholder="name" style="flex:1;">
        <input type="text" class="field-edit" data-id="${step.id}" data-index="${fi}" data-prop="selector" value="${esc(f.selector || "")}" placeholder="selector" style="flex:2;">
        <select class="extract-type-select" data-id="${step.id}" data-index="${fi}" style="flex:0.8;font-size:11px;padding:4px 6px;">
          <option value="text" ${(f.type || "text") === "text" ? "selected" : ""}>Text</option>
          <option value="html" ${f.type === "html" ? "selected" : ""}>HTML</option>
          <option value="attribute" ${f.type === "attribute" ? "selected" : ""}>Attr</option>
        </select>
        <button class="btn btn-icon" style="color:var(--red);" data-action="remove-extract-field" data-id="${step.id}" data-index="${fi}">✕</button>
      </div>`;
      if (f.type === "attribute") {
        // Without a name there is nothing to read: injector requires
        // field.attribute, so "Attr" used to fall through to text extraction.
        html += `<div class="flex gap-2" style="margin:-2px 0 6px 0;align-items:center;">
          <span style="flex:1;font-size:10px;color:var(--text-dim);text-align:right;">attribute</span>
          <input type="text" class="extract-attr-input" data-id="${step.id}" data-index="${fi}"
            value="${esc(f.attribute || "")}" placeholder="href, src, data-id…"
            style="flex:2.8;font-size:11px;">
        </div>`;
      }

      // Clean the value here, rather than in a spreadsheet afterwards.
      const picked = Array.isArray(f.transform) ? f.transform[0] : "";
      html += `<div class="flex gap-2" style="margin:-2px 0 6px 0;align-items:center;">
        <span style="flex:1;font-size:10px;color:var(--text-dim);text-align:right;">clean up</span>
        <select class="extract-transform-select" data-id="${step.id}" data-index="${fi}" style="flex:2.8;font-size:11px;padding:4px 6px;">
          <option value="">As it appears on the page</option>
          ${Object.entries(TRANSFORMS)
            .map(
              ([name, meta]) =>
                `<option value="${name}" ${picked === name ? "selected" : ""}>${esc(meta.label)}</option>`,
            )
            .join("")}
        </select>
      </div>`;
      if (picked) html += hint(TRANSFORMS[picked]?.help ?? "");
      if (picked === "regex") {
        // Told now, in the box, rather than as an empty column after a run.
        const bad = f.regexPattern && !isValidRegex(f.regexPattern);
        html += `<div class="flex gap-2" style="margin:-6px 0 6px 0;align-items:center;">
          <span style="flex:1;font-size:10px;color:var(--text-dim);text-align:right;">pattern</span>
          <input type="text" class="extract-regex-input" data-id="${step.id}" data-index="${fi}"
            value="${esc(f.regexPattern || "")}" placeholder="SKU: (\\S+)"
            style="flex:2.8;font-size:11px;${bad ? "border-color:var(--red);" : ""}">
        </div>`;
        if (bad) {
          html += `<p style="font-size:11px;color:var(--red);margin:-4px 0 8px 0;">Not a valid pattern — this field would come back empty.</p>`;
        }
      }
    });
    html += `</div>
    <div class="flex gap-2" style="margin-top:12px;align-items:flex-end;">
      <div style="flex:1"><label style="margin-top:0;">Field Name <span style="color:var(--text-dim);font-weight:400;">(optional)</span></label><input type="text" id="new-ex-name-${step.id}" placeholder="named from the element if blank"></div>
      <button class="btn btn-primary" data-action="add-extract-field" data-id="${step.id}" style="height:28px;">🎯 Pick Element</button>
    </div>`;
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── PDF_EXTRACTION ──
  if (step.type === "PDF_EXTRACTION") {
    const source = c.source || "url";
    html += `<label>Source Type</label>
    <select id="cfg-${step.id}-source" data-id="${step.id}" data-key="source" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="url" ${source === "url" ? "selected" : ""}>PDF URL</option>
      <option value="file" ${source === "file" ? "selected" : ""}>From Storage</option>
    </select>`;

    if (source === "url") {
      html += field(
        step,
        "url",
        "PDF URL",
        "text",
        c.url || "https://example.com/document.pdf",
      );
    } else {
      const validIds = new Set(_storageFiles.map((f) => f.id));
      const selectedId = c.fileId;
      html += `<label>Select PDF File</label>
      <select id="cfg-${step.id}-fileId" data-id="${step.id}" data-key="fileId" class="cfg-bind" style="margin-bottom:8px;">
        <option value="">-- Choose file --</option>`;
      _storageFiles.forEach((f) => {
        const selected = selectedId === f.id ? "selected" : "";
        html += `<option value="${esc(f.id)}" ${selected}>${esc(f.name)}</option>`;
      });
      html += `</select>`;
      if (!_storageFiles.length) {
        html += `<div class="empty-inline">No files in Storage. Add PDF files in the Storage tab first.</div>`;
      }
    }

    html += field(
      step,
      "maxPages",
      "Max pages to extract",
      "number",
      c.maxPages ?? 50,
    );
    html += field(
      step,
      "storeAs",
      "Store extracted text as",
      "text",
      c.storeAs || "pdf_text",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── AUTO_EXTRACT ──
  if (step.type === "AUTO_EXTRACT") {
    html += `<div style="background:rgba(139,92,246,0.12);border:1px solid rgba(139,92,246,0.35);border-radius:8px;padding:12px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span style="font-size:20px;">🤖</span>
        <div>
          <div style="font-weight:600;font-size:13px;">Smart Product Auto-Extractor</div>
          <div style="font-size:11px;color:var(--text-dim);">Product pages. Layers 1 and 2 run in-page with no API call; layer 3 asks Gemini only if confidence is low.</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:11px;color:var(--text-dim);">
        <div>✅ JSON-LD / Schema.org</div>
        <div>✅ Open Graph tags</div>
        <div>✅ Heuristic DOM scorer</div>
        <div>✅ Gemini Flash fallback</div>
      </div>
    </div>`;

    html += field(
      step,
      "confidenceThreshold",
      "Escalate to AI below this confidence (0-100)",
      "number",
      c.confidenceThreshold ?? 70,
    );
    html += `<p style="font-size:11px;color:var(--text-dim);margin:-4px 0 10px;">
      Rows are always kept. Below this score the page is sent to Gemini for a
      second opinion; above it, only the on-page layers run.</p>`;

    html += toggle(
      step,
      "useLlm",
      "Enable AI fallback (Gemini) when confidence is low",
    );

    html += `<div style="margin-top:10px;padding:8px 10px;border-radius:6px;background:rgba(99,102,241,0.1);font-size:11px;color:var(--text-dim);">
      <b>Extracted fields:</b> name, price, originalPrice, currency, brand, description, sku, availability, rating, reviewCount, images[]<br>
      <b>Tip:</b> Use this step inside a LOOP to extract products from multiple pages automatically.
    </div>`;

    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── WAIT ──
  if (step.type === "WAIT") {
    const wmode = c.mode || "fixed";
    html += `<label>Wait for</label>
    <select id="cfg-${step.id}-mode" data-id="${step.id}" data-key="mode" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="fixed"            ${wmode === "fixed" ? "selected" : ""}>A fixed time</option>
      <option value="selector-visible" ${wmode === "selector-visible" ? "selected" : ""}>An element to appear</option>
      <option value="selector-gone"    ${wmode === "selector-gone" ? "selected" : ""}>An element to disappear</option>
      <option value="DOM-stable"       ${wmode === "DOM-stable" ? "selected" : ""}>The page to stop changing</option>
    </select>`;
    if (wmode === "fixed") {
      html += field(step, "ms", "Wait (ms)", "number", c.ms ?? 1000);
      html += hint(
        "A fixed wait is a guess. If you are waiting for something specific, " +
          "the modes above wait exactly as long as it takes and no longer.",
      );
    } else if (wmode === "DOM-stable") {
      html += hint(
        "Waits until no elements have been added or removed for half a " +
          "second — useful after a search or a filter, when you do not know " +
          "which element to watch.",
      );
      html += field(
        step,
        "timeout",
        "Give up after (ms)",
        "number",
        c.timeout ?? 15000,
      );
    } else {
      html += selectorRow(step, "selector");
      html += hint(
        wmode === "selector-visible"
          ? "An element that exists but is hidden does not count as appeared."
          : "Use this for a loading spinner or an overlay you need gone.",
      );
      html += field(
        step,
        "timeout",
        "Give up after (ms)",
        "number",
        c.timeout ?? 15000,
      );
      html += hint("Past the timeout the step fails, rather than continuing.");
    }
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── PAGINATE ──
  if (step.type === "PAGINATE") {
    html += `<label>Next-page control</label>`;
    html += selectorRow(step, "selector");
    html += hint(
      "Clicks it, and reports whether there was another page. A missing, " +
        "disabled or hrefless control means the last page — a loop around " +
        "this step stops there instead of re-scraping it.",
    );
    html += field(
      step,
      "settleMs",
      "Wait for the next page (ms)",
      "number",
      c.settleMs ?? 1500,
    );
    html += toggle(
      step,
      "requireChange",
      "Also stop if the page did not change after the click",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── HOVER ──
  if (step.type === "HOVER") {
    html += selectorRow(step, "selector");
    html += `<label>Wait for this to appear <span style="color:var(--text-dim);font-weight:400;">(optional)</span></label>`;
    html += selectorRow(step, "revealSelector");
    html += hint(
      "Name the menu or tooltip the hover should open, and the step waits for " +
        "it and fails if it never comes. Left blank, the step cannot tell " +
        "whether the hover achieved anything.",
    );
    if (c.revealSelector) {
      html += field(
        step,
        "timeout",
        "Give up after (ms)",
        "number",
        c.timeout ?? 3000,
      );
    }
    html += `<div style="background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.35);border-radius:6px;padding:8px 10px;margin:6px 0 10px;font-size:11px;color:var(--text-dim);line-height:1.5;">
      <b>A menu that opens only through CSS cannot be opened here.</b>
      JavaScript menus open fine. A <span class="mono">:hover</span> rule follows
      the real mouse pointer, and no extension may move it without attaching a
      debugger to the browser. If the menu also opens on click, use CLICK.
    </div>`;
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── SELECT ──
  if (step.type === "SELECT") {
    html += `<label>Dropdown</label>`;
    html += selectorRow(step, "selector");
    html += field(step, "value", "Option to choose", "text", c.value || "");
    html += hint(
      "Matched against each option's value first, then its visible label, " +
        "ignoring case. No match fails the step rather than clearing the " +
        "dropdown. Templates work here: {{item.text}}.",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── DRAG_DROP ──
  if (step.type === "DRAG_DROP") {
    html += `<label>Drag this</label>`;
    html += selectorRow(step, "source");
    html += `<label>Onto this</label>`;
    html += selectorRow(step, "target");
    html += hint(
      "Uses HTML5 drag events. Canvas and pointer-based editors that do not " +
        "listen for them will not respond.",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── SCREENSHOT ──
  if (step.type === "SCREENSHOT") {
    const area = c.area || "viewport";
    html += `<label>What to capture</label>
    <select id="cfg-${step.id}-area" data-id="${step.id}" data-key="area" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="viewport" ${area === "viewport" ? "selected" : ""}>The visible area</option>
      <option value="full"     ${area === "full" ? "selected" : ""}>The whole page</option>
      <option value="element"  ${area === "element" ? "selected" : ""}>One element</option>
    </select>`;

    if (area === "element") {
      html += selectorRow(step, "selector");
      html += hint(
        "The element is scrolled into view and the shot is cropped to it. " +
          "An element with no size on screen fails the step rather than " +
          "quietly returning the whole page.",
      );
    } else if (area === "full") {
      html += hint(
        "The page is walked a screenful at a time and the strips are joined. " +
          "Chrome allows about two captures a second, so a long page takes a " +
          "few seconds. A fixed header repeats in each strip — that is what " +
          "stitching does, and there is no way around it from an extension. " +
          "Very long pages are truncated, and say so.",
      );
    }

    html += field(
      step,
      "quality",
      "JPEG quality (1-100)",
      "number",
      c.quality ?? 100,
    );
    html += hint(
      "100 keeps a lossless PNG, where quality means nothing. Below that it " +
        "switches to JPEG, where the number is real.",
    );
    html += hint(
      "Shots are held in memory during the run and saved with the export; a " +
        "run that fills the buffer keeps going and says how many it dropped.",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── API_SNIFFER ──
  if (step.type === "API_SNIFFER") {
    html += hint(
      "Records the XHR and fetch calls the page makes, from the moment the " +
        "run starts until it ends — the step itself does nothing, so its " +
        "position in the pipeline does not matter. Captured requests appear " +
        "in the run monitor and in the export.",
    );
    html += toggle(step, "enabled", "Record network requests during this run");

    html += field(
      step,
      "urlFilter",
      "Only record URLs containing",
      "text",
      c.urlFilter || "",
    );
    const filterProblem = snifferFilterError(c.urlFilter || "");
    if (filterProblem) {
      html += `<p style="font-size:11px;color:var(--red);margin:-4px 0 8px 0;">${esc(filterProblem)}</p>`;
    } else {
      html += hint(
        "Blank records everything, which on a real site is mostly analytics, " +
          "fonts and ad auctions. Several substrings can be separated by " +
          "commas: /api/, /graphql. Start with re: for a regular expression.",
      );
    }

    html += field(
      step,
      "methods",
      "Only these methods (optional)",
      "text",
      c.methods || "",
    );
    html += hint("For example POST, or POST PUT. Blank means any method.");

    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── PAGE_JSON ──
  if (step.type === "PAGE_JSON") {
    const mode = c.mode || "tree";
    html += `<div style="background:rgba(14,165,233,0.10);border:1px solid rgba(14,165,233,0.35);border-radius:8px;padding:10px 12px;margin-bottom:12px;">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px;">🧬 The page itself, as JSON</div>
      <div style="font-size:11px;color:var(--text-dim);line-height:1.5;">
        No selectors, no guessing about what matters — the page as it actually
        is. Use this when a site publishes no structured data, or when you want
        to look at everything before deciding what to scrape.<br><br>
        Scripts, styles and SVG path data are left out by default: a real page
        is mostly those, and they bury the content.
      </div>
    </div>`;

    html += `<label>Shape</label>
    <select id="cfg-${step.id}-mode" data-id="${step.id}" data-key="mode" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="tree" ${mode === "tree" ? "selected" : ""}>Tree — the page's structure, nested</option>
      <option value="text" ${mode === "text" ? "selected" : ""}>Text — every readable line, in order</option>
      <option value="flat" ${mode === "flat" ? "selected" : ""}>Flat — one row per element</option>
    </select>`;
    html += hint(
      mode === "text"
        ? "Good for reading, searching, or handing to an AI. The markup is gone."
        : mode === "flat"
          ? "One row per element with its text, link and path — the easiest way to find the selector you actually want."
          : "Keeps the nesting, so the shape of the page survives. The natural choice if something else will read the JSON.",
    );

    html += `<label>Only this part of the page <span style="color:var(--text-dim);font-weight:400;">(optional)</span></label>`;
    html += selectorRow(step, "selector");
    html += hint(
      "Blank dumps the whole page. Naming one element — a results list, a " +
        "card — is usually what you want, and keeps the output readable.",
    );

    html += field(
      step,
      "maxNodes",
      "Stop after this many elements",
      "number",
      c.maxNodes ?? 5000,
    );
    html += hint(
      "A truncated read says so rather than quietly handing back half a page.",
    );
    html += toggle(step, "includeScripts", "Include scripts and styles too");
    html += field(
      step,
      "storeAs",
      "Store it as",
      "text",
      c.storeAs || "pageJson",
    );
    html += hint(
      "Later steps can reference it. Export as JSON — a page tree does not " +
        "fit a spreadsheet cell.",
    );
    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── PAGE_DATA ──
  if (step.type === "PAGE_DATA") {
    html += `<div style="background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.35);border-radius:8px;padding:10px 12px;margin-bottom:12px;">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px;">🧾 The page's own data — no selectors</div>
      <div style="font-size:11px;color:var(--text-dim);line-height:1.5;">
        Most sites publish their content as structured data for search engines:
        JSON-LD, microdata, Open Graph. This reads it straight off the page.
        It is already typed and named, and it does not break when the site
        changes its CSS.<br><br>
        Best for a <b>single record</b> — a product, an article, a job, a
        recipe — which Detect Table cannot help with, because there is nothing
        repeating to find.
      </div>
    </div>`;

    const src = c.source || "auto";
    html += `<label>Where to read from</label>
    <select id="cfg-${step.id}-source" data-id="${step.id}" data-key="source" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="auto"      ${src === "auto" ? "selected" : ""}>Anywhere it can (recommended)</option>
      <option value="jsonld"    ${src === "jsonld" ? "selected" : ""}>JSON-LD only</option>
      <option value="microdata" ${src === "microdata" ? "selected" : ""}>Microdata only</option>
      <option value="meta"      ${src === "meta" ? "selected" : ""}>Page tags only (Open Graph)</option>
    </select>`;
    if (src === "auto") {
      html += hint(
        "Tries JSON-LD first, then microdata. It does not merge the two — a " +
          "site publishing both publishes the same record twice, and merging " +
          "would double every row.",
      );
    }

    if (src !== "meta") {
      html += field(
        step,
        "type",
        "Keep only this type (optional)",
        "text",
        c.type || "",
      );
      html += hint(
        "A Schema.org type: Product, Article, Recipe, JobPosting, Event, " +
          "LocalBusiness. Leave blank to keep everything the page publishes.",
      );
    }

    html += toggle(step, "flatten", "Flatten into one row per record");
    html += hint(
      c.flatten === false
        ? "Off: records keep their shape. Good for the JSON export, but a " +
            "spreadsheet has no cell for a nested object."
        : "Nested values become columns like offers.price, so the rows fit a " +
            "spreadsheet. Turn off to keep the original shape for JSON.",
    );

    html += field(
      step,
      "storeAs",
      "Also store the whole reading as",
      "text",
      c.storeAs || "pageData",
    );
    html += hint(
      "Later steps can reference it — {{pageData.meta.og:title}} — alongside " +
        "the rows it produced.",
    );

    html += toggle(
      step,
      "optional",
      "Optional — keep going if this step fails",
    );
    return html;
  }

  // ── Generic fallback ──
  for (const [key, value] of Object.entries(c)) {
    if (typeof value === "boolean") {
      html += toggle(step, key, key);
    } else if (typeof value === "number") {
      html += field(step, key, key, "number", value);
    } else if (typeof value === "string") {
      if (key === "selector" || key === "source" || key === "target")
        html += selectorRow(step, key);
      else html += field(step, key, key, "text", value);
    }
  }
  return html;
}

// ── Config helpers ────────────────────────────────────────────────────────────
/**
 * Escape a value for interpolation into the config HTML.
 *
 * Previously escaped only " and <, so an & passed through raw — meaning a value
 * containing the literal text "&quot;" round-tripped as a double quote, and a
 * value in a single-quoted attribute was not escaped at all. & must be replaced
 * first or it would double-escape the entities added after it.
 */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function field(step, key, label, type, value) {
  return `<label>${label}</label>
    <input type="${type}" id="cfg-${step.id}-${key}" value="${esc(value)}"
      data-id="${step.id}" data-key="${key}" class="cfg-bind" style="margin-bottom:8px;">`;
}
function selectorRow(step, key) {
  const v = step.config[key] || "";
  const isMultiSelect =
    ["EXTRACT", "LOOP"].includes(step.type) && key === "selector";
  const modeBadge = isMultiSelect ? "🔀 Bulk" : "🎯 Specific";
  return `<label>${key}</label>
    <div class="flex gap-2" style="margin-bottom:8px;">
      <input type="text" id="cfg-${step.id}-${key}" value="${esc(v)}"
        data-id="${step.id}" data-key="${key}" class="cfg-bind" style="flex:1;">
      <span class="selector-mode-badge" style="padding:4px 8px; background:var(--bg-hover); border-radius:var(--radius-sm); font-size:10px; white-space:nowrap; display:flex; align-items:center; min-width:70px;">${modeBadge}</span>
      <button class="btn btn-icon" data-action="pick-selector" data-id="${step.id}" data-key="${key}"
        style="background:var(--bg-hover);color:var(--text-main);font-size:16px;" title="Pick element">🎯</button>
    </div>`;
}
/**
 * A line of explanation under a control.
 *
 * Several step types had no configuration UI of their own and fell through to
 * a loop over the config object that rendered raw key names as labels: a WAIT
 * card offered a box labelled "ms", DRAG_DROP offered "source" and "target".
 * The values were editable, so the steps were configurable in principle and
 * unusable in practice.
 */
function hint(text) {
  return `<p style="font-size:11px;color:var(--text-dim);margin:-4px 0 10px;">${esc(text)}</p>`;
}

function toggle(step, key, label) {
  const checked = step.config[key] ? "checked" : "";
  return `<div class="toggle-wrap">
    <input type="checkbox" id="cfg-${step.id}-${key}" ${checked} data-id="${step.id}" data-key="${key}" class="cfg-bind">
    <div class="toggle-switch"></div>
    <span>${label}</span>
  </div>`;
}

/**
 * Keep a step's config self-consistent after one field changes.
 *
 * Switching a LOOP from elements mode to count mode carried the "0 = every
 * match" value over, where 0 means zero iterations — the loop then ran nothing
 * and said nothing (B-22). The executor now rejects it outright, so fix it here
 * rather than letting the user hit that error.
 *
 * @param {object} step
 * @param {string} changedKey
 */
function _normalizeStepConfig(step, changedKey) {
  if (step.type !== "LOOP") return;
  if (changedKey !== "type" && changedKey !== "max") return;
  const mode = step.config.type || "count";
  if (mode !== "elements" && !(step.config.max > 0)) step.config.max = 10;
}

/**
 * Save a key and then check that it works.
 *
 * Saving reported "saved" whether the key was valid, expired or a typo — the
 * six validators in api-key-manager.js existed but nothing ever called them
 * (F-03). Validation is one network call and only happens on an explicit save,
 * so it costs nothing on a normal run.
 *
 * @param {string} provider
 * @param {string} label
 * @param {string} inputId
 */
async function _saveAndValidateKey(provider, label, inputId) {
  const val = document.getElementById(inputId)?.value.trim();
  if (!val) return;

  const res = await chrome.runtime.sendMessage({
    type: "key:set",
    payload: { provider, value: val },
  });
  if (!res?.ok) {
    notify("error-log", `Failed to save ${label} key.`);
    return;
  }
  logToMonitor("info-log", `${label} key saved — checking it…`);

  const check = await chrome.runtime
    .sendMessage({
      type: "key:get",
      payload: { validate: true, provider },
    })
    .catch(() => null);

  const result = check?.result?.validation?.[provider];
  if (!result) {
    logToMonitor("warn-log", `${label} key saved; could not check it.`);
  } else if (result.valid === true) {
    notify("info-log", `${label} key saved and verified.`);
  } else if (result.valid === false) {
    notify(
      "error-log",
      `${label} key was rejected: ${result.error || "invalid"}.`,
    );
  } else {
    logToMonitor(
      "warn-log",
      `${label} key saved; validation was inconclusive (${result.error || "no validator"}).`,
    );
  }
}

// ── Config input binding ──────────────────────────────────────────────────────
function bindConfigInputs(container = document) {
  container.querySelectorAll(".cfg-bind").forEach((el) => {
    // This used to clone every input and swap the clone in, to shed listeners
    // it might have bound twice. Replacing a node destroys focus, caret
    // position and selection, and renderPipeline() redraws the whole canvas on
    // every expand, collapse, add and remove — so editing a selector was
    // jumpy for a reason (E-10). A marker does the same job without touching
    // the node; a re-rendered element is a new node and carries no marker.
    if (el.dataset.fsBound === "1") return;
    el.dataset.fsBound = "1";
    const newEl = el;

    newEl.addEventListener("change", (e) => {
      const step = _findStepDeep(_pipeline.steps, e.target.dataset.id);
      if (!step) return;
      const key = e.target.dataset.key;
      if (e.target.type === "checkbox") step.config[key] = e.target.checked;
      else if (e.target.type === "number")
        step.config[key] = parseFloat(e.target.value) || 0;
      else step.config[key] = e.target.value;
      _normalizeStepConfig(step, key);
      saveState();

      // Re-render card config if marked (mode-switching selects)
      if (e.target.dataset.rerender === "true") _rerenderCardConfig(step);
      else {
        const sub = e.target
          .closest(".node-card")
          ?.querySelector(".node-subtitle");
        if (sub) sub.textContent = getStepSubtitle(step);
      }
    });

    if (
      newEl.type === "text" ||
      newEl.type === "number" ||
      newEl.tagName === "TEXTAREA"
    ) {
      newEl.addEventListener("input", (e) => {
        const step = _findStepDeep(_pipeline.steps, e.target.dataset.id);
        if (!step) return;
        const key = e.target.dataset.key;
        step.config[key] =
          e.target.type === "number"
            ? parseFloat(e.target.value) || 0
            : e.target.value;
        const sub = e.target
          .closest(".node-card")
          ?.querySelector(".node-subtitle");
        if (sub) sub.textContent = getStepSubtitle(step);
      });
    }
  });
}

function _rerenderCardConfig(step) {
  const configEl = document.querySelector(
    `.node-wrapper[data-id="${step.id}"] .node-config`,
  );
  if (configEl) {
    // This fires while the user is in the middle of the form — a mode select
    // changes and the whole block is rebuilt — so put the caret back where it
    // was rather than dropping it (E-10).
    const active = document.activeElement;
    const restore =
      active && configEl.contains(active) && active.dataset?.key
        ? {
            key: active.dataset.key,
            start: active.selectionStart,
            end: active.selectionEnd,
          }
        : null;

    configEl.innerHTML = generateConfigHtml(step);
    bindConfigInputs(configEl);
    _makeKeyboardAccessible(configEl);

    if (restore) {
      const again = configEl.querySelector(`[data-key="${restore.key}"]`);
      if (again) {
        again.focus();
        if (restore.start !== null && restore.start !== undefined) {
          try {
            again.setSelectionRange(restore.start, restore.end);
          } catch {
            // Not every input type supports a selection range.
          }
        }
      }
    }
  }
  // Also re-render loop body insert if LOOP mode changed
  const sub = document.querySelector(
    `.node-wrapper[data-id="${step.id}"] .node-subtitle`,
  );
  if (sub) sub.textContent = getStepSubtitle(step);
}

// ── Drag-and-drop node reorder ────────────────────────────────────────────────
function bindDragAndDrop() {
  // We attach dragstart on the card itself (it has draggable="true")
  document.querySelectorAll(".node-card[data-drag-id]").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      _dragSourceId = card.dataset.dragId;
      e.dataTransfer.effectAllowed = "move";
      card.style.opacity = "0.45";
    });
    card.addEventListener("dragend", () => {
      card.style.opacity = "1";
      _dragSourceId = null;
    });
  });
  // The inside of a loop or a branch, so an empty one can be dropped into at
  // all. Listed first: a wrapper nested inside a container would otherwise
  // swallow the event on its way up.
  document
    .querySelectorAll(".loop-body-inner[data-parent-id]")
    .forEach((body) => {
      body.addEventListener("dragover", (e) => {
        if (!_dragSourceId) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        body.classList.add("drop-inside");
      });
      body.addEventListener("dragleave", (e) => {
        if (body.contains(e.relatedTarget)) return;
        body.classList.remove("drop-inside");
      });
      body.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        body.classList.remove("drop-inside");
        if (!_dragSourceId) return;
        const moved = _moveStepInto(
          _dragSourceId,
          body.dataset.parentId,
          body.dataset.branch,
        );
        _dragSourceId = null;
        if (!moved) return;
        saveState();
        renderPipeline();
      });
    });

  document.querySelectorAll(".node-wrapper").forEach((w) => {
    w.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      w.style.outline = "2px solid var(--accent)";
    });
    w.addEventListener("dragleave", () => {
      w.style.outline = "none";
    });
    w.addEventListener("drop", (e) => {
      e.preventDefault();
      w.style.outline = "none";
      if (!_dragSourceId) return;
      const targetId = w.dataset.id;
      if (!targetId || targetId === _dragSourceId) return;
      const moved = _moveStep(_dragSourceId, targetId);
      _dragSourceId = null;
      if (!moved) return;
      saveState();
      renderPipeline();
    });
  });
}

/**
 * Find the list a step lives in, and its index in it.
 *
 * @param {object[]} steps
 * @param {string} id
 * @returns {{ list: object[], index: number, parent: object|null } | null}
 */
function _locateStep(steps, id, parent = null) {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].id === id) return { list: steps, index: i, parent };
    for (const key of ["children", "ifBranch", "elseBranch"]) {
      const sub = steps[i][key];
      if (!Array.isArray(sub)) continue;
      const found = _locateStep(sub, id, steps[i]);
      if (found) return found;
    }
  }
  return null;
}

/** Is `id` inside `step`'s own subtree? */
function _containsStep(step, id) {
  for (const key of ["children", "ifBranch", "elseBranch"]) {
    for (const child of step[key] ?? []) {
      if (child.id === id || _containsStep(child, id)) return true;
    }
  }
  return false;
}

/**
 * Move a step *into* a container, at the end of its list.
 *
 * The other half of E-05. `_moveStep` puts a step where another step is, which
 * is the only thing a drop could express while drops were accepted on
 * `.node-wrapper` alone — so an empty loop had nothing to drop onto, and
 * dropping on a loop's own card moved the step to where the loop is, beside it
 * rather than inside. Both read as "dragging into a loop does not work".
 *
 * @param {string} sourceId
 * @param {string} parentId  - the LOOP or IF_ELSE to move into
 * @param {string} branchKey - "children", "ifBranch" or "elseBranch"
 * @returns {boolean} false when the move was refused
 */
function _moveStepInto(sourceId, parentId, branchKey) {
  const from = _locateStep(_pipeline.steps, sourceId);
  const target = _locateStep(_pipeline.steps, parentId);
  if (!from || !target) return false;

  const container = target.list[target.index];
  const step = from.list[from.index];

  // A container inside itself vanishes from the board, taking its children.
  if (step.id === container.id || _containsStep(step, container.id)) {
    notify(
      "warn-log",
      "A container cannot be moved inside itself — that would remove it from the board.",
    );
    return false;
  }

  if (!Array.isArray(container[branchKey])) container[branchKey] = [];
  from.list.splice(from.index, 1);
  container[branchKey].push(step);
  return true;
}

/**
 * Move a step to sit where another one is, anywhere in the tree.
 *
 * bindDragAndDrop looked both ids up in _pipeline.steps only, so dragging a
 * step inside a LOOP or an IF/ELSE branch — or between a branch and the root —
 * silently did nothing, while the drop target still drew the accent outline and
 * signalled success (E-05).
 *
 * @param {string} sourceId
 * @param {string} targetId
 * @returns {boolean} false when the move is not possible
 */
function _moveStep(sourceId, targetId) {
  const src = _locateStep(_pipeline.steps, sourceId);
  if (!src) return false;

  // A container cannot be dropped inside itself; that detaches the subtree.
  if (_containsStep(src.list[src.index], targetId)) {
    notify("warn-log", "A step cannot be moved inside itself.");
    return false;
  }

  const [moved] = src.list.splice(src.index, 1);

  // Located after the removal, so the target index is the post-removal one.
  const tgt = _locateStep(_pipeline.steps, targetId);
  if (!tgt) {
    src.list.splice(src.index, 0, moved); // put it back
    return false;
  }
  tgt.list.splice(tgt.index, 0, moved);
  return true;
}

/** Shown at most once per panel session. */
let _zoomHintShown = false;

/** Tell the user how to zoom, the first time they try it the obvious way. */
function _hintZoomModifier() {
  if (_zoomHintShown) return;
  _zoomHintShown = true;
  const key = navigator.platform?.startsWith("Mac") ? "⌘" : "Ctrl";
  notify("info-log", `Hold ${key} or Shift while scrolling to zoom the board.`);
}

// ── Keyboard access ───────────────────────────────────────────────────────────
/**
 * Elements that behave like buttons but are not buttons.
 *
 * The board is built from divs with click handlers — nav pills, node headers,
 * the + insert affordances, accordion headers, palette items — none of which had
 * a role, a tabindex or any keyboard activation, so the panel could not be
 * operated without a mouse (E-09). Rather than hand-editing every generation
 * site, they are stamped after each render and activated by one delegated
 * handler, which also covers markup added later.
 */
const KEYBOARD_ACTIVATABLE =
  ".nav-pill, .node-header, .insert-step, .accordion-header, .palette-item, [data-action]";

/** Anything the browser already makes focusable and Enter-activatable. */
const NATIVELY_INTERACTIVE = "button, a[href], input, select, textarea";

/**
 * Give the div-buttons in `root` a role and a tab stop.
 * @param {ParentNode} [root]
 */
function _makeKeyboardAccessible(root = document) {
  for (const el of root.querySelectorAll(KEYBOARD_ACTIVATABLE)) {
    if (el.matches(NATIVELY_INTERACTIVE)) continue;
    if (!el.hasAttribute("role")) el.setAttribute("role", "button");
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
  }
}

/** Enter and Space activate a div-button, the way they do a real one. */
function bindKeyboardActivation() {
  document.body.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const el = e.target.closest?.(KEYBOARD_ACTIVATABLE);
    if (!el || el.matches(NATIVELY_INTERACTIVE)) return;
    // Space scrolls the page by default, and Enter inside a form submits it.
    e.preventDefault();
    el.click();
  });
}

// ── Event delegation ──────────────────────────────────────────────────────────
function bindDelegatedEvents() {
  document.body.addEventListener("click", (e) => {
    const accHeader = e.target.closest(".accordion-header");
    if (accHeader) {
      accHeader.parentElement.classList.toggle("open");
      return;
    }

    const toggleWrap = e.target.closest(".toggle-wrap");
    if (toggleWrap && !e.target.matches('input[type="checkbox"]')) {
      const cb = toggleWrap.querySelector('input[type="checkbox"]');
      if (cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    const target = e.target.closest("[data-action]");
    if (!target) return;
    if (target.classList.contains("action-btn")) e.stopPropagation();

    const action = target.dataset.action;
    const id = target.dataset.id;

    switch (action) {
      case "add-step":
        _addStep(target.dataset.type);
        break;
      case "open-palette":
        _openPalette(
          parseInt(target.dataset.index, 10),
          target.dataset.parentId || "",
          target.dataset.branch || "",
        );
        break;
      case "toggle-expand":
        _toggleExpand(id);
        break;
      case "remove-step":
        _removeStep(e, id);
        break;
      case "test-step":
        _testStep(e, id);
        break;
      case "pick-selector":
        _pickSelector(id, target.dataset.key);
        break;
      case "add-extract-field":
        _addExtractField(id);
        break;
      case "remove-extract-field":
        _removeExtractField(id, parseInt(target.dataset.index, 10));
        break;
      case "set-fill-mode": {
        const step = _findStepDeep(_pipeline.steps, id);
        if (step) {
          step.config.mode = target.dataset.mode;
          saveState();
          _rerenderCardConfig(step);
        }
        break;
      }
      case "add-fill-field":
        _addFillField(id);
        break;
      case "remove-fill-field":
        _removeFillField(id, parseInt(target.dataset.index, 10));
        break;
      case "register-key":
        _registerKey(id);
        break;
      case "upload-step-select-all":
        _uploadStepSelectAll(id);
        break;
      case "upload-step-clear":
        _uploadStepClear(id);
        break;
    }
  });

  document.body.addEventListener("change", (e) => {
    const target = e.target;

    // Extract field type. This was previously handled by the click listener,
    // which fires before the user has picked an option, so the select never
    // actually changed the stored type.
    if (
      target instanceof HTMLSelectElement &&
      target.classList.contains("extract-type-select")
    ) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      field.type = target.value;
      if (field.type !== "attribute") delete field.attribute;
      saveState();
      _rerenderCardConfig(step); // show or hide the attribute input
      return;
    }

    if (
      target instanceof HTMLSelectElement &&
      target.classList.contains("extract-transform-select")
    ) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      // Stored as a list because the engine chains them. The UI offers one for
      // now; a stored list means offering a second later changes no data shape.
      if (target.value) field.transform = [target.value];
      else delete field.transform;
      if (target.value !== "regex") delete field.regexPattern;
      saveState();
      _rerenderCardConfig(step); // show the help, and the pattern box
      return;
    }

    if (!(target instanceof HTMLInputElement)) return;

    // Field rows used to render as `disabled` inputs — greyed out and
    // uneditable — so fixing a typo in a selector meant deleting the row and
    // re-picking the element (E-16).
    if (target.classList.contains("field-edit")) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      field[target.dataset.prop] = target.value;
      saveState();
      return;
    }

    if (target.classList.contains("key-manual-input")) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      if (!step) return;
      const before = _isBrowserReservedKey(step.config.key);
      step.config.key = target.value.trim();
      saveState();
      const disp = document.getElementById(`key-disp-${step.id}`);
      if (disp) disp.textContent = step.config.key || "Not set";
      // Only when the verdict changes, or the caret jumps on every keystroke
      // (E-10).
      if (before !== _isBrowserReservedKey(step.config.key)) {
        _rerenderCardConfig(step);
      }
      return;
    }

    if (target.classList.contains("extract-regex-input")) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      const wasBad = field.regexPattern && !isValidRegex(field.regexPattern);
      field.regexPattern = target.value;
      saveState();
      // Only when the verdict changed: re-rendering on every keystroke would
      // take the caret with it, which is what E-10 was about.
      const isBad = target.value && !isValidRegex(target.value);
      if (Boolean(wasBad) !== Boolean(isBad)) _rerenderCardConfig(step);
      return;
    }

    if (target.classList.contains("extract-attr-input")) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      field.attribute = target.value.trim();
      saveState();
      return;
    }

    if (!target.classList.contains("upload-step-file-check")) return;

    const stepId = target.dataset.stepId;
    const fileId = target.dataset.fileId;
    if (!stepId || !fileId) return;
    _uploadStepToggleFile(stepId, fileId, target.checked);
  });
}

// ── Step actions ──────────────────────────────────────────────────────────────
function _toggleExpand(id) {
  _expandedNodeId = _expandedNodeId === id ? null : id;
  renderPipeline();
}
function _removeStep(e, id) {
  e.stopPropagation();
  _removeStepDeep(_pipeline.steps, id);
  if (_expandedNodeId === id) _expandedNodeId = null;
  saveState();
  renderPipeline();
}
/** Per-step timers that clear a test outcome class. @type {Map<string, number>} */
const _testStepTimers = new Map();

/**
 * Summarise what a test run of a step returned, for the log pane.
 *
 * The result was thrown away, so testing a CLICK or an EXTRACT told you only
 * that it did not throw — never what it matched or what it read back (E-07).
 *
 * @param {*} result
 * @returns {string}
 */
function _describeStepResult(result) {
  if (result === null || result === undefined) return "no result";
  if (Array.isArray(result)) {
    if (!result.length) return "0 rows";
    const keys = Object.keys(result[0] ?? {});
    const head = JSON.stringify(result[0]);
    return `${result.length} row${result.length === 1 ? "" : "s"}, ${keys.length} field${keys.length === 1 ? "" : "s"} — first: ${_clip(head, 220)}`;
  }
  if (typeof result === "object") return _clip(JSON.stringify(result), 260);
  return _clip(String(result), 260);
}

/** @param {string} str @param {number} max */
function _clip(str, max) {
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

async function _testStep(e, id) {
  e.stopPropagation();
  const step = _findStepDeep(_pipeline.steps, id);
  if (!step) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return notify("error-log", "No active tab to test against.");
  const card = document.querySelector(
    `.node-wrapper[data-id="${id}"] .node-card`,
  );

  // The outcome class used to sit on the card until the next full render, so a
  // card could still read "success" long after the pipeline had changed.
  clearTimeout(_testStepTimers.get(id));
  card?.classList.remove("success", "error");
  if (card) card.classList.add("running");

  try {
    const res = await chrome.runtime.sendMessage({
      type: "step:execute",
      payload: { step, tabId: tab.id },
    });
    if (res?.error) throw new Error(res.error);
    if (card) {
      card.classList.remove("running");
      card.classList.add("success");
    }
    notify(
      "info-log",
      `Test ${step.type}: ${_describeStepResult(res?.result)}`,
    );
  } catch (err) {
    if (card) {
      card.classList.remove("running");
      card.classList.add("error");
    }
    notify(
      "error-log",
      err.message.includes("Receiving end")
        ? `Test ${step.type}: refresh the target webpage first.`
        : `Test ${step.type} failed: ${err.message}`,
    );
  }

  if (card) {
    _testStepTimers.set(
      id,
      setTimeout(() => card.classList.remove("success", "error"), 6000),
    );
  }
}

// ── Confirmation ──────────────────────────────────────────────────────────────
/**
 * Ask before doing something that cannot be undone.
 *
 * "🗑 Clear" wiped the whole pipeline and "🧹 Clear Library" deleted every
 * stored file, both on a single click with no confirm and no undo (E-14).
 *
 * @param {{ title: string, body: string, confirmLabel: string }} opts
 * @returns {Promise<boolean>} true if the user confirmed
 */
function _confirmDestructive({ title, body, confirmLabel }) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999; backdrop-filter: blur(4px);
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: var(--bg-raised); border: 1px solid var(--bg-border);
      border-radius: 12px; padding: 22px; max-width: 340px;
      box-shadow: var(--shadow-fly);
    `;

    // Built as nodes: the body can carry a file name or a step count (C-04).
    const h = document.createElement("h2");
    h.style.cssText = "margin:0 0 6px; font-size:15px;";
    h.textContent = title;

    const p = document.createElement("p");
    p.style.cssText = "margin:0 0 18px; color:var(--text-dim); font-size:12px;";
    p.textContent = body;

    const row = document.createElement("div");
    row.style.cssText = "display:flex; gap:8px;";
    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.style.flex = "1";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "btn btn-danger";
    ok.style.flex = "1";
    ok.textContent = confirmLabel;
    row.append(cancel, ok);
    card.append(h, p, row);

    const done = (value) => {
      modal.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    function onKey(e) {
      if (e.key === "Escape") done(false);
    }

    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) done(false);
    });
    document.addEventListener("keydown", onKey, true);

    modal.appendChild(card);
    document.body.appendChild(modal);
    cancel.focus(); // the safe option, not the destructive one
  });
}

// ── Ethics warning confirmation ───────────────────────────────────────────────
/**
 * Show what the ethics gates flagged and let the user decide.
 * @param {Array<{code:string,message:string}>} warnings
 * @returns {Promise<boolean>} true to run anyway
 */
function _confirmEthicsWarnings(warnings) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999; backdrop-filter: blur(4px);
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: var(--bg-raised); border: 1px solid var(--bg-border);
      border-radius: 12px; padding: 22px; max-width: 400px; max-height: 80vh;
      overflow-y: auto; box-shadow: var(--shadow-fly);
    `;

    card.innerHTML = `
      <h2 style="margin:0 0 6px; font-size:15px;">⚠ Ethics check</h2>
      <p style="margin:0 0 14px; color:var(--text-dim); font-size:12px;">
        ${warnings.length} warning${warnings.length === 1 ? "" : "s"} before this run starts.
      </p>
      <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:18px;">
        ${warnings
          .map(
            (
              w,
            ) => `<div style="border-left:3px solid var(--yellow, #FACC15); background:var(--bg-hover); padding:8px 10px; border-radius:4px;">
              <div class="mono" style="font-size:10px; color:var(--text-dim); letter-spacing:.04em;">${esc(w.code)}</div>
              <div style="font-size:12px; margin-top:3px;">${esc(w.message)}</div>
            </div>`,
          )
          .join("")}
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn" id="ethics-cancel" style="flex:1;">Cancel</button>
        <button class="btn btn-primary" id="ethics-proceed" style="flex:1;">Run anyway</button>
      </div>
    `;

    const done = (value) => {
      modal.remove();
      resolve(value);
    };

    card
      .querySelector("#ethics-cancel")
      .addEventListener("click", () => done(false));
    card
      .querySelector("#ethics-proceed")
      .addEventListener("click", () => done(true));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) done(false);
    });

    modal.appendChild(card);
    document.body.appendChild(modal);
    card.querySelector("#ethics-proceed").focus();
  });
}

// ── Selector picker with mode toggle ──────────────────────────────────────────
/**
 * Make sure the content scripts are in the target tab before talking to them.
 *
 * They used to be declared for `<all_urls>` and were therefore always present.
 * Now they are injected on demand (C-09), so the picker has to ask for them.
 *
 * @param {number} tabId
 * @returns {Promise<boolean>} false when the page refuses injection
 */
async function _ensureContentReady(tabId) {
  const res = await chrome.runtime
    .sendMessage({ type: "content:ensure", payload: { tabId } })
    .catch(() => null);
  if (res?.ok) return true;
  notify(
    "error-log",
    res?.error ||
      "Cannot reach that page. Chrome blocks extensions on chrome:// pages, the Web Store and PDF viewers.",
  );
  return false;
}

async function _pickSelector(stepId, key) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return notify("error-log", "No active tab available.");

  const stepType = _findStepDeep(_pipeline.steps, stepId)?.type;
  const defaultBulk =
    key === "selector" && ["EXTRACT", "LOOP"].includes(stepType);

  // Show mode selector modal
  const mode = await _selectSelectorMode(defaultBulk);
  if (mode === null) return; // cancelled

  try {
    if (!(await _ensureContentReady(tab.id))) return;
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "FS_PICK_SELECTOR",
      payload: { bulk: mode },
    });
    if (resp?.ok && resp.result) {
      const input = document.getElementById(`cfg-${stepId}-${key}`);
      if (input) {
        input.value = resp.result;
        const badge = input.parentElement?.querySelector(
          ".selector-mode-badge",
        );
        if (badge) badge.textContent = mode ? "🔀 Bulk" : "🎯 Specific";
        input.dispatchEvent(new Event("change"));
      }
    }
  } catch {
    notify("error-log", "Refresh the target webpage to connect the picker.");
  }
}

async function _selectSelectorMode(defaultBulk) {
  const modal = document.createElement("div");
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center;
    z-index: 9999; backdrop-filter: blur(4px);
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: var(--bg-raised); border: 1px solid var(--bg-border); border-radius: 12px;
    padding: 24px; max-width: 380px; box-shadow: var(--shadow-fly);
  `;

  card.innerHTML = `
    <div style="margin-bottom: 20px;">
      <h2 style="margin: 0 0 8px; font-size: 16px;">Selector Mode</h2>
      <p style="margin: 0; color: var(--text-dim); font-size: 12px;">Choose how to match elements:</p>
    </div>
    <div style="display: flex; gap: 12px; margin-bottom: 16px;">
      <button class="selector-mode-btn" data-mode="specific" style="flex:1; padding:12px; border-radius:8px; border:2px solid var(--accent); background:rgba(99,102,241,0.1); color:var(--text-main); cursor:pointer; font-weight:600; transition:all 0.2s;">
        🎯 Specific
        <div style="font-size:10px; color:var(--text-dim); font-weight:normal; margin-top:4px;">Single element</div>
      </button>
      <button class="selector-mode-btn" data-mode="bulk" style="flex:1; padding:12px; border-radius:8px; border:2px solid var(--bg-border); background:transparent; color:var(--text-main); cursor:pointer; font-weight:600; transition:all 0.2s;">
        🔀 Bulk
        <div style="font-size:10px; color:var(--text-dim); font-weight:normal; margin-top:4px;">Multiple matches</div>
      </button>
    </div>
    <button class="btn" style="width:100%; margin-top:16px;" id="modal-cancel">Cancel</button>
  `;

  let result = null;

  return new Promise((resolve) => {
    const buttons = card.querySelectorAll(".selector-mode-btn");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        result = btn.dataset.mode === "bulk";
        modal.remove();
        resolve(result);
      });
    });

    card.querySelector("#modal-cancel").addEventListener("click", () => {
      modal.remove();
      resolve(null);
    });

    const defaultBtn = card.querySelector(
      `[data-mode="${defaultBulk ? "bulk" : "specific"}"]`,
    );
    if (defaultBtn) {
      defaultBtn.style.borderColor = "var(--accent)";
      defaultBtn.style.background = "rgba(99,102,241,0.15)";
    }

    modal.appendChild(card);
    document.body.appendChild(modal);
  });
}

// ── Detect table ──────────────────────────────────────────────────────────────
/**
 * Read the page's repeating structures and offer them as tables.
 *
 * The normal way to build a scrape is to know CSS selectors before you start:
 * name a field, pick it, repeat, hope they line up. This inverts it — the page
 * is read, and the user picks a table by looking at sample rows.
 */
async function _detectStructure() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return notify("error-log", "No active tab to read.");

  notify("info-log", "Reading the page…");
  const res = await chrome.runtime
    .sendMessage({ type: "content:detect", payload: { tabId: tab.id } })
    .catch(() => null);

  if (!res?.ok) {
    notify("error-log", res?.error || "Could not read that page.");
    return;
  }

  const { candidates = [] } = res.result ?? {};
  if (!candidates.length) {
    // A single-record page — a product, an article, a listing — has nothing
    // repeating to find, and that is most of the pages people point this at
    // after a list. Before sending them off to pick elements by hand, look for
    // the structured data the page probably already publishes: it needs no
    // selectors at all and does not break when the site's CSS changes.
    await _offerPageData(tab.id);
    return;
  }

  const chosen = await _chooseDetectedTable(candidates);
  if (!chosen) return;
  await _insertDetectedTable(chosen);
}

/**
 * The fallback when there is no repeating structure: read the page's own data.
 *
 * Only offered when there is actually something to read. Suggesting a step that
 * would come back empty is worse than saying nothing, because the user spends a
 * run finding out.
 *
 * @param {number} tabId
 */
async function _offerPageData(tabId) {
  const res = await chrome.runtime
    .sendMessage({
      type: "step:execute",
      payload: {
        step: { id: "probe", type: "PAGE_DATA", config: { source: "auto" } },
        tabId,
      },
    })
    .catch(() => null);

  const data = res?.ok ? res.result : null;
  if (!data?.found) {
    notify(
      "warn-log",
      "No repeating tables here, and the page publishes no structured data either. " +
        "Pick the fields you want by hand.",
    );
    return;
  }

  const types = [
    ...new Set(
      (data.records ?? [])
        .map((r) => (Array.isArray(r["@type"]) ? r["@type"][0] : r["@type"]))
        .filter(Boolean),
    ),
  ];
  const what = types.length
    ? `${types.join(", ")} data`
    : `${Object.keys(data.meta ?? {}).length} page tags`;

  const ok = await _confirmDestructive({
    title: "No table — but this page describes itself",
    body:
      `There is nothing repeating on this page to loop over, but it publishes ` +
      `${what} for search engines. Reading that needs no selectors, and it does ` +
      `not break when the site changes its layout.\n\nAdd a "Read the page's own data" step?`,
    confirmLabel: "Add the step",
  });
  if (!ok) return;

  const stepNode = {
    id: _nextStepId(),
    type: "PAGE_DATA",
    config: {
      ...defaultConfig("PAGE_DATA"),
      type: types.length === 1 ? types[0] : "",
    },
  };
  _pipeline.steps.push(stepNode);
  _expandedNodeId = stepNode.id;
  saveState();
  renderPipeline();
  notify(
    "info-log",
    `Added a step that reads this page's ${what}. Run it to see the rows.`,
  );
}

/**
 * Show what was found and let the user pick, by reading rows rather than
 * selectors.
 *
 * @param {object[]} candidates
 * @returns {Promise<object|null>}
 */
function _chooseDetectedTable(candidates) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999; backdrop-filter: blur(4px);
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: var(--bg-raised); border: 1px solid var(--bg-border);
      border-radius: 12px; padding: 20px; width: min(560px, 92vw);
      max-height: 82vh; overflow-y: auto; box-shadow: var(--shadow-fly);
    `;

    const h = document.createElement("h2");
    h.style.cssText = "margin:0 0 4px; font-size:15px;";
    h.textContent = `Found ${candidates.length} table${candidates.length === 1 ? "" : "s"}`;

    const sub = document.createElement("p");
    sub.style.cssText =
      "margin:0 0 14px; color:var(--text-dim); font-size:12px;";
    sub.textContent =
      "Pick the one whose rows look right. It becomes a loop with the columns already filled in.";
    card.append(h, sub);

    const done = (value) => {
      modal.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    function onKey(e) {
      if (e.key === "Escape") done(null);
    }

    for (const c of candidates) {
      const btn = document.createElement("button");
      btn.className = "detect-card";
      btn.type = "button";

      const head = document.createElement("div");
      head.className = "detect-head";
      const count = document.createElement("span");
      count.className = "detect-count";
      count.textContent = `${c.count} rows × ${c.fields.length} columns`;
      const sel = document.createElement("code");
      sel.className = "mono";
      sel.style.cssText = "font-size:10px; color:var(--text-dim);";
      sel.textContent = c.selector;
      head.append(count, sel);
      btn.appendChild(head);

      // Built as nodes: every value here is page content (C-04).
      const scroll = document.createElement("div");
      scroll.className = "detect-scroll";
      const table = document.createElement("table");
      table.className = "detect-table";

      const thead = document.createElement("thead");
      const hrow = document.createElement("tr");
      for (const f of c.fields) {
        const th = document.createElement("th");
        th.textContent = f.name;
        th.title = `${f.selector} · ${f.coverage}% of rows`;
        hrow.appendChild(th);
      }
      thead.appendChild(hrow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const row of c.sampleRows ?? []) {
        const tr = document.createElement("tr");
        for (const f of c.fields) {
          const td = document.createElement("td");
          const v = String(row[f.name] ?? "");
          td.textContent = v.length > 40 ? `${v.slice(0, 40)}…` : v;
          td.title = v;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      scroll.appendChild(table);
      btn.appendChild(scroll);

      btn.addEventListener("click", () => done(c));
      card.appendChild(btn);
    }

    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.style.cssText = "width:100%; margin-top:4px;";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => done(null));
    card.appendChild(cancel);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) done(null);
    });
    document.addEventListener("keydown", onKey, true);
    modal.appendChild(card);
    document.body.appendChild(modal);
    card.querySelector(".detect-card")?.focus();
  });
}

/**
 * Turn a detected table into steps.
 *
 * A LOOP over the container with a nested EXTRACT, rather than one EXTRACT with
 * page-wide selectors. EXTRACT lines its columns up positionally, so a record
 * missing a rating shifts every later rating up a row. Scoping each iteration
 * to its own container is what makes a row a row.
 *
 * @param {object} table
 */
/**
 * The obvious clean-up for a detected column, from what its samples look like.
 *
 * The point of Detect Table is that you press one button and get usable data.
 * Handing back a price column full of "$25.50" strings, and a link column of
 * "/p/123", makes the user do the last mile by hand — which is the mile they
 * came here to avoid. Conservative on purpose: only a column that is *mostly*
 * currency gets read as a number, because guessing wrong is worse than not
 * guessing, and the choice is visible and changeable in the field's row.
 *
 * @param {{kind: string, samples: string[]}} field
 * @returns {string} a transform name, or "" to leave the value alone
 */
function _transformFor(field) {
  if (field.kind === "href" || field.kind === "src") return "url";
  const samples = (field.samples ?? [])
    .filter(Boolean)
    .map((s) => String(s).trim());
  if (samples.length === 0) return "";

  // A column that is *entirely* numbers — populations, areas, counts — is a
  // number. Every sample must qualify, not a majority: a column that is 90%
  // numbers and 10% "N/A" would otherwise turn that 10% into empty cells with
  // nothing said. Leaving it as text costs a conversion; getting it wrong
  // costs data.
  const plainNumber = /^[^\d-]{0,3}-?\d[\d.,\s]*(?:[eE][+-]?\d+)?[^\d]{0,4}$/;
  if (samples.every((s) => plainNumber.test(s))) return "number";

  // Otherwise only where the column reads as money: a currency mark, or a
  // two-decimal amount. "Ships in 2 days" has a number in it and is not one.
  const money = samples.filter(
    (s) => plainNumber.test(s) && /[$£€¥₹]|\d[.,]\d{2}\b/.test(s),
  ).length;
  return money / samples.length > 0.6 ? "number" : "";
}

/**
 * An existing element-loop over this selector, anywhere in the pipeline.
 *
 * Searched depth-first through loop bodies and branches, because a detected
 * table can be dropped inside another container and would still scrape the same
 * list twice.
 *
 * @param {object[]} steps
 * @param {string} selector
 * @returns {?object}
 */
function _findDetectedLoop(steps, selector) {
  for (const step of steps ?? []) {
    if (
      step.type === "LOOP" &&
      step.config?.type === "elements" &&
      step.config?.selector === selector
    ) {
      return step;
    }
    const nested = _findDetectedLoop(
      [
        ...(step.children ?? []),
        ...(step.ifBranch ?? []),
        ...(step.elseBranch ?? []),
      ],
      selector,
    );
    if (nested) return nested;
  }
  return null;
}

async function _insertDetectedTable(table) {
  const extract = {
    id: _nextStepId(),
    type: "EXTRACT",
    config: {
      ...defaultConfig("EXTRACT"),
      fields: table.fields.map((f) => ({
        name: f.name,
        selector: f.selector,
        type: f.kind === "text" ? "text" : "attribute",
        ...(f.kind === "href" ? { attribute: "href" } : {}),
        ...(f.kind === "src" ? { attribute: "src" } : {}),
        ...(_transformFor(f) ? { transform: [_transformFor(f)] } : {}),
      })),
    },
  };

  const loop = {
    id: _nextStepId(),
    type: "LOOP",
    config: {
      ...defaultConfig("LOOP"),
      type: "elements",
      selector: table.selector,
      max: 0, // every match; the page decides how many rows there are
    },
    children: [extract],
  };

  // Pressing the button again used to append a second loop over the same list,
  // say "Added a loop", and give no hint the first was still there. A real run
  // came back with every row five times over — five presses, five full scrapes,
  // no warning anywhere (J-13).
  const existing = _findDetectedLoop(_pipeline.steps, table.selector);
  if (existing) {
    const replace = await _confirmDestructive({
      title: "This list is already in the pipeline",
      body:
        `There is already a loop over ${table.selector}. Adding another would ` +
        `scrape the same list twice, and every row would appear twice in the ` +
        `export.\n\nReplace the existing one?`,
      confirmLabel: "Replace it",
    });
    if (!replace) {
      notify(
        "info-log",
        `Left the pipeline alone — ${table.selector} is already being scraped.`,
      );
      return;
    }
    _removeStepDeep(_pipeline.steps, existing.id);
  }

  _pipeline.steps.push(loop);
  _expandedNodeId = extract.id;
  saveState();
  renderPipeline();
  notify(
    "info-log",
    `${existing ? "Replaced the loop" : "Added a loop"} over ${table.selector} with ${extract.config.fields.length} columns. Check the selectors, then Run.`,
  );
}

// ── Extract field management ──────────────────────────────────────────────────

/**
 * A column name guessed from the selector that produced it.
 *
 * Naming a field before you have picked it is backwards — you do not know what
 * you are about to click. The name box is optional now, and this fills it.
 *
 * @param {string} selector
 * @returns {string}
 */
function _fieldNameFromSelector(selector) {
  const last =
    String(selector)
      .split(/[\s>+~]+/)
      .filter(Boolean)
      .pop() ?? "";
  const token =
    last.match(/\.([A-Za-z][\w-]*)/)?.[1] ??
    last.match(/#([A-Za-z][\w-]*)/)?.[1] ??
    last.match(/\[data-[\w-]*=?"?([\w-]+)/)?.[1] ??
    last.replace(/[^A-Za-z]/g, "");
  const cleaned = token
    // Strip the one- or two-letter prefixes design systems put on everything.
    .replace(/^(s|p|c|js|is|ui|el)[-_]/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return cleaned || "field";
}

/**
 * The container of the nearest LOOP a step sits inside, if any.
 *
 * A field picked inside a loop over `.card` should be described relative to a
 * card — the loop already says what a record is. Without this the picker
 * returned a page-wide selector, so every row of the scrape got the same
 * value, or a value from whichever card happened to be first.
 *
 * @param {string} stepId
 * @returns {string} the loop's selector, or "" when there is no scope
 */
function _loopScopeFor(stepId) {
  let found = _locateStep(_pipeline.steps, stepId);
  while (found?.parent) {
    const p = found.parent;
    if (
      p.type === "LOOP" &&
      p.config?.type === "elements" &&
      p.config?.selector
    ) {
      return p.config.selector;
    }
    found = _locateStep(_pipeline.steps, p.id);
  }
  return "";
}

async function _addExtractField(stepId) {
  const nameInput = document.getElementById(`new-ex-name-${stepId}`);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  // Inside a loop, the record is already chosen and the field is a column
  // within it — so there is nothing to ask about, and the selector comes back
  // relative to the record. Outside one, extract usually wants a column, so
  // bulk stays the default.
  const scopeSelector = _loopScopeFor(stepId);
  const bulk = scopeSelector ? false : await _selectSelectorMode(true);
  if (bulk === null) return;

  try {
    if (!(await _ensureContentReady(tab.id))) return;
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "FS_PICK_SELECTOR",
      payload: { bulk, scopeSelector },
    });
    if (!resp?.ok || !resp.result) return;

    const step = _findStepDeep(_pipeline.steps, stepId);
    if (!step) return;
    const name = nameInput?.value.trim() || _fieldNameFromSelector(resp.result);
    step.config.fields.push({ name, selector: resp.result, type: "text" });
    if (nameInput) nameInput.value = "";
    saveState();
    renderPipeline();
    notify(
      "info-log",
      scopeSelector
        ? `Added field "${name}" — read from each ${scopeSelector} the loop visits.`
        : `Added field "${name}" — ${bulk ? "all matches" : "this element"}.`,
    );
  } catch {
    notify("error-log", "Refresh the target webpage to connect the picker.");
  }
}
function _removeExtractField(stepId, idx) {
  const step = _findStepDeep(_pipeline.steps, stepId);
  if (step?.config?.fields) {
    step.config.fields.splice(idx, 1);
    saveState();
    renderPipeline();
  }
}

// ── Fill field management ─────────────────────────────────────────────────────
async function _addFillField(stepId) {
  const valInput = document.getElementById(`new-fill-val-${stepId}`);
  const value = valInput?.value || "";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    if (!(await _ensureContentReady(tab.id))) return;
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "FS_PICK_SELECTOR",
      payload: { bulk: false },
    });
    if (resp?.ok && resp.result) {
      const step = _findStepDeep(_pipeline.steps, stepId);
      if (step) {
        if (!Array.isArray(step.config.fields)) step.config.fields = [];
        step.config.fields.push({ selector: resp.result, value });
        saveState();
        renderPipeline();
      }
    }
  } catch {
    notify("error-log", "Refresh the target webpage to connect the picker.");
  }
}
function _removeFillField(stepId, idx) {
  const step = _findStepDeep(_pipeline.steps, stepId);
  if (step?.config?.fields) {
    step.config.fields.splice(idx, 1);
    saveState();
    renderPipeline();
  }
}

function _uploadStepSelectAll(stepId) {
  const step = _findStepDeep(_pipeline.steps, stepId);
  if (!step) return;
  step.config.fileIds = _storageFiles.map((f) => f.id);
  saveState();
  _rerenderCardConfig(step);
}

function _uploadStepClear(stepId) {
  const step = _findStepDeep(_pipeline.steps, stepId);
  if (!step) return;
  step.config.fileIds = [];
  saveState();
  _rerenderCardConfig(step);
}

function _uploadStepToggleFile(stepId, fileId, checked) {
  const step = _findStepDeep(_pipeline.steps, stepId);
  if (!step) return;

  if (!Array.isArray(step.config.fileIds)) step.config.fileIds = [];
  const next = new Set(step.config.fileIds);
  if (checked) next.add(fileId);
  else next.delete(fileId);
  step.config.fileIds = [...next];

  saveState();
  const sub = document.querySelector(
    `.node-wrapper[data-id="${step.id}"] .node-subtitle`,
  );
  if (sub) sub.textContent = getStepSubtitle(step);
}

// ── Keyboard register ─────────────────────────────────────────────────────────
/** How long the panel waits for a keystroke before giving up. */
const KEY_CAPTURE_SECONDS = 15;

/**
 * Combos Chrome handles before any page or extension sees them.
 *
 * Reported from a real session: pressing Ctrl+W to register it closed the tab.
 * It always will. `preventDefault` does not reach browser-level shortcuts —
 * a page that could block Ctrl+W could trap you on itself — so these can only
 * be typed, never captured, and the step can still send them as synthetic
 * events for a page that listens for them.
 */
const BROWSER_RESERVED_KEYS = Object.freeze([
  "w",
  "t",
  "n",
  "q",
  "shift+w",
  "shift+t",
  "shift+n",
  "shift+q",
]);

/**
 * Will the browser take this combo before the page gets it?
 * @param {string} combo - e.g. "Ctrl+W"
 * @returns {boolean}
 */
function _isBrowserReservedKey(combo) {
  const parts = String(combo || "")
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.pop() ?? "";
  const ctrlish = parts.includes("ctrl") || parts.includes("meta");
  if (!ctrlish) return false;
  const rest = parts.filter((p) => p !== "ctrl" && p !== "meta").join("+");
  return BROWSER_RESERVED_KEYS.includes(rest ? `${rest}+${key}` : key);
}

function _registerKey(stepId) {
  if (_keyListening) return;
  _keyListening = true;
  const btn = document.getElementById(`key-reg-${stepId}`);
  const disp = document.getElementById(`key-disp-${stepId}`);
  if (btn) {
    btn.textContent = `⏺ Press key(s)… ${KEY_CAPTURE_SECONDS}s`;
    btn.classList.add("listening");
  }

  const onKey = (e) => {
    // Ignore standalone modifier presses
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
    e.preventDefault();
    clearInterval(countdown);
    e.stopPropagation();

    // Build combo string e.g. "Ctrl+Shift+Enter"
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    parts.push(e.key === " " ? "Space" : e.key);
    const combo = parts.join("+");

    const step = _findStepDeep(_pipeline.steps, stepId);
    if (step) {
      step.config.key = combo;
      saveState();
    }
    if (disp) disp.textContent = combo;
    if (btn) {
      btn.textContent = `✓ ${combo}`;
      btn.classList.remove("listening");
    }
    document.removeEventListener("keydown", onKey, true);
    _keyListening = false;
  };

  document.addEventListener("keydown", onKey, true);

  // The button used to sit on "⏺ Press key(s)..." and then silently revert
  // after 15 seconds, with nothing to say why (E-17). Count it down instead,
  // and say what happened when it runs out.
  let remaining = KEY_CAPTURE_SECONDS;
  const countdown = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      if (_keyListening && btn)
        btn.textContent = `⏺ Press key(s)… ${remaining}s`;
      return;
    }
    clearInterval(countdown);
    if (!_keyListening) return;
    document.removeEventListener("keydown", onKey, true);
    _keyListening = false;
    if (btn) {
      btn.textContent = "🔴 Register Key";
      btn.classList.remove("listening");
    }
    notify(
      "warn-log",
      "No key pressed — key capture timed out. Click to retry.",
    );
  }, 1000);
}

// ── System listeners ──────────────────────────────────────────────────────────
function listenToSystem() {
  chrome.runtime.onMessage.addListener((msg) => {
    // If msg provides a tabId, only log/update if it matches our sidepanel's tab
    if (msg.payload?.tabId && msg.payload.tabId !== _tabId) return;
    if (msg.payload?.runId && msg.payload.runId !== _runState.runId) return;

    if (msg.type === "pipeline:status") {
      const info = msg.payload;
      if (info.progress?.total) {
        const pct = Math.round(
          (info.progress.current / info.progress.total) * 100,
        );
        const fill = document.getElementById("mon-progress-fill");
        if (fill) {
          fill.style.width = `${pct}%`;
          document.getElementById("mon-progress-text").textContent = `${pct}%`;
        }
      }
      // The card is labelled Rows Extracted and now reports rows. It used to
      // show progress.current, which is a step counter (E-04).
      if (typeof info.rows === "number") {
        document.getElementById("mon-rows").textContent = info.rows;
      }
      if (info.currentStepId) {
        document
          .querySelectorAll(".node-card")
          .forEach((n) => n.classList.remove("running", "success", "error"));

        // Hide all previously active tracers
        document.querySelectorAll(".wire-path-active-tracer").forEach((t) => {
          t.classList.remove("wire-path-active-tracer");
          t.classList.add("hidden-tracer");
        });

        const active = document.querySelector(
          `.node-wrapper[data-id="${info.currentStepId}"] .node-card`,
        );
        if (active) {
          active.classList.add("running");

          // Light up tracer pointing TO this node
          const tracer = document.querySelector(
            `path.hidden-tracer[data-to="${info.currentStepId}"]`,
          );
          if (tracer) {
            tracer.classList.remove("hidden-tracer");
            tracer.classList.add("wire-path-active-tracer");
          }

          _focusNodeOnBoard(active);
        }
        document.getElementById("mon-state").textContent = "Running...";
        document.getElementById("mon-state").style.color = "var(--text-main)";
      }
      if (info.state === "completed" || info.state === "stopped") {
        stopRunUI();

        // Hide all active tracers on stop/complete
        document.querySelectorAll(".wire-path-active-tracer").forEach((t) => {
          t.classList.remove("wire-path-active-tracer");
          t.classList.add("hidden-tracer");
        });

        document.getElementById("mon-state").textContent =
          info.state === "completed" ? "Success" : "Stopped";
        document.getElementById("mon-state").style.color =
          info.state === "completed" ? "var(--green)" : "var(--text-dim)";
        logToMonitor(
          info.state === "completed" ? "info-log" : "warn-log",
          `Pipeline ${info.state}.`,
        );
      }
    }
    if (msg.type === "pipeline:log") {
      logToMonitor(msg.payload.level, msg.payload.message);
      if (msg.payload.level === "error-log") {
        const el = document.getElementById("mon-errs");
        if (el) el.textContent = parseInt(el.textContent || "0") + 1;
      }
    }
  });
}

const MAX_LOG_ENTRIES = 500;

/**
 * Say something the user needs to see now.
 *
 * Routine errors used to come out of `alert()` — a blocking, unstyled, OS-level
 * dialog for "refresh the page first" (E-06). The log pane was already there
 * for this, but it lives behind a tab the user may not be looking at, so this
 * writes to both: a transient banner, and a permanent log entry.
 *
 * @param {'info-log'|'warn-log'|'error-log'} levelClass
 * @param {string} message
 */
function notify(levelClass, message) {
  logToMonitor(levelClass, message);

  let host = document.getElementById("fs-toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "fs-toasts";
    document.body.appendChild(host);
  }

  const el = document.createElement("div");
  el.className = `fs-toast ${levelClass}`;
  el.textContent = String(message ?? "");
  host.appendChild(el);

  const kill = () => el.remove();
  el.addEventListener("click", kill);
  setTimeout(kill, levelClass === "error-log" ? 7000 : 4000);
}

function logToMonitor(levelClass, message) {
  const logs = document.getElementById("mon-logs");
  if (!logs) return;
  const d = new Date();
  const ts = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;

  const div = document.createElement("div");
  div.className = `log-entry ${levelClass}`;

  // Built as nodes, not innerHTML. Log messages routinely carry page-derived
  // text — selectors, extracted values, API URLs, thrown error messages — so
  // interpolating them as markup let a page break the panel's layout or inject
  // content into it. CSP blocks inline script, but not markup injection.
  const tsEl = document.createElement("span");
  tsEl.className = "log-ts";
  tsEl.textContent = `[${ts}]`;

  const msgEl = document.createElement("span");
  msgEl.className = "log-msg";
  msgEl.textContent = String(message ?? "");

  div.append(tsEl, msgEl);
  logs.appendChild(div);

  // The pane grew without bound; a long run accumulated tens of thousands of
  // nodes and the panel got slower the longer it ran.
  while (logs.childElementCount > MAX_LOG_ENTRIES) {
    logs.removeChild(logs.firstElementChild);
  }

  logs.scrollTop = logs.scrollHeight;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", init);
else init();
