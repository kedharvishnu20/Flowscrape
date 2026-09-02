// === injector.js ===
/**
 * @module injector
 * @description Content script entry point. Creates a shadow DOM host and
 *   dispatches step execution requests from the background over
 *   chrome.runtime.onMessage.
 *
 *   Design decision: Shadow DOM isolation ensures our injected UI (selector
 *   picker overlay) doesn't conflict with page styles.
 *
 *   Trust boundary: the background is trusted, the page is not. The only
 *   window.postMessage input accepted is FS_NETWORK_SNIFF from
 *   page-sniffer.js, and it is treated as page-controlled data — validated and
 *   clamped, never used to choose an action.
 *
 *   This file must stay under 40 KB. Heavy logic lives in form-filler.js,
 *   field-auto-mapper.js, etc. — which are injected via chrome.scripting
 *   on demand, not bundled here.
 *
 * @dependencies (none — minimal entry point)
 */

"use strict";

const FS_ORIGIN = chrome.runtime.getURL("").replace(/\/$/, "");

// ── Content event names ────────────────────────────────────────────────────────
// Message types accepted from the background over chrome.runtime.
// These were once also accepted from the page over postMessage; see the
// listener below for why that is gone.
const CE = Object.freeze({
  STEP_EXEC: "FS_STEP_EXEC",
  PICK_SELECTOR: "FS_PICK_SELECTOR",
  FORM_FILL_ROW: "FS_FORM_FILL_ROW",
});

// ── Shadow DOM host ────────────────────────────────────────────────────────────
const _host = document.createElement("div");
_host.id = "flowscrape-v3-host";
_host.style.cssText =
  "position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;";
const _shadow = _host.attachShadow({ mode: "closed" });
document.documentElement.appendChild(_host);

function _getScopedRoot(context) {
  const loop = context?.loop;
  if (!loop || !loop.selector || typeof loop.index0 !== "number") return null;
  const roots = Array.from(document.querySelectorAll(loop.selector));
  return roots[loop.index0] || null;
}

function _resolveTemplatePath(ctx, expr) {
  const parts = String(expr || "")
    .trim()
    .split(".");
  let val = ctx;
  for (let part of parts) {
    if (val === undefined || val === null) return undefined;

    const bracket = part.match(/^(.+?)\[(\d+)\]$/);
    if (bracket) {
      const key = bracket[1];
      const idx = Number(bracket[2]);
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

function _renderSelectorTemplate(selector, context = {}) {
  if (typeof selector !== "string") return selector;
  if (!selector.includes("{{")) return selector;
  return selector.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const val = _resolveTemplatePath(context, expr);
    return val !== undefined && val !== null ? String(val) : "";
  });
}

function _normalizeScopedSelector(selector, context = {}) {
  if (selector === null || selector === undefined) return "";
  if (typeof selector === "object") return "";
  const rendered = _renderSelectorTemplate(selector, context);
  const text = String(rendered).trim();
  if (!text) return "";
  if (text === "[object Object]" || text === "[object Array]") return "";
  if (/^\d+$/.test(text)) return `:scope > *:nth-child(${Number(text)})`;
  return text;
}

function _queryScoped(selector, context, all = false) {
  const root = _getScopedRoot(context);
  const resolved = _normalizeScopedSelector(selector, context);
  if (root) {
    if (!resolved) return all ? [root] : [root];
    try {
      const scoped = all
        ? Array.from(root.querySelectorAll(resolved))
        : [root.querySelector(resolved)].filter(Boolean);
      if (scoped.length > 0) return scoped;

      // If a full-page selector was provided inside LOOP child step,
      // allow document-level fallback when scoped lookup finds nothing.
      if (resolved.startsWith(":scope")) return [];
      return all
        ? Array.from(document.querySelectorAll(resolved || "*"))
        : [document.querySelector(resolved)].filter(Boolean);
    } catch {
      return [];
    }
  }
  if (!resolved) return [];
  try {
    if (all) return Array.from(document.querySelectorAll(resolved || "*"));
    return [document.querySelector(resolved)].filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Bridge from the MAIN world to the background.
 *
 * This listener used to route FS_STEP_EXEC, FS_PICK_SELECTOR and
 * FS_FORM_FILL_ROW into _handleEvent, guarded only by
 * `event.source !== window` — a check every script running in the page
 * satisfies. Any page could therefore drive CLICK, FILL, SELECT, DRAG_DROP,
 * NAVIGATE, UPLOAD_ACTIVITY and the selector picker on any site the user
 * visited, and read the results back off the `_ACK` reply.
 *
 * Nothing ever sent those events: the background talks to this content script
 * over chrome.tabs.sendMessage, and no code anywhere listened for an _ACK. The
 * whole surface was reachable only by an attacker, so it is gone.
 *
 * What remains is the one real sender — page-sniffer.js, which runs in the MAIN
 * world and has no other way to reach the extension. Its payload is page-
 * controlled by definition (it is the page's own traffic), so it is validated
 * and clamped here rather than trusted: a hostile sender must not be able to
 * push unbounded strings into the service worker's memory.
 */
const SNIFF_LIMITS = { url: 2048, body: 512 * 1024, type: 32 };

function _sanitizeSniffPayload(payload) {
  if (!payload || typeof payload !== "object") return null;

  const str = (value, max) =>
    typeof value === "string" ? value.slice(0, max) : "";

  const url = str(payload.url, SNIFF_LIMITS.url);
  if (!url) return null;

  const status = Number(payload.status);

  return {
    method: str(payload.method, 16).toUpperCase() || "GET",
    url,
    status: Number.isFinite(status) ? status : 0,
    reqBody: str(payload.reqBody, SNIFF_LIMITS.body),
    resBody: str(payload.resBody, SNIFF_LIMITS.body),
    apiType: str(payload.apiType, SNIFF_LIMITS.type),
  };
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const { type, payload } = event.data ?? {};
  if (type !== "FS_NETWORK_SNIFF") return;

  const clean = _sanitizeSniffPayload(payload);
  if (!clean) return;

  try {
    chrome.runtime
      .sendMessage({ type: "network:sniff", payload: clean })
      .catch(() => {});
  } catch {
    // Extension context invalidated (extension reloaded while the page lives on)
  }
});

// ── Runtime message bridge (SW → content script) ──────────────────────────────

/**
 * Message types this listener answers. Anything else must fall through.
 *
 * overlay-engine.js registers a second onMessage listener in this same content
 * script. Chrome runs every listener and delivers the first response, so a
 * listener that returns `true` for messages it does not understand steals them:
 * _handleEvent's default branch resolved to null, this listener replied
 * `{ ok: true, result: null }` first, and the overlay engine's real answer was
 * discarded. That silently disabled ethics Gate 7 and every overlay:* command.
 */
const OWNED_MESSAGE_TYPES = new Set([
  CE.STEP_EXEC,
  CE.FORM_FILL_ROW,
  CE.PICK_SELECTOR,
  "step:execute",
  // Answered so the worker can tell an already-injected tab from a fresh one.
  // The script is no longer declared for <all_urls> — it is injected on demand
  // (C-09) — so "is it there yet?" became a question that needed an answer.
  "fs:ping",
  "FS_DETECT_STRUCTURE",
]);

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const { type, payload } = msg ?? {};
  if (!type || !OWNED_MESSAGE_TYPES.has(type)) return false;

  _handleEvent(type, payload, null)
    .then((result) => respond({ ok: true, result }))
    .catch((err) => respond({ ok: false, error: err.message }));

  return true;
});

// ── Step dispatcher ────────────────────────────────────────────────────────────
async function _handleEvent(type, payload, id) {
  switch (type) {
    case CE.STEP_EXEC:
      return _executeStep(payload);

    case CE.FORM_FILL_ROW:
      return _formFillRow(payload);

    case CE.PICK_SELECTOR:
      return _activateSelectorPicker(payload);

    case "step:execute":
      return _executeStep(payload);

    case "fs:ping":
      return { ready: true };

    // structure-detector.js is injected alongside this file and shares the
    // isolated world, so it hands its entry point over on a global. A classic
    // content script cannot import one.
    case "FS_DETECT_STRUCTURE": {
      const detect = globalThis.__fsDetectStructure;
      if (typeof detect !== "function") {
        throw new Error("Structure detector is not loaded in this page.");
      }
      return detect();
    }

    default:
      throw new Error(`Unhandled event type: ${type}`);
  }
}

// ── Step execution ────────────────────────────────────────────────────────────
async function _executeStep(step) {
  const { type, config } = step;
  const context = step.__fsContext || {};
  // WEBSITE, NAVIGATE, SCREENSHOT and LOOP are not here: the service worker
  // executes those itself and never forwards them. They used to have handlers
  // here that nothing could reach — _stepNavigate set location.href, which is
  // not how the executor navigates, and _stepScreenshot and _stepLoop returned
  // a shape ("screenshotRequested", "loopInfo") no caller ever read (B-32).
  // Reaching one of them now is a real error rather than a silent no-op.
  switch (type) {
    case "CLICK":
      return _stepClick(config, context);
    case "SCROLL":
      return _stepScroll(config, context);
    case "WAIT":
      return _stepWait(config, context);
    case "EXTRACT":
      return _stepExtract(config, context);
    case "AUTO_EXTRACT":
      return _stepAutoExtract(config);
    case "FILL":
      return _stepFill(config, context); // renamed from TYPE
    case "TYPE":
      return _stepFill(config, context); // legacy alias
    case "HOVER":
      return _stepHover(config, context);
    case "SELECT":
      return _stepSelect(config, context);
    case "KEYBOARD":
      return _stepKeyboard(config, context);
    case "DRAG_DROP":
      return _stepDragDrop(config, context);
    case "UPLOAD_ACTIVITY":
      return _stepUploadActivity(config, context);
    case "IF_ELSE":
      return _stepIfElse(config, context);
    case "EXPORT":
      return { exportTriggered: true };
    case "API":
      throw new Error("API step is executed in background runtime only");
    case "PAGINATE":
      return _stepClick(config, context);
    case "QUERY_COUNT": {
      const els = _queryScoped(config.selector || "*", context, true);
      return { count: els.length };
    }
    case "QUERY_ELEMENTS": {
      // Returns rich data for each matched element for template variables
      const qEls = _queryScoped(config.selector || "*", context, true);
      return qEls.map((el, i) => {
        const info = {
          index: i + 1, // 1-based ({{item.index}})
          index0: i, // 0-based ({{item.index0}})
          text: el.textContent.trim(),
          innerText: (el.innerText || "").trim(),
          href: el.href || el.getAttribute("href") || "",
          src: el.src || el.getAttribute("src") || "",
          value: el.value || el.getAttribute("value") || "",
          id: el.id || "",
          class: el.className || "",
          tag: el.tagName.toLowerCase(),
        };
        // All data-* attributes
        for (const [key, val] of Object.entries(el.dataset || {}))
          info[`data-${key}`] = val;
        // All aria-*
        for (const attr of el.attributes) {
          if (attr.name.startsWith("aria-")) info[attr.name] = attr.value;
        }
        return info;
      });
    }
    default:
      throw new Error(`Unknown step type: ${type}`);
  }
}

/**
 * AUTO_EXTRACT step handler.
 * Delegates to window.__fsSmartExtract which is exposed by smart-extractor.js.
 * That function runs Layers 1 (structured data) and 2 (heuristic DOM) locally,
 * then returns the result including a `simplifiedDom` string if the SW should
 * escalate to the LLM layer.
 *
 * @param {object} config - { confidenceThreshold?: number }
 * @returns {Promise<object>} Extraction result
 */
async function _stepAutoExtract(config = {}) {
  // Guard: smart-extractor.js injects __fsSmartExtract onto window.
  // If the script hasn't loaded yet (rare race on instant navigation), wait briefly.
  let retries = 0;
  while (typeof window.__fsSmartExtract !== "function" && retries < 5) {
    await _sleep(200);
    retries++;
  }

  if (typeof window.__fsSmartExtract !== "function") {
    throw new Error(
      "AUTO_EXTRACT: smart-extractor.js not loaded — ensure it is registered " +
        "in manifest.json before injector.js.",
    );
  }

  // Run synchronously — pure DOM reads, no awaits needed inside
  const result = window.__fsSmartExtract({
    confidenceThreshold: config.confidenceThreshold ?? 70,
  });

  return result;
}

// ── Search elements in iframes (for LinkedIn popups, etc.) ─────────────────────
function _searchInIframes(selector) {
  const results = [];
  try {
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        // Check if accessible (same origin)
        const iframeDoc =
          iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc) continue;

        const found = iframeDoc.querySelectorAll(selector);
        if (found.length > 0) results.push(...found);
      } catch (e) {
        // Cross-origin iframe, skip
      }
    }
  } catch {}
  return results;
}

