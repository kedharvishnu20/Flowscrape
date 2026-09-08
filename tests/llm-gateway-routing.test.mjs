// AUTO_EXTRACT's AI layer, routed through the gateway.
//
// It used to be a second HTTP client. It spoke to Gemini and only Gemini, with
// its own key lookup, its own timeout, its own idea of what a bad response
// looks like — while utils/ai-gateway.js already spoke to Anthropic, OpenAI,
// Gemini and any OpenAI-compatible local server, and was wired to the settings
// panel with a provider picker and a test button.
//
// So the one feature that most needed a free local model was the only feature
// that could not use one. That is the thing these tests pin down: point the
// extraction layer at a local server and it works, with no key at all.
//
// The other half is JSON. Asking a model for JSON and then hunting for a code
// fence in prose is how a parser ends up with half an explanation in it. Each
// provider has its own native mechanism and the gateway is the only place that
// should know which — Gemini a response MIME type, OpenAI a response format,
// Anthropic a prefilled assistant turn it must continue from.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { askText, GATEWAY_PROVIDERS } from "../utils/ai-gateway.js";

/** Capture the request a provider would send, without a network. */
function captureRequest(reply) {
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push({ url: String(url), body: JSON.parse(opts.body), opts });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(reply);
      },
    };
  };
  return sent;
}

const OPENAI_REPLY = {
  choices: [{ message: { content: '{"name":"Widget"}' } }],
};
const ANTHROPIC_REPLY = {
  content: [{ type: "text", text: '"name":"Widget"}' }],
};
const GEMINI_REPLY = {
  candidates: [{ content: { parts: [{ text: '{"name":"Widget"}' }] } }],
};

// ── The gateway's JSON mode ──────────────────────────────────────────────────

test("Gemini is asked for JSON with its own response MIME type", async () => {
  const sent = captureRequest(GEMINI_REPLY);
  await askText(
    { prompt: "return JSON" },
    { provider: "gemini", apiKey: "k", model: "gemini-2.0-flash", json: true },
  );
  assert.equal(
    sent[0].body.generationConfig.responseMimeType,
    "application/json",
  );
});

test("OpenAI is asked for JSON with a response format", async () => {
  const sent = captureRequest(OPENAI_REPLY);
  await askText(
    { prompt: "return JSON" },
    { provider: "openai", apiKey: "k", model: "gpt-4o", json: true },
  );
  assert.deepEqual(sent[0].body.response_format, { type: "json_object" });
});

test("Anthropic is given the opening brace to continue from", async () => {
  // It has no JSON-mode flag. A prefilled assistant turn leaves no room for
  // "Here is the JSON you asked for" before the object starts.
  const sent = captureRequest(ANTHROPIC_REPLY);
  const out = await askText(
    { prompt: "return JSON" },
    { provider: "anthropic", apiKey: "k", model: "claude-opus-5", json: true },
  );
  const last = sent[0].body.messages.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.content, "{");
  // The brace is not echoed back, so it has to be put back on the front — or
  // every answer fails to parse by exactly one character.
  assert.equal(out.text, '{"name":"Widget"}');
  assert.deepEqual(JSON.parse(out.text), { name: "Widget" });
});

test("without json mode, nothing is added to the request", async () => {
  const sent = captureRequest(OPENAI_REPLY);
  await askText(
    { prompt: "hello" },
    { provider: "openai", apiKey: "k", model: "gpt-4o" },
  );
  assert.equal(sent[0].body.response_format, undefined);
});

test("a bigger answer can be asked for", async () => {
  // An extraction naming a dozen fields, each with a selector, does not fit in
  // the 1024 the captcha reader needs.
  const sent = captureRequest(OPENAI_REPLY);
  await askText(
    { prompt: "x" },
    { provider: "openai", apiKey: "k", model: "gpt-4o", maxTokens: 2048 },
  );
  assert.equal(sent[0].body.max_tokens, 2048);
});

// ── The free path must not be the fragile one ────────────────────────────────

test("a local server that rejects response_format is asked again without it", async () => {
  // "OpenAI-compatible" is a family, not a specification. Ollama and llama.cpp
  // honour response_format; several other local servers reject the whole
  // request for carrying a field they do not know. Failing outright would make
  // the free path the least reliable one, which is the wrong way round.
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body);
    if (body.response_format) {
      return {
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({
            error: { message: "unknown field response_format" },
          });
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(OPENAI_REPLY);
      },
    };
  };

  const out = await askText(
    { prompt: "return JSON" },
    {
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.2",
      json: true,
    },
  );
  assert.equal(out.ok, true, out.error);
  assert.equal(sent.length, 2, "it should have tried twice");
  assert.equal(sent[1].response_format, undefined);
});

