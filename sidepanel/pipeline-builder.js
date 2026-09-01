// === sidepanel/pipeline-builder.js ===
"use strict";

const MSG = {
  PIPELINE_START: "pipeline:start",
  PIPELINE_STOP: "pipeline:stop",
};
let SK = { PIPELINE: "fs_active_pipeline" };
SK.STORAGE_FILES = "fs_storage_files_v1";
SK.UPLOAD_ACTIVITIES = "fs_upload_activities_v1";

let _tabId = null;

// ── Step Registry ─────────────────────────────────────────────────────────────
const STEP_REGISTRY = {
  WEBSITE: {
    icon: "🕸️",
    cat: "Action",
    desc: "Open website",
    def: { url: "https://", wait: true },
  },
  NAVIGATE: {
    icon: "🌐",
    cat: "Action",
    desc: "Go to URL",
    def: { url: "https://", wait: true },
  },
  CLICK: {
    icon: "🖱️",
    cat: "Action",
    desc: "Click element",
    def: { selector: "", all: false, fallbackToLoopItem: false },
  },
  FILL: {
    icon: "✏️",
    cat: "Action",
    desc: "Fill input / form",
    def: {
      mode: "single",
      selector: "",
      text: "",
      delayMs: 50,
      append: false,
      fields: [],
      submitSelector: "",
    },
  },
  HOVER: {
    icon: "👆",
    cat: "Action",
    desc: "Hover element",
    def: { selector: "" },
  },
  SELECT: {
    icon: "📑",
    cat: "Action",
    desc: "Dropdown select",
    def: { selector: "", value: "" },
  },
  SCROLL: {
    icon: "↕️",
    cat: "Action",
    desc: "Scroll page",
    def: { mode: "pixel", amount: 500 },
  },
  KEYBOARD: {
    icon: "⌨",
    cat: "Action",
    desc: "Press key",
    def: { key: "Enter" },
  },
  DRAG_DROP: {
    icon: "✋",
    cat: "Action",
    desc: "Drag & Drop",
    def: { source: "", target: "" },
  },
  UPLOAD_ACTIVITY: {
    icon: "🛰",
    cat: "Action",
    desc: "Upload from Storage",
    def: { selector: "input[type=file]", fileIds: [], optional: false },
  },

  WAIT: { icon: "⏳", cat: "Flow", desc: "Wait (ms)", def: { ms: 1000 } },
  IF_ELSE: {
    icon: "🔀",
    cat: "Flow",
    desc: "Conditional branch",
    def: { condition: "exists", selector: "", value: "", attr: "" },
  },
  LOOP: {
    icon: "🔁",
    cat: "Flow",
    desc: "Loop / repeat",
    def: { type: "elements", selector: "", max: 10, onFail: "skip" },
  },
  PAGINATE: {
    icon: "📄",
    cat: "Flow",
    desc: "Pagination click",
    def: { selector: "" },
  },

  EXTRACT: {
    icon: "📤",
    cat: "Data",
    desc: "Extract data",
    def: { fields: [] },
  },
  SCREENSHOT: {
    icon: "📸",
    cat: "Data",
    desc: "Capture screenshot",
    def: { quality: 100 },
  },
  EXPORT: {
    icon: "💾",
    cat: "Data",
    desc: "Export results",
    def: { format: "csv" },
  },
  API: {
    icon: "🧩",
    cat: "Data",
    desc: "Call API endpoint",
    def: {
      url: "https://api.example.com/resource",
      method: "GET",
      headers: '{"Accept":"application/json"}',
      body: "",
      timeoutMs: 15000,
      responseType: "auto",
      storeAs: "api",
      failOnHttpError: true,
      exposeBodyAsExtracted: false,
    },
  },
  API_SNIFFER: {
    icon: "🕵️",
    cat: "Data",
    desc: "API Sniffer",
    def: {
      enabled: true,
    },
  },
  PDF_EXTRACTION: {
    icon: "📕",
    cat: "Data",
    desc: "Extract PDF text",
    def: {
      source: "url",
      url: "",
      fileId: "",
      maxPages: 50,
      storeAs: "pdf_text",
    },
  },
  AUTO_EXTRACT: {
    icon: "🤖",
    cat: "Data",
    desc: "Smart product auto-extract",
    def: {
      // smart-extractor.js implements product extraction only; there is no
      // article or listing extractor behind the old extractType dropdown.
      confidenceThreshold: 70,
      useLlm: true,
    },
  },
};

