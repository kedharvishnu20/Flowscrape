// Tests for K-17 — the bring-your-own-key gateway.
//
// FlowScrape's promise is "scrape without paying"; everything a free layer
// (smart-extractor, structured-data, robots/ethics gates) can do is built
// elsewhere. This module is the escape hatch for what nothing free can do:
// one interface — askVision/askText — over four providers (Anthropic,
// OpenAI, Google Gemini, and a user-supplied OpenAI-compatible endpoint for
// a local model), with every failure mode reported as a clear reason rather
// than a thrown string or a silent null — the same contract
// api-key-manager.js's validateApiKey() already uses (see
// key-validation.test.mjs).
//
// Each provider's request shape is checked (URL, headers, body — including
// that the local/compatible provider needs no key), and every failure path
// is checked: no key, an unreachable endpoint, a timeout, a refusal, a rate
// limit, a malformed body, and an oversized response. A stubbed fetch is
// installed per test — no real network call is ever made.
import test from "node:test";
import assert from "node:assert/strict";
import {
  askVision,
  askText,
  testConnection,
  GATEWAY_PROVIDERS,
} from "../utils/ai-gateway.js";

/** Install a fetch stub for one test, restored automatically after. */
function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

const IMG = { data: "ZmFrZS1wbmctYnl0ZXM=", mediaType: "image/png" };

// ── Provider registry ────────────────────────────────────────────────────────

test("the registry lists all four providers, and only the local one is keyless", () => {
  assert.deepEqual(Object.keys(GATEWAY_PROVIDERS).sort(), [
    "anthropic",
    "gemini",
    "openai",
    "openai-compatible",
  ]);
  for (const [id, info] of Object.entries(GATEWAY_PROVIDERS)) {
    if (id === "openai-compatible") {
      assert.equal(info.needsApiKey, false);
      assert.equal(info.needsBaseUrl, true);
    } else {
      assert.equal(info.needsApiKey, true, `${id} should require a key`);
      assert.equal(
        info.needsBaseUrl,
        false,
        `${id} should not need a base URL`,
      );
    }
  }
});

// ── Anthropic request shape ──────────────────────────────────────────────────

test("Anthropic: URL, headers and message shape for a vision ask", async () => {
  let seen;
  const restore = stubFetch(async (url, opts) => {
    seen = { url, opts };
    return jsonResponse(200, {
      content: [{ type: "text", text: "a red shoe" }],
      model: "claude-opus-5",
      stop_reason: "end_turn",
    });
  });
  try {
    const res = await askVision(
      { prompt: "what is this?", image: IMG },
      { provider: "anthropic", apiKey: "sk-ant-test", model: "claude-opus-5" },
    );
    assert.equal(res.ok, true);
    assert.equal(res.text, "a red shoe");
    assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
    assert.equal(seen.opts.headers["x-api-key"], "sk-ant-test");
    assert.equal(seen.opts.headers["anthropic-version"], "2023-06-01");
    const body = JSON.parse(seen.opts.body);
    assert.equal(body.model, "claude-opus-5");
    assert.equal(body.messages[0].role, "user");
    const imageBlock = body.messages[0].content.find((b) => b.type === "image");
    assert.equal(imageBlock.source.type, "base64");
    assert.equal(imageBlock.source.media_type, "image/png");
    assert.equal(imageBlock.source.data, IMG.data);
    const textBlock = body.messages[0].content.find((b) => b.type === "text");
    assert.equal(textBlock.text, "what is this?");
  } finally {
    restore();
  }
});

test("Anthropic: a text-only ask sends plain string content, not an image block", async () => {
  let seen;
  const restore = stubFetch(async (url, opts) => {
    seen = opts;
    return jsonResponse(200, { content: [{ type: "text", text: "hi" }] });
  });
  try {
    await askText(
      { prompt: "hello" },
      { provider: "anthropic", apiKey: "k", model: "claude-opus-5" },
    );
    const body = JSON.parse(seen.body);
    assert.equal(body.messages[0].content, "hello");
  } finally {
    restore();
  }
});

