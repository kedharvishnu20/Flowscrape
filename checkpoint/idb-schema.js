// === idb-schema.js ===
/**
 * @module idb-schema
 * @description Single owner of the `verquill_v3` IndexedDB schema.
 *
 *   Why this module exists: `cursor-store.js` and `row-buffer.js` each used to
 *   call `indexedDB.open(DB_NAME, 1)` with their own `onupgradeneeded` handler.
 *   Only the first opener runs an upgrade, so whichever module happened to open
 *   the database first decided which object stores existed. In practice
 *   `row-buffer.initBuffer()` runs at pipeline start and won that race, creating
 *   the database with `data_rows` only — after which every `cursors` transaction
 *   threw `NotFoundError` and checkpoint/resume silently did nothing.
 *
 *   The schema is now declared once here and both modules share one connection.
 *   Adding a store means adding it to STORES and bumping DB_VERSION; the upgrade
 *   handler is written to be additive so existing databases gain missing stores
 *   without losing data.
 *
 * @dependencies logger
 */

import { logger } from "../utils/logger.js";

const MODULE = "idb-schema";

export const DB_NAME = "verquill_v3";

/**
 * The database this one replaces, and the last trace of the old name anywhere
 * in the project.
 *
 * An IndexedDB database is identified by its name, so renaming DB_NAME does not
 * rename a database — it opens a different, empty one and leaves every pipeline,
 * dataset and cached answer an existing install collected stranded in the old
 * one with no route back through the UI. This constant exists only to carry
 * that data across, once, and can be deleted along with `_adoptPreviousDatabase`
 * once no install is still on the old name.
 */
const PREVIOUS_DB_NAME = "flowscrape_v3";

/**
 * v1 — original schema (inconsistently created; see module docblock).
 * v2 — schema unified here; guarantees `cursors`, `row_buffer` and `data_rows`
 *      all exist regardless of which module opens the database first.
 * v3 — `datasets`, which outlive a run: an EXPORT set to append accumulates
 *      into one named collection so a run per day builds one file.
 * v4 — `ai_cache`: an answer a model already gave, for a page that has not
 *      changed since. The one part of this that costs money is not paid for
 *      twice.
 */
export const DB_VERSION = 4;

export const STORE_CURSORS = "cursors";
export const STORE_ROW_BUFFER = "row_buffer";
export const STORE_DATA_ROWS = "data_rows";
export const STORE_DATASETS = "datasets";
export const STORE_AI_CACHE = "ai_cache";

/**
 * Declarative schema. `upgrade` runs only when the store is created.
 * @type {Array<{ name: string, options: IDBObjectStoreParameters, indexes?: Array<{name:string, keyPath:string, options?:IDBIndexParameters}> }>}
 */
const STORES = [
  {
    name: STORE_CURSORS,
    options: { keyPath: "runId" },
  },
  {
    name: STORE_ROW_BUFFER,
    options: { autoIncrement: true },
  },
  {
    name: STORE_DATA_ROWS,
    options: { autoIncrement: true },
    indexes: [{ name: "runId", keyPath: "runId", options: { unique: false } }],
  },
  {
    // Keyed by dataset name rather than by run: the whole point is that the
    // rows survive the run that produced them.
    name: STORE_DATASETS,
    options: { autoIncrement: true },
    indexes: [
      { name: "dataset", keyPath: "dataset", options: { unique: false } },
    ],
  },
  {
    // Keyed by the fingerprint of the question, so a lookup is a `get` and
    // never a scan. The index is on last use rather than on when the entry was
    // written: eviction has to drop what nobody is asking for, not what was
    // stored longest ago.
    name: STORE_AI_CACHE,
    options: { keyPath: "key" },
    indexes: [
      { name: "lastUsed", keyPath: "lastUsed", options: { unique: false } },
    ],
  },
];

/** @type {Promise<IDBDatabase>|null} Cached connection, shared by all callers. */
let _dbPromise = null;

/** Every record in one store of an already-open database. */
function _readAll(db, storeName) {
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains(storeName)) return resolve([]);
    let req;
    try {
      req = db
        .transaction([storeName], "readonly")
        .objectStore(storeName)
        .getAll();
    } catch {
      return resolve([]);
    }
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => resolve([]);
  });
}

/** Open a database at whatever version it already is, or null if absent. */
function _openExisting(name) {
  return new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(name);
    } catch {
      return resolve(null);
    }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/**
 * Move a previous install's data onto the current database name, once.
 *
 * Best-effort by construction, and that is the point rather than a shortcut:
 * this runs on the path every row write and cursor read depends on, so it is
 * written so that no failure inside it can stop the database opening. Every
 * step swallows its own errors and the caller wraps the whole thing again. The
 * worst outcome is the empty database the rename would have produced anyway;
 * it can never be a broken extension.
 *
 * Runs only when the new database does not exist yet and the old one does, so
 * it cannot overwrite live data and cannot run twice. The old database is left
 * in place rather than deleted — it costs nothing, and it is the only copy of
 * the data if this ever gets something subtly wrong.
 */
