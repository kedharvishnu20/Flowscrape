// Regression tests for audit findings C-07 and C-08, plus general manifest
// sanity.
//
// C-07: web_accessible_resources listed sidepanel/*, content/*, background/*,
// utils/*, data-sources/*, exporters/*, script-gen/*, ethics/* and checkpoint/*
// against <all_urls>. Any page could fetch and read the entire extension
// source, and probe a known path to fingerprint the extension.
//
// C-08: activeTab, declarativeNetRequest, webRequest and notifications were
// requested and never called once. Unused high-privilege permissions are the
// most common cause of Web Store review rejection, and each one widens what a
// compromise is worth.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8"));

/** Every source file that could call a chrome.* API. */
const SOURCES = [
  "background/service-worker.js",
  "background/proxy-manager.js",
  "background/api-key-manager.js",
  "background/ethics-engine.js",
  "background/llm-extractor.js",
  "background/rate-limiter.js",
  "content/injector.js",
  "content/overlay-engine.js",
  "content/form-filler.js",
  "sidepanel/pipeline-builder.js",
  "sidepanel/overlay-panel.js",
  "checkpoint/cursor-store.js",
  "checkpoint/row-buffer.js",
  "checkpoint/idb-schema.js",
];
const allSource = (
  await Promise.all(SOURCES.map((f) => readFile(join(ROOT, f), "utf8")))
).join("\n");

/**
 * chrome.* namespace each permission gates. Whitespace-tolerant, because these
 * calls are often written as `chrome.sidePanel\n  .setPanelBehavior(...)`.
 */
const api = (ns) => new RegExp(`chrome\\.${ns}\\s*\\.`);
const PERMISSION_API = {
  scripting: api("scripting"),
  storage: api("storage"),
  alarms: api("alarms"),
  sidePanel: api("sidePanel"),
  proxy: api("proxy"),
  tabs: api("tabs"),
  downloads: api("downloads"),
  notifications: api("notifications"),
  declarativeNetRequest: api("declarativeNetRequest"),
  webRequest: api("webRequest"),
};

test("every requested permission has a caller", () => {
  const unused = manifest.permissions.filter((p) => {
    const probe = PERMISSION_API[p];
    return probe && !probe.test(allSource);
  });
  assert.deepEqual(
    unused,
    [],
    "a permission with no caller is pure attack surface and a review risk",
  );
});

test("the permissions dropped in the C-08 trim stay dropped", () => {
  for (const p of ["activeTab", "declarativeNetRequest", "webRequest", "notifications"]) {
    assert.ok(
      !manifest.permissions.includes(p),
      `${p} was requested and never called`,
    );
  }
});

test("the declarative_net_request block went with its permission", () => {
  assert.ok(!("declarative_net_request" in manifest));
});

test("web_accessible_resources exposes no wildcards", () => {
  const resources = manifest.web_accessible_resources.flatMap((e) => e.resources);
  const wildcards = resources.filter((r) => r.includes("*"));
  assert.deepEqual(
    wildcards,
    [],
    "a directory wildcard publishes every file in it to every page",
  );
});

test("web_accessible_resources exposes no background or extension-only code", () => {
  const resources = manifest.web_accessible_resources.flatMap((e) => e.resources);
  for (const prefix of ["background/", "sidepanel/", "script-gen/", "ethics/", "checkpoint/", "data-sources/", "exporters/"]) {
    assert.deepEqual(
      resources.filter((r) => r.startsWith(prefix)),
      [],
      `${prefix} is never loaded by a page`,
    );
  }
});

test("every dynamically imported content module is web-accessible", async () => {
  // The closure that actually needs exposing: the two
  // import(chrome.runtime.getURL(...)) calls in injector.js, plus what they
  // import. Anything missing here fails at runtime with a blocked fetch.
  const injector = await readFile(join(ROOT, "content/injector.js"), "utf8");
  const entryPoints = [
    ...injector.matchAll(/import\(chrome\.runtime\.getURL\("([^"]+)"\)\)/g),
  ].map((m) => m[1]);

  assert.ok(entryPoints.length > 0, "found the dynamic imports");

  const closure = new Set();
  async function walk(file) {
    if (closure.has(file)) return;
    closure.add(file);
    const src = await readFile(join(ROOT, file), "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*import\s+[^'"]*from\s+["']([^"']+)["']/g)) {
      if (m[1].startsWith(".")) {
        await walk(normalize(join(dirname(file), m[1])).split("\\").join("/"));
      }
    }
  }
  for (const entry of entryPoints) await walk(entry);

  const exposed = new Set(
    manifest.web_accessible_resources.flatMap((e) => e.resources),
  );
  const missing = [...closure].filter((f) => !exposed.has(f));
  assert.deepEqual(missing, [], "these would fail to load at runtime");
});

test("every web-accessible resource actually exists", async () => {
  for (const r of manifest.web_accessible_resources.flatMap((e) => e.resources)) {
    await access(join(ROOT, r)); // throws if missing
  }
});

test("declared content scripts and icons exist on disk", async () => {
  for (const entry of manifest.content_scripts) {
    for (const f of entry.js) await access(join(ROOT, f));
  }
  for (const path of Object.values(manifest.icons)) await access(join(ROOT, path));
  await access(join(ROOT, manifest.background.service_worker));
  await access(join(ROOT, manifest.side_panel.default_path));
});

test("the manifest version matches package.json", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.equal(manifest.version, pkg.version, "these drifted apart before (I-04)");
});
