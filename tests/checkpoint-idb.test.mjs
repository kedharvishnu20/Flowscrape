// Regression tests for audit finding A-03.
//
// cursor-store.js and row-buffer.js each used to call
// indexedDB.open('flowscrape_v3', 1) with their own onupgradeneeded handler
// declaring different object stores. Only the first opener runs an upgrade, so
// whichever module opened the database first decided which stores existed.
// row-buffer won that race in practice, `cursors` was never created, and every
// checkpoint write threw NotFoundError into a .catch(() => {}).
//
// These tests import row-buffer FIRST on purpose — that is the order that broke.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = new URL("../", import.meta.url);
const load = (p) => import(new URL(p, ROOT).href);

// Import order matters: row-buffer before cursor-store.
const rowBuffer = await load("checkpoint/row-buffer.js");
const cursorStore = await load("checkpoint/cursor-store.js");
const resume = await load("checkpoint/resume-manager.js");
const schema = await load("checkpoint/idb-schema.js");

test("row-buffer opening first still creates every store", async () => {
  rowBuffer.initBuffer("run_A");
  await rowBuffer.pushRow("run_A", { name: "Widget", price: "10" });
  await rowBuffer.flush("run_A");

  const db = await schema.openDB();
  assert.deepEqual(
    Array.from(db.objectStoreNames).sort(),
    ["cursors", "data_rows", "row_buffer"],
    "the store row-buffer does not declare must still exist",
  );
  assert.equal(db.version, schema.DB_VERSION);
});

test("cursors round-trip after row-buffer created the database", async () => {
  await cursorStore.saveCursor({ runId: "run_A", rowIndex: 7, stepIndex: 3 });

  const cursor = await cursorStore.loadCursor("run_A");
  assert.equal(cursor?.rowIndex, 7);
  assert.equal(cursor?.stepIndex, 3);
  assert.ok(cursor?.savedAt, "savedAt is stamped on write");

  const all = await cursorStore.listCursors();
  assert.equal(all.length, 1);
  assert.equal(all[0].runId, "run_A");
});

test("a write is durable by the time saveCursor resolves", async () => {
  // The old _tx resolved when its callback returned, not when the transaction
  // committed, so it could report success for a write still in flight.
  await cursorStore.saveCursor({
    runId: "run_durable",
    rowIndex: 1,
    stepIndex: 1,
  });
  const immediately = await cursorStore.loadCursor("run_durable");
  assert.equal(immediately?.rowIndex, 1);
  await cursorStore.deleteCursor("run_durable");
});

test("resume-manager detects and clears an incomplete run", async () => {
  const before = await resume.getResumePayload();
  assert.equal(before.hasResumable, true);
  assert.ok(before.runs.some((r) => r.runId === "run_A"));

  await resume.markRunCompleted("run_A");

  const after = await resume.getResumePayload();
  assert.equal(
    after.hasResumable,
    false,
    "cursor is gone once the run completes",
  );
});

test("rows are stored, tagged and scoped per run", async () => {
  await rowBuffer.pushRow("run_A", { name: "Gadget", price: "20" });
  await rowBuffer.finalizeBuffer("run_A");

  const rows = await rowBuffer.readAllRows("run_A");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.runId === "run_A"));
  assert.ok(rows.some((r) => r.name === "Widget"));
  assert.ok(rows.some((r) => r.name === "Gadget"));

  rowBuffer.initBuffer("run_B");
  await rowBuffer.pushRow("run_B", { name: "Other" });
  await rowBuffer.finalizeBuffer("run_B");

  assert.equal(
    (await rowBuffer.readAllRows("run_A")).length,
    2,
    "run_A untouched",
  );
  assert.equal((await rowBuffer.readAllRows("run_B")).length, 1);
  assert.equal(
    (await rowBuffer.readAllRows("latest")).length,
    0,
    "an unknown runId returns nothing rather than everything",
  );
});

test("clearRows removes only the run it was asked about", async () => {
  await rowBuffer.clearRows("run_A");
  assert.equal((await rowBuffer.readAllRows("run_A")).length, 0);
  assert.equal((await rowBuffer.readAllRows("run_B")).length, 1);
  await rowBuffer.finalizeBuffer("run_B"); // release the flush timer
});
