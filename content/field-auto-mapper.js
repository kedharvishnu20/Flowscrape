// === field-auto-mapper.js ===
/**
 * @module field-auto-mapper
 * @description Automatically maps dataset column names to DOM form fields
 *   using Levenshtein + Jaccard similarity scoring. Immediately renders
 *   preview overlays for all proposed mappings after scoring.
 *
 *   Design decision: Auto-map proposals are shown visually on the page via
 *   overlay zones (cyan for confirmed, yellow badge for low-confidence < 0.70
 *   proposals) BEFORE the user confirms. This lets the user visually verify
 *   mappings on the actual page, not just in the mapping table.
 *
 * @dependencies overlay-engine, color-utils, logger
 *
 * NOT REACHABLE. Nothing imports this module. It exists to support the
 * FORM_FILL flow described in docs/ISSUE_AUDIT.md A-07, which has no entry
 * point.
 */

"use strict";

import { overlayEngine } from "./overlay-engine.js";
import { ZONE_PALETTE, COLOR_WARNING } from "../utils/color-utils.js";
import { logger } from "../utils/logger.js";

const MODULE = "field-auto-mapper";
const LEVENSHTEIN_THRESHOLD = 0.7;
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "with",
  "at",
  "by",
  "your",
  "enter",
  "please",
  "type",
  "input",
  "field",
  "here",
  "required",
  "optional",
  "select",
  "choose",
]);

// ── Similarity algorithms ─────────────────────────────────────────────────────

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Uint32Array(b.length + 1);
  let curr = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function levenshteinNorm(a, b) {
  const al = a.toLowerCase().trim(),
    bl = b.toLowerCase().trim();
  if (al === bl) return 1;
  const max = Math.max(al.length, bl.length);
  return max === 0 ? 1 : 1 - levenshteinDistance(al, bl) / max;
}

function tokenize(s) {
  return new Set(
    String(s || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(/[\s_\-./\\[\]()+,;:]+/)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length > 0 && !STOPWORDS.has(w)),
  );
}

function jaccard(setA, setB) {
  if (!setA.size && !setB.size) return 1;
  const inter = new Set([...setA].filter((t) => setB.has(t)));
  return inter.size / (setA.size + setB.size - inter.size);
}

function tokenCoverage(setA, setB) {
  if (!setA.size) return 0;
  let hit = 0;
  for (const t of setA) if (setB.has(t)) hit++;
  return hit / setA.size;
}

function fieldMatchScore(col, signal) {
  const sa = tokenize(col),
    sb = tokenize(signal);
  return Math.max(
    jaccard(sa, sb),
    levenshteinNorm(col, signal),
    tokenCoverage(sa, sb),
  );
}

// ── Signal extraction ─────────────────────────────────────────────────────────

function _extractSignals(el) {
  const signals = [];
  const pushSignal = (val) => {
    const s = String(val || "").trim();
    if (s) signals.push(s);
  };

  pushSignal(el.name);
  pushSignal(el.id);
  pushSignal(el.placeholder);
  pushSignal(el.getAttribute("aria-label"));
  pushSignal(el.title);

  const autocomplete = el.getAttribute("autocomplete");
  if (autocomplete && autocomplete !== "off") {
    pushSignal(autocomplete.replace(/[-_]+/g, " "));
    pushSignal(autocomplete);
  }

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const ref = document.getElementById(id);
      if (ref) pushSignal(ref.textContent);
    }
  }

  const describedBy = el.getAttribute("aria-describedby");
  if (describedBy) {
    for (const id of describedBy.split(/\s+/)) {
      const ref = document.getElementById(id);
      if (ref) pushSignal(ref.textContent);
    }
  }

  const id = el.id;
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label) pushSignal(label.textContent);
  }

  const parentLabel = el.closest("label");
  if (parentLabel) {
    const text = parentLabel.textContent.replace(el.value ?? "", "").trim();
    if (text) pushSignal(text);
  }

  if (el.labels && el.labels.length) {
    for (const label of el.labels) pushSignal(label.textContent);
  }

  const fieldset = el.closest("fieldset");
  if (fieldset) {
    const legend = fieldset.querySelector("legend");
    if (legend) pushSignal(legend.textContent);
  }

  const dataAttrs = [
    "data-label",
    "data-field",
    "data-name",
    "data-testid",
    "data-test",
    "data-qa",
    "data-qa-id",
    "data-automation",
  ];
  for (const attr of dataAttrs) pushSignal(el.getAttribute(attr));

  let prev = el.previousElementSibling;
  if (prev && ["LABEL", "SPAN", "P", "DIV"].includes(prev.tagName)) {
    const t = prev.textContent.trim();
    if (t && t.length < 60) pushSignal(t);
  }

  return [...new Set(signals)];
}