test("a hosted provider is not retried without its response format", async () => {
  // Only the local family is unpredictable. Silently dropping the request
  // OpenAI rejected would hide a real problem behind a worse answer.
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: false,
      status: 400,
      async text() {
        return JSON.stringify({ error: { message: "nope" } });
      },
    };
  };
  const out = await askText(
    { prompt: "return JSON" },
    { provider: "openai", apiKey: "k", model: "gpt-4o", json: true },
  );
  assert.equal(out.ok, false);
  assert.equal(calls, 1);
});

// ── The extraction layer on top of it ────────────────────────────────────────

test("the extraction layer no longer carries an HTTP client of its own", () => {
  const src = readFileSync(
    new URL("../background/llm-extractor.js", import.meta.url),
    "utf8",
  );
  assert.ok(!/fetch\(/.test(src), "it still calls fetch directly");
  assert.ok(!/generativelanguage/.test(src), "it still knows a Gemini URL");
  assert.ok(!/getApiKey/.test(src), "it still looks a key up for itself");
  assert.match(src, /askText/, "it should go through the gateway");
});

test("a provider's refusal reaches the caller with its own words", async () => {
  const { llmExtract } = await import("../background/llm-extractor.js");
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async text() {
      return JSON.stringify({ error: { message: "invalid key" } });
    },
  });
  const out = await llmExtract("some page text", {
    provider: "openai",
    apiKey: "bad",
    model: "gpt-4o",
  });
  assert.equal(out.code, "no-key");
  assert.match(
    out.error,
    /invalid key/,
    "the provider's own message is more use than 'the LLM layer failed'",
  );
});

test("a local model with no key at all can answer the extraction", async () => {
  // The whole point. No key, nothing leaves the machine, and the layer works.
  const { llmExtract } = await import("../background/llm-extractor.js");
  let headers = null;
  globalThis.fetch = async (_url, opts) => {
    headers = opts.headers;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          model: "llama3.2",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  name: "Blue Widget",
                  price: "£10.00",
                  confidence: { name: 90, price: 88 },
                }),
              },
            },
          ],
        });
      },
    };
  };
  const out = await llmExtract("Blue Widget £10.00", {
    provider: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.2",
    apiKey: null,
  });
  assert.equal(out.result.name, "Blue Widget");
  assert.equal(out.result.price, "£10.00");
  assert.equal(
    out.method,
    "llm",
    'not "llm-gemini" — three of the four providers are not Gemini, and one of them is local',
  );
  assert.equal(
    out.model,
    "llama3.2",
    "the row should say which model answered",
  );
  // "Nothing leaves the machine" has to include the credential. A local server
  // that asked for no auth must not be sent one.
  assert.equal(headers.authorization, undefined);
});

// ── One reader for the settings ──────────────────────────────────────────────

test("the storage key and the key-naming convention live in one place", () => {
  const worker = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  const extractor = readFileSync(
    new URL("../background/llm-extractor.js", import.meta.url),
    "utf8",
  );
  // The settings handlers legitimately write the key under that name. What
  // must not respell the convention is anything that *reads* it to make a
  // call — two readers is two chances for the free path to work in one place
  // and be refused in the other.
  assert.ok(
    !/getApiKey\(`gateway:/.test(extractor),
    "the extraction layer should read its config through gateway-config.js",
  );
  assert.match(
    worker,
    /readGatewayConfig\(\)/,
    "the captcha reader should use the shared reader too",
  );
  assert.ok(
    !/_askGatewayForCaptcha[\s\S]{0,600}getApiKey\(`gateway:/.test(worker),
    "the captcha reader still spells the convention out for itself",
  );
});

test("every provider in the registry is one the extraction layer can use", async () => {
  // The layer takes whatever the panel offers; a provider the picker lists and
  // the extractor cannot reach would be a dead option in a dropdown.
  const { readGatewayConfig } = await import("../background/gateway-config.js");
  assert.equal(typeof readGatewayConfig, "function");
  assert.ok(Object.keys(GATEWAY_PROVIDERS).includes("openai-compatible"));
});
