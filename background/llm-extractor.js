// === llm-extractor.js ===
/**
 * @module llm-extractor
 * @description Layer 3 LLM-based product extraction using Gemini Flash.
 *
 *   Called ONLY when Layers 1 & 2 (smart-extractor.js) return an
 *   overall confidence below the configured threshold (default: 70).
 *
 *   Flow:
 *     1. Caller sends a simplified DOM string (12000 char max).
 *     2. We call the Gemini Flash API (gemini-2.0-flash model).
 *     3. The model returns a strictly typed JSON product object.
 *     4. We validate and normalize the response.
 *     5. We return the same shape as smart-extractor's result so the
 *        service-worker can merge/use it transparently.
 *
 *   Design decisions:
 *     - Uses Gemini Flash (not Pro) for speed and cost efficiency.
 *       Flash handles structured product extraction at the same
 *       quality as Pro for this type of task.
 *     - Temperature = 0 for maximum determinism — we want facts, not creativity.
 *     - System prompt is hardcoded and never user-editable to prevent injection.
 *     - The prompt instructs the model to return ONLY valid JSON.
 *       We still validate the response defensively.
 *     - Max output tokens = 1024 — a full product object is never larger.
 *     - Timeout = 20 seconds. On timeout, returns null so the pipeline
 *       continues with whatever Layers 1 & 2 found.
 *
 * @dependencies background/api-key-manager.js (getApiKey)
 */

import { getApiKey } from "./api-key-manager.js";
import { logger } from "../utils/logger.js";

const MODULE = "llm-extractor";

// ── Constants ─────────────────────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 20_000;

/**
 * The system-level instruction sent to the model.
 * Never modified at runtime — prevents prompt injection.
 */
const SYSTEM_INSTRUCTION = `You are a precise data extraction engine for e-commerce product pages.
Your task is to extract product information from the provided page text.
Rules:
- Return ONLY a single valid JSON object. No markdown, no explanation, no code fences.
- Use null (not empty string) for missing fields.
- prices must include the currency symbol if visible (e.g. "₹1,299", "$49.99").
- images must be absolute URLs only.
- confidence values must be integers 0-100.
- Never hallucinate data. If you are not certain, use null.`;

/**
 * The extraction prompt template.
 * {dom} is replaced with the simplified DOM text.
 */
const PROMPT_TEMPLATE = `Extract product data from this e-commerce page content:

---PAGE CONTENT START---
{dom}
---PAGE CONTENT END---

Return a JSON object with exactly this structure:
{
  "name": string or null,
  "price": string or null,
  "originalPrice": string or null,
  "currency": string or null,
  "brand": string or null,
  "description": string or null,
  "sku": string or null,
  "availability": string or null,
  "rating": string or null,
  "reviewCount": string or null,
  "images": [],
  "confidence": {
    "name": integer,
    "price": integer,
    "originalPrice": integer,
    "currency": integer,
    "brand": integer,
    "description": integer,
    "sku": integer,
    "availability": integer,
    "rating": integer,
    "reviewCount": integer,
    "images": integer
  }
}`;

// ── Gemini API call ───────────────────────────────────────────────────────────

/**
 * Call Gemini Flash with a structured extraction prompt.
 *
 * @param {string} simplifiedDom - Stripped page text (max 12000 chars)
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<object|null>} Parsed product object or null on failure
 */
