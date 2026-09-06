// === ai-gateway.js ===
/**
 * @module ai-gateway
 * @description Bring-your-own-key gateway (K-17): one interface for asking a
 *   vision- or text-capable model a question, with the provider difference
 *   confined to this file.
 *
 *   This is the escape hatch for whatever the free layers (smart-extractor,
 *   structured-data, the free captcha path another agent owns) cannot do —
 *   never a requirement. `askVision`/`askText` take the provider, key, model
 *   and (for the local/compatible provider) base URL as plain arguments; this
 *   module never reads chrome.storage itself. That keeps the dependency
 *   direction the rest of the codebase uses (background/utils, never
 *   utils/background — see step-types.js) and makes every path here testable
 *   with a stubbed fetch and no chrome.* shims at all. The caller — the
 *   service-worker message handler — is the one place that knows the key
 *   lives in api-key-manager.js.
 *
 *   Local models (Ollama, LM Studio, llama.cpp — anything speaking the
 *   OpenAI chat-completions shape on localhost) are the "openai-compatible"
 *   provider: free, and nothing leaves the machine. It gets the same
 *   first-class treatment as the paid providers, not a bolted-on extra —
 *   the whole point of this module is that the paid path is optional.
 *
 *   Every failure — no key, an unreachable endpoint, a refusal, a rate
 *   limit, a malformed response — comes back as {ok:false, error, code}.
 *   Nothing here throws a string, and nothing here throws at all for an
 *   expected failure; a caller can put `.error` straight in front of a user
 *   the way validateApiKey()'s callers already do (see key-validation.test.mjs).
 *
 * @dependencies none — takes fetch as ambient (stubbed by tests), no chrome.*
 */

"use strict";

// ── Provider registry ───────────────────────────────────────────────────────

/**
 * @typedef {Object} GatewayProviderInfo
 * @property {string} label
 * @property {boolean} needsApiKey   false only for openai-compatible, where a
 *   local server commonly has no auth at all
 * @property {boolean} needsBaseUrl  true only for openai-compatible
 * @property {string}  [defaultModel]
 * @property {string}  keyPlaceholder
 * @property {string}  modelPlaceholder
 */

/** @type {Record<string, GatewayProviderInfo>} */
export const GATEWAY_PROVIDERS = Object.freeze({
  anthropic: {
    label: "Anthropic",
    needsApiKey: true,
    needsBaseUrl: false,
    defaultModel: "claude-opus-5",
    keyPlaceholder: "sk-ant-...",
    modelPlaceholder: "claude-opus-5",
  },
  openai: {
    label: "OpenAI",
    needsApiKey: true,
    needsBaseUrl: false,
    defaultModel: "gpt-4o",
    keyPlaceholder: "sk-...",
    modelPlaceholder: "gpt-4o",
  },
  gemini: {
    label: "Google Gemini",
    needsApiKey: true,
    needsBaseUrl: false,
    defaultModel: "gemini-2.0-flash",
    keyPlaceholder: "AIzaSy...",
    modelPlaceholder: "gemini-2.0-flash",
  },
  "openai-compatible": {
    label: "OpenAI-compatible (local — Ollama, LM Studio, llama.cpp, ...)",
    needsApiKey: false,
    needsBaseUrl: true,
    defaultModel: undefined,
    keyPlaceholder: "usually blank for a local server",
    modelPlaceholder: "llama3.2-vision, qwen2.5vl, ...",
  },
});

const DEFAULT_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 10_000; // testConnection: a probe, not a real ask
const MAX_RESPONSE_CHARS = 1_000_000; // ~1MB of response text — a broken local
// endpoint streaming garbage (or an accidental proxy loop) must not be read
// into memory in full before this module notices something is wrong.

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const GEMINI_URL_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * @typedef {Object} GatewayConfig
 * @property {keyof GATEWAY_PROVIDERS} provider
 * @property {?string} [apiKey]
 * @property {?string} [model]
 * @property {?string} [baseUrl]  required and only used for openai-compatible
 * @property {number}  [timeoutMs]
 */

