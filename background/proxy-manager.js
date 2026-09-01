// === proxy-manager.js ===
/**
 * @module proxy-manager
 * @description Manages user-supplied proxy pool: parsing all 5 input formats,
 *   health-checking, 4 rotation modes (round-robin / random / sticky / geo),
 *   and applying proxies via Chrome Proxy API PAC script.
 *
 *   Design decision: PAC-script approach is used for all proxy types including
 *   SOCKS because chrome.proxy.settings.set() with PAC is the only MV3-compatible
 *   way to dynamically rotate proxies without requiring a native host. For HTTP
 *   proxies where SOCKS is unavailable, we fall back to fixed proxy config.
 *
 *   Credentials (user/pass) are stored ONLY in chrome.storage.session and are
 *   purged automatically when the browser session ends. Pool metadata (host,
 *   port, type, country, alive, latencyMs, failCount) goes to chrome.storage.local.
 *
 * @dependencies logger, strings
 */

import { logger } from '../utils/logger.js';
import { S } from '../utils/strings.js';

const MODULE = 'proxy-manager';

// ── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY_POOL  = 'fs_proxy_pool';   // local: pool metadata (no creds)
const STORAGE_KEY_CREDS = 'fs_proxy_creds';  // session: user/pass per host:port
const PROXY_HEALTH_TIMEOUT_MS = 5000;
const HEALTH_CHECK_URL  = 'https://httpbin.org/ip';

/**
 * @typedef {Object} ProxyEntry
 * @property {string}  host
 * @property {number}  port
 * @property {string}  [user]
 * @property {string}  [pass]
 * @property {'http'|'https'|'socks4'|'socks5'} type
 * @property {string}  [country]       ISO-3166-1 alpha-2
 * @property {number|null} latencyMs   null = untested
 * @property {boolean} alive           default true
 * @property {number}  failCount       consecutive failures
 * @property {number}  lastTestedAt    epoch ms
 */

// ── Module state ──────────────────────────────────────────────────────────────
let _pool      = [];         // Array<ProxyEntry> (creds stripped)
let _credMap   = new Map();  // host:port → {user, pass}
let _rrIndex   = 0;          // round-robin cursor
let _stickyMap = new Map();  // domain → ProxyEntry

// ── Rotation mode ─────────────────────────────────────────────────────────────
let _rotationMode = 'round-robin'; // 'round-robin' | 'random' | 'sticky' | 'geo'

// ── Parser helpers ────────────────────────────────────────────────────────────

/**
 * Infer protocol from port when not specified.
 * @param {number} port
 * @returns {'socks5'|'http'}
 */
function _inferProtocol(port) {
  return port === 1080 ? 'socks5' : 'http';
}

/**
 * Normalize a protocol string to our accepted types.
 * @param {string} proto
 * @returns {'http'|'https'|'socks4'|'socks5'}
 */
function _normalizeProtocol(proto) {
  const p = proto.toLowerCase();
  if (p === 'socks4') return 'socks4';
  if (p === 'socks5' || p === 'socks') return 'socks5';
  if (p === 'https') return 'https';
  return 'http';
}

/**
 * Describe a proxy line safely enough to log.
 *
 * A proxy line is `host:port:user:pass`, so logging the raw text — as the parse
 * failure path used to — put credentials straight into the console, in a module
 * whose logger documents that it never logs them. Nothing beyond scheme and
 * host:port is ever returned.
 *
 * @param {string} line
 * @returns {string}
 */
function _describeProxyLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return '(empty)';

  // scheme://user:pass@host:port -> scheme://host:port
  const withoutUserInfo = trimmed.replace(/\/\/[^@/]*@/, '//');

  const parts = withoutUserInfo.split(':');
  if (parts.length > 2) return `${parts[0]}:${parts[1]}:***`;
  return withoutUserInfo.slice(0, 64);
}

/**
 * Parse a single proxy line in any of the 5 supported text formats.
 * Returns null (and logs) if the line is malformed.
 * @param {string} line
 * @param {number} [index] - line number, for the failure log
 * @returns {ProxyEntry|null}
 */