function _pickClickableTarget(el) {
  if (!el) return null;
  const clickableSel = [
    "a[href]",
    "button",
    "label",
    "input:not([type='hidden'])",
    "select",
    "textarea",
    "summary",
    "[role='button']",
    "[onclick]",
    "[tabindex]",
  ].join(",");

  const ancestor = el.closest?.(clickableSel);
  if (ancestor) return ancestor;
  if (el.matches?.(clickableSel)) return el;
  return el;
}

function _isInteractable(el) {
  if (!(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.pointerEvents === "none") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return true;
}

function _resolveTopmostAtCenter(el) {
  if (!(el instanceof Element)) return null;
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const stack = document.elementsFromPoint(cx, cy);
  const related = stack.find(
    (node) =>
      node instanceof Element &&
      node !== _host &&
      (node === el || node.contains(el) || el.contains(node)),
  );
  if (related) return _pickClickableTarget(related) || related;
  const top = stack.find((node) => node instanceof Element && node !== _host);
  if (!top) return el;
  return _pickClickableTarget(top) || top;
}

function _dispatchKeyboardActivate(el) {
  if (!(el instanceof HTMLElement)) return;
  try {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    el.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  } catch {}
}

function _dispatchSyntheticClick(el) {
  if (!(el instanceof Element)) return;
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: cx,
    clientY: cy,
  };
  try {
    el.dispatchEvent(
      new PointerEvent("pointerdown", { ...init, pointerId: 1 }),
    );
    el.dispatchEvent(new MouseEvent("mousedown", init));
    el.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent("mouseup", init));
    el.dispatchEvent(new MouseEvent("click", init));
  } catch {
    el.dispatchEvent(new MouseEvent("click", init));
  }
}

function _isInViewport(el) {
  if (!(el instanceof Element)) return false;
  const r = el.getBoundingClientRect();
  return (
    r.bottom > 0 &&
    r.right > 0 &&
    r.top < window.innerHeight &&
    r.left < window.innerWidth
  );
}