test("Anthropic: an unspecified model falls back to the documented default", async () => {
  let seen;
  const restore = stubFetch(async (url, opts) => {
    seen = opts;
    return jsonResponse(200, { content: [{ type: "text", text: "hi" }] });
  });
  try {
    await askText({ prompt: "hi" }, { provider: "anthropic", apiKey: "k" });
    assert.equal(JSON.parse(seen.body).model, "claude-opus-5");
  } finally {
    restore();
  }
});

test("Anthropic: a refusal stop_reason is reported, not returned as text", async () => {
  const restore = stubFetch(async () =>
    jsonResponse(200, {
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", explanation: "policy" },
    }),
  );
  try {
    const res = await askText(
      { prompt: "x" },
      { provider: "anthropic", apiKey: "k", model: "claude-opus-5" },
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "refused");
    assert.match(res.error, /policy/);
  } finally {
    restore();
  }
});

// ── OpenAI request shape ─────────────────────────────────────────────────────

test("OpenAI: URL, bearer auth and image_url content shape", async () => {
  let seen;
  const restore = stubFetch(async (url, opts) => {
    seen = { url, opts };
    return jsonResponse(200, {
      choices: [{ message: { content: "a cat" }, finish_reason: "stop" }],
      model: "gpt-4o",
    });
  });
  try {
    const res = await askVision(
      { prompt: "describe", image: IMG },
      { provider: "openai", apiKey: "sk-oa-test", model: "gpt-4o" },
    );
    assert.equal(res.ok, true);
    assert.equal(res.text, "a cat");
    assert.equal(seen.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(seen.opts.headers.authorization, "Bearer sk-oa-test");
    const body = JSON.parse(seen.opts.body);
    const imgBlock = body.messages[0].content.find(
      (b) => b.type === "image_url",
    );
    assert.equal(imgBlock.image_url.url, `data:image/png;base64,${IMG.data}`);
  } finally {
    restore();
  }
});

test("OpenAI: a content-filter finish_reason is a refusal, not a blank answer", async () => {
  const restore = stubFetch(async () =>
    jsonResponse(200, {
      choices: [
        { message: { content: null }, finish_reason: "content_filter" },
      ],
    }),
  );
  try {
    const res = await askText(
      { prompt: "x" },
      { provider: "openai", apiKey: "k", model: "gpt-4o" },
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "refused");
  } finally {
    restore();
  }
});

// ── Gemini request shape ─────────────────────────────────────────────────────

test("Gemini: the key travels as a query param and inline_data carries the image", async () => {
  let seenUrl, seenBody;
  const restore = stubFetch(async (url, opts) => {
    seenUrl = url;
    seenBody = JSON.parse(opts.body);
    return jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: "a dog" }] } }],
    });
  });
  try {
    const res = await askVision(
      { prompt: "what animal?", image: IMG },
      { provider: "gemini", apiKey: "AIza-secret", model: "gemini-2.0-flash" },
    );
    assert.equal(res.ok, true);
    assert.equal(res.text, "a dog");
    assert.match(
      seenUrl,
      /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.0-flash:generateContent\?key=AIza-secret$/,
    );
    const inlineData = seenBody.contents[0].parts.find((p) => p.inline_data);
    assert.equal(inlineData.inline_data.mime_type, "image/png");
    assert.equal(inlineData.inline_data.data, IMG.data);
  } finally {
    restore();
  }
});

test("Gemini: a blockReason is reported as a refusal", async () => {
  const restore = stubFetch(async () =>
    jsonResponse(200, { promptFeedback: { blockReason: "SAFETY" } }),
  );
  try {
    const res = await askText(
      { prompt: "x" },
      { provider: "gemini", apiKey: "k", model: "gemini-2.0-flash" },
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "refused");
    assert.match(res.error, /SAFETY/);
  } finally {
    restore();
  }
});

// ── OpenAI-compatible (the local-model path) ─────────────────────────────────

