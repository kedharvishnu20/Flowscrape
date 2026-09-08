// === llm-extractor.js ===
/**
 * @module llm-extractor
 * @description Layer 3 of AUTO_EXTRACT: ask a model when the free layers could
 *   not answer.
 *
 *   Called ONLY when layers 1 and 2 (`content/smart-extractor.js`) come back
 *   below the configured confidence threshold. The free layers answer most
 *   pages; this is the escape hatch, and it is never a requirement.
 *
 *   **This used to be a second HTTP client.** It spoke to Gemini and only
 *   Gemini, with its own key lookup, its own timeout, its own error handling
 *   and its own copy of "what a bad response looks like" — while
 *   `utils/ai-gateway.js` already spoke to Anthropic, OpenAI, Gemini and any
 *   OpenAI-compatible local server, and was wired to the settings panel with a
 *   provider picker and a test button. So the one feature that most needed a
 *   free local model was the one feature that could not use one, and a fix to
 *   either client left the other wrong. It now goes through the gateway like
 *   everything else, which means:
 *
 *   - Point it at Ollama or LM Studio and the layer costs nothing and sends
 *     nothing off the machine.
 *   - JSON comes back as JSON, using each provider's own native mechanism
 *     rather than a regex hunting for a code fence.
 *
 *   Design decisions kept from before: temperature is not set (the gateway
 *   does not expose it and the prompt does the work), the system instruction is
 *   hardcoded and never user-editable so page content cannot rewrite it, and a
 *   response that does not parse returns null so the run continues with
 *   whatever layers 1 and 2 found.
 *
 * @dependencies background/gateway-config.js, utils/ai-gateway.js
 */

import { askText } from "../utils/ai-gateway.js";
import { readGatewayConfig, describeGateway } from "./gateway-config.js";
import { mapModelKeys } from "../utils/extraction-schema.js";
import { logger } from "../utils/logger.js";
import { cacheKey, readCache, writeCache } from "../checkpoint/ai-cache.js";

const MODULE = "llm-extractor";

// ── Constants ─────────────────────────────────────────────────────────────────

/** A product object with a confidence per field fits well inside this. */
const MAX_TOKENS = 2048;
const TIMEOUT_MS = 20_000;

/** How much page text the model is given. Beyond this the tail is dropped. */
const MAX_DOM_CHARS = 12_000;

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
 * Ask the configured model for the page's product data.
 *
 * @param {string} simplifiedDom - stripped page text
 * @param {import("../utils/ai-gateway.js").GatewayConfig} config
 * @returns {Promise<object|null>} the parsed product object, or null when the
 *   model could not be reached or did not answer usefully. Null rather than a
 *   throw: this layer is a bonus, and a run must survive it failing.
 */
/**
 * The prompt for a schema the user named themselves.
 *
 * Built rather than templated: the product prompt spells out eleven keys and a
 * confidence block, and a page of court listings needs none of them. The
 * instruction to use null and never guess carries over unchanged — it is the
 * part that keeps an empty column empty instead of plausible.
 *
 * @param {string[]} fields
 * @param {string} dom
 */
function _schemaPrompt(fields, dom, wantSelectors = false) {
  const shape = fields
    .map((f) => `  ${JSON.stringify(f)}: string or null`)
    .join(",\n");
  const conf = fields
    .map((f) => `    ${JSON.stringify(f)}: integer`)
    .join(",\n");
  const sel = fields
    .map((f) => `    ${JSON.stringify(f)}: string or null`)
    .join(",\n");

  // Asking for "a selector" gets nth-child chains that verify today and break
  // when the site adds a banner. Asking for a stable one gets classes and
  // attributes more often — and the ones that still come back positional are
  // kept and labelled rather than trusted.
  const selectorRules = wantSelectors
    ? `
- selectors: a CSS selector that matches exactly ONE element holding that value.
- Prefer a class, id or data attribute over a position. Do not use :nth-child
  or a long chain of bare tag names — those break when the page changes.
- Use null for a selector you are not confident about. A wrong selector is
  worse than none.`
    : "";

  const selectorBlock = wantSelectors
    ? `,
  "selectors": {
${sel}
  }`
    : "";

  return `You are a precise data extraction engine for web pages.
Extract exactly these fields from the page content below.
Rules:
- Return ONLY a single valid JSON object. No markdown, no explanation, no code fences.
- Use null (not an empty string) for a field the page does not state.
- Copy values as the page writes them; do not reformat, convert or summarise.
- Never infer or invent. If you are not certain, use null.
- confidence values are integers 0-100.${selectorRules}

---PAGE CONTENT START---
${dom}
---PAGE CONTENT END---

Return a JSON object with exactly this structure:
{
${shape},
  "confidence": {
${conf}
  }${selectorBlock}
}`;
}

/**
 * Ask the configured model for the page's data.
 *
 * @param {string} simplifiedDom - stripped page text
 * @param {{fields: string[], isDefault: boolean}} schema
 * @param {import("../utils/ai-gateway.js").GatewayConfig} config
 */