function _pickBestClickMatch(candidates) {
  const list = Array.from(candidates || []).filter((n) => n instanceof Element);
  if (!list.length) return null;

  const modalCandidates = Array.from(
    document.querySelectorAll('[role="dialog"], [aria-modal="true"]'),
  ).filter((el) => _isInteractable(el));
  const activeModal = modalCandidates.length
    ? modalCandidates[modalCandidates.length - 1]
    : null;

  const score = (el) => {
    let s = 0;
    if (_isInteractable(el)) s += 40;
    if (_isInViewport(el)) s += 20;
    if (activeModal && activeModal.contains(el)) s += 80;

    const clickable = _pickClickableTarget(el);
    if (clickable && clickable !== el) s += 10;

    const r = el.getBoundingClientRect();
    const area = Math.max(1, r.width * r.height);
    s += Math.min(20, Math.log10(area));
    return s;
  };

  list.sort((a, b) => score(b) - score(a));
  return list[0] || null;
}

async function _stepClick(
  { selector, retries = 3, all = false, fallbackToLoopItem = false },
  context = {},
) {
  let els = [];
  const renderedSelector = _normalizeScopedSelector(selector, context);
  const scopedRoot = _getScopedRoot(context);
  let usedRootFallback = false;

  // Try up to `retries` times with waits in between
  for (let i = 0; i < retries; i++) {
    const matches = _queryScoped(selector, context, true);
    els = all ? matches : [_pickBestClickMatch(matches)].filter(Boolean);
    if (!selector && scopedRoot) els = [scopedRoot];
    if (els.length) break;
    await _sleep(600); // Increased wait time
  }

  // Try searching in iframes as fallback
  if (!els.length) {
    const iframeMatches = _searchInIframes(selector);
    els = all
      ? iframeMatches
      : [_pickBestClickMatch(iframeMatches)].filter(Boolean);
  }

  // In LOOP children, optionally fall back to the current loop item root.
  //
  // This used to happen unconditionally: a selector that matched nothing inside
  // a loop silently clicked the item container instead, so a typo produced a
  // plausible-looking successful click on the wrong element. It is now opt-in,
  // because "click the row itself" is a real pattern but it must be a choice.
  if (!els.length && scopedRoot && !all && fallbackToLoopItem) {
    els = [scopedRoot];
    usedRootFallback = true;
  }

  if (!els.length) {
    const inLoop = Boolean(scopedRoot);
    throw new Error(
      `❌ Click target not found. Selector: "${renderedSelector || selector}"\n` +
        `Try: 1) Wait longer before click, 2) Use element picker (🎯), 3) Check if in iframe` +
        (inLoop
          ? `\n4) Or enable "Fall back to the loop item" to click the row itself`
          : ""),
    );
  }

  let clicked = 0;
  for (const el of els) {
    let target = _pickClickableTarget(el);
    if (!target) continue;

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    await _sleep(180);

    // On modal-heavy apps, center can be covered by transient layers.
    const topmost = _resolveTopmostAtCenter(target);
    if (topmost) target = topmost;

    if (!_isInteractable(target)) {
      await _sleep(220);
      const retryTopmost = _resolveTopmostAtCenter(target);
      if (retryTopmost) target = retryTopmost;
    }

    if (target instanceof HTMLElement) target.focus?.({ preventScroll: true });

    const isCheck =
      target instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(target.type?.toLowerCase());
    const wasChecked = isCheck ? target.checked : undefined;

    const primary = _pickClickableTarget(target) || target;
    const centerResolved = _resolveTopmostAtCenter(primary) || primary;
    const candidates = [primary, centerResolved].filter(
      (node, idx, arr) => node && arr.indexOf(node) === idx,
    );

    let fired = false;
    for (const candidate of candidates) {
      if (!_isInteractable(candidate)) continue;
      try {
        candidate.click();
        fired = true;
      } catch {}

      if (!fired && candidate instanceof HTMLElement) {
        _dispatchSyntheticClick(candidate);
        fired = true;
      }

      if (!fired && candidate instanceof HTMLElement) {
        _dispatchKeyboardActivate(candidate);
        fired = true;
      }

      if (fired) break;
    }

    if (fired) clicked++;

    // Some pages block native click on hidden radio/checkbox wrappers.
    if (isCheck && target.checked === wasChecked) {
      if (target.type.toLowerCase() === "radio") target.checked = true;
      else target.checked = !target.checked;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // For delegated handlers (common on LI lists), also bubble a click on original matched node.
    if (target !== el && el instanceof HTMLElement) {
      _dispatchSyntheticClick(el);
    }
  }
  return {
    clicked,
    matched: els.length,
    selector: renderedSelector || selector,
    usedRootFallback,
  };
}

async function _stepScroll(
  { mode = "pixel", amount, value, selector, behavior = "smooth" },
  context = {},
) {
  const scrollAmount = amount ?? value ?? 300;
  const scrollBehavior = behavior === "instant" ? "auto" : "smooth";
  if ((mode === "selector" || mode === "element") && selector) {
    const el = _queryScoped(selector, context, false)[0];
    if (el) el.scrollIntoView({ behavior: scrollBehavior, block: "center" });
  } else if (mode === "percent") {
    // documentElement, not body: with `body { height: 100% }` — or any layout
    // where the scroll container is the html element — body.scrollHeight is the
    // viewport height, so "scroll to 100%" moved one screen (B-31).
    const docHeight = Math.max(
      document.documentElement?.scrollHeight ?? 0,
      document.body?.scrollHeight ?? 0,
    );
    window.scrollTo({
      top: (docHeight * scrollAmount) / 100,
      behavior: scrollBehavior,
    });
  } else {
    // mode === 'pixel' or 'px' or default
    window.scrollBy({ top: scrollAmount, behavior: scrollBehavior });
  }
  return { scrolled: true };
}

async function _stepWait(
  { mode = "fixed", ms = 1000, selector, timeout = 15000 },
  context = {},
) {
  if (mode === "fixed") {
    await _sleep(ms);
  } else if (mode === "selector-visible" && selector) {
    await _waitForSelectorScoped(selector, timeout, context);
  } else if (mode === "DOM-stable") {
    await _waitDOMStable();
  } else {
    await _sleep(ms);
  }
  return { waited: true };
}

async function _stepExtract({ fields = [], schema = [] }, context = {}) {
  const extractors = schema.length > 0 ? schema : fields;
  if (extractors.length === 0) return [];

  const rawData = {};
  let maxLen = 1;

  const _extractValue = (el, field) => {
    if (field.type === "attribute") {
      // Falling through to text here would look like a successful extraction
      // of the wrong thing, which is how this went unnoticed while the UI had
      // no way to supply an attribute name at all.
      if (!field.attribute) {
        throw new Error(
          `EXTRACT field "${field.name || "unnamed"}" is set to Attr but has no attribute name.`,
        );
      }
      return el.getAttribute(field.attribute) ?? null;
    }
    if (field.type === "html") return el.innerHTML;

    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const inputType = el.type?.toLowerCase() ?? "text";
      if (inputType === "checkbox" || inputType === "radio") {
        return el.checked ? (el.value ?? "true") : "";
      }
      if (inputType === "file") {
        const files = Array.from(el.files || []);
        return files.length
          ? files.map((f) => f.name).join(", ")
          : (el.value ?? "");
      }
      return el.value ?? el.getAttribute("value") ?? "";
    }
    if (tag === "textarea") return el.value ?? "";
    if (tag === "select") {
      const opts = Array.from(el.selectedOptions || []);
      if (el.multiple) {
        return opts
          .map((o) => o.value || o.textContent.trim())
          .filter(Boolean)
          .join(", ");
      }
      const opt = opts[0];
      return opt ? opt.value || opt.textContent.trim() : (el.value ?? "");
    }
    if (el.isContentEditable)
      return el.innerText?.trim() ?? el.textContent.trim();

    // Intelligent media and url scraping
    if (tag === "img")
      return el.src || el.dataset?.src || el.getAttribute("src");
    if (tag === "a" && !el.textContent.trim())
      return el.href || el.getAttribute("href");
    if (tag === "video" || tag === "audio")
      return (
        el.src || el.getAttribute("src") || el.querySelector("source")?.src
      );
    return (el.innerText || el.textContent || "").trim();
  };

  for (const field of extractors) {
    const name = field.name || "data";
    // Pull all elements matching the selector
    const els = _queryScoped(field.selector, context, true);
    if (els.length > maxLen) maxLen = els.length;

    rawData[name] = els.map((el) => _extractValue(el, field));
  }

  // Row assembly. Fields can legitimately match a different number of elements
  // than the row count: a page title matches once and belongs on every row.
  // But a field matching 3 of 10 rows is missing data, not a value to repeat —
  // padding those with the first match (as this used to) invents data that
  // looks real.
  //
  //   exactly 1 match  -> broadcast to every row (a shared, page-level value)
  //   n matches, n > 1 -> positional; rows past n get null
  //   0 matches        -> null everywhere
  const results = [];
  for (let i = 0; i < maxLen; i++) {
    const row = {};
    for (const field of extractors) {
      const name = field.name || "data";
      const values = rawData[name];

      let value;
      if (values.length === 1) {
        value = values[0];
      } else if (i < values.length) {
        value = values[i];
      } else {
        value = null;
      }

      // ?? not ||: "0", "" and false are real extracted values, and turning
      // them into null loses out-of-stock counts, empty inputs and the like.
      row[name] = value ?? null;
    }
    results.push(row);
  }
  return results;
}

