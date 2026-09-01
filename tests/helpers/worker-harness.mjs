// Loads background/service-worker.js under a mock extension environment.
//
// The worker registers listeners and bootstraps at import, so everything it
// touches has to exist before the import runs. The mocks record what the
// executor did — which tab updates it issued, what it sent to the content
// script, what it downloaded — so tests can assert on behaviour rather than on
// source text.
import "fake-indexeddb/auto";
import { finalizeBuffer } from "../../checkpoint/row-buffer.js";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

/** Everything the mocks observed, cleared between tests with reset(). */
export const calls = {
  tabUpdates: [],
  contentMessages: [],
  runtimeMessages: [],
  downloads: [],
  scriptingRegistered: [],
};

export function reset() {
  for (const key of Object.keys(calls)) calls[key].length = 0;
}

function storageArea() {
  const map = new Map();
  return {
    async get(keys) {
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (map.has(k)) out[k] = map.get(k);
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

/**
 * What the content script replies to a step:execute message.
 * Tests override this to simulate EXTRACT results or a failing step.
 * @type {(payload: object) => any}
 */
export let contentResponder = () => ({ ok: true, result: null });
export function onContentMessage(fn) {
  contentResponder = fn;
}

globalThis.self = { addEventListener() {}, skipWaiting() {} };

globalThis.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    async sendMessage(msg) {
      calls.runtimeMessages.push(msg);
    },
    getURL: (p) => `chrome-extension://test/${p}`,
    lastError: null,
  },
  storage: { local: storageArea(), session: storageArea() },
  alarms: { create() {}, async clear() {}, onAlarm: { addListener() {} } },
  sidePanel: { async setPanelBehavior() {} },
  tabs: {
    async update(tabId, props) {
      calls.tabUpdates.push({ tabId, ...props });
    },
    async get() {
      return { windowId: 1, url: "https://shop.test/" };
    },
    async sendMessage(tabId, msg) {
      calls.contentMessages.push(msg);
      return contentResponder(msg.payload);
    },
    async captureVisibleTab() {
      return "data:image/png;base64,AAAA";
    },
  },
  downloads: {
    async download(opts) {
      calls.downloads.push(opts);
      return 1;
    },
  },
  scripting: {
    async registerContentScripts(scripts) {
      calls.scriptingRegistered.push(...scripts);
    },
    async unregisterContentScripts() {},
    async getRegisteredContentScripts() {
      return [];
    },
    async executeScript() {
      return [];
    },
  },
  proxy: {
    settings: {
      get(_d, cb) { cb({ value: { mode: "system" } }); },
      set(_d, cb) { cb(); },
      clear(_d, cb) { cb(); },
    },
  },
};

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  url: "https://api.shop.test/x",
  headers: new Map([["content-type", "application/json"]]),
  async json() { return { ok: true }; },
  async text() { return "{}"; },
});

// The worker builds Blob URLs for downloads.
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => "blob:mock";
  globalThis.URL.revokeObjectURL = () => {};
}

const worker = await import(
  new URL("../../background/service-worker.js", import.meta.url).href
);

export const {
  _dispatchStep,
  _executeSteps,
  _executeStepList,
  _assertOriginAllowed,
  _resolveStr,
  _runStates,
} = worker.__testing;

/**
 * Register a run so the executor has state to work against.
 * @param {object} [over]
 * @returns {{ runId: string, runState: object }}
 */
export function startRun(over = {}) {
  const runId = `run_test_${Math.random().toString(36).slice(2, 8)}`;
  const runState = {
    active: true,
    paused: false,
    runId,
    tabId: 1,
    targetOrigin: "https://shop.test",
    allowedOrigins: new Set(["https://shop.test"]),
    results: [],
    screenshots: [],
    ...over,
  };
  _runStates.set(runId, runState);
  return { runId, runState };
}

/**
 * Tear a run down.
 *
 * initBuffer starts a 30s setInterval that only finalizeBuffer clears, and an
 * EXPORT step re-arms it. Without this the test process keeps a live timer per
 * run and node:test never exits — which is also a real leak on any path where
 * a run ends without finalizing (audit D-12).
 */
export async function endRun(runId) {
  await finalizeBuffer(runId).catch(() => {});
  _runStates.delete(runId);
}
