// === captcha-check.js ===
/**
 * @module captcha-check
 * @description Is a captcha standing between this run and the page?
 *
 *   Not "does this page use a captcha" — that is a different and much less
 *   useful question. reCAPTCHA v3 runs invisibly on an enormous share of the
 *   web and challenges almost nobody; a hidden `.g-recaptcha` inside a login
 *   form nobody is filling in blocks nothing. A tool that stopped for those
 *   would cry wolf on most of the internet, and the warning would be ignored
 *   exactly when it mattered.
 *
 *   So the test is whether something is *rendered and in the way*: a widget or
 *   challenge iframe with a real box on screen, or one of the full-page
 *   interstitials that replace the site outright. Anything weaker is reported
 *   as `present` and never stops the run.
 *
 *   Replaces content/captcha-detector.js, which was an ES module importing the
 *   overlay engine — content scripts cannot import, which is why it was in no
 *   manifest entry and never ran a line (A-06). This is a classic script with
 *   no dependencies, injected on demand, and it shares the isolated world the
 *   same way structure-detector.js does.
 *
 * @dependencies none
 */

"use strict";

(() => {
  /** A box big enough to be a control a person is meant to use. */
  const MIN_BOX = 40;

  function _visible(el) {
    if (!el || !el.isConnected) return false;
    const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    if (style) {
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") {
        return false;
      }
      if (Number(style.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= MIN_BOX && r.height >= MIN_BOX;
  }

  function _sitekeyFrom(el) {
    if (!el) return null;
    return (
      el.getAttribute?.("data-sitekey") ??
      el.src?.match(/[?&]k=([^&]+)/)?.[1] ??
      null
    );
  }

  /** A short, human description of where it is. */
  function _describe(el) {
    if (!el) return "";
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList?.length ? `.${[...el.classList][0]}` : "";
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  }

  /**
   * The widgets, in the order a person would notice them.
   * Each entry: [type, selectors that mean "rendered challenge"].
   */
  const WIDGETS = [
    [
      "recaptcha",
      [
        ".g-recaptcha[data-sitekey]",
        'iframe[src*="recaptcha"][src*="anchor"]',
        'iframe[src*="recaptcha"][src*="bframe"]',
      ],
    ],
    [
      "hcaptcha",
      [
        ".h-captcha[data-sitekey]",
        ".hcaptcha[data-sitekey]",
        'iframe[src*="hcaptcha.com"]',
      ],
    ],
    [
      "turnstile",
      [
        ".cf-turnstile[data-sitekey]",
        'iframe[src*="challenges.cloudflare.com"]',
      ],
    ],
    [
      "image",
      [
        'img[src*="captcha" i]',
        'img[alt*="captcha" i]',
        'input[name*="captcha" i]',
        'input[id*="captcha" i]',
      ],
    ],
  ];

  /**
   * Full-page interstitials, which replace the site rather than sitting in it.
   * These are blocking whether or not anything inside them has a usable box —
   * the page the run wanted is simply not there.
   */
  function _interstitial() {
    const title = (document.title || "").toLowerCase();
    const cf =
      document.getElementById("challenge-running") ||
      document.getElementById("cf-challenge-running") ||
      document.querySelector("#challenge-form, .cf-browser-verification");
    if (cf) return { type: "cloudflare", where: _describe(cf) };
    if (
      /^(just a moment|attention required|checking your browser|access denied)/.test(
        title,
      )
    ) {
      return { type: "cloudflare", where: `page title: ${document.title}` };
    }
    if (document.querySelector('form[action*="/errors/validateCaptcha"]')) {
      return { type: "image", where: "amazon validateCaptcha form" };
    }
    return null;
  }

  /**
   * @returns {{blocking: boolean, present: boolean, type: string|null,
   *   sitekey: string|null, where: string, reason: string}}
   */
  function checkCaptcha() {
    const none = {
      blocking: false,
      present: false,
      type: null,
      sitekey: null,
      where: "",
      reason: "",
    };

    const wall = _interstitial();
    if (wall) {
      return {
        blocking: true,
        present: true,
        type: wall.type,
        sitekey: null,
        where: wall.where,
        reason: "the site replaced the page with a challenge",
      };
    }

    let present = null;
    for (const [type, selectors] of WIDGETS) {
      for (const sel of selectors) {
        let els;
        try {
          els = document.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (const el of els) {
          if (_visible(el)) {
            return {
              blocking: true,
              present: true,
              type,
              sitekey: _sitekeyFrom(el),
              where: _describe(el),
              reason: "a challenge is rendered on the page",
            };
          }
          // Remember the first one seen, so "present but not in the way" can
          // still be reported without stopping anything.
          present ??= { type, sitekey: _sitekeyFrom(el), where: _describe(el) };
        }
      }
    }

    if (present) {
      return {
        blocking: false,
        present: true,
        type: present.type,
        sitekey: present.sitekey,
        where: present.where,
        reason: "a captcha is on the page but is not currently in the way",
      };
    }
    return none;
  }

  // The isolated world is shared with injector.js, the same way
  // structure-detector.js hands over its entry point.
  globalThis.__fsCheckCaptcha = checkCaptcha;
})();

// === END captcha-check.js ===