async function _stepUploadActivity(
  { selector = "", files = [] },
  context = {},
) {
  const _isFileInput = (node) =>
    node instanceof HTMLInputElement && node.type === "file";

  const _sameDialogRank = (candidate, anchor) => {
    const candidateDialog = candidate.closest?.(
      '[role="dialog"], [aria-modal="true"]',
    );
    const anchorDialog = anchor?.closest?.(
      '[role="dialog"], [aria-modal="true"]',
    );
    return candidateDialog && anchorDialog && candidateDialog === anchorDialog;
  };

  const _visibleish = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  };

  const _rankFileInputs = (inputs, anchor) => {
    const list = Array.from(inputs || []);
    list.sort((a, b) => {
      const aSame = _sameDialogRank(a, anchor) ? 1 : 0;
      const bSame = _sameDialogRank(b, anchor) ? 1 : 0;
      if (aSame !== bSame) return bSame - aSame;
      const aVisible = _visibleish(a) ? 1 : 0;
      const bVisible = _visibleish(b) ? 1 : 0;
      if (aVisible !== bVisible) return bVisible - aVisible;
      return 0;
    });
    return list;
  };

  const _deepQueryAll = (root, selector) => {
    const results = [];
    const seen = new Set();

    const visit = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);

      try {
        if (node.querySelectorAll) {
          results.push(...node.querySelectorAll(selector));
        }
      } catch {}

      const treeWalker = document.createTreeWalker(
        node,
        NodeFilter.SHOW_ELEMENT,
      );
      let current = treeWalker.currentNode;
      while (current) {
        const shadow = current.shadowRoot;
        if (shadow) visit(shadow);
        current = treeWalker.nextNode();
      }
    };

    visit(root);
    return results;
  };

  const _findPopupTrigger = (anchor) => {
    if (!(anchor instanceof Element)) return null;
    const scope =
      anchor.closest?.('[role="dialog"], [aria-modal="true"]') ||
      anchor.parentElement ||
      anchor;
    const triggerSelectors = [
      'button[aria-label*="Add media"]',
      'button[aria-label*="Media"]',
      'button[aria-label*="upload"]',
      'button[aria-label*="Upload"]',
      '[role="button"][aria-label*="Add media"]',
      '[role="button"][aria-label*="Upload"]',
      "button.share-promoted-detour-button",
      'button[title*="media"]',
      'button[title*="upload"]',
    ];

    for (const sel of triggerSelectors) {
      const found = scope.querySelector?.(sel) || anchor.querySelector?.(sel);
      if (found instanceof HTMLElement) return found;
    }

    const nearbyButtons = Array.from(
      scope.querySelectorAll?.("button,[role='button']") || [],
    );
    return (
      nearbyButtons.find((el) => {
        const label =
          `${el.getAttribute?.("aria-label") || ""} ${el.getAttribute?.("title") || ""} ${el.textContent || ""}`.toLowerCase();
        return (
          label.includes("media") ||
          label.includes("upload") ||
          label.includes("add")
        );
      }) || null
    );
  };

  const _findUploadInput = async () => {
    const anchor = _queryScoped(selector, context, false)[0] || null;
    if (!anchor) return null;

    if (_isFileInput(anchor)) return anchor;

    const fromAnchor = anchor.querySelector?.('input[type="file"]');
    if (_isFileInput(fromAnchor)) return fromAnchor;

    const scopedModal = anchor.closest?.(
      '[role="dialog"], [aria-modal="true"]',
    );
    const fromModal = scopedModal?.querySelector?.('input[type="file"]');
    if (_isFileInput(fromModal)) return fromModal;

    const deepFromAnchor = _deepQueryAll(anchor, 'input[type="file"]').find(
      _isFileInput,
    );
    if (deepFromAnchor) return deepFromAnchor;

    const deepFromModal = scopedModal
      ? _deepQueryAll(scopedModal, 'input[type="file"]').find(_isFileInput)
      : null;
    if (deepFromModal) return deepFromModal;

    // If the picker landed on a trigger button/container, click once to reveal the hidden input.
    if (anchor instanceof HTMLElement) {
      const trigger = _findPopupTrigger(anchor);
      if (trigger && trigger !== anchor) {
        try {
          trigger.click();
        } catch {
          _dispatchSyntheticClick(trigger);
        }
        await _sleep(700);
      }

      try {
        anchor.click();
      } catch {
        _dispatchSyntheticClick(anchor);
      }
      await _sleep(700);
    }

    const afterClickFromAnchor = anchor.querySelector?.('input[type="file"]');
    if (_isFileInput(afterClickFromAnchor)) return afterClickFromAnchor;

    const deepAfterClickFromAnchor = _deepQueryAll(
      anchor,
      'input[type="file"]',
    ).find(_isFileInput);
    if (deepAfterClickFromAnchor) return deepAfterClickFromAnchor;

    const afterClickFromModal =
      scopedModal?.querySelector?.('input[type="file"]');
    if (_isFileInput(afterClickFromModal)) return afterClickFromModal;

    const deepAfterClickFromModal = scopedModal
      ? _deepQueryAll(scopedModal, 'input[type="file"]').find(_isFileInput)
      : null;
    if (deepAfterClickFromModal) return deepAfterClickFromModal;

    const afterClickTrigger = _findPopupTrigger(anchor);
    if (afterClickTrigger && afterClickTrigger !== anchor) {
      try {
        afterClickTrigger.click();
      } catch {
        _dispatchSyntheticClick(afterClickTrigger);
      }
      await _sleep(700);
      const modalAfterTrigger =
        scopedModal?.querySelector?.('input[type="file"]');
      if (_isFileInput(modalAfterTrigger)) return modalAfterTrigger;
      const deepModalAfterTrigger = scopedModal
        ? _deepQueryAll(scopedModal, 'input[type="file"]').find(_isFileInput)
        : null;
      if (deepModalAfterTrigger) return deepModalAfterTrigger;
      const anchorAfterTrigger = anchor.querySelector?.('input[type="file"]');
      if (_isFileInput(anchorAfterTrigger)) return anchorAfterTrigger;
      const deepAnchorAfterTrigger = _deepQueryAll(
        anchor,
        'input[type="file"]',
      ).find(_isFileInput);
      if (deepAnchorAfterTrigger) return deepAnchorAfterTrigger;
    }

    const allInputs = _rankFileInputs(
      _deepQueryAll(document, 'input[type="file"]'),
      anchor,
    );
    return allInputs[0] || null;
  };

  const input = await _findUploadInput();
  if (!input) throw new Error(`Upload input not found near: ${selector}`);
  if (!_isFileInput(input)) {
    throw new Error(`Target is not input[type=file]: ${selector}`);
  }

  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("UPLOAD_ACTIVITY has no files to upload.");
  }

  const dt = new DataTransfer();
  for (const item of files) {
    const dataUrl = String(item?.dataUrl || "");
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw new Error(`Invalid file payload for ${item?.name || "unknown"}`);
    }
    const mime = match[1] || "application/octet-stream";
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
    const file = new File([bytes], item?.name || "upload.bin", { type: mime });
    dt.items.add(file);
  }

  input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  return {
    uploaded: dt.files.length,
    selector,
    fileNames: Array.from(dt.files).map((f) => f.name),
  };
}

