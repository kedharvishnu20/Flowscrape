// Regression tests for audit findings B-19, B-20 and B-21.
//
// This module is not reached by a pipeline run (audit A-05), so these are
// latent defects — but B-19 in particular becomes live the moment anyone wires
// the pool up, and it hijacks the user's whole browser when it does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// ── chrome.proxy mock that records what the module does to the global setting ─
const proxyCalls = [];
let currentValue = { mode: "system" };

globalThis.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      async get() {
        return {};
      },
      async set() {},
      async remove() {},
    },
    session: {
      async get() {
        return {};
      },
      async set() {},
      async remove() {},
    },
  },
  proxy: {
    settings: {
      get(_details, cb) {
        proxyCalls.push({ op: "get" });
        cb({ value: currentValue });
      },
      set({ value }, cb) {
        proxyCalls.push({
          op: "set",
          mode: value.mode,
          pac: value.pacScript?.data,
        });
        currentValue = value;
        cb();
      },
      clear(_scope, cb) {
        proxyCalls.push({ op: "clear" });
        currentValue = { mode: "system" };
        cb();
      },
    },
  },
};

globalThis.fetch = async () => ({ ok: true, status: 200 });

const pm = await import(
  new URL("../background/proxy-manager.js", import.meta.url).href
);

test("a valid credentialed line parses", () => {
  const entries = pm.parseProxyText("203.0.113.5:8080:user:pass");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].host, "203.0.113.5");
  assert.equal(entries[0].port, 8080);
  assert.equal(entries[0].user, "user");
});

test("entries with an unusable port are rejected, not stored", () => {
  // _makeEntry accepted anything, so parseProxyJSON's try/catch was dead code
  // and entries with port: NaN entered the pool.
  const entries = pm.parseProxyJSON([
    { host: "203.0.113.5", port: "not-a-port" },
    { host: "", port: 8080 },
    { host: "198.51.100.7", port: 70000 },
    { host: "198.51.100.8", port: 3128 },
  ]);
  assert.equal(entries.length, 1, "only the valid entry survives");
  assert.equal(entries[0].host, "198.51.100.8");
});

test("a pasted CSV is recognised", () => {
  // README lists CSV as a supported paste format; parseProxyText only ever
  // tried the line formats, so every row was rejected.
  const csv = [
    "host,port,username,password,type",
    "203.0.113.5,8080,alice,s3cret,http",
    "198.51.100.7,1080,,,socks5",
  ].join("\n");

  const entries = pm.parseProxyText(csv);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].user, "alice");
  assert.equal(entries[1].type, "socks5");
});

test("line formats still parse when the text is not CSV", () => {
  const entries = pm.parseProxyText(
    "203.0.113.5:8080\nsocks5://198.51.100.7:1080\n# a comment\n",
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[1].type, "socks5");
});

test("socks5:// and socks4:// URLs parse", () => {
  // The scheme pattern was /^[a-z]+:\/\//, which cannot match "socks5:" — it
  // stops at the digit. Both fell through to the plain host:port branch and
  // parsed as host "socks5" with a NaN port.
  const entries = pm.parseProxyText(
    "socks5://198.51.100.7:1080\nsocks4://198.51.100.8:1081\nhttp://user:pw@203.0.113.5:3128",
  );
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => [e.host, e.port, e.type]),
    [
      ["198.51.100.7", 1080, "socks5"],
      ["198.51.100.8", 1081, "socks4"],
      ["203.0.113.5", 3128, "http"],
    ],
  );
  assert.equal(entries[2].user, "user");
  assert.equal(entries[2].pass, "pw");
});

test("a health check restores the browser's proxy settings", async () => {
  pm.addToPool(pm.parseProxyText("203.0.113.5:8080"));
  proxyCalls.length = 0;

  await pm.testProxy({ host: "203.0.113.5", port: 8080, type: "http" });

  const ops = proxyCalls.map((c) => c.op);
  assert.ok(ops.includes("get"), "the previous configuration is read first");
  assert.ok(ops.includes("set"), "the proxy under test is applied");

  const last = proxyCalls[proxyCalls.length - 1];
  assert.ok(
    last.op === "clear" ||
      (last.op === "set" && !last.pac?.includes("203.0.113.5")),
    `the tested proxy must not be left applied (last op: ${JSON.stringify(last)})`,
  );
});

test("the browser is not left routed through the last tested proxy", async () => {
  pm.addToPool(pm.parseProxyText("198.51.100.9:8081"));
  await pm.testAllProxies({});

  assert.notEqual(currentValue.mode, "pac_script", "settings were put back");
});

test("health checks run one at a time", async () => {
  // Each one swaps a browser-wide PAC script; concurrent tests measured each
  // other's proxies.
  const src = await readFile(
    new URL("../background/proxy-manager.js", import.meta.url),
    "utf8",
  );
  // The body ends at the first line-start brace; an inner `}\n` at deeper
  // indentation must not terminate the match.
  const fn = src.match(
    /export async function testAllProxies\([\s\S]*?\n\}\n/,
  )[0];
  assert.ok(
    !/await Promise\.allSettled\(/.test(fn),
    "allSettled over a global setting produces meaningless results",
  );
  assert.match(fn, /for \(const entry of \[\.\.\._pool\]\)/);
});

test("the module says plainly that it is not wired up", async () => {
  const src = await readFile(
    new URL("../background/proxy-manager.js", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /NOT CURRENTLY REACHED BY A PIPELINE RUN/,
    "630 lines that look like a working feature should say that they are not",
  );
});