function _parseLine(line, index) {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;

  try {
    // ── Format 5: JSON object on one line ─────────────────────────────────
    if (line.startsWith('{')) {
      const obj = JSON.parse(line);
      if (!obj.host || !obj.port) throw new Error('Missing host or port');
      return _makeEntry({
        host: String(obj.host),
        port: parseInt(obj.port, 10),
        user: obj.user  ?? obj.username ?? undefined,
        pass: obj.pass  ?? obj.password ?? undefined,
        type: obj.type  ? _normalizeProtocol(obj.type) : _inferProtocol(parseInt(obj.port, 10)),
        country: obj.country ?? undefined,
      });
    }

    // ── Formats with protocol prefix (socks5://, http://, etc.) ──────────
    if (/^[a-z]+:\/\//i.test(line)) {
      // Use URL parser; don't let it throw on bad input
      let urlStr = line;
      // Ensure double-slash for URL parser
      if (!/^[a-z]+:\/\//i.test(urlStr)) urlStr = 'http://' + urlStr;
      const url = new URL(urlStr);
      const proto = _normalizeProtocol(url.protocol.replace(':', ''));
      const host  = url.hostname;
      const port  = parseInt(url.port || (proto === 'socks5' ? '1080' : '3128'), 10);
      const user  = url.username ? decodeURIComponent(url.username) : undefined;
      const pass  = url.password ? decodeURIComponent(url.password) : undefined;
      return _makeEntry({ host, port, user, pass, type: proto });
    }

    // ── Remaining: plain IP:PORT… formats ─────────────────────────────────
    const parts = line.split(':');
    if (parts.length < 2) throw new Error('Cannot parse');

    const host = parts[0];
    const port = parseInt(parts[1], 10);
    if (!host || isNaN(port)) throw new Error('Missing host or port');

    // IP:PORT:USER:PASS
    if (parts.length === 4) {
      return _makeEntry({ host, port, user: parts[2], pass: parts[3], type: _inferProtocol(port) });
    }
    // IP:PORT (plain)
    return _makeEntry({ host, port, type: _inferProtocol(port) });

  } catch (err) {
    logger.warn(MODULE, 'parse-line-fail', {
      line: index === undefined ? undefined : index + 1,
      value: _describeProxyLine(line),
      error: err.message,
    });
    return null;
  }
}

/**
 * Build a complete ProxyEntry, separating credentials from metadata.
 * @param {{host:string,port:number,user?:string,pass?:string,type:string,country?:string}} opts
 * @returns {ProxyEntry}
 */
function _makeEntry({ host, port, user, pass, type, country }) {
  return {
    host,
    port,
    user,           // kept in memory for immediate use; persisted only to session
    pass,
    type,
    country:       country ?? null,
    latencyMs:     null,
    alive:         true,
    failCount:     0,
    lastTestedAt:  0,
  };
}

/**
 * Deduplicate pool by host:port.
 * @param {ProxyEntry[]} entries
 * @returns {ProxyEntry[]}
 */
function _deduplicate(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.host}:${entry.port}`;
    if (seen.has(key)) {
      logger.warn(MODULE, 'dupe-skipped', { key });
    } else {
      seen.set(key, entry);
    }
  }
  return [...seen.values()];
}

// ── Public parsers ────────────────────────────────────────────────────────────

/**
 * Parse a multiline text block (paste) into ProxyEntry[].
 * @param {string} text
 * @returns {ProxyEntry[]}
 */
export function parseProxyText(text) {
  const lines   = text.split(/\r?\n/);
  const entries = lines.map(_parseLine).filter(Boolean);
  return _deduplicate(entries);
}

/**
 * Parse a JSON array of proxy objects.
 * @param {string|object[]} input - JSON string or already-parsed array
 * @returns {ProxyEntry[]}
 */
export function parseProxyJSON(input) {
  let arr;
  if (typeof input === 'string') {
    try { arr = JSON.parse(input); } catch (e) {
      logger.error(MODULE, 'json-parse-fail', { error: e.message });
      return [];
    }
  } else {
    arr = input;
  }
  if (!Array.isArray(arr)) {
    logger.error(MODULE, 'json-not-array', {});
    return [];
  }
  const entries = arr.map(obj => {
    try {
      return _makeEntry({
        host:    String(obj.host),
        port:    parseInt(obj.port, 10),
        user:    obj.user  ?? obj.username ?? undefined,
        pass:    obj.pass  ?? obj.password ?? undefined,
        type:    obj.type  ? _normalizeProtocol(obj.type) : _inferProtocol(parseInt(obj.port, 10)),
        country: obj.country ?? undefined,
      });
    } catch (err) {
      // Never log the entry itself — a JSON proxy record carries pass/password.
      logger.warn(MODULE, 'json-entry-skip', {
        host: typeof obj?.host === 'string' ? obj.host : '(missing)',
        port: Number.isFinite(Number(obj?.port)) ? Number(obj.port) : '(missing)',
        error: err.message,
      });
      return null;
    }
  }).filter(Boolean);
  return _deduplicate(entries);
}

/**
 * Parse a CSV string (header row required: host,port,username,password,type)
 * @param {string} csv
 * @returns {ProxyEntry[]}
 */
export function parseProxyCSV(csv) {
  const lines  = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idx    = field => header.indexOf(field);

  const iHost = idx('host');
  const iPort = idx('port');
  const iUser = Math.max(idx('username'), idx('user'));
  const iPass = Math.max(idx('password'), idx('pass'));
  const iType = idx('type');
  const iCountry = idx('country');

  if (iHost === -1 || iPort === -1) {
    logger.error(MODULE, 'csv-missing-header', { header });
    return [];
  }

  const entries = lines.slice(1).map((line, i) => {
    const cols = line.split(',').map(c => c.trim());
    if (cols.length < 2) {
      logger.warn(MODULE, 'csv-row-skip', { row: i + 1 });
      return null;
    }
    try {
      return _makeEntry({
        host:    cols[iHost],
        port:    parseInt(cols[iPort], 10),
        user:    iUser >= 0 ? cols[iUser] : undefined,
        pass:    iPass >= 0 ? cols[iPass] : undefined,
        type:    iType >= 0 && cols[iType] ? _normalizeProtocol(cols[iType]) : _inferProtocol(parseInt(cols[iPort], 10)),
        country: iCountry >= 0 ? cols[iCountry]?.toUpperCase() : undefined,
      });
    } catch (err) {
      logger.warn(MODULE, 'csv-entry-fail', { row: i + 1, error: err.message });
      return null;
    }
  }).filter(Boolean);

  return _deduplicate(entries);
}

// ── Pool management ───────────────────────────────────────────────────────────

/**
 * Load the pool from chrome.storage.local (no credentials).
 * Credentials are re-hydrated from session storage.
 */
export async function loadPool() {
  try {
    const { [STORAGE_KEY_POOL]: meta, [STORAGE_KEY_CREDS]: creds } =
      await chrome.storage.local.get([STORAGE_KEY_POOL]);
    const sessionItems = await chrome.storage.session.get([STORAGE_KEY_CREDS]);
    const sessionCreds = sessionItems[STORAGE_KEY_CREDS] ?? {};

    _pool = (meta ?? []).map(entry => ({
      ...entry,
      user: undefined,
      pass: undefined,
    }));

    _credMap = new Map(Object.entries(sessionCreds));
    logger.info(MODULE, 'pool-loaded', { count: _pool.length });
  } catch (err) {
    logger.error(MODULE, 'pool-load-fail', { error: err.message });
    _pool = [];
  }
}

/**
 * Persist pool metadata (no credentials) to chrome.storage.local.
 * Credentials saved separately to chrome.storage.session.
 */
export async function savePool() {
  // Strip credentials before persisting locally
  const meta = _pool.map(({ user, pass, ...rest }) => rest); // eslint-disable-line no-unused-vars
  // Serialize credential map
  const credObj = Object.fromEntries(_credMap.entries());

  try {
    await chrome.storage.local.set({ [STORAGE_KEY_POOL]: meta });
    await chrome.storage.session.set({ [STORAGE_KEY_CREDS]: credObj });
    logger.info(MODULE, 'pool-saved', { count: meta.length });
  } catch (err) {
    logger.error(MODULE, 'pool-save-fail', { error: err.message });
    throw err;
  }
}

/**
 * Add entries to the pool (merges with deduplication).
 * @param {ProxyEntry[]} entries
 */
export function addToPool(entries) {
  const existing = new Map(_pool.map(e => [`${e.host}:${e.port}`, e]));
  for (const entry of entries) {
    const key = `${entry.host}:${entry.port}`;
    if (!existing.has(key)) {
      const { user, pass, ...meta } = entry;
      _pool.push(meta);
      if (user || pass) {
        _credMap.set(key, { user: user ?? '', pass: pass ?? '' });
      }
      existing.set(key, meta);
    }
  }
}

/**
 * Clear the entire pool from memory and storage.
 */
export async function clearPool() {
  _pool = [];
  _credMap = new Map();
  _rrIndex = 0;
  _stickyMap = new Map();
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_POOL]: [] });
    await chrome.storage.session.remove([STORAGE_KEY_CREDS]);
    logger.info(MODULE, 'pool-cleared', {});
  } catch (err) {
    logger.error(MODULE, 'pool-clear-fail', { error: err.message });
  }
}

/** Get pool metadata (no credentials). */
export function getPool() { return [..._pool]; }

/** Set rotation mode. */
export function setRotationMode(mode) {
  const valid = ['round-robin', 'random', 'sticky', 'geo'];
  if (!valid.includes(mode)) throw new Error(`Invalid rotation mode: ${mode}`);
  _rotationMode = mode;
  logger.info(MODULE, 'rotation-mode-set', { mode });
}

/** Get current rotation mode. */
export function getRotationMode() { return _rotationMode; }

// ── Proxy selection ───────────────────────────────────────────────────────────

/**
 * Get alive proxies.
 * @returns {ProxyEntry[]}
 */
function _aliveProxies() {
  return _pool.filter(p => p.alive);
}

/**
 * Select next proxy according to the current rotation mode.
 * @param {{ domain?: string, targetCountry?: string }} [context]
 * @returns {ProxyEntry|null}
 */
export function selectProxy(context = {}) {
  const alive = _aliveProxies();
  if (alive.length === 0) {
    logger.error(MODULE, 'no-alive-proxies', {});
    return null;
  }

  switch (_rotationMode) {
    case 'round-robin': {
      const entry = alive[_rrIndex % alive.length];
      _rrIndex = (_rrIndex + 1) % alive.length;
      return _attachCreds(entry);
    }
    case 'random': {
      const entry = alive[Math.floor(Math.random() * alive.length)];
      return _attachCreds(entry);
    }
    case 'sticky': {
      const domain = context.domain ?? '__default__';
      if (_stickyMap.has(domain)) {
        const stuck = _stickyMap.get(domain);
        // Re-check still alive
        const stillAlive = _pool.find(p => p.host === stuck.host && p.port === stuck.port && p.alive);
        if (stillAlive) return _attachCreds(stillAlive);
      }
      // Assign a new one
      const entry = alive[_rrIndex % alive.length];
      _rrIndex = (_rrIndex + 1) % alive.length;
      _stickyMap.set(domain, entry);
      return _attachCreds(entry);
    }
    case 'geo': {
      const country = (context.targetCountry ?? '').toUpperCase();
      const geoMatch = alive.filter(p => p.country?.toUpperCase() === country);
      const candidates = geoMatch.length > 0 ? geoMatch : alive;
      const entry = candidates[Math.floor(Math.random() * candidates.length)];
      if (geoMatch.length === 0) {
        logger.warn(MODULE, 'geo-no-match', { country });
      }
      return _attachCreds(entry);
    }
    default: {
      logger.warn(MODULE, 'unknown-rotation-mode', { mode: _rotationMode });
      return _attachCreds(alive[0]);
    }
  }
}

/**
 * Attach credentials from credMap to a copy of the entry.
 * @param {ProxyEntry} entry
 * @returns {ProxyEntry}
 */
function _attachCreds(entry) {
  const key   = `${entry.host}:${entry.port}`;
  const creds = _credMap.get(key) ?? {};
  return { ...entry, user: creds.user, pass: creds.pass };
}

// ── Health checking ───────────────────────────────────────────────────────────

/**
 * Test a single proxy entry for liveness.
 * Updates `alive`, `latencyMs`, `failCount`, `lastTestedAt` in-place.
 * Non-blocking: returns a Promise.
 * @param {ProxyEntry} entry
 * @param {number} [retryCount=3]
 * @returns {Promise<ProxyEntry>}
 */
export async function testProxy(entry, retryCount = 3) {
  const key = `${entry.host}:${entry.port}`;
  const poolEntry = _pool.find(p => `${p.host}:${p.port}` === key);
  if (!poolEntry) {
    logger.warn(MODULE, 'test-proxy-not-in-pool', { key });
    return entry;
  }

  const start = Date.now();
  // We cannot change actual networking in a content script from here.
  // This health check is run from the service worker using the Chromium proxy
  // API; we temporarily apply this proxy, make the fetch, then record result.
  // For the health check we rely on network fetch (SW context only).
  try {
    await _applyProxy(entry);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_HEALTH_TIMEOUT_MS);
    const res = await fetch(HEALTH_CHECK_URL, {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timer);

    const latencyMs = Date.now() - start;
    poolEntry.alive      = res.ok;
    poolEntry.latencyMs  = latencyMs;
    poolEntry.failCount  = res.ok ? 0 : poolEntry.failCount + 1;
    poolEntry.lastTestedAt = Date.now();

    if (!res.ok) {
      logger.warn(MODULE, 'proxy-test-fail', { host: entry.host, port: entry.port, status: res.status });
    } else {
      logger.info(MODULE, 'proxy-test-ok', { host: entry.host, port: entry.port, latencyMs });
    }
  } catch (err) {
    poolEntry.alive      = false;
    poolEntry.failCount  = (poolEntry.failCount ?? 0) + 1;
    poolEntry.lastTestedAt = Date.now();
    poolEntry.latencyMs  = null;
    logger.warn(MODULE, 'proxy-test-error', { host: entry.host, port: entry.port, error: err.message });

    if (poolEntry.failCount >= retryCount) {
      poolEntry.alive = false;
      logger.info(MODULE, 'proxy-marked-dead', { host: entry.host, port: entry.port, failCount: poolEntry.failCount });
    }
  }

  return poolEntry;
}

/**
 * Test all proxies in the pool concurrently (non-blocking relative to pipeline).
 * @param {object} [opts]
 * @param {boolean} [opts.autoRemoveDead=false]
 * @param {number}  [opts.retryCount=3]
 * @returns {Promise<void>}
 */
export async function testAllProxies({ autoRemoveDead = false, retryCount = 3 } = {}) {
  logger.info(MODULE, 'health-check-start', { count: _pool.length });
  await Promise.allSettled(_pool.map(entry => testProxy(entry, retryCount)));

  if (autoRemoveDead) {
    const before = _pool.length;
    _pool = _pool.filter(p => p.alive);
    logger.info(MODULE, 'auto-removed-dead', { removed: before - _pool.length });
  }

  await savePool();
  logger.info(MODULE, 'health-check-complete', {
    alive: _pool.filter(p => p.alive).length,
    total: _pool.length,
  });
}

/**
 * Mark a proxy as failed. If failCount >= retryCount, mark dead.
 * @param {string} host
 * @param {number} port
 * @param {number} [retryCount=3]
 */
export function markProxyFailure(host, port, retryCount = 3) {
  const key   = `${host}:${port}`;
  const entry = _pool.find(p => `${p.host}:${p.port}` === key);
  if (!entry) return;
  entry.failCount = (entry.failCount ?? 0) + 1;
  if (entry.failCount >= retryCount) {
    entry.alive = false;
    logger.warn(MODULE, 'proxy-dead', { host, port, failCount: entry.failCount });
  }
}

/**
 * Rotate to the next proxy and apply it (called after consecutive failures).
 * @param {object} [context]
 * @returns {Promise<ProxyEntry|null>}
 */
export async function rotateProxy(context = {}) {
  const next = selectProxy(context);
  if (!next) {
    logger.error(MODULE, 'rotate-fail-no-alive', {});
    return null;
  }
  await _applyProxy(next);
  logger.info(MODULE, 'proxy-rotated', { host: next.host, port: next.port });
  return next;
}

// ── Chrome Proxy API application ──────────────────────────────────────────────

/**
 * Apply a proxy via chrome.proxy.settings.set() using a PAC script.
 * @param {ProxyEntry} entry
 * @returns {Promise<void>}
 */
export async function _applyProxy(entry) {
  // Build PAC script string dynamically
  let proxyStr;
  if (entry.type === 'socks4') {
    proxyStr = `SOCKS4 ${entry.host}:${entry.port}`;
  } else if (entry.type === 'socks5') {
    proxyStr = `SOCKS5 ${entry.host}:${entry.port}`;
  } else if (entry.type === 'https') {
    proxyStr = `HTTPS ${entry.host}:${entry.port}`;
  } else {
    proxyStr = `PROXY ${entry.host}:${entry.port}`;
  }

  const pacScript = `function FindProxyForURL(url, host) { return "${proxyStr}"; }`;

  await new Promise((resolve, reject) => {
    chrome.proxy.settings.set(
      { value: { mode: 'pac_script', pacScript: { data: pacScript } }, scope: 'regular' },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      }
    );
  });

  logger.info(MODULE, 'proxy-applied', { host: entry.host, port: entry.port, type: entry.type });
}

/**
 * Clear proxy settings (use direct connection).
 * @returns {Promise<void>}
 */
export async function clearProxy() {
  await new Promise((resolve, reject) => {
    chrome.proxy.settings.clear({ scope: 'regular' }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
  logger.info(MODULE, 'proxy-cleared', {});
}

/**
 * Export pool hosts only (no credentials).
 * @returns {string} newline-separated host:port entries
 */
export function exportHostsOnly() {
  return _pool.map(p => `${p.host}:${p.port}`).join('\n');
}

// Availability summary
export function getPoolSummary() {
  const alive = _pool.filter(p => p.alive).length;
  return { total: _pool.length, alive, dead: _pool.length - alive, mode: _rotationMode };
}

// === END proxy-manager.js ===