/**
 * @typedef {Object} GatewayResult
 * @property {boolean} ok
 * @property {string}  [text]     the model's answer, present when ok
 * @property {string}  [model]    the model id that actually answered
 * @property {string}  [error]    human-readable reason, present when !ok —
 *   safe to show a user as-is
 * @property {string}  [code]     machine-readable: 'bad-config' | 'no-key' |
 *   'network' | 'timeout' | 'http-error' | 'rate-limited' | 'refused' |
 *   'bad-response' | 'response-too-large'
 * @property {number}  [status]   HTTP status, when one was received
 */

/**
 * Ask a vision-capable model to look at one image and answer a prompt.
 *
 * @param {{ prompt: string, image: { data: string, mediaType: string } }} input
 *   `image.data` is base64 with no `data:` prefix.
 * @param {GatewayConfig} config
 * @returns {Promise<GatewayResult>}
 */
export async function askVision({ prompt, image }, config) {
  const bad = _checkConfig(config);
  if (bad) return bad;
  if (!prompt || typeof prompt !== "string") {
    return _fail("bad-config", "A prompt is required.");
  }
  if (!image?.data || !image?.mediaType) {
    return _fail(
      "bad-config",
      "An image (base64 data + media type) is required for askVision.",
    );
  }
  return _dispatch(config, (ctx) => _requestFor(ctx, { prompt, image }));
}

/**
 * Ask a text-capable model a question with no image.
 *
 * @param {{ prompt: string }} input
 * @param {GatewayConfig} config
 * @returns {Promise<GatewayResult>}
 */
export async function askText({ prompt }, config) {
  const bad = _checkConfig(config);
  if (bad) return bad;
  if (!prompt || typeof prompt !== "string") {
    return _fail("bad-config", "A prompt is required.");
  }
  return _dispatch(config, (ctx) => _requestFor(ctx, { prompt, image: null }));
}

/**
 * Confirm a configured provider/key/model/baseUrl actually works, end to end
 * — the settings UI's "test this" button. Runs the exact same request path
 * as askText, so "connection tested OK" and "the pipeline can use this"
 * mean the same thing; a lighter models-list probe would not.
 *
 * @param {GatewayConfig} config
 * @returns {Promise<GatewayResult>}
 */
export async function testConnection(config) {
  return askText(
    { prompt: 'Reply with exactly one word: "OK".' },
    { ...config, timeoutMs: config?.timeoutMs ?? TEST_TIMEOUT_MS },
  );
}

// ── Config validation ───────────────────────────────────────────────────────

function _checkConfig(config) {
  const provider = config?.provider;
  const info = GATEWAY_PROVIDERS[provider];
  if (!info) {
    return _fail(
      "bad-config",
      `Unknown provider "${provider}". Choose one of: ${Object.keys(GATEWAY_PROVIDERS).join(", ")}.`,
    );
  }
  if (info.needsApiKey && !config.apiKey) {
    return _fail(
      "no-key",
      `${info.label} needs an API key. Add one in Settings, or switch to the local OpenAI-compatible provider — it costs nothing.`,
    );
  }
  if (info.needsBaseUrl && !config.baseUrl) {
    return _fail(
      "bad-config",
      "A base URL is required for the OpenAI-compatible provider — e.g. http://localhost:11434/v1 for Ollama.",
    );
  }
  if (info.needsBaseUrl) {
    try {
      new URL(config.baseUrl);
    } catch {
      return _fail("bad-config", "The base URL is not a valid URL.");
    }
  }
  return null;
}