// ── FILL (was TYPE): single or multi-field input ─────────────────────────────

/**
 * Write a value the way a real keystroke would.
 *
 * `el.value = x` assigns to the property, and React (and Vue's v-model, and
 * Angular's ControlValueAccessor) install their own accessor on the instance
 * and cache the last value they saw in `_valueTracker`. So the assignment is
 * either swallowed or reverted on the next render, and the field snaps back to
 * empty — the single most common way FILL silently did nothing (B-10).
 *
 * Calling the *prototype's* native setter writes past the framework's accessor,
 * and clearing the tracker makes React believe the value changed so it runs its
 * onChange. This is the technique that has been sitting unused in the dead
 * content/form-filler.js all along.
 *
 * @param {HTMLElement} el
 * @param {string} value
 */
function _setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const tracker = el._valueTracker;
  // Setting the tracker to something other than the incoming value is what
  // makes React's change detection fire; clearing it outright is enough.
  if (tracker) tracker.setValue(`${value}_`);
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** An `input` event frameworks recognise. A plain Event is not an InputEvent. */
function _fireInput(el) {
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
}

function _fireChange(el) {
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * What kind of thing are we filling? FILL used to assume "something with a
 * .value you can append characters to", so a checkbox, a radio, a <select> and
 * a contenteditable div all silently did nothing (B-10).
 *
 * @param {Element} el
 * @returns {'checkbox'|'select'|'contenteditable'|'file'|'text'|null}
 */
function _fillKind(el) {
  if (!el) return null;
  const tag = el.tagName;
  if (tag === "SELECT") return "select";
  if (tag === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return "checkbox";
    if (type === "file") return "file";
    return "text";
  }
  if (tag === "TEXTAREA") return "text";
  // isContentEditable is false for a detached element and undefined outside a
  // rendering engine, so fall back to the attribute that drives it.
  const ce = el.getAttribute?.("contenteditable");
  if (
    el.isContentEditable ||
    (ce !== null && ce !== undefined && ce !== "false")
  ) {
    return "contenteditable";
  }
  return null;
}

/** Values that mean "tick this box". */
const _TRUTHY_FILL = new Set(["true", "1", "yes", "on", "checked", "check"]);

async function _stepFill(
  {
    mode = "single",
    selector = "",
    text = "",
    delayMs = 50,
    append = false,
    fields = [],
    submitSelector = "",
  },
  context = {},
) {
  async function _typeInto(el, value, delay, shouldAppend) {
    const kind = _fillKind(el);
    if (!kind) {
      throw new Error(
        `Fill target is not an input, textarea, select or contenteditable: <${el.tagName.toLowerCase()}>`,
      );
    }
    if (kind === "file") {
      throw new Error(
        "Fill cannot set a file input for security reasons — use an Upload from Storage step.",
      );
    }

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await _sleep(100);
    el.focus();

    const valStr = String(value ?? "");

    if (kind === "checkbox") {
      const want = _TRUTHY_FILL.has(valStr.trim().toLowerCase());
      // A radio can only be set, never cleared, by clicking it.
      if (el.checked !== want) {
        el.checked = want;
        _fireInput(el);
        _fireChange(el);
      }
      return { kind, checked: el.checked };
    }

    if (kind === "select") {
      return _setSelectValue(el, valStr);
    }

    if (kind === "contenteditable") {
      if (!shouldAppend) el.textContent = "";
      for (const ch of valStr) {
        el.textContent += ch;
        _fireInput(el);
        await _sleep(delay || 50);
      }
      _fireChange(el);
      return { kind, length: el.textContent.length };
    }

    // Text-like. Typed a character at a time so per-keystroke handlers
    // (autocomplete, validation, search-as-you-type) see the same sequence a
    // person would produce.
    let typed = shouldAppend ? String(el.value ?? "") : "";
    if (!shouldAppend) {
      _setNativeValue(el, "");
      _fireInput(el);
    }
    for (const ch of valStr) {
      typed += ch;
      _setNativeValue(el, typed);
      _fireInput(el);
      await _sleep(delay || 50);
    }
    _fireChange(el);

    // Verify it stuck. A framework that reverts the value is the whole point of
    // _setNativeValue, and reporting success while the field is empty is what
    // made this so hard to see. maxlength and input masks legitimately shorten
    // what lands, so a truncation to the field's limit counts as accepted.
    const max = el.maxLength;
    const truncated = max >= 0 ? typed.slice(0, max) : null;
    if (el.value !== typed && el.value !== truncated) {
      throw new Error(
        `Fill did not stick: typed ${JSON.stringify(typed)}, field holds ${JSON.stringify(el.value)}. The page may be controlling this input.`,
      );
    }
    return { kind, typed: el.value };
  }

  if (mode === "multi" && fields.length > 0) {
    const results = [];
    const missing = [];
    for (const f of fields) {
      const el = _queryScoped(f.selector, context, false)[0];
      if (!el) {
        // Skipping silently meant a half-filled form was reported as a full
        // success, and the submit click went through anyway.
        missing.push(f.selector);
        continue;
      }
      results.push(
        await _typeInto(el, f.value ?? "", delayMs, f.append || false),
      );
      await _sleep(120);
    }
    if (missing.length) {
      throw new Error(`Fill target not found: ${missing.join(", ")}`);
    }
    if (submitSelector) {
      const btn = _queryScoped(submitSelector, context, false)[0];
      if (!btn) throw new Error(`Submit target not found: ${submitSelector}`);
      btn.scrollIntoView();
      await _sleep(200);
      btn.click();
    }
    return { filled: results.length, fields: results };
  }

  // single mode. The old code fell back to the scope root when the selector
  // matched nothing, so a typo typed into whatever container the loop was on.
  const el = _queryScoped(selector, context, false)[0];
  if (!el) throw new Error(`Fill target not found: ${selector}`);
  const result = await _typeInto(el, text, delayMs, append);
  return { typed: true, ...result };
}

async function _stepHover({ selector }, context = {}) {
  const el =
    _queryScoped(selector, context, false)[0] || _getScopedRoot(context);
  if (!el) throw new Error(`Hover target not found: ${selector}`);
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  await _sleep(150);
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: cx,
    clientY: cy,
  };
  el.dispatchEvent(new MouseEvent("mouseenter", init));
  el.dispatchEvent(new MouseEvent("mouseover", init));
  el.dispatchEvent(new MouseEvent("mousemove", init));
  el.dispatchEvent(new PointerEvent("pointerenter", { ...init, pointerId: 1 }));
  el.dispatchEvent(new PointerEvent("pointermove", { ...init, pointerId: 1 }));
  return { hovered: true, x: cx, y: cy };
}