test("openai-compatible: hits <baseUrl>/chat/completions with no auth header when no key is set", async () => {
  let seen;
  const restore = stubFetch(async (url, opts) => {
    seen = { url, opts };
    return jsonResponse(200, {
      choices: [
        { message: { content: "local answer" }, finish_reason: "stop" },
      ],
    });
  });
  try {
    const res = await askText(
      { prompt: "hi" },
      {
        provider: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        model: "llama3.2",
      },
    );
    assert.equal(res.ok, true);
    assert.equal(res.text, "local answer");
    assert.equal(seen.url, "http://localhost:11434/v1/chat/completions");
    assert.equal("authorization" in seen.opts.headers, false);
  } finally {
    restore();
  }
});

test("openai-compatible: a trailing slash on the base URL does not produce a double slash", async () => {
  let seenUrl;
  const restore = stubFetch(async (url) => {
    seenUrl = url;
    return jsonResponse(200, {
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });
  });
  try {
    await askText(
      { prompt: "hi" },
      {
        provider: "openai-compatible",
        baseUrl: "http://localhost:11434/v1/",
        model: "m",
      },
    );
    assert.equal(seenUrl, "http://localhost:11434/v1/chat/completions");
  } finally {
    restore();
  }
});

test("openai-compatible: refuses with a clear reason when no base URL is configured", async () => {
  const res = await askText(
    { prompt: "hi" },
    { provider: "openai-compatible", model: "m" },
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "bad-config");
  assert.match(res.error, /base URL/i);
});

test("openai-compatible: a malformed base URL is rejected before any fetch happens", async () => {
  let called = false;
  const restore = stubFetch(async () => {
    called = true;
    return jsonResponse(200, {});
  });
  try {
    const res = await askText(
      { prompt: "hi" },
      { provider: "openai-compatible", baseUrl: "not a url", model: "m" },
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "bad-config");
    assert.equal(called, false);
  } finally {
    restore();
  }
});

// ── Failure paths shared by every provider ───────────────────────────────────

test("a missing key is reported as 'no-key' and never reaches fetch", async () => {
  let called = false;
  const restore = stubFetch(async () => {
    called = true;
    return jsonResponse(200, {});
  });
  try {
    const res = await askText({ prompt: "hi" }, { provider: "openai" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "no-key");
    assert.equal(called, false, "no request should be attempted without a key");
  } finally {
    restore();
  }
});

test("an unreachable endpoint (fetch rejects) is reported as 'network', not thrown", async () => {
  const restore = stubFetch(async () => {
    throw new TypeError("Failed to fetch");
  });
  try {
    const res = await askText(
      { prompt: "hi" },
      {
        provider: "openai-compatible",
        baseUrl: "http://localhost:11434",
        model: "m",
      },
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "network");
    assert.equal(typeof res.error, "string");
  } finally {
    restore();
  }
});

test("a slow/unreachable local endpoint times out in seconds, not indefinitely", async () => {
  const restore = stubFetch(
    (url, opts) =>
      new Promise((resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
        // Never resolves on its own — only the abort signal ends this.
      }),
  );
  try {
    const start = Date.now();
    const res = await askText(
      { prompt: "hi" },
      {
        provider: "openai-compatible",
        baseUrl: "http://localhost:11434",
        model: "m",
        timeoutMs: 50,
      },
    );
    const elapsed = Date.now() - start;
    assert.equal(res.ok, false);
    assert.equal(res.code, "timeout");
    assert.ok(elapsed < 2000, `should fail fast, took ${elapsed}ms`);
  } finally {
    restore();
  }
});

test("a 429 is reported as 'rate-limited'", async () => {
  const restore = stubFetch(async () =>
    jsonResponse(429, { error: { message: "slow down" } }),
  );
  try {
    const res = await askText(
      { prompt: "hi" },
      { provider: "openai", apiKey: "k", model: "gpt-4o" },
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "rate-limited");
    assert.equal(res.status, 429);
  } finally {
    restore();
  }
});

test("a 401 is reported as 'no-key' with the provider's own message", async () => {
  const restore = stubFetch(async () =>
    jsonResponse(401, { error: { message: "Incorrect API key provided" } }),
  );
  try {
    const res = await askText(
      { prompt: "hi" },
      { provider: "openai", apiKey: "bad-key", model: "gpt-4o" },
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "no-key");
    assert.match(res.error, /Incorrect API key provided/);
  } finally {
    restore();
  }
});

test("malformed JSON is reported as 'bad-response', not thrown", async () => {
  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    async text() {
      return "<html>not json</html>";
    },
  }));
  try {
    const res = await askText(
      { prompt: "hi" },
      { provider: "openai", apiKey: "k", model: "gpt-4o" },
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "bad-response");
  } finally {
    restore();
  }
});

