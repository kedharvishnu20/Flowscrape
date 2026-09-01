// === captcha-detector.js ===
/**
 * @module captcha-detector
 * @description Detects reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile,
 *   and image captchas. Always registers orange overlay zones for detected
 *   captcha elements, regardless of captchaEnabled flag.
 *
 *   Design decision: We register captcha overlays unconditionally because
 *   the user must always see where captchas are — even when solving is
 *   disabled. This is the transparency contract of FlowScrape's visual
 *   philosophy: no blind scraping of any kind.
 *
 * @dependencies overlay-engine, logger
 *
 * NOT LOADED. This module is not in manifest.json's content_scripts and nothing
 * imports it, so no captcha is ever detected. Its counterpart, solveCaptcha in
 * background/api-key-manager.js, is exposed via the captcha:solve message that
 * nothing sends. See docs/ISSUE_AUDIT.md A-06.
 */

'use strict';

import { overlayEngine } from './overlay-engine.js';
import { COLOR_CAPTCHA } from '../utils/color-utils.js';
import { logger }        from '../utils/logger.js';

const MODULE = 'captcha-detector';

/**
 * @typedef {Object} CaptchaDetection
 * @property {boolean}  found
 * @property {'recaptcha-v2'|'recaptcha-v3'|'hcaptcha'|'turnstile'|'image'|null} type
 * @property {string|null} sitekey
 * @property {Element|null} container
 * @property {number}  confidence   0-1
 * @property {string|null} zoneId   Overlay zone ID (always registered when found)
 */

// ── Detection helpers ─────────────────────────────────────────────────────────

function _scriptLoaded(pattern) {
  return Array.from(document.querySelectorAll('script[src]'))
    .some(s => pattern.test(s.src));
}

function _windowGlobal(name) {
  try { return !!window[name]; } catch { return false; }
}

// ── reCAPTCHA v2 ─────────────────────────────────────────────────────────────

function _detectRecaptchaV2() {
  const widget = document.querySelector('.g-recaptcha[data-sitekey]');
  if (widget) {
    return { found: true, type: 'recaptcha-v2', sitekey: widget.getAttribute('data-sitekey'), container: widget, confidence: 1.0 };
  }
  const iframe = document.querySelector('iframe[src*="recaptcha"][src*="anchor"]');
  if (iframe) {
    const m = iframe.src.match(/[?&]k=([^&]+)/);
    return { found: true, type: 'recaptcha-v2', sitekey: m?.[1] ?? null, container: iframe, confidence: 0.9 };
  }
  if (_scriptLoaded(/recaptcha\/api\.js/)) {
    return { found: true, type: 'recaptcha-v2', sitekey: null, container: null, confidence: 0.5 };
  }
  return null;
}

// ── reCAPTCHA v3 ─────────────────────────────────────────────────────────────