/**
 * Choose an option on a <select>.
 *
 * `el.value = x` on a select whose options do not contain x sets it to "" —
 * the select is silently *cleared*, and the old code reported success (B-23).
 * Matching is tried by value, then by visible label, then case-insensitively,
 * because the label is what the user sees and therefore what they type into
 * the step config.
 *
 * @param {HTMLSelectElement} el
 * @param {string} value
 */
function _setSelectValue(el, value) {
  const want = String(value ?? "");
  const norm = (s) =>
    String(s ?? "")
      .trim()
      .toLowerCase();
  const options = Array.from(el.options || []);

  const match =
    options.find((o) => o.value === want) ??
    options.find((o) => o.text.trim() === want.trim()) ??
    options.find((o) => norm(o.value) === norm(want)) ??
    options.find((o) => norm(o.text) === norm(want));

  if (!match) {
    throw new Error(
      `Select has no option matching ${JSON.stringify(want)}. Available: ${
        options.map((o) => o.value || o.text.trim()).join(", ") || "(none)"
      }`,
    );
  }

  if (match.disabled) {
    throw new Error(`Select option ${JSON.stringify(want)} is disabled.`);
  }

  el.value = match.value;
  // A select fires input as well as change when a person picks an option, and
  // frameworks listen for input. Only change was sent before.
  _fireInput(el);
  _fireChange(el);
  return { kind: "select", selected: match.value, label: match.text.trim() };
}