function _fail(code, error, status) {
  const out = { ok: false, code, error };
  if (status !== undefined) out.status = status;
  return out;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

async function _dispatch(config, run) {
  const info = GATEWAY_PROVIDERS[config.provider];
  const model = config.model || info.defaultModel;
  if (!model) {
    return _fail(
      "bad-config",
      `A model id is required for ${info.label} — e.g. "${info.modelPlaceholder}".`,
    );
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run({
      provider: config.provider,
      apiKey: config.apiKey ?? null,
      model,
      baseUrl: config.baseUrl ?? null,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      return _fail(
        "timeout",
        `${info.label} did not respond within ${Math.round(timeoutMs / 1000)}s. If this is a local server, confirm it is running and the base URL is correct.`,
      );
    }
    // fetch() rejects with a plain TypeError for DNS failure, connection
    // refused, and similar — the exact case a local model that is not
    // running produces. Never surface err.message verbatim here: on some
    // runtimes it can echo the request URL, which for Gemini carries the key.
    return _fail(
      "network",
      `Could not reach ${info.label}. ${config.provider === "openai-compatible" ? "Is the local server running at the configured base URL?" : "Check your network connection."}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function _requestFor(ctx, { prompt, image }) {
  switch (ctx.provider) {
    case "anthropic":
      return _askAnthropic(ctx, prompt, image);
    case "openai":
      return _askOpenAiChat(ctx, OPENAI_URL, prompt, image);
    case "gemini":
      return _askGemini(ctx, prompt, image);
    case "openai-compatible":
      return _askOpenAiChat(
        ctx,
        `${ctx.baseUrl.replace(/\/+$/, "")}/chat/completions`,
        prompt,
        image,
      );
    default:
      // _checkConfig() already rejects an unknown provider before this can
      // run; this only guards against a future provider added to the
      // registry without a case here.
      return _fail("bad-config", `No request builder for "${ctx.provider}".`);
  }
}

// ── Anthropic ────────────────────────────────────────────────────────────────

async function _askAnthropic(ctx, prompt, image) {
  const content = image
    ? [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.data,
          },
        },
        { type: "text", text: prompt },
      ]
    : prompt;

  const body = {
    model: ctx.model,
    max_tokens: 1024,
    messages: [{ role: "user", content }],
  };

  const res = await _boundedFetch(
    ANTHROPIC_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ctx.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    },
    "Anthropic",
  );
  if (!res.ok) return res;

  const json = res.json;
  if (json.stop_reason === "refusal") {
    return _fail(
      "refused",
      `Anthropic declined to answer${json.stop_details?.explanation ? `: ${json.stop_details.explanation}` : "."}`,
    );
  }
  const textBlock = Array.isArray(json.content)
    ? json.content.find((b) => b?.type === "text")
    : null;
  if (!textBlock?.text) {
    return _fail("bad-response", "Anthropic returned no text content.");
  }
  return { ok: true, text: textBlock.text, model: json.model || ctx.model };
}

// ── OpenAI / OpenAI-compatible ────────────────────────────────────────────────

async function _askOpenAiChat(ctx, url, prompt, image) {
  const content = image
    ? [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: { url: `data:${image.mediaType};base64,${image.data}` },
        },
      ]
    : prompt;

  const body = {
    model: ctx.model,
    max_tokens: 1024,
    messages: [{ role: "user", content }],
  };

  const headers = { "content-type": "application/json" };
  if (ctx.apiKey) headers["authorization"] = `Bearer ${ctx.apiKey}`;

  const label = ctx.provider === "openai" ? "OpenAI" : "The local server";

  const res = await _boundedFetch(
    url,
    { method: "POST", headers, body: JSON.stringify(body), signal: ctx.signal },
    label,
  );
  if (!res.ok) return res;

  const json = res.json;
  const choice = json.choices?.[0];
  const finishReason = choice?.finish_reason;
  if (finishReason === "content_filter") {
    return _fail("refused", `${label} declined to answer (content filter).`);
  }
  // A message's `content` is normally a string; some OpenAI-compatible
  // servers echo the request's content-block array back instead. Handle both
  // rather than reporting "no text" for a response that has one.
  const raw = choice?.message?.content;
  const text =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw.find((b) => b?.type === "text")?.text
        : null;
  if (!text) {
    return _fail("bad-response", `${label} returned no text content.`);
  }
  return { ok: true, text, model: json.model || ctx.model };
}

// ── Gemini ───────────────────────────────────────────────────────────────────

async function _askGemini(ctx, prompt, image) {
  const parts = image
    ? [
        { text: prompt },
        { inline_data: { mime_type: image.mediaType, data: image.data } },
      ]
    : [{ text: prompt }];

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { maxOutputTokens: 1024 },
  };

  // The key travels as a query parameter — Gemini has no header auth for this
  // endpoint. It must never reach a log: _boundedFetch and every error path
  // below only ever mention "Google Gemini", never the URL it built.
  const url = `${GEMINI_URL_BASE}/${encodeURIComponent(ctx.model)}:generateContent?key=${encodeURIComponent(ctx.apiKey)}`;

  const res = await _boundedFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctx.signal,
    },
    "Google Gemini",
  );
  if (!res.ok) return res;

  const json = res.json;
  const blockReason = json.promptFeedback?.blockReason;
  if (blockReason) {
    return _fail(
      "refused",
      `Google Gemini declined to answer: ${blockReason}.`,
    );
  }
  const candidate = json.candidates?.[0];
  if (candidate?.finishReason === "SAFETY") {
    return _fail("refused", "Google Gemini declined to answer (safety).");
  }
  const text = candidate?.content?.parts
    ?.map((p) => p?.text)
    .filter(Boolean)
    .join("");
  if (!text) {
    return _fail("bad-response", "Google Gemini returned no text content.");
  }
  return { ok: true, text, model: ctx.model };
}

// ── Shared HTTP plumbing ────────────────────────────────────────────────────

/**
 * Fetch, cap how much response text is read, and fully classify the common
 * failure shapes (rate limit, auth, malformed body, a 2xx response that is
 * itself an error envelope) so each provider function only has to handle its
 * own success JSON shape.
 *
 * @param {string} label - provider name for a human-readable error, e.g. "OpenAI"
 * @returns {Promise<{ok:true,status:number,json:object}|GatewayResult>}
 */
async function _boundedFetch(url, opts, label) {
  const resp = await fetch(url, opts); // network/abort errors bubble to _dispatch's catch

  const text = await resp.text();
  if (text.length > MAX_RESPONSE_CHARS) {
    return _fail(
      "response-too-large",
      `The response was larger than expected (>${Math.round(MAX_RESPONSE_CHARS / 1000)}KB) and was not processed. This usually means the base URL points at something other than the model API.`,
      resp.status,
    );
  }

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    return _fail(
      "bad-response",
      `${label} did not return valid JSON (HTTP ${resp.status}).`,
      resp.status,
    );
  }

  // json.error shows up both as a non-2xx body (OpenAI, Gemini) and, for
  // Anthropic, as a 2xx-adjacent {type:"error", error:{...}} envelope — check
  // it before resp.ok so neither shape slips through as a success.
  const providerMessage =
    typeof json.error === "string" ? json.error : json.error?.message;
  if (json.error || json.type === "error" || !resp.ok) {
    return _providerError(label, resp.status, providerMessage);
  }

  return { ok: true, status: resp.status, json };
}

/**
 * Turn a non-2xx or error-shaped response into a GatewayResult, using the
 * provider's own error message when present.
 */
function _providerError(label, status, providerMessage) {
  if (status === 401 || status === 403) {
    return _fail(
      "no-key",
      `${label} rejected the API key${providerMessage ? `: ${providerMessage}` : "."}`,
      status,
    );
  }
  if (status === 429) {
    return _fail("rate-limited", "Rate limited — try again shortly.", 429);
  }
  return _fail(
    "http-error",
    `${label} returned an error${providerMessage ? `: ${providerMessage}` : ` (HTTP ${status}).`}`,
    status,
  );
}

// Re-exported only for tests that want to exercise the HTTP layer in
// isolation rather than through askVision/askText.
export const _internal = { _boundedFetch, _providerError };

// === END ai-gateway.js ===
