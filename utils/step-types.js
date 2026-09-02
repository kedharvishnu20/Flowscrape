// === step-types.js ===
/**
 * @module step-types
 * @description The pipeline's step vocabulary, in one place.
 *
 *   This list used to be copy-pasted into four places — the side panel's
 *   STEP_REGISTRY, injector.js's _executeStep switch, both script emitters, and
 *   the MCP server's supportedStepTypes — and had drifted in all of them.
 *   pipeline_validate reported FILL and AUTO_EXTRACT as "unsupported step
 *   types" for pipelines the UI had just built, while listing FORM_FILL, which
 *   does not exist as a step at all.
 *
 *   Everything that can import a module now reads this file. content/injector.js
 *   cannot — it is a classic content script with no module scope — so a test
 *   asserts its switch covers every type marked `runsIn: "page"` instead.
 *
 * @dependencies none
 */

"use strict";

/**
 * @typedef {Object} StepType
 * @property {string}  icon      Palette glyph
 * @property {'Action'|'Flow'|'Data'} cat  Palette grouping
 * @property {string}  desc      One-line description, shown in the palette
 * @property {'page'|'background'} runsIn  Which context executes it
 * @property {object}  def       Default config cloned into a new step
 * @property {'children'|'branches'} [container]  Whether it nests other steps
 * @property {boolean} [internal] Not a user-selectable step
 * @property {string}  [aliasOf]  Legacy name kept for older saved pipelines
 * @property {boolean} [exportable] false when script-gen cannot emit it;
 *                     defaults to true
 */

