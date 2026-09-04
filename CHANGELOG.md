# Changelog

All notable changes to this project.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`utils/version.js` is the single definition of the version number; a test fails
if any copy of it drifts.

## [Unreleased]

Everything below was found by a full-repository audit
([`docs/ISSUE_AUDIT.md`](docs/ISSUE_AUDIT.md), 149 findings) and fixed against
it. Entries name the finding, so the audit and this file can be read together.

Every fix landed with regression tests, and every test was run against the
pre-fix tree first to confirm it failed. The suite went from **zero tests to
630**, plus **63 end-to-end checks** that load the extension into a real
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
- **`PAGE_DATA` reads the structured data the page already publishes** (J-07) —
  JSON-LD, Schema.org microdata, Open Graph. No selectors at all, already typed
  and named, and it does not break when a designer renames a class. The existing
  JSON-LD reader only ever looked for `@type: Product`, so a recipe, a job
  posting, an article or an event was invisible.

  This is the answer to "can we just turn the page into JSON" for a single
  record — a product, an article — which Detect Table cannot help with, because
  there is nothing repeating to find. Detect Table now offers it when it finds
  no table, and only when there is something to read.

- **`IF_ELSE` can ask about emptiness, numbers and patterns** (J-08) — "only
  scrape items under £50" and "skip the row when the price is missing" could not
  be expressed at all before. The page reports what it saw and the worker
  decides, so a numeric branch uses the same number reader `EXTRACT` does rather
  than a second copy of it.
- **`SCREENSHOT` can capture the whole page or one element** (J-11), not just
  the visible strip. Full-page walks the page and joins the strips, puts the
  scroll position back, and truncates a bottomless feed rather than looping
  forever. A fixed header repeats in each strip — that is what stitching does,
  and it is stated rather than hidden. Captures are paced: Chrome allows about
  two a second, which the first real-browser run discovered by being refused.
- **The API sniffer can be filtered** (J-10) by URL and method, before the
  bounded buffer rather than after it, so analytics and font requests can no
  longer push the calls you wanted out of the capture.
- **`KEYBOARD` has a target and a repeat count** (J-09). It typed at whatever
  had focus, once.
- **Extracted values are cleaned as they are read** (J-06). `"$25.50"` arrives
  as `25.5`, `"/p/123"` as a full URL. Number reading handles European decimals,
  where the comma is the point — `"1.234,56"` read as `1.234` is a hundredfold
  error in a price column with nothing to signal it — and text with no number in
  it becomes empty, never `0`, because `0` is a plausible price. Detect Table
  picks the obvious transforms itself.

### Fixed — reported from real use

Six findings, all from someone actually running the extension rather than from
reading the code.

- **Nothing could reach inside an iframe** (J-14). The content script was
  injected into the top document only, and an iframe is a separate document
  rather than a branch of its parent's DOM — so no step could touch anything
  in one, on any site. Injection reaches every frame now, and each page step
  carries a **"Look inside iframes as well"** toggle. A toggle rather than
  always searching, because searching every frame changes what an ambiguous
  selector matches and a page can carry a dozen advertising iframes.
- **Half the step types could not be tested** (J-15) — `Unknown step type:
LOOP`, `Unknown step type: API_SNIFFER`, and PDF extraction with them. The
  test path forwarded anything it did not special-case to the page, and ten of
  the twenty-two types run in the worker. It asks the registry where a step
  runs now, and the three that genuinely cannot be tested alone say why.
- **The API sniffer captured and threw the captures away** (J-16). It hooked
  the page and recorded requests; the run state holding them was deleted the
  moment the run ended, and `data:download` never returned them. So the only
  way to see one was inside the export archive.
- **Detect Table ignored a table's own header row** (J-17), naming columns
  `tdnthoftype, tdnthoftype 2, …` while the page's `<thead>` said `name,
author, stars, price`.
- **`HOVER` reported success whatever happened** (J-18). It can open a
  JavaScript menu and cannot open a CSS `:hover` one — `:hover` follows the
  real mouse pointer, which no page may move. It can now be told what should
  appear, and fails with that explanation when nothing does.
- **A browser shortcut could not be registered, only triggered** (J-19):
  pressing Ctrl+W to capture it closed the tab, as it always will. Combos can
  be typed now, and a reserved one is flagged.

### Fixed — found by running it on a real website

The first scrape against a site I did not write the markup for
(`scrapethissite.com`) returned the right data in the wrong shape (J-12):

```
country name,strongnthoftype,country capital,strongnthoftype 2,…,sup
Andorra,Capital:,Andorra la Vella,Population:,84000,Area (km2):,468.0,2
```

- **Detect Table returned the page's own labels as columns.** Real markup labels
  its fields inline — `<strong>Capital:</strong>` beside the value — and those
  have the same shape in every record, so they read as perfectly consistent
  columns. Three held one label repeated 250 times; a fourth held the `2` from
  `km<sup>2</sup>`. A column whose value never changes is now dropped, and
  samples are kept for every record rather than the first three, because
  constancy cannot be judged from three.
- **`"1.4E7"` was read as `1.4`.** That is how the site reports Antarctica's
  area, and the numeric run stopped at the `E` — fourteen million became one
  point four, which looks entirely plausible in a column of areas.
- **Detect Table stacked a second scrape of the same list** (J-13), which is
  where the run's 1,250 rows for 250 countries came from: the button appended a
  loop each time it was pressed, said "Added a loop", and never mentioned that
  the previous one was still on the board. The generated pipeline was correct —
  reproduced in a real browser, it yields exactly one row per record. An
  existing loop over the same selector is now found first, and replacing it is
  a question rather than an accident.
- **Plain-number columns were left as text**, because the automatic transform
  only recognised money. A column whose samples are _all_ cleanly numeric is now
  read as numbers — all, not a majority, so a column that is 90% numbers and 10%
  `"N/A"` is left alone rather than having that 10% quietly emptied.

### Fixed — the exported scripts

- **A regex transform reached neither script intact.** In JavaScript `\S` in a
  single-quoted literal is just `S`; in Python the same pattern was emitted into
  an `r""` raw string with the backslash doubled. Both scripts parsed, ran, and
  matched nothing. The suite now reads the emitted pattern back and checks what
  it _matches_ rather than how it is spelled, and an unusable pattern is emitted
  as a refusal instead of repaired.
- **The browser snippet `PAGE_DATA` hands to Playwright** was embedded in a
  Python `"""…"""` literal with escaped single quotes, which Python resolves
  before the browser sees them — arriving as JavaScript with an unterminated
  string. It compiled as Python, because to Python it is just text.
- **Every `IF_ELSE` condition but `exists` was emitted as `if (true)`** with a
  TODO comment beside it, so an exported script took the IF branch
  unconditionally — it ran, produced a file, and had silently ignored its own
  branching. The existing check could not see it: it looks for `# TODO` in the
  Python output, and the Node stub was a `//` comment.
- The emitted scripts are now **compiled** in the test suite — `node --check`
  and `python -m py_compile` over a pipeline using every construct the emitters
  can produce. Pattern-matching the output is happy with source that will not
  parse.

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