async function _adoptPreviousDatabase() {
  // Firefox before 126 and older Safari have no databases(); there is no way to
  // ask what exists, so skip rather than guess.
  if (typeof indexedDB.databases !== "function") return;

  const names = (await indexedDB.databases().catch(() => [])).map(
    (d) => d.name,
  );
  if (!names.includes(PREVIOUS_DB_NAME)) return;
  if (names.includes(DB_NAME)) return; // already created, so already past this

  const previous = await _openExisting(PREVIOUS_DB_NAME);
  if (!previous) return;

  try {
    const carried = {};
    for (const store of STORES) {
      carried[store.name] = await _readAll(previous, store.name);
    }
    previous.close();

    const rows = Object.values(carried).reduce((n, r) => n + r.length, 0);
    if (!rows) return;

    // Opening at DB_VERSION creates the stores through the normal upgrade path,
    // so the schema is the one STORES declares rather than a copy of the old.
    const fresh = await new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const store of STORES) {
          if (db.objectStoreNames.contains(store.name)) continue;
          const created = db.createObjectStore(store.name, store.options);
          for (const index of store.indexes ?? []) {
            created.createIndex(index.name, index.keyPath, index.options);
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (!fresh) return;

    await new Promise((resolve) => {
      const names = STORES.map((s) => s.name);
      const tx = fresh.transaction(names, "readwrite");
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
      for (const store of STORES) {
        const target = tx.objectStore(store.name);
        for (const record of carried[store.name]) {
          // Stores with a keyPath carry their own key; autoIncrement ones are
          // re-keyed on insert, which is fine — nothing references those ids.
          try {
            target.add(record);
          } catch {
            /* one bad record must not abandon the rest */
          }
        }
      }
    });
    fresh.close();

    logger.info(MODULE, "adopted-previous-database", {
      from: PREVIOUS_DB_NAME,
      rows,
    });
  } catch (err) {
    logger.warn(MODULE, "adopt-previous-failed", { error: err?.message });
    try {
      previous.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Open (or reuse) the shared database connection.
 *
 * The returned promise is cached, so concurrent callers share one connection
 * and one upgrade transaction. If the connection is closed by a competing
 * upgrade elsewhere, the cache is dropped so the next call reopens.
 *
 * A previous install's data is adopted first, at most once — see
 * `_adoptPreviousDatabase`. It cannot fail in a way that stops the open.
 *
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (_dbPromise) return _dbPromise;

  const attempt = _adoptPreviousDatabase()
    .catch(() => {})
    .then(() => _openCurrent());

  _dbPromise = attempt;
  attempt.catch(() => {
    if (_dbPromise === attempt) _dbPromise = null;
  });
  return attempt;
}

/** Open the current database, creating or upgrading its stores. */
function _openCurrent() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      // indexedDB.open can throw synchronously — a browser with storage
      // disabled, a private window, a worker torn down mid-call. That throw
      // never reaches req.onerror, so the cache below would keep handing back a
      // rejected promise for the life of the worker and every later row write,
      // cursor save and read would fail with the original error. Found while
      // testing D-12; recorded as A-10.
      reject(err);
      return;
    }

    req.onupgradeneeded = (event) => {
      const db = req.result;
      logger.info(MODULE, "schema-upgrade", {
        from: event.oldVersion,
        to: event.newVersion,
      });

      for (const store of STORES) {
        if (db.objectStoreNames.contains(store.name)) continue;
        const created = db.createObjectStore(store.name, store.options);
        for (const index of store.indexes ?? []) {
          created.createIndex(index.name, index.keyPath, index.options);
        }
        logger.info(MODULE, "store-created", { store: store.name });
      }
    };

    req.onsuccess = () => {
      const db = req.result;

      // Another context asked for a newer version — release our handle so the
      // upgrade is not blocked, and force the next caller to reopen.
      db.onversionchange = () => {
        logger.warn(MODULE, "versionchange-closing", {});
        db.close();
        _dbPromise = null;
      };

      db.onclose = () => {
        _dbPromise = null;
      };

      resolve(db);
    };

    req.onblocked = () => {
      logger.warn(MODULE, "open-blocked", {
        note: "Another connection is holding an older version open.",
      });
    };

    req.onerror = () => {
      logger.error(MODULE, "open-fail", { error: req.error?.message });
      reject(req.error);
    };
  });
}

/**
 * Run a transaction and resolve once it has actually committed.
 *
 * `fn` receives a map of store name → IDBObjectStore and may return a promise.
 * The transaction's `complete` event — not `fn`'s resolution — settles the
 * returned promise, so writes are durable by the time callers continue.
 *
 * @param {string[]} storeNames
 * @param {'readonly'|'readwrite'} mode
 * @param {(stores: Record<string, IDBObjectStore>) => any} fn
 * @returns {Promise<any>} whatever `fn` resolved to
 */
export async function withStores(storeNames, mode, fn) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (err) {
      reject(err);
      return;
    }

    let result;
    let failed = false;

    tx.oncomplete = () => {
      if (!failed) resolve(result);
    };
    tx.onerror = () => {
      failed = true;
      reject(tx.error);
    };
    tx.onabort = () => {
      failed = true;
      reject(tx.error ?? new Error("Transaction aborted"));
    };

    const stores = Object.fromEntries(
      storeNames.map((name) => [name, tx.objectStore(name)]),
    );

    Promise.resolve()
      .then(() => fn(stores))
      .then((value) => {
        result = value;
      })
      .catch((err) => {
        failed = true;
        try {
          tx.abort();
        } catch {
          /* already settled */
        }
        reject(err);
      });
  });
}

/**
 * Promisify a single IDBRequest.
 * @param {IDBRequest} req
 * @returns {Promise<any>}
 */
export function requestAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// === END idb-schema.js ===
