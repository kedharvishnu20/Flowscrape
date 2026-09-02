# Changelog

All notable changes to this project.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`utils/version.js` is the single definition of the version number; a test fails
if any copy of it drifts.

## [Unreleased]

Everything below was found by a full-repository audit
([`docs/ISSUE_AUDIT.md`](docs/ISSUE_AUDIT.md), 135 findings) and fixed against
it. Entries name the finding, so the audit and this file can be read together.

Every fix landed with regression tests, and every test was run against the
pre-fix tree first to confirm it failed. The suite went from **zero tests to
501**, plus **42 end-to-end checks** that load the extension into a real
Chromium and drive it — which is what caught four of them, including the two
worst.

### Added — what the steps can now do

Section J of the audit. These are not defects in the A–I sense; they are
capabilities the configuration promised and the code did not have.

- **`WAIT` can wait for something** (J-01), instead of only for the clock. Wait
  for an element to appear, for one to disappear, or for the page to stop
  changing. The first two had been implemented in the content script since the
  first commit and were unreachable: the worker's WAIT case slept and returned,
  so nothing ever forwarded them. "Appear" means rendered, not merely present —
  a `display:none` placeholder matching the selector is what makes an existence
  check resolve early and hand the next step an empty page.
- **`SCROLL` has an infinite mode** (J-02) that scrolls until the page stops
  growing, for feeds and "load more" lists. Bounded, and it says whether it
  stopped because the feed ended or because it ran out of scrolls.
- **`PAGINATE` knows when the pages run out** (J-03). It was
  `return _stepClick(config)` — a click under a different name — so a loop set
  to 10 pages ran its body 10 times whether or not the site had 10 pages, and
  re-scraped the last one. A Next control that is missing, disabled, hidden or
  hrefless now ends the loop, and it says which.
- **`NAVIGATE` waits for the page** (J-04) rather than sleeping three seconds
  and hoping. A slow page is no longer scraped empty; a fast one no longer costs
  three seconds per iteration.
- **Seven step types have a configuration UI** (J-05) — WAIT, HOVER, SELECT,
  DRAG_DROP, PAGINATE, SCREENSHOT and API_SNIFFER fell through to a loop that
  rendered raw config keys as labels, so DRAG_DROP offered "source" and "target"
  and nothing else.
- Both script emitters were brought along, so an exported script does what the
  pipeline does: the new wait modes, the infinite scroll loop, and a paginating
  LOOP that clicks Next — which the emitted loop never did at all.

### Fixed — the product did not work

- **FILL could not fill any framework-controlled input** (B-10). It assigned
  `el.value` and dispatched a plain `Event`; React caches the last value it saw,
  saw no change, and overwrote the field on its next render. The step reported
  success over an empty box. Vue and Angular lost the same way. It writes
  through the prototype's native setter now, and verifies the value stuck.
  Checkboxes, radios, `<select>` and contenteditable are handled instead of
  silently doing nothing.
- **`Disallow:` blocked the whole site** (B-17). The canonical "everything is
  allowed" line matched every path. Plus four more RFC 9309 defects: `$`
  escaping, group merging, Allow tie-breaks, and 4xx handling (B-18).
- **Pause did nothing and could not be reached** (E-01). There was no resume
  message at all, and the executor had stopped reading the flag.
- **The selector picker could deadlock** (E-02). It resolved only on click — no
  Escape, no cancel, no timeout — leaving the panel awaiting forever.
- **`SELECT` silently cleared the control** when no option matched (B-23), and
  `KEYBOARD` sent `code` values no real keyboard produces (B-24).
- **Templates did not resolve below the top level** (B-11), so `{{item.href}}`
  inside a FILL field was typed into the page verbatim.
- **`PDF_EXTRACTION` never parsed anything** (B-28). It had a full config UI and
  stored `{status: "pending"}`. The extension reads PDFs itself now —
  [`utils/pdf-text.js`](utils/pdf-text.js), no dependencies.
- **API keys were never validated** (F-03). Six validators existed and nothing
  called them; a typo saved exactly like a working key.
- **Script export always emitted Python** (B-12); the Node emitter had no route
  from the UI at all.

### Fixed — data loss and lies about data

- **Rows were silently duplicated on export** (D-07): dedup compared stringified
  rows, and an IndexedDB round-trip does not preserve key order.
- **Every page step after a navigation failed** (A-13). Content scripts are
  injected on demand and die with their document; only the start of a run
  injected them. So a pipeline that turned a page collected the first page and
  then logged `Receiving end does not exist` once per step — which is most of
  what a scraper does. Found by an end-to-end check that paginated three pages
  correctly and came back with one row.
- **`EXPORT` had never downloaded a file** (A-12). The worker called
  `URL.createObjectURL`, which MV3 service workers do not have, so every export
  failed and produced nothing. It passed 442 unit tests because the test harness
  defined that function for the worker — a mock more capable than the runtime.
  Found by running an export in a real browser.
