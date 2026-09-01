# FlowScrape v3 — Known Limitations

> Platform constraints and accepted trade-offs. Bugs live in
> [ISSUE_AUDIT.md](ISSUE_AUDIT.md); this file is for things that are the way
> they are on purpose, or because MV3 leaves no alternative.

---

## MV3 Service Worker Constraints

| Limitation | Impact | Workaround |
|-----------|--------|------------|
| SW can be killed at any time | The run is lost, not just a row: `_runStates` is an in-memory Map and is not persisted. The panel's Stop button stays visible and rows already written to IndexedDB are orphaned under a forgotten runId (audit D-01) | None yet |
| SW has no DOM access | All DOM work must go through content scripts | `chrome.tabs.sendMessage` to `content/injector.js`. (`chrome.scripting` is used only to register the network sniffer, not for DOM work) |
| SW lifecycle is unpredictable | Module-scope state (session key) resets on kill | AES-GCM key re-initialized on every `activate` event |
| `type: "module"` SW | Top-level `await` works; dynamic imports limited | Static imports only in SW; dynamic imports tested |

---

## Proxy Limitations

| Limitation | Notes |
|-----------|-------|
| `chrome.proxy` requires `proxy` permission | Listed in manifest; user is informed on install |
| SOCKS5 authentication not supported by Chrome Proxy API | Authenticated SOCKS5 proxies may fail; use HTTP proxied alternatives |
| PAC script applies to ALL tabs (not per-tab) | Rotating proxy during multi-tab runs affects all tabs |
| Background health check uses extension's network (not proxy) | Health check result may differ from actual proxy behavior in content scripts |
| No per-request proxy selection | Chrome's proxy API is session-scope; you cannot proxy one request differently than another in the same session |

---

## Form Filler Limitations

| Limitation | Notes |
|-----------|-------|
| React fiber hack is fragile | React's internal fiber keys change between versions; hack is best-effort and may fail on React 19+ |
| `file` input type (`<input type=file>`) | DataTransfer assignment works in most browsers but may be blocked by strict site CSPs |
| Shadow DOM fields | `document.querySelector()` does not pierce shadow roots; shadow-walker.js traversal needed for such fields |
| CAPTCHA auto-solve rate limits | Third-party CAPTCHA APIs have their own rate limits independent of FlowScrape's ethics gate |
| Custom web components | Non-standard input components (e.g., `<my-input>`) may not respond to native events; manual handler required |

---

## Data Parsing

| Limitation | Notes |
|-----------|-------|
| No data-file input exists | `data-sources/csv-parser.js` and `json-parser.js` are complete and imported by nothing. There is no UI to load a data file and no step that consumes one (audit F-02) |
| djb2 collisions | `utils/deduplicator.js` is not cryptographic — ~0.00000023% collision probability per row. It is also not currently used by anything |

---

## Script Export

| Limitation | Notes |
|-----------|-------|
| Emitters cover 11 of 21 step types | FILL, HOVER, SELECT, KEYBOARD, DRAG_DROP, UPLOAD_ACTIVITY, SCREENSHOT, PAGINATE, API_SNIFFER, PDF_EXTRACTION and AUTO_EXTRACT emit a `# TODO` comment. An exported script can silently do less than the pipeline (audit B-13) |
| Templates are not resolved | `{{loop.index}}` and friends are a runtime feature of the executor. The emitters copy config strings verbatim, so templates appear literally in the generated script (audit B-16) |
| Only proxy credentials are redacted | The README's "credentials are always redacted" claim covers the proxy env vars only. A password typed into a FILL step is emitted as written (audit B-14) |
| No Rust / Go emitters | Out of scope |

---

## API Key Manager

| Limitation | Notes |
|-----------|-------|
| Keys last one browser session | The AES key is stored alongside the ciphertext in `chrome.storage.session`, which Chrome clears on browser close. Until Batch 1 the key lived in module scope only, so keys became unreadable roughly thirty seconds after being saved — see the Storage and secrets section of the README for what the encryption is and is not worth |
| No Claude / Anthropic validator | Anthropic's validation endpoint requires a test call which costs tokens; validation skipped, key stored as-is |
| DeathByCaptcha uses user:pass format | Not supported by the standard key entry UI; enter as `user:pass` string in the key field |

---

## Side Panel

| Limitation | Notes |
|-----------|-------|
| `showSaveFilePicker` not available in side panels in some Chrome builds | Falls back to Blob download automatically |
| Auto-Map requires active tab | The tab must be on the target form page when clicking Auto-Map |
| Drag-and-drop reorders root steps only | Dragging a step inside a LOOP or an IF/ELSE branch silently does nothing, while the drop target still highlights as though it worked (audit E-05) |

---

## Ethics Engine

| Limitation | Notes |
|-----------|-------|
| Geo-distance calculation | Uses a simplified region-to-region comparison rather than true Haversine distance (> 5000km criterion is approximate) |
| robots.txt TTL is 15 min | A site could update robots.txt mid-run; FlowScrape will not re-check until cache expires |
| `robots.txt` fetch failure = allow | If robots.txt is unreachable (network error), FlowScrape warns but does not block (conservative but permissive) |

---

## Not reachable from the UI

These modules exist, mostly work, and are called by nothing. Each says so in its
own header.

| Subsystem | Audit |
|---|---|
| Proxy pool — parsing, rotation, health checks, PAC application | A-05 |
| Captcha solving — 2captcha, Anti-Captcha, CapSolver, and detection | A-06 |
| FORM_FILL — `form-filler.js`, `field-auto-mapper.js`, its ethics gates | A-07 |
| Data-file input — `csv-parser.js`, `json-parser.js` | F-02 |

Whether to wire them up or remove them is an open decision. Until it is made,
treat them as untested.

*Last reviewed against the code at batch 4.*