async function _stepSelect({ selector, value }, context = {}) {
  const el = _queryScoped(selector, context, false)[0];
  if (!el) throw new Error(`Select target not found: ${selector}`);
  if (el.tagName !== "SELECT") {
    throw new Error(
      `Select target is a <${el.tagName.toLowerCase()}>, not a <select>.`,
    );
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  await _sleep(100);
  return { selected: true, ..._setSelectValue(el, value) };
}

/**
 * The `code` value a physical key would report.
 *
 * The old rule was `"Key" + upper` for any single character, which produced
 * `Key1` for a digit (it is `Digit1`) and `Key-` for a symbol (`Minus`) —
 * neither of which is a real code, so any site keyed on `event.code` ignored
 * the event entirely (B-24).
 *
 * @param {string} key
 * @returns {string}
 */
function _keyToCode(key) {
  if (key.length !== 1) return _NAMED_KEY_CODES[key] ?? key;
  if (key >= "a" && key <= "z") return `Key${key.toUpperCase()}`;
  if (key >= "A" && key <= "Z") return `Key${key}`;
  if (key >= "0" && key <= "9") return `Digit${key}`;
  return _SYMBOL_KEY_CODES[key] ?? "";
}

/** US-layout codes for the punctuation reachable without a modifier. */
const _SYMBOL_KEY_CODES = Object.freeze({
  " ": "Space",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
});

/** Named keys whose code differs from their key value. */
const _NAMED_KEY_CODES = Object.freeze({
  Escape: "Escape",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  " ": "Space",
  Space: "Space",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
});

async function _stepKeyboard({ key }, context = {}) {
  // key may be a combo like "Ctrl+Enter" or "Shift+Alt+Delete"
  const parts = (key || "Enter").split("+");
  const mainKey = parts[parts.length - 1];
  const ctrlKey = parts.includes("Ctrl");
  const altKey = parts.includes("Alt");
  const shiftKey = parts.includes("Shift");
  const metaKey = parts.includes("Meta");

  const active = document.activeElement || document.body;
  const code = _keyToCode(mainKey);
  const which = mainKey.length === 1 ? mainKey.charCodeAt(0) : 0;
  const evInit = {
    key: mainKey,
    code,
    which,
    charCode: which,
    keyCode: which,
    bubbles: true,
    cancelable: true,
    ctrlKey,
    altKey,
    shiftKey,
    metaKey,
  };

  active.dispatchEvent(new KeyboardEvent("keydown", evInit));
  active.dispatchEvent(new KeyboardEvent("keypress", evInit));
  await _sleep(40);
  active.dispatchEvent(new KeyboardEvent("keyup", evInit));
  return { keypressed: key };
}

async function _stepDragDrop({ source, target }, context = {}) {
  const src =
    _queryScoped(source, context, false)[0] || _getScopedRoot(context);
  const tgt = _queryScoped(target, context, false)[0] || null;
  if (!src || !tgt) throw new Error(`Drag/drop source or target not found`);
  const sr = src.getBoundingClientRect();
  const tr = tgt.getBoundingClientRect();
  const sx = sr.left + sr.width / 2,
    sy = sr.top + sr.height / 2;
  const tx = tr.left + tr.width / 2,
    ty = tr.top + tr.height / 2;
  const dt = new DataTransfer();
  const mki = (x, y) => ({
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  src.dispatchEvent(
    new PointerEvent("pointerdown", { ...mki(sx, sy), pointerId: 1 }),
  );
  src.dispatchEvent(new MouseEvent("mousedown", mki(sx, sy)));
  await _sleep(80);
  src.dispatchEvent(
    new DragEvent("dragstart", { ...mki(sx, sy), dataTransfer: dt }),
  );
  await _sleep(80);
  // simulate movement in 5 steps
  for (let i = 1; i <= 5; i++) {
    const x = sx + ((tx - sx) * i) / 5,
      y = sy + ((ty - sy) * i) / 5;
    const over = document.elementFromPoint(x, y) || tgt;
    over.dispatchEvent(
      new DragEvent("dragover", { ...mki(x, y), dataTransfer: dt }),
    );
    await _sleep(25);
  }
  tgt.dispatchEvent(
    new DragEvent("dragenter", { ...mki(tx, ty), dataTransfer: dt }),
  );
  tgt.dispatchEvent(
    new DragEvent("drop", { ...mki(tx, ty), dataTransfer: dt }),
  );
  await _sleep(60);
  src.dispatchEvent(
    new DragEvent("dragend", { ...mki(tx, ty), dataTransfer: dt }),
  );
  src.dispatchEvent(new MouseEvent("mouseup", mki(tx, ty)));
  src.dispatchEvent(
    new PointerEvent("pointerup", { ...mki(tx, ty), pointerId: 1 }),
  );
  return { dragged: true };
}

/** Collapse every run of whitespace to one space, and trim. */
function _normText(v) {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

async function _stepIfElse(
  { condition, selector, value = "", attr = "" },
  context = {},
) {
  const el =
    _queryScoped(selector, context, false)[0] || _getScopedRoot(context);
  const exists = !!el;
  let conditionMet = false;
  switch (condition) {
    case "exists":
      conditionMet = exists;
      break;
    case "not-exists":
      conditionMet = !exists;
      break;
    // Real markup indents its text, so an element rendered as "Add to cart"
    // has a textContent of "\n      Add to cart\n    ". trim() alone does not
    // help when the whitespace is *inside* the string, which is why
    // text-equals almost never matched anything (B-25).
    case "text-equals":
      conditionMet = exists && _normText(el.textContent) === _normText(value);
      break;
    case "text-contains":
      conditionMet =
        exists && _normText(el.textContent).includes(_normText(value));
      break;
    case "attr-equals":
      conditionMet =
        exists && (el.getAttribute(attr) ?? "").trim() === String(value).trim();
      break;
    case "attr-contains":
      conditionMet = exists && (el.getAttribute(attr) || "").includes(value);
      break;
    default:
      conditionMet = exists;
  }
  return { conditionMet };
}

// ── Form fill row ─────────────────────────────────────────────────────────────
async function _formFillRow({ config, row, rowIndex, context }) {
  // Dynamically load form-filler (keeps injector.js small)
  const mod = await import(chrome.runtime.getURL("content/form-filler.js"));
  return mod.executeRow(config, row, rowIndex, context);
}

// ── Bulk selector — finds the common pattern for sibling elements ─────────────────
function _buildBulkSelector(el) {
  // Build path from element up to the first repeating container
  let path = [];
  let current = el;
  let foundBulkSequence = false;

  for (let depth = 0; depth < 5; depth++) {
    if (!current || current === document.documentElement) break;

    const parent = current.parentElement;
    const sameTagSiblings = parent
      ? Array.from(parent.children).filter((c) => c.tagName === current.tagName)
      : [];

    let part = current.tagName.toLowerCase();

    if (!foundBulkSequence && sameTagSiblings.length > 1) {
      // Find common classes across siblings
      const sigClass = _findCommonClass(sameTagSiblings);
      if (sigClass) {
        part += `.${CSS.escape(sigClass)}`;
        foundBulkSequence = true;
      } else if (["li", "tr", "td", "article", "section"].includes(part)) {
        foundBulkSequence = true;
      }
    } else {
      // Try to add stable classes
      if (current.className && typeof current.className === "string") {
        const stableClasses = current.className
          .split(/\s+/)
          .filter((c) => c && !/[\d_]/.test(c) && !c.includes("hover"));
        if (stableClasses.length > 0) {
          part += `.${CSS.escape(stableClasses[0])}`;
        }
      }
    }

    path.unshift(part);

    // If we've established a solid array anchor, check if it matches enough targets globally
    if (foundBulkSequence) {
      try {
        const candidate = path.join(" > ");
        if (document.querySelectorAll(candidate).length >= 2) {
          return {
            selector: candidate,
            count: document.querySelectorAll(candidate).length,
          };
        }
      } catch {}
    }

    current = parent;
  }

  return {
    selector: _buildSpecificSelector(el),
    count: document.querySelectorAll(_buildSpecificSelector(el)).length,
  };
}

function _findCommonClass(elements) {
  if (!elements.length) return "";
  const classSets = elements.map((el) => Array.from(el.classList || []));
  // Find classes present in ALL elements
  const common = classSets[0].filter(
    (cls) =>
      cls.length > 1 && // skip single-char utility classes
      !cls.match(/^(active|selected|hover|first|last|odd|even|\d)/) && // skip state classes
      classSets.every((set) => set.includes(cls)),
  );
  return common[0] || "";
}

function _buildNthPath(node, maxDepth = 8) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return "*";
  const parts = [];
  let current = node;
  let depth = 0;

  while (current && depth < maxDepth && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    const parent = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const sameType = Array.from(parent.children).filter(
      (c) => c.tagName.toLowerCase() === tag,
    );
    const idx = sameType.indexOf(current) + 1;
    parts.unshift(idx > 0 ? `${tag}:nth-of-type(${idx})` : tag);
    current = parent;
    depth++;
  }

  return parts.join(" > ") || node.tagName.toLowerCase();
}

function _buildSpecificSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const tag = el.tagName.toLowerCase();
  const cls = Array.from(el.classList || [])
    .filter((c) => !c.match(/^(active|selected|hover|open|show)/))
    .slice(0, 2);
  if (cls.length) return `${tag}.${cls.map((c) => CSS.escape(c)).join(".")}`;
  // Never return a bare tag; use structural path fallback.
  return _buildNthPath(el);
}

// ── Selector picker overlay ────────────────────────────────────────────────────
let _pickerActive = false;
let _pickerResolve = null;

/**
 * Let the user click an element and return a selector for it.
 *
 * Cancelling used to be impossible. The promise resolved only from onClick —
 * no Escape, no right-click, no timeout — so a user who changed their mind left
 * `_pickerActive` true for the life of the page, every later pick returned null
 * immediately, and the side panel sat awaiting a message that never came. Only
 * a page reload recovered it.
 *
 * @param {{ bulk?: boolean }} payload
 * @returns {Promise<string|null>} selector, or null if cancelled
 */
async function _activateSelectorPicker(payload) {
  if (_pickerActive) return null;
  _pickerActive = true;
  const isBulk = payload?.bulk === true;

  return new Promise((resolve) => {
    _pickerResolve = resolve;

    // The blocker div. The host element sets pointer-events:none so the rest of
    // our shadow UI never eats page clicks, and this inherited it — so despite
    // the comment that used to sit here, it blocked nothing and the page kept
    // firing its own hover styles under the crosshair.
    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed;top:0;left:0;width:100%;height:100%;",
      "z-index:2147483645;cursor:crosshair;background:transparent;",
      "pointer-events:auto;",
    ].join("");
    _shadow.appendChild(overlay);

    let currentTarget = null;
    const highlight = document.createElement("div");
    highlight.style.cssText = [
      "position:fixed;pointer-events:none;border:2px solid #2563eb;",
      "background:rgba(37,99,235,0.1);border-radius:4px;transition:all 0.1s;z-index:2147483647;",
    ].join("");

    // Tiny instruction tooltip attached to the highlight
    const tooltip = document.createElement("div");
    tooltip.style.cssText =
      "position:absolute;bottom:-24px;left:-2px;background:#2563eb;color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;white-space:nowrap;font-family:sans-serif;pointer-events:none;";
    tooltip.textContent = "Click to pick · Esc to cancel";
    highlight.appendChild(tooltip);

    _shadow.appendChild(highlight);

    document.addEventListener("mousemove", onMove, true); // Capture phase!
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("beforeunload", onUnload);

    let _blockTimer = null;
    let _lastX = 0,
      _lastY = 0;

    function _isIgnoredPickerTarget(el) {
      if (!el || el === _host || el === overlay || el === highlight)
        return true;
      if (el === document.documentElement || el === document.body) return true;
      return false;
    }

    function _pickRealTargetAtPoint(x, y) {
      const prevDisplay = _host.style.display;
      _host.style.display = "none";
      const stack = document.elementsFromPoint(x, y);
      _host.style.display = prevDisplay;

      const base = stack.find((node) => !_isIgnoredPickerTarget(node)) || null;
      if (!base) return null;

      const clickable = base.closest?.(
        "button,a,input,textarea,select,[role='button'],[contenteditable='true'],[aria-label]",
      );
      return clickable && !_isIgnoredPickerTarget(clickable) ? clickable : base;
    }

    function _pickTargetFromEvent(e) {
      const path = Array.isArray(e?.composedPath?.()) ? e.composedPath() : [];
      const base =
        path.find(
          (node) =>
            node &&
            node.nodeType === Node.ELEMENT_NODE &&
            !_isIgnoredPickerTarget(node),
        ) || null;
      if (!base) return null;

      const clickable = base.closest?.(
        "button,a,input,textarea,select,[role='button'],[contenteditable='true'],[aria-label]",
      );
      return clickable && !_isIgnoredPickerTarget(clickable) ? clickable : base;
    }

    function _updateHighlight() {
      if (!currentTarget) return;
      const rect = currentTarget.getBoundingClientRect();

      Object.assign(highlight.style, {
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    }

    function onMove(e) {
      _lastX = e.clientX;
      _lastY = e.clientY;
      if (!_blockTimer) {
        _blockTimer = requestAnimationFrame(() => {
          const realTarget =
            _pickTargetFromEvent(e) || _pickRealTargetAtPoint(_lastX, _lastY);
          _blockTimer = null;
          if (!realTarget) return;
          currentTarget = realTarget;
          _updateHighlight();
        });
      }
    }

    /**
     * Tear everything down exactly once and settle the promise.
     * Every exit path goes through here, so the picker cannot be left armed.
     * @param {string|null} selector
     */
    function finish(selector) {
      if (!_pickerActive) return; // already settled
      _pickerActive = false;

      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("beforeunload", onUnload);

      if (_blockTimer) cancelAnimationFrame(_blockTimer);
      overlay.remove();
      highlight.remove();

      const settle = _pickerResolve;
      _pickerResolve = null;
      settle?.(selector);
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();

      // Resolve again at click time so we don't keep a stale container target.
      currentTarget =
        _pickTargetFromEvent(e) ||
        _pickRealTargetAtPoint(e.clientX, e.clientY) ||
        currentTarget;

      finish(currentTarget ? _buildSelector(currentTarget, isBulk) : null);
    }

    function onKey(e) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    }

    function onContextMenu(e) {
      // Right-click is the other reflex for "get me out of this mode".
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    }

    function onUnload() {
      // A navigation destroys the page the picker was pointing at; settle so
      // the caller is not left waiting on a tab that no longer exists.
      finish(null);
    }
  });
}

function _buildSelector(el, bulk = false) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return "*";
  if (el.tagName.toLowerCase() === "html") return "html";
  if (el.tagName.toLowerCase() === "body") return "body";

  // 0. Intelligent Bulk Engine (for LOOP and EXTRACT)
  if (bulk) {
    const res = _buildBulkSelector(el);
    if (res && res.selector !== "*") return res.selector;
  }

  const semantics = [
    "data-testid",
    "data-test",
    "data-view-name",
    "data-id",
    "name",
    "aria-label",
    "placeholder",
    "role",
    "type",
    "title",
    "alt",
  ];

  const isLikelyStableClass = (c) => {
    if (!c) return false;
    if (/^(active|selected|hover|focus|open|show|disabled)$/i.test(c))
      return false;
    if (/^ng-|^css-|^jsx-|^sc-/.test(c)) return false;
    if (/\d{4,}/.test(c)) return false;
    if (/^(x|y|z|sm|md|lg|xl)$/i.test(c)) return false;
    return true;
  };

  const qCount = (sel) => {
    try {
      return document.querySelectorAll(sel).length;
    } catch {
      return 0;
    }
  };

  const nthOfType = (node) => {
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (!parent) return tag;
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName.toLowerCase() === tag,
    );
    const idx = siblings.indexOf(node) + 1;
    return idx > 0 ? `${tag}:nth-of-type(${idx})` : tag;
  };

  const unique = (sel) => qCount(sel) === 1;

  const buildNodeCandidates = (node) => {
    const tag = node.tagName.toLowerCase();
    const out = [];

    if (node.id) {
      const idSel = `#${CSS.escape(node.id)}`;
      out.push(idSel);
      out.push(`${tag}${idSel}`);
    }

    for (const attr of semantics) {
      const val = node.getAttribute?.(attr);
      if (!val || String(val).length > 120) continue;
      out.push(`${tag}[${attr}="${CSS.escape(String(val))}"]`);
    }

    const classes = Array.from(node.classList || []).filter(
      isLikelyStableClass,
    );
    if (classes.length > 0) {
      out.push(`${tag}.${CSS.escape(classes[0])}`);
      if (classes.length > 1) {
        out.push(`${tag}.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}`);
      }
      if (classes.length > 2) {
        out.push(
          `${tag}.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}.${CSS.escape(classes[2])}`,
        );
      }
    }

    out.push(nthOfType(node));
    out.push(tag);

    // De-duplicate while preserving score order
    return Array.from(new Set(out));
  };

  // 1) Try direct unique selector for the target element.
  const selfCandidates = buildNodeCandidates(el);
  const isTagOnly = (sel) => sel === el.tagName.toLowerCase();
  for (const sel of selfCandidates) {
    if (isTagOnly(sel)) continue;
    if (unique(sel)) return sel;
  }

  // 2) Build anchored path upward until unique.
  let current = el;
  let depth = 0;
  let parts = [];
  let bestSelector =
    selfCandidates.find((s) => !isTagOnly(s)) || _buildNthPath(el);
  let bestCount = qCount(bestSelector) || Number.POSITIVE_INFINITY;

  while (current && depth < 8 && current !== document.documentElement) {
    const candidates = buildNodeCandidates(current);
    const part =
      candidates.find((s) => s.startsWith("#")) ||
      candidates.find((s) => s.includes("[")) ||
      candidates.find((s) => s.includes(".")) ||
      candidates.find((s) => s.includes(":nth-of-type(")) ||
      current.tagName.toLowerCase();

    parts.unshift(part);
    const chain = parts.join(" > ");
    const count = qCount(chain);
    if (count === 1) return chain;
    if (count > 0 && count < bestCount) {
      bestCount = count;
      bestSelector = chain;
    }

    current = current.parentElement;
    depth++;
  }

  // 3) Return best non-unique candidate; if it degrades, force structural path.
  if (bestSelector === el.tagName.toLowerCase()) {
    return _buildNthPath(el);
  }
  return bestSelector;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// _waitForSelector lived here, duplicating _waitForSelectorScoped below
// without the scoping. Nothing called it (B-32).

async function _waitForSelectorScoped(selector, timeout, context = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (_queryScoped(selector, context, false).length > 0) return;
    await _sleep(200);
  }
  throw new Error(`Timeout waiting for selector: ${selector}`);
}

async function _waitDOMStable(quietMs = 300, timeout = 8000) {
  return new Promise((resolve) => {
    let timer = null;
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        obs.disconnect();
        resolve();
      }, quietMs);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    timer = setTimeout(() => {
      obs.disconnect();
      resolve();
    }, timeout);
  });
}

// === END injector.js ===

// ── Bootstrap overlay engine ─────────────────────────────────────────────────
// overlay-engine.js is an ES module — it cannot be declared in manifest
// content_scripts directly. We load it dynamically so it self-initialises
// (overlayEngine.init() is called at the bottom of overlay-engine.js).
import(chrome.runtime.getURL("content/overlay-engine.js")).catch((err) => {
  console.warn("[FlowScrape] overlay-engine failed to load:", err.message);
});
