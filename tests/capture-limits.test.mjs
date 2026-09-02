// Regression tests for audit findings D-02, D-07, D-10 and D-11 — the things
// that decide whether a long run survives.
//
// D-02: the keep-alive was an alarm at periodInMinutes 0.33, commented "~20s".
// Chrome clamps any period under 1 to a minute in a packed extension; the MV3
// idle timeout is 30 seconds. So the alarm fired after the worker it was meant
// to keep alive had already been torn down. It was armed only from `activate`,
// so it never returned after a restart, and it was cleared when the last run
// ended.
//
// D-10 / D-11: screenshots and sniffed requests accumulated in the worker's
// heap with no bound at all. A 200-iteration loop with a screenshot step ran
// out of memory long before the export it was collecting for; a sniffer run on
// a chatty page did the same at up to 550 KB per request.
//
// D-07: export dedup stringified each row and compared the strings. A row read
// back from IndexedDB has no guaranteed property order, so it never matched its
// in-memory twin and every row came out twice.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const swSrc = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);

/** Evaluate a top-level function out of the worker source. */
function fnFromSource(name, deps = "") {
  const src = swSrc.match(
    new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`),
  )?.[0];
  assert.ok(src, `could not find ${name}`);
  return new Function(`${deps}\n${src}\nreturn ${name};`)();
}

// ── D-10 / D-11: bounded buffers ─────────────────────────────────────────────

const LIMITS = {
  screenshotBytes: 48 * 1024 * 1024,
  networkBytes: 32 * 1024 * 1024,
};

function makePush() {
  const logs = [];
  const push = fnFromSource(
    "_pushCapture",
    `const _broadcastLog = (level, msg) => __logs.push({ level, msg });`,
  );
  // The generated function closes over __logs from its own scope chain, so hand
  // it in through globalThis for the duration of the test.
  globalThis.__logs = logs;
  return { push, logs };
}

test("a capture buffer stops growing at its count limit", () => {
  const { push, logs } = makePush();
  const rs = {};
  let kept = 0;
  for (let i = 0; i < 20; i++) {
    if (push(rs, "screenshots", { i }, 10, 1000, 5, "run_1")) kept++;
  }
  assert.equal(kept, 5, "it kept accepting past the limit");
  assert.equal(rs.screenshots.length, 5);
  assert.equal(rs.screenshotsDropped, 15, "and it counts what it dropped");
  assert.equal(logs.length, 1, "one warning per run, not one per drop");
  assert.match(logs[0].msg, /buffer is full/);
  delete globalThis.__logs;
});

test("a capture buffer stops growing at its byte limit", () => {
  const { push } = makePush();
  const rs = {};
  let kept = 0;
  for (let i = 0; i < 20; i++) {
    if (push(rs, "networks", { i }, 300, 1000, 999, "run_1")) kept++;
  }
  assert.equal(kept, 3, "300 bytes each into a 1000-byte budget");
  assert.equal(rs.networksBytes, 900);
  delete globalThis.__logs;
});

test("a single oversized entry is dropped, not accepted", () => {
  const { push } = makePush();
  const rs = {};
  assert.equal(push(rs, "screenshots", {}, 5000, 1000, 99, "r"), false);
  assert.equal(rs.screenshots.length, 0);
  delete globalThis.__logs;
});

test("the limits are real numbers, not disabled", () => {
  assert.match(swSrc, /screenshotBytes: 48 \* 1024 \* 1024/);
  assert.match(swSrc, /networkBytes: 32 \* 1024 \* 1024/);
  assert.match(swSrc, /screenshotCount: 500/);
  assert.match(swSrc, /networkCount: 5000/);
});

test("both capture paths go through the limiter", () => {
  const shot = swSrc.match(
    /async function _captureScreenshot\([\s\S]*?\n\}\n/,
  )[0];
  assert.match(shot, /_pushCapture\(/);
  assert.ok(
    !/runState\.screenshots\.push\(/.test(shot),
    "the unbounded push is gone",
  );

  const sniff = swSrc.match(
    /_registerHandler\("network:sniff"[\s\S]*?\n\}\);/,
  )[0];
  assert.match(sniff, /_pushCapture\(/);
  assert.ok(!/rs\.networks\.push\(/.test(sniff));
});

test("a short export says it is short", () => {
  const fn = swSrc.match(/async function _doExport\([\s\S]*?\n\}\n/)[0];
  assert.match(fn, /runState\.screenshotsDropped \|\| 0/);
  assert.match(fn, /runState\.networksDropped \|\| 0/);
  assert.match(
    fn,
    /droppedRowCount\(runId\)/,
    "rows lost to a dead buffer too",
  );
  assert.match(fn, /capture\(s\) dropped when the buffer filled/);
  assert.match(fn, /dropped \? "warn-log" : "info-log"/);
});

// ── D-07: dedup ──────────────────────────────────────────────────────────────

// Built lazily: extracting at module scope makes a missing function abort the
// whole file, so every later test disappears instead of failing.
const rowKey = (...a) => fnFromSource("_rowKey")(...a);

test("two rows with the same data in a different key order are one row", () => {
  assert.equal(
    rowKey({ title: "A", price: 1 }),
    rowKey({ price: 1, title: "A" }),
    "an IndexedDB round-trip does not preserve key order",
  );
});

test("rows that really differ still differ", () => {
  assert.notEqual(rowKey({ a: 1 }), rowKey({ a: 2 }));
  assert.notEqual(rowKey({ a: 1 }), rowKey({ a: 1, b: 2 }));
  assert.notEqual(rowKey({ a: "1" }), rowKey({ a: 1 }), "types are kept apart");
});

test("the export dedups on that key and adds as it goes", () => {
  const fn = swSrc.match(/async function _doExport\([\s\S]*?\n\}\n/)[0];
  assert.match(fn, /new Set\(allRows\.map\(_rowKey\)\)/);
  assert.match(fn, /seen\.add\(key\)/, "duplicates within the IDB rows too");
  assert.ok(
    !/seen\.has\(JSON\.stringify\(clean\)\)/.test(fn),
    "the order-dependent comparison is gone",
  );
});

// ── D-02: keeping the worker alive ───────────────────────────────────────────

test("the alarm uses a period Chrome will honour", () => {
  assert.match(swSrc, /periodInMinutes: 1 \}/);
  // Checked against the code with comments stripped: the docblock explaining
  // the old value names it, and would otherwise match forever.
  const code = swSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/periodInMinutes: 0\.33/.test(code),
    "0.33 was clamped to a minute, so it fired after the worker was gone",
  );
});

test("something actually resets the idle timer during a run", () => {
  const fn = swSrc.match(/function _startHeartbeat\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /const KEEPALIVE_MS = 20000;|setInterval\(/);
  assert.match(
    fn,
    /chrome\.runtime\.getPlatformInfo/,
    "an API call, not a timer",
  );
  assert.match(
    fn,
    /_runStates\.size === 0/,
    "and it stops when nothing is running",
  );
});

test("the keep-alive is not started twice", () => {
  const fn = swSrc.match(/function _startHeartbeat\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /if \(_keepaliveTimer\) return;/);
});

test("a restarted worker re-arms itself from the alarm", () => {
  const listener = swSrc.match(
    /chrome\.alarms\.onAlarm\.addListener\(\(alarm\) => \{[\s\S]*?\n\}\);/,
  )[0];
  assert.match(listener, /if \(_runStates\.size > 0\) _startHeartbeat\(\);/);
  assert.match(listener, /else _stopHeartbeat\(\);/);
});

test("stopping clears the interval as well as the alarm", () => {
  const fn = swSrc.match(/function _stopHeartbeat\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /clearInterval\(_keepaliveTimer\)/);
  assert.match(fn, /_keepaliveTimer = null/, "so it can be started again");
  assert.match(fn, /chrome\.alarms\.clear\("fs_sw_heartbeat"\)/);

  assert.match(swSrc, /if \(_runStates\.size === 0\) _stopHeartbeat\(\);/);
});

test("the alarm is no longer described as a 20-second heartbeat", () => {
  assert.ok(!/\{ periodInMinutes: 0\.33 \}\); \/\/ ~20s/.test(swSrc));
});