function _detectRecaptchaV3() {
  if (_windowGlobal('grecaptcha') && typeof window.grecaptcha?.execute === 'function') {
    const el = document.querySelector('[data-action],.g-recaptcha[data-size="invisible"]');
    const sitekey = el?.getAttribute('data-sitekey')
      ?? (document.head.innerHTML.match(/sitekey['":\s]+([A-Za-z0-9_-]{20,})/)?.[1]) ?? null;
    return { found: true, type: 'recaptcha-v3', sitekey, container: el ?? null, confidence: 0.85 };
  }
  if (_scriptLoaded(/recaptcha\/api\.js.*render=/)) {
    const m = Array.from(document.querySelectorAll('script[src*="recaptcha"]'))
      .map(s => s.src.match(/render=([^&]+)/)).find(Boolean);
    return { found: true, type: 'recaptcha-v3', sitekey: m?.[1] ?? null, container: null, confidence: 0.7 };
  }
  return null;
}

// ── hCaptcha ──────────────────────────────────────────────────────────────────

function _detectHCaptcha() {
  const widget = document.querySelector('.h-captcha[data-sitekey],.hcaptcha[data-sitekey]');
  if (widget) {
    return { found: true, type: 'hcaptcha', sitekey: widget.getAttribute('data-sitekey'), container: widget, confidence: 1.0 };
  }
  const iframe = document.querySelector('iframe[src*="hcaptcha.com"]');
  if (iframe) {
    return { found: true, type: 'hcaptcha', sitekey: null, container: iframe, confidence: 0.85 };
  }
  if (_scriptLoaded(/hcaptcha\.com\/1\/api\.js/)) {
    return { found: true, type: 'hcaptcha', sitekey: null, container: null, confidence: 0.6 };
  }
  return null;
}

// ── Cloudflare Turnstile ──────────────────────────────────────────────────────

function _detectTurnstile() {
  const widget = document.querySelector('.cf-turnstile[data-sitekey]');
  if (widget) {
    return { found: true, type: 'turnstile', sitekey: widget.getAttribute('data-sitekey'), container: widget, confidence: 1.0 };
  }
  if (_scriptLoaded(/challenges\.cloudflare\.com\/turnstile/)) {
    return { found: true, type: 'turnstile', sitekey: null, container: null, confidence: 0.7 };
  }
  return null;
}

// ── Image captcha ─────────────────────────────────────────────────────────────

function _detectImageCaptcha() {
  const imgEl = document.querySelector('img[src*="captcha"],img[alt*="captcha" i],img[id*="captcha" i]');
  if (imgEl) {
    return { found: true, type: 'image', sitekey: null, container: imgEl, confidence: 0.75 };
  }
  const inputEl = document.querySelector('input[name*="captcha" i],input[id*="captcha" i]');
  if (inputEl) {
    return { found: true, type: 'image', sitekey: null, container: inputEl, confidence: 0.65 };
  }
  return null;
}

// ── Overlay registration for captcha zones ────────────────────────────────────

/**
 * Register an orange overlay zone for a captcha container.
 * Always called regardless of captchaEnabled flag.
 * @param {CaptchaDetection} detection
 * @param {number}           stepIndex
 * @returns {string|null} zoneId
 */
function _registerCaptchaOverlay(detection, stepIndex = 0) {
  if (!detection.container) return null;
  try {
    const zoneId = overlayEngine.register({
      selector:   _selectorFor(detection.container),
      label:      `🔒 ${detection.type}`,
      stepIndex,
      fieldIndex: 0,
      mode:       'preview',
      color:      COLOR_CAPTCHA,
    });
    logger.info(MODULE, 'captcha-overlay-registered', { type: detection.type, zoneId });
    return zoneId;
  } catch (err) {
    logger.warn(MODULE, 'captcha-overlay-fail', { error: err.message });
    return null;
  }
}

function _selectorFor(el) {
  if (!el) return '';
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.className) return `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`;
  return el.tagName.toLowerCase();
}

// ── Main detector ─────────────────────────────────────────────────────────────

/**
 * Detect all captchas on the current page. Returns all detections,
 * sorted by confidence. Registers orange overlay zones unconditionally.
 * @param {number} [stepIndex=0]
 * @returns {CaptchaDetection[]}
 */
export function detectCaptcha(stepIndex = 0) {
  const detectors = [
    _detectRecaptchaV2,
    _detectRecaptchaV3,
    _detectHCaptcha,
    _detectTurnstile,
    _detectImageCaptcha,
  ];

  const found = detectors
    .map(fn => { try { return fn(); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence);

  // Always register orange overlay zones — visual transparency contract
  for (const detection of found) {
    detection.zoneId = _registerCaptchaOverlay(detection, stepIndex);
  }

  if (found.length > 0) {
    logger.info(MODULE, 'captcha-detected', { count: found.length, types: found.map(d => d.type) });
  }

  return found;
}

/**
 * Returns the highest-confidence captcha detection, or null if none.
 * @param {number} [stepIndex=0]
 * @returns {CaptchaDetection|null}
 */
export function detectPrimaryCaptcha(stepIndex = 0) {
  const results = detectCaptcha(stepIndex);
  return results.length > 0 ? results[0] : null;
}

/**
 * Watch for captcha appearance via MutationObserver.
 * Registers overlay zones for any newly detected captchas.
 * @param {function(CaptchaDetection): void} callback
 * @param {number} [stepIndex=0]
 * @returns {MutationObserver}
 */
export function watchForCaptcha(callback, stepIndex = 0) {
  const obs = new MutationObserver(() => {
    const captcha = detectPrimaryCaptcha(stepIndex);
    if (captcha) callback(captcha);
  });
  obs.observe(document.body, { childList: true, subtree: true });
  return obs;
}

// ── highlight / clearHighlight (step interface contract) ──────────────────────

export function highlight(config, stepIndex) {
  return detectCaptcha(stepIndex);
}

export function clearHighlight(stepIndex) {
  overlayEngine.clearStep(stepIndex);
}

// === END captcha-detector.js ===