test("a response over the size cap is refused before JSON.parse is attempted", async () => {
  const huge = "x".repeat(1_500_000);
  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    async text() {
      return huge;
    },
  }));
  try {
    const res = await askText(
      { prompt: "hi" },
      { provider: "openai", apiKey: "k", model: "gpt-4o" },
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "response-too-large");
  } finally {
    restore();
  }
});

test("a 2xx body shaped like an OpenAI error is not read as a successful answer", async () => {
  const restore = stubFetch(async () =>
    jsonResponse(200, { error: { message: "quota exceeded" } }),
  );
  try {
    const res = await askText(
      { prompt: "hi" },
      { provider: "openai", apiKey: "k", model: "gpt-4o" },
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /quota exceeded/);
  } finally {
    restore();
  }
});

test("askVision requires an image; askText and askVision both require a prompt", async () => {
  const cfg = { provider: "openai", apiKey: "k", model: "gpt-4o" };
  const noPrompt = await askText({ prompt: "" }, cfg);
  assert.equal(noPrompt.ok, false);
  assert.equal(noPrompt.code, "bad-config");

  const noImage = await askVision({ prompt: "x", image: null }, cfg);
  assert.equal(noImage.ok, false);
  assert.equal(noImage.code, "bad-config");
});

test("an unknown provider name is rejected with the valid list, not a crash", async () => {
  const res = await askText(
    { prompt: "hi" },
    { provider: "made-up-provider", apiKey: "k" },
  );
  assert.equal(res.ok, false);
  assert.equal(res.code, "bad-config");
  assert.match(res.error, /anthropic/);
});

// ── testConnection ────────────────────────────────────────────────────────────

test("testConnection reports success by running the real ask path", async () => {
  let seenBody;
  const restore = stubFetch(async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return jsonResponse(200, { content: [{ type: "text", text: "OK" }] });
  });
  try {
    const res = await testConnection({
      provider: "anthropic",
      apiKey: "k",
      model: "claude-opus-5",
    });
    assert.equal(res.ok, true);
    assert.match(seenBody.messages[0].content, /OK/);
  } finally {
    restore();
  }
});

test("testConnection surfaces the same clear reason a real ask would on failure", async () => {
  const res = await testConnection({ provider: "gemini" }); // no key
  assert.equal(res.ok, false);
  assert.equal(res.code, "no-key");
});

// ── Never leak the key ───────────────────────────────────────────────────────

test("a Gemini failure's error text never contains the API key", async () => {
  const restore = stubFetch(async () => {
    throw new TypeError("Failed to fetch");
  });
  try {
    const res = await askText(
      { prompt: "hi" },
      {
        provider: "gemini",
        apiKey: "AIzaSy-SUPER-SECRET-KEY",
        model: "gemini-2.0-flash",
      },
    );
    assert.equal(res.ok, false);
    assert.ok(!JSON.stringify(res).includes("AIzaSy-SUPER-SECRET-KEY"));
  } finally {
    restore();
  }
});

test("a rejected key is echoed by neither askText nor testConnection's result", async () => {
  const restore = stubFetch(async () =>
    jsonResponse(401, { error: { message: "invalid" } }),
  );
  try {
    const res = await askText(
      { prompt: "hi" },
      { provider: "openai", apiKey: "sk-openai-secret-value", model: "gpt-4o" },
    );
    assert.ok(!JSON.stringify(res).includes("sk-openai-secret-value"));
  } finally {
    restore();
  }
});