export async function llmExtract(simplifiedDom, config, schema = null) {
  if (!simplifiedDom || !config) return null;

  const dom = simplifiedDom.slice(0, MAX_DOM_CHARS);
  const prompt =
    schema && !schema.isDefault
      ? _schemaPrompt(schema.fields, dom, schema.wantSelectors === true)
      : `${SYSTEM_INSTRUCTION}\n\n${PROMPT_TEMPLATE.replace("{dom}", dom)}`;

  const said = await askText(
    { prompt },
    { ...config, json: true, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS },
  );

  if (!said.ok) {
    // The gateway's messages are already written to be shown to a person, so
    // they are passed along rather than replaced with "the LLM layer failed".
    logger.warn(MODULE, "gateway-declined", {
      code: said.code,
      error: said.error,
    });
    return { error: said.error, code: said.code };
  }

  const parsed =
    schema && !schema.isDefault
      ? _parseSchemaAnswer(said.text, schema.fields)
      : _parseAndValidate(said.text);
  if (parsed) parsed.model = said.model ?? config.model ?? null;
  return parsed;
}

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
    // Not "llm-gemini" any more: whichever of the four providers the user
    // configured answered this, and a label naming one vendor was wrong for
    // three of them — including the local one that costs nothing.
    method: "llm",
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
 * Run layer 3 with whatever model the user configured, if any.
 *
 * Also where the cache sits, because this is the point at which the provider
 * and model are known — and both are part of the question. Putting it in the
 * executor instead would mean reading the gateway settings twice and getting
 * the key wrong the day someone switches provider.
 *
 * @param {string} simplifiedDom
 * @param {{fields: string[], isDefault: boolean}|null} schema
 * @param {{url?: string, cache?: boolean}} [opts]
 * @returns {Promise<object|null>} null when no model is configured — which is
 *   the default, and not a failure.
 */
export async function runLlmLayer(simplifiedDom, schema = null, opts = {}) {
  const config = await readGatewayConfig();
  if (!config) {
    logger.info(MODULE, "no-model-configured", {
      note: "Skipping the AI layer — no provider set up in Settings.",
    });
    return null;
  }

  const useCache = opts.cache !== false;
  const dom = String(simplifiedDom ?? "").slice(0, MAX_DOM_CHARS);
  const fields = schema && !schema.isDefault ? schema.fields : [];

  let key = null;
  if (useCache && dom) {
    key = await cacheKey({
      url: opts.url ?? "",
      dom,
      fields,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    });
    const hit = await readCache(key);
    if (hit?.value) {
      logger.info(MODULE, "cache-hit", { model: hit.model });
      // Marked, not disguised: a run that says "the model answered" when the
      // answer came out of a store is telling the user something untrue about
      // where their data came from.
      return { ...hit.value, cached: true };
    }
  }

  logger.info(MODULE, "asking", { model: describeGateway(config) });
  const out = await llmExtract(simplifiedDom, config, schema);

  // Only a real answer. A rate limit, a local server not started yet, a reply
  // that would not parse — all transient, and all would otherwise become this
  // page's permanent answer.
  if (!out?.error && out?.result && key) {
    await writeCache(key, out, { url: opts.url ?? "", model: out.model ?? "" });
  }
  return out;
}

/**
 * Read a model's answer for a schema the user named.
 *
 * The key mapping is the same one the structured-data path uses: a model asked
 * for "published date" may answer with "publishedDate", and insisting on the
 * exact spelling would throw away a correct answer.
 *
 * @param {string} raw
 * @param {string[]} fields
 */
function _parseSchemaAnswer(raw, fields) {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    logger.warn(MODULE, "invalid-json", { sample: cleaned.slice(0, 200) });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const values = mapModelKeys(parsed, fields);
  const confidence = parsed.confidence ?? {};
  const result = {};
  const perField = {};
  for (const field of fields) {
    const v = values[field];
    result[field] = v === undefined || v === "" ? null : v;
    const c = Number(
      confidence[field] ?? mapModelKeys(confidence, [field])[field],
    );
    // A field the model answered but did not score is taken at a middling 60
    // rather than 0: a zero would lose to an empty free layer, which is the
    // opposite of what the answer is worth.
    perField[field] = Number.isFinite(c)
      ? Math.max(0, Math.min(100, Math.round(c)))
      : result[field] != null
        ? 60
        : 0;
  }

  const answered = fields.filter((f) => result[f] != null).length;
  const overallConfidence = fields.length
    ? Math.round(
        fields.reduce((sum, f) => sum + perField[f], 0) / fields.length,
      )
    : 0;

  logger.info(MODULE, "schema-extraction-done", {
    answered,
    of: fields.length,
    overallConfidence,
  });

  return {
    result,
    perField,
    fields,
    // Carried through unjudged. Whether a selector is worth keeping is decided
    // by running it in the page, which cannot happen here.
    selectors: mapModelKeys(parsed.selectors ?? {}, fields),
    overallConfidence,
    method: "llm",
    warnings: [],
    needsLlm: false,
  };
}

// === END llm-extractor.js ===