// ── State ─────────────────────────────────────────────────────────────────────
let _pipeline = { steps: [] };
let _expandedNodeId = null;
let _insertCtx = { index: -1, parentId: "", branchKey: "" };
let _runState = { active: false, timer: null, startTs: 0, runId: null };
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
    _tabId = activeInfo.tabId;
    SK.PIPELINE = `fs_active_pipeline_${_tabId}`;
    const saved = (await chrome.storage.local.get(SK.PIPELINE))[SK.PIPELINE];
    _pipeline = saved?.steps ? saved : { steps: [] };
    _expandedNodeId = null;
    _boardState.fittedOnce = false;
    renderPipeline();
  });

  bindNavTabs();
  bindGlobalControls();
  bindStorageControls();
  bindPalette();
  bindDelegatedEvents();
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

  chrome.runtime
    .sendMessage({ type: "checkpoint:check" })
    .then((res) => {
      if (res?.ok && res.result?.hasResumable && res.result.runs?.length > 0) {
        const banner = document.createElement("div");
        banner.className = "resume-banner";
        banner.innerHTML = `<span>⟳ Incomplete run found</span><button class="btn" id="btn-resume-run" style="font-size:11px;">Download Data</button>`;
        document.getElementById("view-monitor")?.prepend(banner);
        document
          .getElementById("btn-resume-run")
          ?.addEventListener("click", () =>
            document.getElementById("btn-download-partial")?.click(),
          );
      }
    })
    .catch(() => {});
}

async function saveState() {
  await chrome.storage.local.set({ [SK.PIPELINE]: _pipeline });
}

