// Regression tests for audit findings C-03 and C-11.
//
// utils/logger.js documents that it "NEVER logs secrets, API keys, proxy
// credentials, or PII", and _sanitize redacts by key name. But proxy-manager
// logged the raw text line on a parse failure — and a proxy line is
// host:port:user:pass, under the key `line`, which matches no redaction
// pattern. The JSON path logged the whole entry, including `password`.
//
// _sanitize also skipped arrays outright, so a secret inside an array of
// objects went through untouched.
import test from "node:test";
import assert from "node:assert/strict";

const logged = [];
const originalWarn = console.warn;
const originalLog = console.log;
const originalError = console.error;

// logger writes through console; capture everything it emits.
const capture = (...args) => logged.push(args.map(String).join(" "));
console.warn = capture;
console.log = capture;
console.error = capture;

const { parseProxyText, parseProxyJSON } = await import(
  new URL("../background/proxy-manager.js", import.meta.url).href
);
const { logger } = await import(
  new URL("../utils/logger.js", import.meta.url).href
);

console.warn = originalWarn;
console.log = originalLog;
console.error = originalError;

/** Run fn with console captured, return everything logged during it. */
function withCapture(fn) {
  const start = logged.length;
  console.warn = capture;
  console.log = capture;
  console.error = capture;
  try {
    fn();
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
    console.error = originalError;
  }
  return logged.slice(start).join("\n");
}

test("a malformed proxy line does not log its credentials", () => {
  // Trailing colon makes the port unparseable, so this hits the failure path.
  const output = withCapture(() =>
    parseProxyText("this is not a proxy:::hunter2\n"),
  );

  assert.ok(
    output.includes("parse-line-fail"),
    "the failure is still reported",
  );
  assert.ok(!output.includes("hunter2"), "the password must not appear");
});

test("credentials in a scheme URL are stripped from the log", () => {
  const output = withCapture(() =>
    parseProxyText("socks5://alice:s3cret@[not a host]:99999999\n"),
  );
  assert.ok(!output.includes("s3cret"), "password must not appear");
  assert.ok(!output.includes("alice"), "username must not appear either");
});

// Defensive: this log path is currently unreachable because _makeEntry never
// throws (audit B-21), so parseProxyJSON's try/catch never fires. Fixed anyway,
// since making _makeEntry validate is the obvious next change and would turn
// this into a live leak.
test("a bad JSON proxy entry does not log its password", () => {
  const output = withCapture(() =>
    parseProxyJSON([
      { host: null, port: "nope", username: "bob", password: "hunter2" },
    ]),
  );
  assert.ok(!output.includes("hunter2"), "password must not appear");
  assert.ok(!output.includes("bob"), "username must not appear");
});

test("a valid credentialed line never reaches the log at all", () => {
  const output = withCapture(() =>
    parseProxyText("203.0.113.5:8080:user:pass\n"),
  );
  assert.ok(
    !output.includes("pass"),
    "the success path must stay quiet about credentials",
  );
});

test("parsing still works after redaction", () => {
  const entries = parseProxyText(
    "203.0.113.5:8080:user:pass\n198.51.100.7:3128\n",
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].host, "203.0.113.5");
  assert.equal(
    entries[0].user,
    "user",
    "credentials are still parsed, just not logged",
  );
  assert.equal(entries[1].port, 3128);
});

test("the logger redacts secrets nested inside arrays", () => {
  const output = withCapture(() =>
    logger.info("test", "event", {
      proxies: [{ host: "203.0.113.5", password: "hunter2" }],
      nested: { deeper: [{ apiKey: "sk-secret" }] },
    }),
  );

  assert.ok(
    !output.includes("hunter2"),
    "arrays were skipped by _sanitize entirely",
  );
  assert.ok(
    !output.includes("sk-secret"),
    "including arrays reached through an object",
  );
  assert.ok(output.includes("203.0.113.5"), "non-secret fields still logged");
});
