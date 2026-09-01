# FlowScrape

A Chrome MV3 extension for visual web automation and data extraction. You build
a pipeline of steps on a node board in the side panel, run it against the active
tab, and export the results.

No build step. No bundler. Plain ES modules, loaded directly by Chrome.

> **Status.** This is a working tool with known gaps. Several subsystems in the
> tree are not reachable from the UI and are labelled as such, both here and in
> the modules themselves. [`docs/ISSUE_AUDIT.md`](docs/ISSUE_AUDIT.md) is a full
> inventory of what works, what does not, and what has been fixed so far. Read
> it before trusting any claim in this file.

---

## Quick start

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder
4. Click the FlowScrape icon; the side panel opens

Chrome 120 or newer.

### Working on it

```bash
npm install     # jsdom + fake-indexeddb, for the tests only
npm test        # 367 tests, ~9s, no browser needed
npm run check   # parses every source file as an ES module
npm run format  # prettier; `npm run format:check` in CI
```

The extension itself has no dependencies and nothing to build — `npm install`
is only for the test suite.

---

## How a run works

```
side panel  ──pipeline:preflight──▶  service worker  ──▶  ethics gates
    │                                     │                    │
    │  ◀── warnings, blockers ────────────┘                    │
    │                                                          │
    └──pipeline:start──▶  service worker  ─────────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │                    │
            steps that run in     steps that run in
            the background        the page
            (NAVIGATE, API,       (CLICK, FILL, EXTRACT,
             LOOP, EXPORT…)        SELECT, IF_ELSE…)
                    │                    │
                    │            chrome.tabs.sendMessage
                    │                    ▼
                    │            content/injector.js
                    │                    │
                    └────────▶  rows ────┘
                                 │
                       checkpoint/row-buffer.js  ──▶  IndexedDB
                                 │
                       exporters/row-formatters.js ──▶ download
```

Which context runs a given step is declared once, in
[`utils/step-types.js`](utils/step-types.js) — the single source of the step
vocabulary, read by the side panel, the script emitters and the MCP server.

---

## Project structure

```
manifest.json                  MV3 manifest
package.json                   test tooling only; the extension has no deps

background/                    Service worker
  service-worker.js            Pipeline orchestrator, message bus, export
  ethics-engine.js             7 pre-run gates
  llm-extractor.js             AUTO_EXTRACT layer 3 (Gemini Flash)
  api-key-manager.js           AES-GCM key store; captcha dispatch (unreachable)
  proxy-manager.js             Proxy pool (unreachable — see A-05)
  rate-limiter.js              Token bucket (barely used)

content/                       Page context
  injector.js                  Step dispatcher, selector picker, shadow host
  smart-extractor.js           AUTO_EXTRACT layers 1 & 2
  page-sniffer.js              fetch/XHR capture, injected only during a run
  overlay-engine.js            Scrape-zone overlays
  overlay-renderer.js          Per-zone overlay elements
  form-filler.js               (unreachable — see A-07)
  field-auto-mapper.js         (unreachable — see A-07)
  captcha-detector.js          (unreachable — see A-06)
  smart-sleep.js               (unreachable — injector has its own waits)

sidepanel/
  index.html                   UI and all styles; fonts bundled locally
  pipeline-builder.js          Board, palette, step config, run control
  overlay-panel.js             Overlay preferences
  fonts/                       Inter + JetBrains Mono, latin subset

utils/
  step-types.js                The step vocabulary — one definition
  version.js                   The version number — one definition
  logger.js                    Structured logger; redacts by key name
  color-utils.js               Zone colours, WCAG contrast
  strings.js                   UI strings (mostly unused)
  levenshtein.js               (unreachable)
  deduplicator.js              (unreachable)

checkpoint/
  idb-schema.js                Owns the IndexedDB schema
  row-buffer.js                Buffer rows, flush every 50 rows or 30s
  cursor-store.js              Run position for resume
  resume-manager.js            Incomplete-run detection

exporters/
  row-formatters.js            CSV · JSON · JSONL · TSV · XML · Markdown
  stream-writer.js             File System Access API, Blob fallback
  text-exporters.js            Save-dialog wrapper (unreachable)

ethics/
  robots-parser.js             RFC 9309 parser
  pii-detector.js              SSN · card · email · phone regexes

script-gen/
  pipeline-compiler.js         Pipeline JSON → AST
  python-emitter.js            AST → Python (playwright)
  node-emitter.js              AST → Node (playwright)

data-sources/
  csv-parser.js                (unreachable — no data-file input exists)
  json-parser.js               (unreachable)

mcp/                           Standalone MCP server (see mcp/README.md)
tests/                         367 tests; node:test, jsdom, fake-indexeddb
scripts/check-syntax.mjs       Parses every source file
docs/                          Audit, manual, template guide, limitations
examples/                      Pipeline JSON you can import
```

