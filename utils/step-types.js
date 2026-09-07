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
    def: {
      selector: "",
      all: false,
      fallbackToLoopItem: false,
      inFrame: false,
    },
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
      inFrame: false,
    },
  },
  HOVER: {
    icon: "👆",
    cat: "Action",
    desc: "Hover element",
    runsIn: "page",
    def: { selector: "", revealSelector: "", timeout: 3000, inFrame: false },
  },
  SELECT: {
    icon: "📑",
    cat: "Action",
    desc: "Dropdown select",
    runsIn: "page",
    def: { selector: "", value: "", inFrame: false },
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
      container: "",
      inFrame: false,
    },
  },
  KEYBOARD: {
    icon: "⌨",
    cat: "Action",
    desc: "Press key",
    runsIn: "page",
    def: { key: "Enter", selector: "", repeat: 1, delayMs: 50, inFrame: false },
  },
  DRAG_DROP: {
    icon: "✋",
    cat: "Action",
    desc: "Drag & Drop",
    runsIn: "page",
    def: { source: "", target: "", inFrame: false },
  },
  UPLOAD_ACTIVITY: {
    icon: "🛰",
    cat: "Action",
    desc: "Upload from Storage",
    runsIn: "page",
    def: {
      selector: "input[type=file]",
      fileIds: [],
      optional: false,
      inFrame: false,
    },
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
    def: {
      condition: "exists",
      selector: "",
      value: "",
      attr: "",
      inFrame: false,
    },
  },
  LOOP: {
    icon: "🔁",
    cat: "Flow",
    desc: "Loop / repeat",
    runsIn: "background",
    container: "children",
    // `type` picks the mode: elements, count, paginate (click a Next control),
    // paginate-links (walk a set of numbered page links) or paginate-url
    // (fill a page number into a URL template). The last two exist because a
    // numbered paginator has no Next control to click and nothing that ever
    // goes dead — the links simply stop existing.
    def: {
      type: "elements",
      selector: "",
      max: 10,
      onFail: "skip",
      urlTemplate: "",
      startPage: 1,
      pageStep: 1,
    },
  },
  PAGINATE: {
    icon: "📄",
    cat: "Flow",
    desc: "Next page",
    runsIn: "page",
    def: { selector: "", settleMs: 1500, requireChange: false, inFrame: false },
  },
  SOLVE_CAPTCHA: {
    icon: "🧮",
    cat: "Flow",
    desc: "Answer a written challenge (owned sites only)",
    // The gates live in the worker: the run's captchaAuthorized flag and a
    // per-domain attestation, both of which the page has no business seeing.
    runsIn: "background",
    def: { submitSelector: "" },
    // Not expressible in an exported script, and not by accident: the gates
    // are the step. A generated script carries no attestation and no run
    // authorisation, so an emitted equivalent would be the same act with the
    // consent stripped out of it.
    exportable: false,
  },
  ASSERT: {
    icon: "✅",
    cat: "Flow",
    desc: "Check the page still looks right",
    runsIn: "page",
    def: {
      assertion: "exists",
      selector: "",
      value: "",
      count: 1,
      inFrame: false,
    },
  },

  SESSION: {
    icon: "🔐",
    cat: "Flow",
    desc: "Save or restore a logged-in session",
    // The worker owns chrome.cookies; the page owns localStorage. The step
    // runs here and asks the page for its half, the same split DOWNLOAD_FILE
    // uses.
    runsIn: "background",
    def: {
      mode: "save",
      name: "default",
      includeCookies: true,
      includeStorage: true,
    },
    // A saved session lives encrypted inside the extension, and a standalone
    // script has no way to reach it — nor should a shared pipeline carry
    // someone's cookies out with it. Playwright's own storageState is the
    // right tool on that side; see docs/SESSIONS_AND_HEADERS.md.
    exportable: false,
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  EXTRACT: {
    icon: "📤",
    cat: "Data",
    desc: "Extract data",
    runsIn: "page",
    def: { fields: [], inFrame: false },
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
    def: {
      source: "auto",
      type: "",
      flatten: true,
      storeAs: "pageData",
      inFrame: false,
    },
  },
  PAGE_JSON: {
    icon: "🧬",
    cat: "Data",
    desc: "The whole page as JSON",
    runsIn: "page",
    def: {
      mode: "tree",
      selector: "",
      maxNodes: 5000,
      maxDepth: 25,
      includeScripts: false,
      storeAs: "pageJson",
      inFrame: false,
    },
    // Not expressible in a standalone script without carrying the whole DOM
    // walker; see the note in the emitters.
    exportable: false,
  },
  DOWNLOAD_FILE: {
    icon: "📥",
    cat: "Data",
    desc: "Download matched files",
    // The worker owns chrome.downloads; the page only says which URLs it can
    // see, which is what DOWNLOAD_COLLECT below is for.
    runsIn: "background",
    def: {
      selector: "",
      attr: "auto",
      url: "",
      filename: "flowscrape/{{file.name}}",
      max: 25,
      inFrame: false,
    },
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
    // rowsPath picks the array of records out of the response body — dotted
    // path, empty meaning "the body itself, if it is an array". It applies
    // whether pagination is on or not, so a single call and a paginated one
    // land rows the same way (K-25).
    //
    // pagination.mode picks how the next page is found: "cursor" reads
    // cursorPath out of the body and sends it back as cursorParam on the next
    // request; "page" increments pageParam by pageStep each request; "link"
    // reads the RFC 8288 `Link` response header for `rel="next"`. maxPages is
    // a safety cap, not the exit condition — the source saying it has no more
    // pages is (K-25).
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
      rowsPath: "",
      pagination: {
        mode: "none",
        cursorPath: "",
        cursorParam: "cursor",
        pageParam: "page",
        startPage: 1,
        pageStep: 1,
        maxPages: 10,
      },
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
  DOWNLOAD_COLLECT: {
    icon: "🔗",
    cat: "Data",
    desc: "Read the URLs a DOWNLOAD_FILE selector matches",
    runsIn: "page",
    def: { selector: "", attr: "auto" },
    internal: true,
  },
  SESSION_STORAGE: {
    icon: "🗄️",
    cat: "Data",
    desc: "Read or write the page's own storage, for SESSION",
    runsIn: "page",
    def: { mode: "dump" },
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
 * The bounds on a step's own retry, in one place.
 *
 * `optional` could only say "give up quietly", so a selector that is flaky
 * rather than wrong — a lazily loaded image, a panel that animates in — lost
 * the row instead of the attempt. Four places read these numbers: the
 * executor, the panel and both emitters. A hand-edited pipeline asking for
 * fifty retries with no delay would otherwise be a way to outrun the rate
 * limiter, so the clamp lives with the vocabulary rather than at each reader.
 */
export const RETRY_LIMITS = Object.freeze({
  maxRetries: 5,
  maxDelayMs: 30000,
  defaultDelayMs: 500,
});

/**
 * How many extra attempts a step asks for, 0 to RETRY_LIMITS.maxRetries.
 * @param {object} [config]
 * @returns {number}
 */
export function retryCount(config) {
  const n = Math.floor(Number(config?.retries));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, RETRY_LIMITS.maxRetries);
}

/**
 * How long to wait before the next attempt.
 * @param {object} [config]
 * @returns {number}
 */
export function retryDelayMs(config) {
  const n = Number(config?.retryDelayMs);
  if (!Number.isFinite(n) || n < 0) return RETRY_LIMITS.defaultDelayMs;
  return Math.min(n, RETRY_LIMITS.maxDelayMs);
}

/**
 * Bounds on an API step's own retry against 429 and 5xx.
 *
 * This is separate from RETRY_LIMITS above: the generic step retry re-runs
 * the whole step after any failure, on a delay the user picked. This one
 * fires only on a rate-limit or server error, waits however long the server's
 * `Retry-After` said to (when there was one), and exists precisely so a
 * single API step does not just fail the moment a server asks it to slow
 * down. The cap keeps a chatty `Retry-After` from stalling a run for an hour
 * — a server is free to ask for one; honouring it is not the same as obeying
 * it without limit.
 */
export const API_RETRY_LIMITS = Object.freeze({
  maxAttempts: 4, // the first try, plus up to 3 more
  maxTotalWaitMs: 60_000, // never accumulate more than a minute of waiting
  fallbackBaseMs: 1000, // backoff base when the server names no Retry-After
});

/**
 * Bounds on how many pages an API step's pagination will fetch.
 *
 * `maxPages` is a safety limit, not the exit condition — pagination is meant
 * to stop because the source says to (no next cursor, no `rel="next"`, an
 * empty page), and this cap only exists so a source that never says to stop
 * cannot run forever.
 */
export const PAGINATION_LIMITS = Object.freeze({
  maxPages: 500,
  defaultMaxPages: 10,
});

/**
 * How many pages an API step's pagination is allowed to fetch, 1 to
 * PAGINATION_LIMITS.maxPages.
 * @param {object} [pagination]
 * @returns {number}
 */
export function paginationMaxPages(pagination) {
  const n = Math.floor(Number(pagination?.maxPages));
  if (!Number.isFinite(n) || n <= 0) return PAGINATION_LIMITS.defaultMaxPages;
  return Math.min(n, PAGINATION_LIMITS.maxPages);
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
