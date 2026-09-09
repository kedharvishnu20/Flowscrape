// Carrying a previous install's data onto the new database name.
//
// An IndexedDB database is identified by its name, so renaming DB_NAME from
// `flowscrape_v3` to `verquill_v3` does not rename anything — it opens a
// different, empty database and leaves every pipeline, dataset and cached
// answer stranded in the old one, invisible, with no route back through the UI.
// A cosmetic rename must not empty somebody's workspace.
//
// The migration runs on the path every row write and cursor read depends on, so
// the tests below care as much about it failing safely as about it working.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";

const SCHEMA = new URL("../checkpoint/idb-schema.js", import.meta.url).href;
const LEGACY = "flowscrape_v3";

/** A fresh module instance, since the connection promise is cached per module. */
let bust = 0;
const freshSchema = () => import(`${SCHEMA}?v=${bust++}`);

/** Stand up a database under the old name, holding rows worth losing. */
function seedLegacy(rows) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY, 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("cursors", { keyPath: "runId" });
      db.createObjectStore("row_buffer", { autoIncrement: true });
      const dr = db.createObjectStore("data_rows", { autoIncrement: true });
      dr.createIndex("runId", "runId", { unique: false });
      const ds = db.createObjectStore("datasets", { autoIncrement: true });
      ds.createIndex("dataset", "dataset", { unique: false });
      const ac = db.createObjectStore("ai_cache", { keyPath: "key" });
      ac.createIndex("lastUsed", "lastUsed", { unique: false });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(["data_rows", "datasets"], "readwrite");
      for (const r of rows) tx.objectStore("data_rows").add(r);
      tx.objectStore("datasets").add({ dataset: "prices", row: { sku: "A1" } });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

const readAll = (db, store) =>
  new Promise((resolve) => {
    const req = db.transaction([store], "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => resolve([]);
  });

const wipe = async () => {
  for (const { name } of await indexedDB.databases()) {
    await new Promise((r) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = r;
    });
  }
};

test("rows collected under the old name survive the rename", async () => {
  await wipe();
  await seedLegacy([
    { runId: "r1", name: "Widget", price: "10" },
    { runId: "r1", name: "Gadget", price: "12" },
  ]);

  const schema = await freshSchema();
  assert.equal(
    schema.DB_NAME,
    "verquill_v3",
    "the rename should have happened",
  );

  const db = await schema.openDB();
  const rows = await readAll(db, "data_rows");
  assert.equal(rows.length, 2, "the scraped rows did not come across");
  assert.deepEqual(rows.map((r) => r.name).sort(), ["Gadget", "Widget"]);

  // Datasets are the ones that outlive a run, so losing them is the worst case.
  const datasets = await readAll(db, "datasets");
  assert.equal(datasets.length, 1);
  assert.equal(datasets[0].dataset, "prices");
});

test("the old database is left intact, as the only other copy", async () => {
  // If the copy above is ever subtly wrong, this is what it is recoverable from.
  const names = (await indexedDB.databases()).map((d) => d.name);
  assert.ok(names.includes(LEGACY), "the previous database was destroyed");
});

test("an install with no previous database is unaffected", async () => {
  await wipe();
  const schema = await freshSchema();
  const db = await schema.openDB();
  assert.equal(db.name, "verquill_v3");
  assert.deepEqual(await readAll(db, "data_rows"), []);
  // The schema still has to be complete — the migration must not have replaced
  // the normal upgrade path.
  assert.deepEqual(Array.from(db.objectStoreNames).sort(), [
    "ai_cache",
    "cursors",
    "data_rows",
    "datasets",
    "row_buffer",
  ]);
});

test("it does not run a second time over live data", async () => {
  // Guarded on the new database not existing yet. Without that, every open
  // would re-add the old rows and duplicate the user's data on every worker
  // start.
  await wipe();
  await seedLegacy([{ runId: "r1", name: "Widget" }]);

  await (await freshSchema()).openDB();
  const second = await freshSchema();
  const db = await second.openDB();

  assert.equal(
    (await readAll(db, "data_rows")).length,
    1,
    "the migration ran twice and duplicated rows",
  );
});

test("an empty previous database does not create a spurious one", async () => {
  await wipe();
  await seedLegacy([]);
  // seedLegacy always writes one dataset row, so drop it to get a truly empty
  // previous install.
  const prev = await new Promise((r) => {
    const req = indexedDB.open(LEGACY);
    req.onsuccess = () => r(req.result);
  });
  await new Promise((r) => {
    const tx = prev.transaction(["datasets"], "readwrite");
    tx.objectStore("datasets").clear();
    tx.oncomplete = r;
  });
  prev.close();

  const schema = await freshSchema();
  const db = await schema.openDB();
  assert.deepEqual(await readAll(db, "data_rows"), []);
  assert.equal(db.name, "verquill_v3");
});
