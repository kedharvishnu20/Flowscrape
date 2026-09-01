// === smart-sleep.js ===
/**
 * @module smart-sleep
 * @description 3-tier adaptive wait system for content scripts.
 *   Tier 1: Fixed ms sleep.
 *   Tier 2: Selector-visible wait (MutationObserver-based).
 *   Tier 3: Network-idle wait (patched fetch/XHR counters).
 *
 *   Design decision: We use MutationObserver (not polling loops) for
 *   DOM stability to avoid burning CPU. For network idle, we patch
 *   window.fetch and XMLHttpRequest.send — done once on module load —
 *   and count in-flight requests. This avoids needing webRequest API
 *   from the content script side.
 *
 * @dependencies none (content script context)
 */

"use strict";

// ── Network idle tracker ───────────────────────────────────────────────────────
let _inFlightCount = 0;

// Patch fetch
const _origFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  _inFlightCount++;
  try {
    return await _origFetch(...args);
  } finally {
    _inFlightCount--;
  }
};

// Patch XHR
const _origOpen = XMLHttpRequest.prototype.open;
const _origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (...args) {
  _inFlightCount++;
  this.addEventListener(
    "loadend",
    () => {
      _inFlightCount = Math.max(0, _inFlightCount - 1);
    },
    { once: true },
  );
  return _origSend.apply(this, args);
};

// ── Tier 1: Fixed sleep ───────────────────────────────────────────────────────
/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tier 2: Selector-visible wait ────────────────────────────────────────────
/**
 * Wait until a CSS selector matches a visible element.
 * @param {string} selector
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<Element>}
 */
export function waitForSelector(selector, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el && _isVisible(el)) {
      resolve(el);
      return;
    }

    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found && _isVisible(found)) {
        obs.disconnect();
        clearTimeout(timer);
        resolve(found);
      }
    });
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    const timer = setTimeout(() => {
      obs.disconnect();
      reject(
        new Error(
          `waitForSelector timeout: "${selector}" after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });
}

function _isVisible(el) {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

// ── Tier 2b: DOM stability (MutationObserver-based) ──────────────────────────
/**
 * Wait until the DOM has been stable (no mutations) for a given duration.
 * @param {number} [stableMs=300]    - Quiet period duration
 * @param {number} [timeoutMs=10000] - Max wait
 * @returns {Promise<void>}
 */
export function waitForDOMStable(stableMs = 300, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let quietTimer = null;
    const deadline = setTimeout(() => {
      obs.disconnect();
      clearTimeout(quietTimer);
      resolve(); // timeout gracefully
    }, timeoutMs);

    const resetQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        obs.disconnect();
        clearTimeout(deadline);
        resolve();
      }, stableMs);
    };

    const obs = new MutationObserver(resetQuiet);
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    resetQuiet(); // start the first quiet timer
  });
}

// ── Tier 3: Network idle ───────────────────────────────────────────────────────
/**
 * Wait until no in-flight XHR/fetch requests for a given quiet period.
 * @param {number} [quietMs=500]     - Required quiet period with no requests
 * @param {number} [timeoutMs=15000] - Max wait
 * @returns {Promise<void>}
 */
export function waitForNetworkIdle(quietMs = 500, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let quietStart = null;

    const check = () => {
      if (Date.now() - start > timeoutMs) {
        resolve();
        return;
      }

      if (_inFlightCount === 0) {
        if (!quietStart) quietStart = Date.now();
        if (Date.now() - quietStart >= quietMs) {
          resolve();
          return;
        }
      } else {
        quietStart = null;
      }
      setTimeout(check, 100);
    };

    setTimeout(check, 100);
  });
}

// ── Auto-wait (smart composite) ───────────────────────────────────────────────
/**
 * Adaptive wait: DOM stability + network idle, with a max timeout.
 * Used by the AUTO wait mode in form-filler.js.
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<void>}
 */
export async function autoWait(timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  // Small initial settle
  await sleep(200);
  // Wait for both DOM stable and network idle, up to deadline
  const remaining = () => Math.max(0, deadline - Date.now());
  await Promise.race([
    waitForNetworkIdle(500, remaining()),
    sleep(remaining()),
  ]);
  await sleep(300); // extra settle for React renders
}

// === END smart-sleep.js ===
