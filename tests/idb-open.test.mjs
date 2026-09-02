// Regression test for audit finding A-10, found while testing D-12.
//
// openDB() caches its promise so concurrent callers share one connection. But
// indexedDB.open can throw synchronously — storage disabled, a private window,
// a worker torn down mid-call — and that throw never reaches req.onerror, which
// was the only place that cleared the cache. So one transient failure left a
// rejected promise cached for the life of the service worker, and every later
// row write, cursor save and read failed with the original error: the run kept
// going and persisted nothing.
//
// This lives in its own file because node:test gives each file a fresh process,
// and the test needs openDB to have no cached connection yet.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openDB } from "../checkpoint/idb-schema.js";

test("a failed open does not poison the cached connection", async () => {
  const real = globalThis.indexedDB.open;

  globalThis.indexedDB.open = () => {
    throw new Error("storage disabled");
  };
  await assert.rejects(() => openDB(), /storage disabled/);

  globalThis.indexedDB.open = real;
  const db = await openDB();
  assert.ok(db, "the next call opens a fresh connection");
});

test("the open path clears its cache on any failure, not just onerror", async () => {
  const src = await readFile(
    new URL("../checkpoint/idb-schema.js", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /attempt\.catch\(\(\) => \{\s*\n\s*if \(_dbPromise === attempt\) _dbPromise = null;/,
  );
  assert.match(
    src,
    /try \{\s*\n\s*req = indexedDB\.open\(DB_NAME, DB_VERSION\);/,
  );
});