- **One failed `indexedDB.open` disabled all persistence** for the worker's life
  (A-10, found while testing D-12) — the rejected promise stayed cached, and
  every later write failed with the original error.
- **The PDF reader lost every stream after the first** (A-11), because
  `endstream` ends in `stream`. Eighteen hand-built fixtures passed; a
  Chrome-printed PDF came back empty.
- **A transient flush failure killed the step that produced the row** (D-12),
  under a docblock promising the opposite.
- **The keep-alive could not keep anything alive** (D-02). Chrome clamps the
  alarm period it used to a full minute; the idle timeout is 30 seconds.
- **Screenshots and sniffed requests grew without bound** (D-10, D-11) until the
  worker ran out of memory, mid-run.
- **Row padding invented data** (B-08), and `EXTRACT` could not read an attribute
  at all (B-07).
- **XML and Markdown export were missing** and three CSV serializers disagreed
  (D-03…D-06, D-08).

### Fixed — security and privacy

- **Any web page could drive the step executor** (C-01). The only guard was
  `event.source !== window`, which every script in the page satisfies. The
  module docblock claimed an origin check that did not exist.
- **The network sniffer ran on every page** (C-02), and **two content scripts ran
  on every page the user visited** (C-09) for a tool that acts on one tab.
  Everything is injected on demand now.
- **Credentials were written into exported scripts in plaintext** (B-14), under a
  README claiming they were always redacted.
- **Proxy credentials were logged** (C-03), and the log sanitiser skipped arrays
  (C-11).
- **The MCP HTTP transport bound every interface** with no authentication (C-06).
- **Untrusted text was interpolated into the panel's DOM** (C-04, C-05).
- **A proxy health check left the whole browser proxied** (B-19).
- Four unused permissions dropped, `web_accessible_resources` cut from ten
  wildcards to five named files (C-07, C-08).

### Fixed — the UI

Pause and Resume (E-01); a cancellable picker (E-02, E-03); a row counter that
counts rows (E-04); `alert()` replaced with a toast and a log entry (E-06); test
steps that report what they returned (E-07); keyboard operation of the whole
panel (E-09); editing that no longer loses the caret (E-10); wires that redraw
once a frame instead of once per pointer move (E-11); an explained zoom modifier
(E-12); a board that stays with its running tab (E-13); confirmation before
destructive actions (E-14); drag-and-drop that works inside loops and branches
(E-05); editable field rows (E-16); a key-capture countdown (E-17); a bounded log
pane (E-18); and a storage panel that shows how full it is (E-20).

### Changed

- **One definition of each shared thing**, each with a test that fails on drift:
  the step vocabulary ([`utils/step-types.js`](utils/step-types.js), G-01), row
  formatting ([`exporters/row-formatters.js`](exporters/row-formatters.js),
  D-03), the IndexedDB schema
  ([`checkpoint/idb-schema.js`](checkpoint/idb-schema.js), A-03), the version
  number ([`utils/version.js`](utils/version.js), I-04), and one step dispatch
  chain instead of two that had drifted (B-27).
- **Rate limiting is enforced**, not just warned about (F-09). Ethics gate 3 said
  a run was too fast and nothing slowed it down.
- **The domain lock guards the actual risk** (B-03) rather than blocking every
  multi-origin pipeline.
- Documentation rewritten from the code (H-01…H-07, H-10). The old README
  described a planned architecture, presented dead modules as live, and asserted
  a security check that was not implemented.
- Prettier, and a test suite where there was none (I-01, I-02).

### Removed

Dead modules, each for a stated reason (F-01, F-02, F-07):
`data-sources/csv-parser.js` and `json-parser.js` (no input path exists),
`utils/deduplicator.js` (superseded), `content/smart-sleep.js` (unusable from a
classic content script), `utils/strings.js` (nothing rendered it).

`exporters/text-exporters.js`, `exporters/stream-writer.js`,
`utils/levenshtein.js` and `background/rate-limiter.js` were kept and wired up
instead — they were written for callers that never called.

### Known limitations, stated rather than hidden

- Capture buffers are **bounded**, not streamed to IndexedDB. A run that fills
  them keeps going, drops the excess, and says how much (D-10, D-11).
- Credential detection for script export is **heuristic** — key names, header
  names, password-shaped selectors. A password in a field none of those match is
  still emitted as written, so the export lists every credential it replaced
  (B-14).
- `D-01` is fixed in the sense that matters: a run lost to a terminated worker is
  **detected and reported**, and its rows stay downloadable. Resuming the
  pipeline itself is not attempted.
- Three modules remain unreachable on purpose: `form-filler.js`,
  `field-auto-mapper.js`, `captcha-detector.js` (A-05, A-06, A-07). The reasoning
  is in the audit.

## [3.0.0]

The state the audit was written against. Git history before this point labels
the same code `v3` and `v4` interchangeably, which is part of what I-04 was
about.