/** @type {Record<string, StepType>} */
export const STEP_TYPES = Object.freeze({
  // ── Action ────────────────────────────────────────────────────────────────
  WEBSITE: {
    icon: "🕸️",
    cat: "Action",
    desc: "Open website",
    runsIn: "background",
    def: { url: "https://", wait: true, timeoutMs: 30000 },
  },
  NAVIGATE: {
    icon: "🌐",
    cat: "Action",
    desc: "Go to URL",
    runsIn: "background",
    def: { url: "https://", wait: true, timeoutMs: 30000 },
  },
  CLICK: {
    icon: "🖱️",
    cat: "Action",
    desc: "Click element",
    runsIn: "page",
    def: { selector: "", all: false, fallbackToLoopItem: false },
  },
  FILL: {
    icon: "✏️",
    cat: "Action",
    desc: "Fill input / form",
    runsIn: "page",
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
    runsIn: "page",
    def: { selector: "" },
  },
  SELECT: {
    icon: "📑",
    cat: "Action",
    desc: "Dropdown select",
    runsIn: "page",
    def: { selector: "", value: "" },
  },
  SCROLL: {
    icon: "↕️",
    cat: "Action",
    desc: "Scroll page",
    runsIn: "page",
    def: {
      mode: "pixel",
      amount: 500,
      maxScrolls: 50,
      settleMs: 1200,
      selector: "",
    },
  },
  KEYBOARD: {
    icon: "⌨",
    cat: "Action",
    desc: "Press key",
    runsIn: "page",
    def: { key: "Enter", selector: "", repeat: 1, delayMs: 50 },
  },
  DRAG_DROP: {
    icon: "✋",
    cat: "Action",
    desc: "Drag & Drop",
    runsIn: "page",
    def: { source: "", target: "" },
  },
  UPLOAD_ACTIVITY: {
    icon: "🛰",
    cat: "Action",
    desc: "Upload from Storage",
    runsIn: "page",
    def: { selector: "input[type=file]", fileIds: [], optional: false },
    // Not expressible in an exported script: needs the file bytes from the extension's storage library.
    exportable: false,
  },

  // ── Flow ──────────────────────────────────────────────────────────────────
  WAIT: {
    icon: "⏳",
    cat: "Flow",
    desc: "Wait for time or element",
    // "background" is the fixed-time case, which is most of them and needs no
    // page at all. The other modes watch the DOM, so _dispatchStep forwards
    // those to the content script.
    runsIn: "background",
    def: { mode: "fixed", ms: 1000, selector: "", timeout: 15000 },
  },
  IF_ELSE: {
    icon: "🔀",
    cat: "Flow",
    desc: "Conditional branch",
    runsIn: "page",
    container: "branches",
    def: { condition: "exists", selector: "", value: "", attr: "" },
  },
  LOOP: {
    icon: "🔁",
    cat: "Flow",
    desc: "Loop / repeat",
    runsIn: "background",
    container: "children",
    def: { type: "elements", selector: "", max: 10, onFail: "skip" },
  },
  PAGINATE: {
    icon: "📄",
    cat: "Flow",
    desc: "Next page",
    runsIn: "page",
    def: { selector: "", settleMs: 1500, requireChange: false },
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  EXTRACT: {
    icon: "📤",
    cat: "Data",
    desc: "Extract data",
    runsIn: "page",
    def: { fields: [] },
  },
  SCREENSHOT: {
    icon: "📸",
    cat: "Data",
    desc: "Capture screenshot",
    runsIn: "background",
    def: { quality: 100, area: "viewport", selector: "" },
  },
  PAGE_DATA: {
    icon: "🧾",
    cat: "Data",
    desc: "Read the page's own data",
    runsIn: "page",
    def: { source: "auto", type: "", flatten: true, storeAs: "pageData" },
  },
  EXPORT: {
    icon: "💾",
    cat: "Data",
    desc: "Export results",
    runsIn: "background",
    def: { format: "csv" },
  },
  API: {
    icon: "🧩",
    cat: "Data",
    desc: "Call API endpoint",
    runsIn: "background",
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
    runsIn: "background",
    def: { enabled: true, urlFilter: "", methods: "" },
    // Not expressible in an exported script: needs the in-page fetch/XHR hook.
    exportable: false,
  },
  PDF_EXTRACTION: {
    icon: "📕",
    cat: "Data",
    desc: "Extract PDF text",
    runsIn: "background",
    def: {
      source: "url",
      url: "",
      fileId: "",
      maxPages: 50,
      storeAs: "pdf_text",
    },
    // Not expressible in an exported script: Playwright drives a browser and
    // has no PDF text extractor. The extension reads PDFs itself — see
    // utils/pdf-text.js — but that cannot be emitted as standalone code.
    exportable: false,
  },
  AUTO_EXTRACT: {
    icon: "🤖",
    cat: "Data",
    desc: "Smart product auto-extract",
    runsIn: "background",
    def: { confidenceThreshold: 70, useLlm: true },
    // Not expressible in an exported script: needs the three-layer extractor and a Gemini key.
    exportable: false,
  },

  // ── Internal ──────────────────────────────────────────────────────────────
  // Dispatched by the executor, never placed in a pipeline by a user.
  TYPE: {
    icon: "✏️",
    cat: "Action",
    desc: "Fill input (legacy name)",
    runsIn: "page",
    def: {},
    internal: true,
    aliasOf: "FILL",
  },
  QUERY_COUNT: {
    icon: "🔢",
    cat: "Data",
    desc: "Count matching elements",
    runsIn: "page",
    def: { selector: "" },
    internal: true,
  },
  QUERY_ELEMENTS: {
    icon: "🔎",
    cat: "Data",
    desc: "Read matching elements for loop templates",
    runsIn: "page",
    def: { selector: "" },
    internal: true,
  },
  PAGE_METRICS: {
    icon: "📐",
    cat: "Data",
    desc: "Measure the page, for a full-page screenshot",
    runsIn: "page",
    def: {},
    internal: true,
  },
  SCROLL_TO: {
    icon: "↕️",
    cat: "Action",
    desc: "Scroll to an exact offset, for a full-page screenshot",
    runsIn: "page",
    def: { top: 0 },
    internal: true,
  },
  ELEMENT_BOX: {
    icon: "🔲",
    cat: "Data",
    desc: "Measure one element, for an element screenshot",
    runsIn: "page",
    def: { selector: "" },
    internal: true,
  },
  PAGINATE_PROBE: {
    icon: "📄",
    cat: "Flow",
    desc: "Inspect the Next control without clicking it",
    runsIn: "page",
    def: { selector: "" },
    internal: true,
  },
});

/** Step types a user can add to a pipeline. */
export const USER_STEP_TYPES = Object.freeze(
  Object.keys(STEP_TYPES).filter((t) => !STEP_TYPES[t].internal),
);

/** Every recognised type, including internal dispatch types. */
export const ALL_STEP_TYPES = Object.freeze(Object.keys(STEP_TYPES));

/** Types the content script must be able to execute. */
export const PAGE_STEP_TYPES = Object.freeze(
  ALL_STEP_TYPES.filter((t) => STEP_TYPES[t].runsIn === "page"),
);

/**
 * Step types the script emitters can express. Everything else emits an explicit
 * failure rather than a comment, and is reported to the user before download —
 * an exported script that silently does less than the pipeline is worse than
 * one that refuses to run.
 */
export const EXPORTABLE_STEP_TYPES = Object.freeze(
  ALL_STEP_TYPES.filter((t) => STEP_TYPES[t].exportable !== false),
);

/**
 * @param {string} type
 * @returns {boolean}
 */
export function isExportableStepType(type) {
  return STEP_TYPES[type]?.exportable !== false;
}

/**
 * @param {string} type
 * @returns {boolean}
 */
export function isKnownStepType(type) {
  return Object.prototype.hasOwnProperty.call(STEP_TYPES, String(type ?? ""));
}

/**
 * Default config for a new step of this type, safe to mutate.
 * @param {string} type
 * @returns {object}
 */
export function defaultConfig(type) {
  const entry = STEP_TYPES[type];
  if (!entry) throw new Error(`Unknown step type: ${type}`);
  return structuredClone(entry.def);
}

// === END step-types.js ===