async function _saveStorageFiles() {
  try {
    await chrome.storage.local.set({ [SK.STORAGE_FILES]: _storageFiles });
  } catch (error) {
    logToMonitor(
      "error-log",
      `Storage save failed (quota). Remove large files and retry. ${error?.message || ""}`,
    );
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
      _storageFiles = [];
      await _saveStorageFiles();
      renderStoragePanel();
      logToMonitor("info-log", "Storage library cleared.");
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
  for (const file of files) {
    const sig = `${file.name}::${file.size}::${file.lastModified}`;
    if (!existing.has(sig)) {
      const dataUrl = await _readFileAsDataUrl(file);
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
  _updateActivity(activityId, {
    processedFiles: files.length,
    progress: 100,
    status: "completed",
    completedAt: Date.now(),
    message: "Files staged in storage",
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
      _pipeline.steps = [];
      _expandedNodeId = null;
      _boardState.fittedOnce = false;
      await chrome.storage.local.remove(SK.PIPELINE);
      saveState();
      renderPipeline();
    });

  const btnRun = document.getElementById("btn-master-run");
  const btnStop = document.getElementById("btn-master-stop");

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
      logToMonitor("error-log", `Blocked · ${blocker?.code}: ${blocker?.message}`);
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
      btnStop.classList.remove("hidden");
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
    ?.addEventListener("click", async () => {
      const val = document.getElementById("key-2captcha").value.trim();
      if (!val) return;
      const res = await chrome.runtime.sendMessage({
        type: "key:set",
        payload: { provider: "2captcha", value: val },
      });
      logToMonitor(
        res?.ok ? "info-log" : "error-log",
        res?.ok ? "2Captcha key saved." : "Failed to save 2Captcha key.",
      );
    });
  document
    .getElementById("btn-save-key-openai")
    ?.addEventListener("click", async () => {
      const val = document.getElementById("key-openai").value.trim();
      if (!val) return;
      const res = await chrome.runtime.sendMessage({
        type: "key:set",
        payload: { provider: "openai", value: val },
      });
      logToMonitor(
        res?.ok ? "info-log" : "error-log",
        res?.ok ? "OpenAI key saved." : "Failed to save OpenAI key.",
      );
    });
  document
    .getElementById("btn-save-key-gemini")
    ?.addEventListener("click", async () => {
      const val = document.getElementById("key-gemini").value.trim();
      if (!val) return;
      const res = await chrome.runtime.sendMessage({
        type: "key:set",
        payload: { provider: "gemini", value: val },
      });
      logToMonitor(
        res?.ok ? "info-log" : "error-log",
        res?.ok ? "Gemini key saved." : "Failed to save Gemini key.",
      );
    });
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
    .getElementById("btn-export-script")
    ?.addEventListener("click", async () => {
      if (!_pipeline.steps.length)
        return logToMonitor("warn-log", "Pipeline is empty.");
      const format = "python"; // prompt() is blocked in sidepanel, defaulting to python
      const res = await chrome.runtime.sendMessage({
        type: "script:export",
        payload: { pipeline: _pipeline, format },
      });
      if (res?.ok && res.result?.code) {
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
    ?.addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({
        type: "data:download",
        payload: { runId: _runState.runId || "latest" },
      });
      if (res?.ok && res.result?.rows?.length > 0) {
        const rows = res.result.rows.map((r) => {
          const { runId, ...c } = r;
          return c;
        });
        const headers = Array.from(new Set(rows.flatMap(Object.keys)));
        const csv =
          headers.join(",") +
          "\n" +
          rows
            .map((r) =>
              headers
                .map((h) => `"${String(r[h] || "").replace(/"/g, '""')}"`)
                .join(","),
            )
            .join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `flowscrape_partial_${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        logToMonitor("info-log", `Downloaded ${rows.length} partial rows.`);
      } else {
        logToMonitor("warn-log", "No collected data available yet.");
      }
    });
}

function startMonitorTimer() {
  if (_runState.timer) clearInterval(_runState.timer);
  _runState.timer = setInterval(() => {
    const s = Math.floor((Date.now() - _runState.startTs) / 1000);
    document.getElementById("mon-time").textContent =
      `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);
}
function stopRunUI() {
  _runState.active = false;
  clearInterval(_runState.timer);
  document.getElementById("btn-master-run").classList.remove("hidden");
  document.getElementById("btn-master-stop").classList.add("hidden");
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
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return;
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
  window.addEventListener("resize", () => _renderBoardWires());

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
  _renderBoardWires();
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

  let id = typeof step.id === "string" && step.id.trim() ? step.id.trim() : "";
  if (!id || seenIds.has(id)) {
    id = _nextStepId();
  }
  seenIds.add(id);

  const normalized = {
    id,
    type,
    config:
      step.config && typeof step.config === "object"
        ? JSON.parse(JSON.stringify(step.config))
        : {},
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
  const reg = STEP_REGISTRY[type];
  const newStep = {
    id: "s_" + Date.now() + Math.floor(Math.random() * 1000),
    type,
    config: { ...JSON.parse(JSON.stringify(reg.def)), optional: false },
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
      <div class="loop-body-inner">`;
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
      html += `<div class="loop-body-inner">`;
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
      return `${c.type} mode · max ${c.max}`;
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
function generateConfigHtml(step) {
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
    html += toggle(step, "optional", "optional");
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
    html += toggle(step, "optional", "optional");
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
    html += toggle(step, "optional", "optional");
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
          <input type="text" value="${esc(f.selector || "")}" disabled placeholder="selector" style="flex:1.5;font-size:10px;">
          <input type="text" value="${esc(f.value || "")}"    disabled placeholder="value"    style="flex:2;">
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
    html += toggle(step, "optional", "optional");
    return html;
  }

  // ── KEYBOARD ──
  if (step.type === "KEYBOARD") {
    html += `<label>Key to Press</label>
    <div class="flex gap-2" style="margin-bottom:10px;align-items:center;">
      <div class="key-display" id="key-disp-${step.id}">${esc(c.key || "Not set")}</div>
      <button class="btn key-register-btn" id="key-reg-${step.id}" data-action="register-key" data-id="${step.id}">🔴 Register Key</button>
    </div>`;
    html += toggle(step, "optional", "optional");
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
        "Safety max (0 = unlimited)",
        "number",
        c.max ?? 0,
      );
    } else if (ltype === "count") {
      html += field(step, "max", "Repeat N times", "number", c.max ?? 10);
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
    html += toggle(step, "optional", "optional");
    return html;
  }

  // ── IF_ELSE ──
  if (step.type === "IF_ELSE") {
    const cond = c.condition || "exists";
    html += `<label>Condition</label>
    <select id="cfg-${step.id}-condition" data-id="${step.id}" data-key="condition" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="exists"       ${cond === "exists" ? "selected" : ""}>Element exists</option>
      <option value="not-exists"   ${cond === "not-exists" ? "selected" : ""}>Element does NOT exist</option>
      <option value="text-equals"  ${cond === "text-equals" ? "selected" : ""}>Text equals value</option>
      <option value="text-contains"${cond === "text-contains" ? "selected" : ""}>Text contains value</option>
      <option value="attr-equals"  ${cond === "attr-equals" ? "selected" : ""}>Attribute equals value</option>
      <option value="attr-contains"${cond === "attr-contains" ? "selected" : ""}>Attribute contains value</option>
    </select>`;
    html += selectorRow(step, "selector");
    if (
      ["text-equals", "text-contains", "attr-equals", "attr-contains"].includes(
        cond,
      )
    ) {
      html += field(step, "value", "Value to compare", "text", c.value || "");
    }
    if (["attr-equals", "attr-contains"].includes(cond)) {
      html += field(step, "attr", "Attribute name", "text", c.attr || "");
    }
    html += `<p style="font-size:11px;color:var(--text-dim);margin-top:8px;margin-bottom:0;">
      Add steps in the <b>IF ✓</b> and <b>ELSE ✗</b> blocks below the card.</p>`;
    return html;
  }

  // ── SCROLL ──
  if (step.type === "SCROLL") {
    html += `<label>Mode</label><select id="cfg-${step.id}-mode" data-id="${step.id}" data-key="mode" data-rerender="true" class="cfg-bind" style="margin-bottom:8px;">
      <option value="pixel"   ${(c.mode || "pixel") === "pixel" ? "selected" : ""}>Pixel (scroll by amount)</option>
      <option value="percent" ${c.mode === "percent" ? "selected" : ""}>Percent of page</option>
      <option value="selector"${c.mode === "selector" ? "selected" : ""}>To element (selector)</option>
    </select>`;
    if (c.mode === "selector") {
      html += selectorRow(step, "selector");
    } else {
      html += field(step, "amount", "Amount", "number", c.amount ?? 500);
    }
    html += toggle(step, "optional", "optional");
    return html;
  }

  // ── EXPORT ──
  if (step.type === "EXPORT") {
    html += `<label>Format</label><select id="cfg-${step.id}-format" data-id="${step.id}" data-key="format" class="cfg-bind" style="margin-bottom:8px;">
      <option value="csv"  ${(c.format || "csv") === "csv" ? "selected" : ""}>CSV</option>
      <option value="json" ${c.format === "json" ? "selected" : ""}>JSON</option>
      <option value="jsonl"${c.format === "jsonl" ? "selected" : ""}>JSONL</option>
      <option value="tsv"  ${c.format === "tsv" ? "selected" : ""}>TSV</option>
    </select>`;
    html += toggle(step, "optional", "optional");
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

    html += toggle(step, "optional", "optional");
    return html;
  }

  // ── EXTRACT ──
  if (step.type === "EXTRACT") {
    html += `<div id="extract-fields-${step.id}">`;
    (c.fields || []).forEach((f, fi) => {
      html += `<div class="flex gap-2" style="margin-bottom:4px;align-items:center;">
        <input type="text" value="${esc(f.name || "")}"     disabled style="flex:1;">
        <input type="text" value="${esc(f.selector || "")}" disabled style="flex:2;">
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
    });
    html += `</div>
    <div class="flex gap-2" style="margin-top:12px;align-items:flex-end;">
      <div style="flex:1"><label style="margin-top:0;">Field Name</label><input type="text" id="new-ex-name-${step.id}" placeholder="e.g. price"></div>
      <button class="btn btn-primary" data-action="add-extract-field" data-id="${step.id}" style="height:28px;">🎯 Pick Element</button>
    </div>`;
    html += toggle(step, "optional", "optional");
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
    html += toggle(step, "optional", "optional");
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

    html += toggle(step, "useLlm", "Enable AI fallback (Gemini) when confidence is low");

    html += `<div style="margin-top:10px;padding:8px 10px;border-radius:6px;background:rgba(99,102,241,0.1);font-size:11px;color:var(--text-dim);">
      <b>Extracted fields:</b> name, price, originalPrice, currency, brand, description, sku, availability, rating, reviewCount, images[]<br>
      <b>Tip:</b> Use this step inside a LOOP to extract products from multiple pages automatically.
    </div>`;

    html += toggle(step, "optional", "optional");
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
function esc(s) {
  return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;");
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
function toggle(step, key, label) {
  const checked = step.config[key] ? "checked" : "";
  return `<div class="toggle-wrap">
    <input type="checkbox" id="cfg-${step.id}-${key}" ${checked} data-id="${step.id}" data-key="${key}" class="cfg-bind">
    <div class="toggle-switch"></div>
    <span>${label}</span>
  </div>`;
}

// ── Config input binding ──────────────────────────────────────────────────────
function bindConfigInputs(container = document) {
  container.querySelectorAll(".cfg-bind").forEach((el) => {
    // Basic trick to clear old listeners if we ever accidentally rebind
    const newEl = el.cloneNode(true);
    if (el.parentNode) el.parentNode.replaceChild(newEl, el);

    newEl.addEventListener("change", (e) => {
      const step = _findStepDeep(_pipeline.steps, e.target.dataset.id);
      if (!step) return;
      const key = e.target.dataset.key;
      if (e.target.type === "checkbox") step.config[key] = e.target.checked;
      else if (e.target.type === "number")
        step.config[key] = parseFloat(e.target.value) || 0;
      else step.config[key] = e.target.value;
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
    configEl.innerHTML = generateConfigHtml(step);
    bindConfigInputs(configEl);
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
      // Only reorder within the same parent for now (root level)
      const srcIdx = _pipeline.steps.findIndex((s) => s.id === _dragSourceId);
      const tgtIdx = _pipeline.steps.findIndex((s) => s.id === targetId);
      if (srcIdx !== -1 && tgtIdx !== -1) {
        const [moved] = _pipeline.steps.splice(srcIdx, 1);
        _pipeline.steps.splice(tgtIdx, 0, moved);
        saveState();
        renderPipeline();
      }
      _dragSourceId = null;
    });
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
    if (target instanceof HTMLSelectElement &&
        target.classList.contains("extract-type-select")) {
      const step = _findStepDeep(_pipeline.steps, target.dataset.id);
      const field = step?.config?.fields?.[parseInt(target.dataset.index, 10)];
      if (!field) return;
      field.type = target.value;
      if (field.type !== "attribute") delete field.attribute;
      saveState();
      _rerenderCardConfig(step); // show or hide the attribute input
      return;
    }

    if (!(target instanceof HTMLInputElement)) return;

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
async function _testStep(e, id) {
  e.stopPropagation();
  const step = _findStepDeep(_pipeline.steps, id);
  if (!step) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return alert("No active tab to test against.");
  const card = document.querySelector(
    `.node-wrapper[data-id="${id}"] .node-card`,
  );
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
  } catch (err) {
    if (card) {
      card.classList.remove("running");
      card.classList.add("error");
    }
    alert(
      err.message.includes("Receiving end")
        ? "Refresh the target webpage first."
        : `Test failed: ${err.message}`,
    );
  }
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
            (w) => `<div style="border-left:3px solid var(--yellow, #FACC15); background:var(--bg-hover); padding:8px 10px; border-radius:4px;">
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

    card.querySelector("#ethics-cancel").addEventListener("click", () => done(false));
    card.querySelector("#ethics-proceed").addEventListener("click", () => done(true));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) done(false);
    });

    modal.appendChild(card);
    document.body.appendChild(modal);
    card.querySelector("#ethics-proceed").focus();
  });
}

// ── Selector picker with mode toggle ──────────────────────────────────────────
async function _pickSelector(stepId, key) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return alert("No active tab available.");

  const stepType = _findStepDeep(_pipeline.steps, stepId)?.type;
  const defaultBulk =
    key === "selector" && ["EXTRACT", "LOOP"].includes(stepType);

  // Show mode selector modal
  const mode = await _selectSelectorMode(defaultBulk);
  if (mode === null) return; // cancelled

  try {
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
    alert("Refresh the target webpage to connect the picker.");
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

// ── Extract field management ──────────────────────────────────────────────────
async function _addExtractField(stepId) {
  const nameInput = document.getElementById(`new-ex-name-${stepId}`);
  if (!nameInput?.value.trim()) return alert("Enter a field name first.");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "FS_PICK_SELECTOR",
      payload: { bulk: true },
    });
    if (resp?.ok && resp.result) {
      const step = _findStepDeep(_pipeline.steps, stepId);
      if (step) {
        step.config.fields.push({
          name: nameInput.value.trim(),
          selector: resp.result,
          type: "text",
        });
        saveState();
        renderPipeline();
      }
    }
  } catch {
    alert("Refresh the target webpage to connect the picker.");
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
    alert("Refresh the target webpage to connect the picker.");
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
function _registerKey(stepId) {
  if (_keyListening) return;
  _keyListening = true;
  const btn = document.getElementById(`key-reg-${stepId}`);
  const disp = document.getElementById(`key-disp-${stepId}`);
  if (btn) {
    btn.textContent = "⏺ Press key(s)...";
    btn.classList.add("listening");
  }

  const onKey = (e) => {
    // Ignore standalone modifier presses
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
    e.preventDefault();
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
  setTimeout(() => {
    if (!_keyListening) return;
    document.removeEventListener("keydown", onKey, true);
    _keyListening = false;
    if (btn) {
      btn.textContent = "🔴 Register Key";
      btn.classList.remove("listening");
    }
  }, 15000);
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
        document.getElementById("mon-rows").textContent = info.progress.current;
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

function logToMonitor(levelClass, message) {
  const logs = document.getElementById("mon-logs");
  if (!logs) return;
  const d = new Date();
  const ts = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
  const div = document.createElement("div");
  div.className = `log-entry ${levelClass}`;
  div.innerHTML = `<span class="log-ts">[${ts}]</span><span class="log-msg">${message}</span>`;
  logs.appendChild(div);
  logs.scrollTop = logs.scrollHeight;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", init);
else init();