Modules marked unreachable are not dead in the sense of being broken — most
work — but nothing in the product calls them. Each one says so in its own
header, with the audit finding that explains why.

---

## Step types

Twenty-one, defined in [`utils/step-types.js`](utils/step-types.js).

| Category | Steps                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------ |
| Action   | `WEBSITE` `NAVIGATE` `CLICK` `FILL` `HOVER` `SELECT` `SCROLL` `KEYBOARD` `DRAG_DROP` `UPLOAD_ACTIVITY` |
| Flow     | `WAIT` `IF_ELSE` `LOOP` `PAGINATE`                                                                     |
| Data     | `EXTRACT` `SCREENSHOT` `EXPORT` `API` `API_SNIFFER` `PDF_EXTRACTION` `AUTO_EXTRACT`                    |

`PDF_EXTRACTION` is a stub inside the extension: it logs a message pointing at
the MCP server's `pdf_extract_text`, which does the real work.

### Templates

String config values support `{{loop.index}}`, `{{item.href}}`,
`{{extracted.price}}` and array indexing. See
[`docs/JinjaTemplateGuide.md`](docs/JinjaTemplateGuide.md). Every string in a
step's config is resolved, at any depth — including `FILL` field values and
`EXTRACT` field selectors. Templates are a runtime feature of the executor, so
an exported script carries them literally (audit B-16).

### AUTO_EXTRACT

Product pages only. Three layers, each run only if the previous one was not
confident enough:

1. **Structured data** — JSON-LD `@type Product`, microdata, Open Graph
2. **Heuristic DOM** — class/id keywords, font size, distance to the add-to-cart
   button, price regexes
3. **Gemini Flash** — only below the configured confidence, only if a Gemini key
   is stored, and only if the step's AI toggle is on

Rows carry `_confidence` and `_extractionMethod`.

---

## Ethics gates

Seven gates run before the first step. The side panel runs them as a preflight
and shows what they found; the service worker runs them again at start, so a
client that skips the preflight gains nothing.

| Gate                | Effect                                                                        |
| ------------------- | ----------------------------------------------------------------------------- |
| 1 robots.txt        | Warn if the path is disallowed (override with the bypass checkbox)            |
| 2 PII               | Deferred to the content side, which does not implement it — currently a no-op |
| 3 Rate limit        | Warn above ~100 req/hr estimated                                              |
| 4 Captcha volume    | Warn above 50 solves/hr estimated                                             |
| 5 Proxy geo         | Warn if the proxy region differs from the declared one                        |
| 6 Domain lock       | **Block** if any step's origin differs from the tab's                         |
| 7 Overlay readiness | Warn about selectors that match nothing on the page                           |

Gate 6 is aggressive: it blocks multi-domain pipelines and any `API` step
pointing at a third-party host. See audit B-03 — whether it should block, warn,
or exempt API steps is an open question.

---

## Storage and secrets

