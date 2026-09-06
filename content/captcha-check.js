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
 *   It also answers a second question the detector never asked: **can anything
 *   free do something about this one?** `tier` is that answer —
 *   `solvable-locally` for the arithmetic and word puzzles a small site writes
 *   itself, `needs-a-service` for the widget captchas that need a solver
 *   somebody is paid to run, and `not-solvable` for the full-page Cloudflare
 *   and Akamai walls, which are bot management rather than captchas: there is
 *   no answer to type, and no money spent anywhere buys one.
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

  /**
   * What, if anything, can be done about a challenge without paying for it.
   *
   * These strings travel to the worker and into the log, so they are written
   * to be read there rather than decoded.
   */
  const TIER = Object.freeze({
    LOCAL: "solvable-locally",
    SERVICE: "needs-a-service",
    NONE: "not-solvable",
  });

  function _visible(el, minBox = MIN_BOX) {
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
    return r.width >= minBox && r.height >= minBox;
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
   * What each type costs to get past.
   *
   * Cloudflare and Akamai interstitials are the entries worth being explicit
   * about: they are bot management, not captchas. There is no puzzle to answer
   * — the wall lifts on a browser fingerprint and a TLS handshake, or it does
   * not lift — so a solving service has nothing to sell for one, and marking
   * them `not-solvable` is what stops somebody spending money on it later.
   */
  const TYPE_TIER = Object.freeze({
    question: TIER.LOCAL,
    recaptcha: TIER.SERVICE,
    hcaptcha: TIER.SERVICE,
    turnstile: TIER.SERVICE,
    image: TIER.SERVICE,
    cloudflare: TIER.NONE,
    akamai: TIER.NONE,
  });

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
    const ak = document.querySelector(
      '#sec-cpt-if, #sec-cpt-form, [href*="/_sec/cp_challenge"]',
    );
    if (ak) return { type: "akamai", where: _describe(ak) };
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
   * Does this text look like a challenge somebody wrote by hand?
   *
   * A shape test, and only that. Whether the question can actually be answered
   * is decided once, in utils/captcha-solvers.js, by the worker — a second
   * parser here would be a second definition of the same thing, free to drift
   * from the first (G-01). This exists so that a page asking an arithmetic
   * question is described as one, instead of being filed under "image captcha"
   * because its answer box happens to be named `captcha_field`.
   */
  const WRITTEN_SHAPE =
    /\b\d{1,4}\s*(?:[+\-−–*×\/÷]|plus|minus|times|divided by)\s*\d{1,4}\b|\b(?:sum|total) of\b|\bhow many (?:letters|characters)\b|\b(?:first|second|third|fourth|fifth|last) word\b|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:plus|minus|times)\s+(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

  /** A typed answer box is an ordinary input, far shorter than MIN_BOX. */
  const MIN_INPUT_HEIGHT = 10;

  /**
   * The text a person reads before typing into this box: its label, and the
   * nearest ancestor carrying wording of its own.
   */
  function _promptFor(input) {
    const parts = [];
    if (input.id) {
      const label = document.querySelector(
        `label[for="${CSS.escape(input.id)}"]`,
      );
      if (label) parts.push(label.textContent || "");
    }
    const wrapper = input.closest("label, p, div, td, li, fieldset, form");
    if (wrapper) parts.push(wrapper.textContent || "");
    parts.push(input.getAttribute("aria-label") || "");
    parts.push(input.getAttribute("placeholder") || "");
    parts.push(input.getAttribute("title") || "");
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  /** A selector the worker can hand straight back to FILL. */
  function _selectorFor(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const name = el.getAttribute("name");
    if (name) return `input[name="${CSS.escape(name)}"]`;
    return "";
  }

  /**
   * A written challenge: a question in the markup and a box to type into.
   *
   * Looked for before the widget list, because `input[name*="captcha"]` sits in
   * there as an image-captcha tell and would otherwise claim the answer box of
   * every arithmetic question on the web.
   */
  function _written() {
    const inputs = document.querySelectorAll(
      'input[type="text"], input[type="number"], input[type="tel"], input:not([type])',
    );
    for (const input of inputs) {
      if (!_visible(input, MIN_INPUT_HEIGHT)) continue;
      const selector = _selectorFor(input);
      if (!selector) continue;
      const prompt = _promptFor(input);
      if (!prompt || prompt.length > 300) continue;
      if (!WRITTEN_SHAPE.test(prompt)) continue;
      return {
        type: "question",
        where: _describe(input),
        question: prompt,
        answerSelector: selector,
      };
    }
    return null;
  }

  /**
   * @returns {{blocking: boolean, present: boolean, type: string|null,
   *   tier: string|null, sitekey: string|null, where: string, reason: string,
   *   question: string, answerSelector: string}}
   */
  function checkCaptcha() {
    const none = {
      blocking: false,
      present: false,
      type: null,
      tier: null,
      sitekey: null,
      where: "",
      reason: "",
      question: "",
      answerSelector: "",
    };

    const wall = _interstitial();
    if (wall) {
      return {
        ...none,
        blocking: true,
        present: true,
        type: wall.type,
        tier: TYPE_TIER[wall.type] ?? TIER.SERVICE,
        where: wall.where,
        reason:
          TYPE_TIER[wall.type] === TIER.NONE
            ? "the site replaced the page with a bot-management interstitial, " +
              "which has no answer to type"
            : "the site replaced the page with a challenge",
      };
    }

    const written = _written();
    if (written) {
      return {
        ...none,
        blocking: true,
        present: true,
        type: written.type,
        tier: TIER.LOCAL,
        where: written.where,
        reason:
          "the page asks a written question before it will accept the form",
        question: written.question,
        answerSelector: written.answerSelector,
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
              ...none,
              blocking: true,
              present: true,
              type,
              tier: TYPE_TIER[type] ?? TIER.SERVICE,
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
        ...none,
        blocking: false,
        present: true,
        type: present.type,
        tier: TYPE_TIER[present.type] ?? TIER.SERVICE,
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