// ── Field scanning ────────────────────────────────────────────────────────────

function _buildSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.querySelectorAll(tag));
    const idx = siblings.indexOf(el) + 1;
    return `${_buildSelector(parent)} > ${tag}:nth-of-type(${idx})`;
  }
  return tag;
}

export function scanPageFields() {
  const candidates = [];
  for (const el of document.querySelectorAll("input, select, textarea")) {
    const type = el.type?.toLowerCase() ?? "text";
    if (
      ["hidden", "password", "submit", "button", "reset", "image"].includes(
        type,
      )
    )
      continue;
    if (el.disabled || el.readOnly) continue;
    const signals = _extractSignals(el);
    if (!signals.length) continue;
    candidates.push({ el, selector: _buildSelector(el), signals, type });
  }
  return candidates;
}

// ── Auto-mapper ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} MappingProposal
 * @property {string} column
 * @property {string} selector
 * @property {string} inputType
 * @property {number} confidence
 * @property {string} matchedSignal
 * @property {string} zoneId       Overlay zone ID registered for this proposal
 */

/**
 * Auto-map dataset column names to DOM fields, rendering preview overlays.
 * @param {string[]} columns - Dataset column names
 * @param {number}   [stepIndex=0]
 * @returns {MappingProposal[]}
 */
export function autoMapFields(columns, stepIndex = 0) {
  const pageFields = scanPageFields();
  const proposals = [];
  const usedSelectors = new Set();

  // Clear any existing auto-map overlays for this step
  overlayEngine.clearStep(stepIndex);

  for (const [colIdx, column] of columns.entries()) {
    let bestScore = 0;
    let bestField = null;
    let bestSignal = "";

    for (const field of pageFields) {
      if (usedSelectors.has(field.selector)) continue;
      for (const signal of field.signals) {
        const score = fieldMatchScore(column, signal);
        if (score > bestScore) {
          bestScore = score;
          bestField = field;
          bestSignal = signal;
        }
      }
    }

    if (bestScore >= LEVENSHTEIN_THRESHOLD && bestField) {
      usedSelectors.add(bestField.selector);

      // High confidence: use zone palette color; low confidence: yellow warning
      const color =
        bestScore >= 0.9
          ? ZONE_PALETTE[colIdx % ZONE_PALETTE.length]
          : COLOR_WARNING;

      const label =
        bestScore >= 0.9
          ? column
          : `⚠️ ${column} (${Math.round(bestScore * 100)}%)`;

      const zoneId = overlayEngine.register({
        selector: bestField.selector,
        label,
        stepIndex,
        fieldIndex: colIdx,
        mode: "preview",
        color,
      });

      proposals.push({
        column,
        selector: bestField.selector,
        inputType: bestField.type,
        confidence: Math.round(bestScore * 100) / 100,
        matchedSignal: bestSignal,
        zoneId,
      });

      logger.debug(MODULE, "proposal", {
        column,
        selector: bestField.selector,
        confidence: bestScore,
      });
    } else {
      logger.debug(MODULE, "no-match", { column, bestScore });
    }
  }

  logger.info(MODULE, "auto-map-complete", {
    columns: columns.length,
    matched: proposals.length,
    unmatched: columns.length - proposals.length,
  });

  return proposals;
}

// ── highlight / clearHighlight (step interface contract) ──────────────────────

export function highlight(config, stepIndex) {
  const columns = (config.fieldMappings ?? []).map((m) => m.column);
  return autoMapFields(columns, stepIndex);
}

export function clearHighlight(stepIndex) {
  overlayEngine.clearStep(stepIndex);
}

// === END field-auto-mapper.js ===