export async function llmExtract(simplifiedDom, apiKey) {
  if (!simplifiedDom || !apiKey) return null;

  const prompt = PROMPT_TEMPLATE.replace(
    "{dom}",
    simplifiedDom.slice(0, 12000),
  );
  const requestBody = {
    system_instruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0, // Maximum determinism
      maxOutputTokens: MAX_TOKENS,
      responseMimeType: "application/json", // Force JSON-only output
    },
    safetySettings: [
      // Allow commercial content — product pages can mention restricted items
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_ONLY_HIGH",
      },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(
      `${GEMINI_API_URL}?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      },
    );

    if (!resp.ok) {
      const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
      logger.warn(MODULE, "gemini-api-error", {
        status: resp.status,
        body: errText.slice(0, 200),
      });
      return null;
    }

    const json = await resp.json();
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      logger.warn(MODULE, "gemini-empty-response", {});
      return null;
    }

    return _parseAndValidate(raw);
  } catch (err) {
    if (err?.name === "AbortError") {
      logger.warn(MODULE, "gemini-timeout", { timeoutMs: TIMEOUT_MS });
    } else {
      logger.error(MODULE, "gemini-fetch-error", { error: err.message });
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Response parsing & validation ─────────────────────────────────────────────

/**
 * Parse the model response string into a validated product object.
 *
 * The model is instructed to return clean JSON, but we also handle
 * the case where it wraps the response in markdown code fences.
 *
 * @param {string} raw - Raw text from Gemini response
 * @returns {object|null}
 */
function _parseAndValidate(raw) {
  // Strip any accidental markdown code fences
  let cleaned = raw.trim();
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.warn(MODULE, "gemini-invalid-json", {
      raw: raw.slice(0, 300),
      error: err.message,
    });
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logger.warn(MODULE, "gemini-bad-shape", {});
    return null;
  }

  // Normalize and sanitize each field
  const result = {
    name: _str(parsed.name),
    price: _str(parsed.price),
    originalPrice: _str(parsed.originalPrice),
    currency: _str(parsed.currency),
    brand: _str(parsed.brand),
    description: _str(parsed.description),
    sku: _str(parsed.sku),
    availability: _str(parsed.availability),
    rating: _str(parsed.rating),
    reviewCount: _str(parsed.reviewCount),
    images: _arrayOfStrings(parsed.images),
  };

  // Validate per-field confidence scores from model
  const modelConf = parsed.confidence;
  const perField = {};
  const fieldList = [
    "name",
    "price",
    "originalPrice",
    "currency",
    "brand",
    "description",
    "sku",
    "availability",
    "rating",
    "reviewCount",
    "images",
  ];

  for (const field of fieldList) {
    const raw = modelConf?.[field];
    const n = parseInt(raw, 10);
    // If model gave a valid 0–100 score, use it; otherwise infer from presence
    if (Number.isFinite(n) && n >= 0 && n <= 100) {
      perField[field] = n;
    } else {
      // Fallback: 80 if field has a value, 0 if null
      const v = result[field];
      perField[field] =
        v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)
          ? 80
          : 0;
    }
  }

  // Compute overall confidence
  const weights = {
    name: 30,
    price: 25,
    images: 15,
    brand: 10,
    description: 10,
    sku: 5,
    availability: 5,
  };
  let totalWeight = 0,
    weightedSum = 0;
  for (const [field, weight] of Object.entries(weights)) {
    totalWeight += weight;
    weightedSum += (perField[field] || 0) * weight;
  }
  const overallConfidence = Math.round(weightedSum / totalWeight);

  // Build warnings for low-confidence fields
  const warnings = [];
  for (const [field, conf] of Object.entries(perField)) {
    if (result[field] != null && conf < 50) {
      warnings.push(
        `⚠️ LLM field "${field}" has low confidence (${conf}/100).`,
      );
    }
  }

  logger.info(MODULE, "llm-extraction-done", {
    overallConfidence,
    fieldsFound: fieldList.filter((f) => result[f] != null && result[f] !== "")
      .length,
  });

  return {
    result,
    perField,
    overallConfidence,
    method: "llm-gemini",
    warnings,
    needsLlm: false, // by definition — LLM already ran
  };
}

// ── String helpers ────────────────────────────────────────────────────────────

/** Coerce a value to a clean string or null */
function _str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s === "null" || s === "undefined" ? null : s;
}

/** Coerce a value to an array of strings, filtering null/empty */
function _arrayOfStrings(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((item) => _str(item))
    .filter((s) => s !== null && s.startsWith("http")); // must be absolute URLs
}

// ── Convenience wrapper ───────────────────────────────────────────────────────

/**
 * High-level function used by service-worker.js.
 * Loads the Gemini key automatically, calls llmExtract, returns result.
 *
 * @param {string} simplifiedDom
 * @returns {Promise<object|null>}
 */
export async function runLlmLayer(simplifiedDom) {
  const apiKey = await getApiKey("gemini").catch(() => null);
  if (!apiKey) {
    logger.info(MODULE, "no-gemini-key", {
      note: "Skipping LLM layer — no Gemini key stored.",
    });
    return null;
  }
  return llmExtract(simplifiedDom, apiKey);
}

// === END llm-extractor.js ===