| Where                       | What                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `chrome.storage.session`    | API keys (AES-GCM ciphertext) and the key that encrypts them                                       |
| `chrome.storage.local`      | Pipelines per tab, overlay prefs, proxy pool metadata, the file library (base64, budgeted to 8 MB) |
| IndexedDB (`flowscrape_v3`) | Result rows, run cursors                                                                           |
| Module scope                | Nothing that has to survive a worker restart                                                       |

API keys live for one browser session and are cleared when Chrome closes.

**On the encryption**: the key sits in the same session-scoped storage as the
ciphertext it protects. There is no MV3 mechanism for a key that both outlives
service-worker termination and is never written down, and the previous design —
key in module scope only — meant keys silently became unreadable about thirty
seconds after you saved them. This is defence in depth against incidental
exposure, not protection from anything that can already read extension storage.

The logger redacts by key name and recurses into arrays and objects. It is not a
guarantee: a secret under an innocuous key still gets logged.

---

## Permissions

Seven, each with a call site, enforced by a test:

`scripting` · `storage` · `alarms` · `sidePanel` · `proxy` · `tabs` ·
`downloads`, plus `<all_urls>` host access.

`web_accessible_resources` lists five files — the modules the content script
dynamically imports — not the whole tree.

---

## Script export

A pipeline can be emitted as a runnable Python or Node script (Playwright).

The emitters cover **17 of the 21 step types**. The other four need the
extension itself and cannot be expressed standalone:

| Step              | Why                                              |
| ----------------- | ------------------------------------------------ |
| `UPLOAD_ACTIVITY` | Needs file bytes from the storage library        |
| `API_SNIFFER`     | Needs the in-page fetch/XHR hook                 |
| `PDF_EXTRACTION`  | Needs the MCP server's PDF tooling               |
| `AUTO_EXTRACT`    | Needs the three-layer extractor and a Gemini key |

Those emit an explicit `raise NotImplementedError` / `throw`, and are listed in
the run log before the download. They used to become a `# TODO` comment, so the
script ran and quietly did less than the pipeline.

Python or Node — pick the language in the toolbar next to the button.

**Credentials** are replaced with `__FS_ENV__NAME__` markers that both generated
scripts resolve from the environment at run time, so nothing is written into the
file. Detection is by config key name, by HTTP header name (`Authorization`,
`X-API-Key`, `Cookie`…), and by password-shaped selectors. A password typed into
a field none of those recognise is still emitted as written — nothing in the
config distinguishes it from any other text — so the run log lists every
credential it replaced, and what it did not find is visible by omission.

**Templates are not resolved.** `{{loop.index}}` is a runtime feature of the
executor; a standalone script has nothing to resolve it with. Any template left
in the pipeline is named in the run log before the download, rather than shipped
as literal braces in a URL (audit B-16).

---

## MCP server

[`mcp/`](mcp/) is a standalone Model Context Protocol server exposing 18 tools:
workspace file access, pipeline compile/validate/save/emit, PDF text
extraction, PII and robots checks, and row formatting. It shares
`utils/step-types.js` and `exporters/row-formatters.js` with the extension, so
validation and output match.

See [`mcp/README.md`](mcp/README.md).

---

## Docs

| File                                                                   | What it is                            |
| ---------------------------------------------------------------------- | ------------------------------------- |
| [`docs/ISSUE_AUDIT.md`](docs/ISSUE_AUDIT.md)                           | Full issue inventory, with fix status |
| [`docs/flowscrape-master-manual.md`](docs/flowscrape-master-manual.md) | Per-function reference (partly stale) |
| [`docs/JinjaTemplateGuide.md`](docs/JinjaTemplateGuide.md)             | Template syntax                       |
| [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md)               | Platform constraints                  |
| [`docs/TEST_CHECKLIST.md`](docs/TEST_CHECKLIST.md)                     | Manual browser checks                 |

---

## License

MIT — see [LICENSE](LICENSE).
