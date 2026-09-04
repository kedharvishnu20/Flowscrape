# FlowScrape — Full Issue Audit

**Audited commit:** `b2baae8` (branch `dev`, branched from `master`)
**Scope:** every file in the repository — extension (`manifest.json`, `background/`, `content/`, `sidepanel/`, `checkpoint/`, `data-sources/`, `exporters/`, `script-gen/`, `ethics/`, `utils/`), the MCP server (`mcp/`), and all documentation.
**Method:** full read of all 18,632 lines of source + docs, ES-module syntax check of every `.js`/`.mjs` (all parse cleanly), DOM-id cross-reference between `index.html` and `pipeline-builder.js`, import-graph analysis, npm-registry verification of the MCP SDK surface.

**Totals:** 160 findings — 18 blocker · 41 high · 71 medium · 30 low. The
original audit recorded 126; four blockers were found while fixing them (A-10 …
A-13, three of the four in a real browser) and section J adds five capability
gaps found by reading every step type against its implementation.

| Section                         | Findings |
| ------------------------------- | -------- |
| A · Blockers                    | 13       |
| B · Logic & correctness         | 34       |
| C · Security & privacy          | 12       |
| D · Data integrity & edge cases | 14       |
| E · UI / UX                     | 20       |
| F · Dead code & wiring gaps     | 10       |
| G · MCP integration             | 9        |
| H · Documentation               | 12       |
| I · Project hygiene             | 6        |
| J · Capability gaps             | 30       |

---

## Status

Findings are recorded as of the audited commit. Fixes land on `dev` and are
listed here as they do, so this document does not drift out of step with the
code the way the rest of the docs did.

**Batch 1 — fixed** (the blockers that stop the product working at all):

| Finding    | Commit    | Notes                                                                    |
| ---------- | --------- | ------------------------------------------------------------------------ |
| A-03       | `1d3ca3d` | Schema moved to `checkpoint/idb-schema.js`; `DB_VERSION` 2               |
| A-04       | `30234ac` | Also fixes the proxy pool emptying after idle (part of D-02)             |
| A-08       | `9502845` | Also fixes the un-awaited `previewAll`, and F-08's `overlay:reloadPrefs` |
| A-09       | `44e3958` | Latin-subset variable faces vendored under `sidepanel/fonts/`            |
| A-01, A-02 | `94507cf` | Dead code removed rather than the missing markup added                   |
| B-01, B-02 | `d4a5d74` | New `pipeline:preflight`; gate 6 left as-is pending the B-03 decision    |

**Batch 2 — fixed** (Phase 2, the silent-failure sweep):

| Finding          | Commit    | Notes                                                                         |
| ---------------- | --------- | ----------------------------------------------------------------------------- |
| I-01, I-03, I-06 | `91cd668` | `npm test` (Node's runner) and `npm run check`; root `package.json`           |
| B-04, B-05, B-06 | `49c0ddb` | Also distinguishes LLM failure causes, and fixes two unstyled log levels      |
| B-07             | `4ae289a` | Also fixes the field-type select, which was wired to `click` and never worked |
| B-08             | `02a4f60` | Adds a jsdom harness; audit entry corrected in the same commit                |
| B-09             | `293b215` | Fallback is now a per-step toggle, off by default                             |

**Batch 3 — fixed** (Phase 3, security):

| Finding    | Commit    | Notes                                                                   |
| ---------- | --------- | ----------------------------------------------------------------------- |
| C-01, H-09 | `afe806b` | Page-facing step surface removed; sniffer payload clamped               |
| C-03, C-11 | `a6d6595` | Credentials redacted in logs; `_sanitize` now recurses arrays           |
| C-02       | `84b98ca` | Sniffer registered at runtime, origin-scoped, only during a sniffer run |
| C-07, C-08 | `1b57423` | 4 unused permissions dropped; WAR cut from 10 wildcards to 5 files      |

**Batch 4 — fixed** (remaining security, correctness and documentation):

| Finding                           | Commit        | Notes                                                                                |
| --------------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| C-04, C-05, E-18                  | `0b09f04`     | Log entries built as nodes; `esc` completed; log pane capped                         |
| C-06, G-02, G-03, F-06            | `6fca25a`     | MCP binds loopback, writes gated, CLI flags fixed, deps trimmed                      |
| G-01, E-08                        | `d622e48`     | `utils/step-types.js` is now the one definition                                      |
| B-19, B-20, B-21                  | `ce7278a`     | Proxy health check restores settings; also fixed a `socks5://` parser bug it exposed |
| D-03, D-04, D-05, D-06, D-08      | `c7ccc95`     | `exporters/row-formatters.js` replaces four implementations                          |
| H-01…H-07, H-10, F-05, G-04, I-05 | _docs commit_ | README rewritten from the code; LICENSE added; duplicate README removed              |

**Not fixed by decision:** A-05, A-06, A-07 (proxy rotation, captcha solving,
FORM_FILL). All three are unreachable, so they behave identically whether
removed or kept. Enabling them adds a class of capability that was never asked
for; deleting them forecloses that. Each module now states plainly that nothing
calls it, and B-19 — the one dangerous latent bug among them — is fixed. Their
own defects are still fixed as defects: B-33 (captcha poll recursion) and B-34
(shared rotation cursor) are done.

**How F-01's nine modules were resolved, one at a time.** "Dead code" is not one
decision:

| Module                                                                  | Outcome                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `data-sources/csv-parser.js`, `json-parser.js`                          | **Deleted.** No data-file input path exists; building one is new product scope, not a fix                           |
| `utils/deduplicator.js`                                                 | **Deleted.** `_rowKey` in the worker supersedes it (D-07)                                                           |
| `content/smart-sleep.js`                                                | **Deleted.** `injector.js` is a classic content script and cannot import a module, so it could never have used this |
| `utils/strings.js`                                                      | **Deleted.** Its only importer never referenced anything on it, and the panel hardcodes its text (F-07)             |
| `exporters/text-exporters.js`, `stream-writer.js`                       | **Wired up.** The panel's partial-run download uses them, for the save dialog a worker cannot show                  |
| `utils/levenshtein.js`                                                  | **Wired up.** `field-auto-mapper.js` imported it instead of keeping its own copy                                    |
| `background/rate-limiter.js`                                            | **Wired up.** The executor paces every page- and network-touching step (F-09)                                       |
| `content/captcha-detector.js`, `field-auto-mapper.js`, `form-filler.js` | **Kept**, per the decision above                                                                                    |

**Batch 5 — fixed:**

| Finding                | Commit    | Notes                                                                                                                                                                                    |
| ---------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-03                   | `d51d72a` | Gate 6 reports authored origins; undeclared ones are blocked at execution, where a templated URL is finally known. Gates 2, 3, 4 and the FORM_FILL constraints now walk nested steps too |
| B-27                   | `f7a742c` | One `_dispatchStep`; first behavioural tests for the executor                                                                                                                            |
| B-13, B-15             | `27865a4` | 6 more step types emitted; the remaining 4 fail loudly and are reported. SCROLL reads `config.amount`                                                                                    |
| D-01, B-26, D-14, H-08 | `c9b7d93` | A lost run is detected and reported instead of hanging the UI; completed runs stop being resumable; the `"latest"` sentinel is gone                                                      |
| E-01, E-02, E-03       | `0b087e5` | Pause/Resume exists end to end; the picker can be cancelled and its overlay actually blocks. See the note below on E-01                                                                  |

| E-04, E-06, E-07, E-14 | `1a35b1c` | The row card counts rows; `alert()` replaced by a toast plus a log entry; a test step reports what it returned; both Clear buttons confirm first |

| B-17, B-18 | `3e19288` | Empty `Disallow:` no longer blocks the site; `$` is escaped and anchors deliberately; group merging and Allow tie-breaks now follow RFC 9309; any 4xx counts as no-robots |

| B-10, B-23, B-24, B-25, B-31 | `2331ef5` | FILL writes through the native setter and handles checkbox/radio/select/contenteditable; SELECT matches by label and fails loudly; KEYBOARD emits real `code` values; text conditions normalise whitespace; percent scroll measures the document |

| B-11, B-22 | `7b7d669` | Templates resolve at any depth; LOOP rejects a zero count instead of running nothing, and a failed element query skips rather than looping blind |

| D-02, D-07, D-10, D-11 | `e216049` | A real keep-alive replaces the clamped alarm; capture buffers are bounded and say when they fill; export dedup no longer depends on key order |

| B-12, B-14, B-16, D-09 | `cc38011` | Node emitter reachable; credentials become env markers both scripts resolve; templates named before download; imports validated against the registry and filled from its defaults |

| E-10, E-13, B-29, B-30, C-12 | `7a03e5d` | The board stays with a running tab; editing no longer loses the caret; screenshots stop stealing focus and honour quality; the file library checks its budget before writing |

| I-02, I-04, G-06, G-07, G-08 | `92e2ac7` | Prettier config and `npm run format`; one `utils/version.js` with a test that fails on drift; MCP search takes a file-name pattern and says a glob is not a directory; `pipeline_report` stops emitting two scripts to measure them. The MCP emit tools also gained the B-14/B-16 handling |
| F-03, F-10 | _this batch_ | API keys are validated on save, which makes the six validators reachable; the example uses a selector that can match, and `examples/` has a README |
| C-10, B-32, D-12, D-13, E-19, **A-10** | _this batch_ | Log level switchable and quiet in a packed build; unreachable content-script handlers removed; a failed flush no longer kills the step; the ring-buffer claim corrected; the finished run stops matching the log filter. A-10 is new — found while testing D-12 |
| E-05, E-09, E-11, E-12, E-15, E-16, E-17, E-20 | _this batch_ | Drag-and-drop works anywhere in the tree; the panel is keyboard-operable; wires redraw once a frame; the zoom modifier is explained; IF_ELSE can be optional; field rows are editable; key capture counts down; the library shows how full it is |
| B-28, G-05 | _this batch_ | `utils/pdf-text.js` reads PDFs in the worker with no dependencies; both "use an MCP tool" messages are gone, one of which named a tool that never existed |
| C-09, F-01, F-02, F-04, F-07, F-09, B-33, B-34 | _this batch_ | Content scripts injected on demand instead of running on every page; the dead half resolved module by module; rate limiting actually paces a run; captcha polling loops; sticky and round-robin get separate cursors |
| H-12 | _this batch_ | `CONTRIBUTING.md`, `CHANGELOG.md` and `docs/ARCHITECTURE.md` — the last had ten decisions in it that were only recorded in module docblocks, if anywhere |
| **A-11** | `19e3725` | New. The PDF reader mis-framed every stream after the first, because `endstream` ends in `stream`. Found by running it against a Chrome-printed PDF in the e2e suite |
| **A-12** | _this batch_ | New. `EXPORT` downloaded nothing in any real browser: MV3 service workers have no `URL.createObjectURL`, and the unit harness stubbed one in |
| **A-13**, plus the step-capability work | _this batch_ | New. Every page step after a navigation failed, because the on-demand content script is destroyed with its document and only the start of a run re-injected it. Found by the paginating e2e check. Landed alongside the J findings below |
| **J-30** | _this batch_ | New. The capture engine was correct after J-26 — an early fetch, an XHR, a cross-origin call and a timer-fired one all stored — but the download button discarded the captures and reported "that run stored no rows", and the log names only the first three, so a busy site went silent mid-run |
| **J-28**, **J-29** | _this batch_ | New. J-28 is a regression J-26's fix introduced and the user caught within the hour: registering injector.js as a content script let it be evaluated twice, and its top-level `const`s collide at instantiation — the whole content script was lost. It is wrapped in a function now. Fixing it also exposed two tests that had been passing vacuously |
| **J-24** … **J-27** | _this batch_ | New, all four from real use. Neither selector mode did what it said — Specific returned the whole column, Bulk returned every cell in the table. Detect Table dropped every column rendered as icons rather than text. The API sniffer's MAIN-world hook had no isolated-world listener after a navigation, so it captured nothing on any run that navigated. And a paginating loop offered a bulk picker for its one Next button |
| **J-23** | _this batch_ | New. The board was a 1400x1200 pan/zoom canvas inside a 400px panel, so nested steps were laid out where they could not be seen — the "UI constraints" that made dropping a step into a loop look broken. It is a scrolling list now, and the panel has an actual visual design rather than framework defaults |
| J-20, J-21, J-22 | _this batch_ | A field picked inside a loop is described relative to the record, which is what makes a grid of product cards scrapeable; steps can be dragged into a loop; and PAGE_JSON returns the page itself as JSON |
| J-14 … J-19 | _earlier_ | Steps can reach inside iframes; every step type can be tested; the API sniffer's captures survive the run that made them; a table names its own columns; HOVER says when it achieved nothing; a browser shortcut can be typed rather than pressed. All six reported from real use |
| **J-13** | _earlier_ | Detect Table appended a second loop over the same list every time it was pressed, without a word — which is where a real run's 1,250 rows for 250 countries came from |
| J-08 … J-12 | _this batch_ | IF_ELSE can ask about emptiness, numbers and patterns; KEYBOARD has a target and a repeat; the sniffer can be filtered; SCREENSHOT can capture the whole page or one element; and Detect Table stops returning a page's own labels as columns |
| J-06, J-07 | _this batch_ | Extracted values are cleaned as they are read, in one module both emitters share; and PAGE_DATA reads the JSON-LD, microdata and Open Graph every site already publishes — the answer to "turn the page into JSON" for a single record |
| J-01 … J-05 | _this batch_ | WAIT's element and DOM-settle modes reachable at last; infinite scroll; pagination that knows when the pages run out; navigation that waits for the page; the seven step types that had no configuration UI |
| F-08, G-09, H-11 | _earlier commits_ | Fixed as a side effect and only noted in their own entries: F-08 by the `overlay:reloadPrefs` handler in `9502845`, G-09 by the shared row formatter in `c7ccc95`, H-11 by nested template resolution in `7b7d669`. Listed here so the count reconciles |

**Still open: nothing.** 157 of 160 findings fixed; A-05, A-06 and A-07 left by
decision, as set out above. The count grew from the original 126 because four
findings were discovered while testing the fixes for others and added to the
audit rather than fixed silently — A-10 (a cached IndexedDB failure), A-11 (PDF
stream framing), A-12 (`EXPORT` downloading nothing at all) and A-13 (every page
step after a navigation failing) — and because section J records thirteen
capabilities the steps advertised and did not have — the last two, J-12 and
J-13, found by running the extension against a real website rather than a
fixture, and by counting the rows it brought back. Three of the four new
blockers came from running the code in a real browser, which is why
`npm run e2e` exists.

The four **Correction** paragraphs in the sections below mark entries that were
overstated or wrong when written. They are left in place, corrected, rather than
edited into looking right.

**E-01 was worse than recorded, and partly my doing.** The finding says the
backend was fully wired and only the button was missing. By the time it was
fixed that was no longer true twice over: there had never been a
`pipeline:resume` message — `PIPELINE_PAUSE` set the flag and only
`PIPELINE_STOP` cleared it, so pausing a run could only ever end it — and the
`_executeSteps` merge in `f7a742c` (B-27) had dropped the `paused` wait
entirely, making the flag inert. Both are fixed, and the wait now sits in the
shared step loop, so pause applies inside `LOOP` bodies and `IF_ELSE` branches
for the first time.

**D-01 is fixed in the sense that matters, not fully.** Resuming a pipeline
from where a terminated worker left off would mean re-entering the step chain
with the right template context against a tab that may since have navigated.
That is not attempted. What is fixed is the silence: the loss is detected,
reported, and the collected rows stay downloadable.

---

## Severity key

| Tag         | Meaning                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| **BLOCKER** | Feature is dead on arrival — it throws, silently no-ops, or can never be reached by a user |
| **HIGH**    | Works sometimes, produces wrong results, or is a real security/privacy exposure            |
| **MEDIUM**  | Correctness or UX defect with a workaround                                                 |
| **LOW**     | Hygiene, polish, minor drift                                                               |

---

# A. Blockers — code that cannot work as written

### A-01 · BLOCKER · `_sleep` is not defined in the side panel

`sidepanel/pipeline-builder.js:488` calls `await _sleep(450)` inside `_runUploadActivity()`, but `_sleep` is **never defined anywhere in that file** (the only occurrence in the whole file is the call site). The first iteration throws `ReferenceError`. Because `_startUploadActivityFromSelection()` calls `_runUploadActivity()` without `await` or `.catch()`, the rejection is unhandled and invisible: the activity row is created, stays `running` forever, and never completes.

### A-02 · BLOCKER · The entire "Upload Setup" UI section is missing from the HTML

Six element IDs are wired up in JS but do not exist in `sidepanel/index.html`:

| Referenced in `pipeline-builder.js` | Purpose                      |
| ----------------------------------- | ---------------------------- |
| `upload-file-selector`              | file checkbox list           |
| `upload-setup-count`                | selected-file counter        |
| `btn-upload-setup-select-all`       | select all                   |
| `btn-upload-setup-clear`            | clear selection              |
| `btn-upload-start`                  | start upload                 |
| `upload-activity-list`              | activity list (Storage view) |

Every lookup uses `?.`, so it fails silently. `renderStoragePanel()` maintains `_selectedStorageFileIds` for a selector that is never rendered. The Storage tab contains only the "Storage Library" accordion. **Net effect: the entire Storage→Upload workflow is unreachable**, and A-01 means it would crash even if the markup existed.

### A-03 · BLOCKER · IndexedDB store collision silently kills checkpoint/resume

`checkpoint/row-buffer.js:33` and `checkpoint/cursor-store.js:32` both open database `flowscrape_v3` **at version 1**, but declare different stores in `onupgradeneeded`:

- `cursor-store` creates `cursors`, `row_buffer`, `data_rows`
- `row-buffer` creates **only** `data_rows`

`initBuffer()` runs first at pipeline start (`service-worker.js` `_executePipeline`), so `row-buffer` wins the race and creates the DB at v1 with only `data_rows`. `cursor-store` then opens v1, gets no upgrade event, and every `db.transaction(['cursors'])` throws `NotFoundError`.

Consequences, all silent because the SW wraps the call in `.catch(() => {})`:

- `saveCursor()` fails on **every step of every run** — checkpointing does not exist
- `listCursors()` / `getResumePayload()` / `checkpoint:check` fail — the resume banner never appears
- The whole `checkpoint/` subsystem and its README/manual claims are inoperative

**Fix:** bump `DB_VERSION` and put the schema in one shared module.

### A-04 · BLOCKER · API keys become permanently undecryptable after the first service-worker restart

`background/api-key-manager.js` holds the AES-GCM key in module scope only, and re-initialises it **only** in the `activate` listener (`service-worker.js:103`). MV3 kills an idle SW after ~30 s; on the next wake, `activate` does **not** fire again. `_ensureKey()` (`api-key-manager.js:47`) then generates a _brand-new_ random key, so every ciphertext already in `chrome.storage.session` decrypts to garbage. `getApiKey()` catches the failure and returns `null`.

Result: the user saves a Gemini/OpenAI/2captcha key, the SW idles out, and from then on the key is silently gone — `runLlmLayer()` logs `no-gemini-key` and returns `null`, and AUTO_EXTRACT's LLM layer never runs again with no user-visible error. `KNOWN_LIMITATIONS.md` describes this as a browser-restart limitation; in reality it happens within a minute of idling.

Same root cause: `loadPool()` also only runs in `activate`, so the proxy pool is empty after any SW restart.

### A-05 · BLOCKER · Proxies are never applied to any pipeline run

`selectProxy` / `rotateProxy` / `_applyProxy` are reachable only through the `proxy:select`, `proxy:rotate` and `proxy:test` messages (`service-worker.js`). **Nothing sends those messages** — not the pipeline executor, not the side panel, not any step type. `_executePipeline` never touches the proxy manager.

The Settings tab's "Update Pool" button parses and persists proxies (`proxy:update`), and that is the end of it. 630 lines of `proxy-manager.js` — 5 input formats, 4 rotation modes, health checks, PAC application — are unreachable from the product. The README documents the pool as a headline feature.

### A-06 · BLOCKER · Captcha solving is entirely unreachable

`solveCaptcha()` (459 lines of provider integration for 2captcha / Anti-Captcha / CapSolver) is exposed via the `captcha:solve` message. Nothing sends it. `content/captcha-detector.js` is never imported by any file and is not in `manifest.json`'s content scripts, so nothing ever detects a captcha in the first place. There is no captcha step type in `STEP_REGISTRY`.

### A-07 · BLOCKER · `FORM_FILL` is a phantom step type

The ethics engine enforces hard blocks on `FORM_FILL` (`ethics-engine.js` — password fields, hidden fields, row cap, delay floor), both script emitters have a `FORM_FILL` case, and `mcp/server.mjs:66` lists it as a supported type. But:

- `FORM_FILL` is **not** in `STEP_REGISTRY` (`pipeline-builder.js:15`) — no way to create one
- `injector.js` `_executeStep` has no `FORM_FILL` case
- `_formFillRow()` (`injector.js:1152`) is only reachable via an `FS_FORM_FILL_ROW` postMessage that nothing dispatches

So `content/form-filler.js` (456 lines, 8 input handlers, React-fiber hack) and `content/field-auto-mapper.js` (333 lines) are both dead, and every `FORM_FILL`-dependent ethics gate is a no-op. The `FILL` step that _does_ exist is a much simpler, unrelated implementation.

### A-08 · BLOCKER · Ethics Gate 7 can never fire — two content listeners fight over `respond()`

`_gate7_overlayReadiness` (`ethics-engine.js:203`) sends `overlay:setMode` to the tab. `injector.js:156` registers a `chrome.runtime.onMessage` listener that returns `true` for **every** message with a `type` field and answers `{ok:true, result:null}` for unknown types (`_handleEvent` default → `null`). `overlay-engine.js` registers a _second_ listener that actually handles `overlay:*`, but injector's listener responds first, so the overlay engine's reply is discarded. Gate 7 sees `result.unmatched === undefined` and always returns "no warning".

This also breaks every other overlay control path from the background.

### A-09 · BLOCKER · Google Fonts is loaded from a remote CDN in an MV3 extension page

`sidepanel/index.html:8-12` has `<link rel="preconnect">` + a remote stylesheet from `fonts.googleapis.com`. MV3's extension-page CSP does not permit remote resources; the request is blocked, the panel silently falls back to system fonts, and the console fills with CSP violations. It is also a privacy leak (a request to Google every time the panel opens) and a Chrome Web Store review flag. Fonts must be bundled locally.

### A-10 · BLOCKER · One failed `indexedDB.open` disables all persistence for the worker's life

_Not in the original audit — found while writing the regression test for D-12._

`openDB()` caches its promise so concurrent callers share a connection, and `req.onerror` clears that cache on failure. But `indexedDB.open` can throw **synchronously** — storage disabled by policy, a private window, a worker torn down mid-call — and that throw never reaches `onerror`. The rejected promise therefore stayed cached, and every subsequent row write, cursor save and read failed with the original error for as long as the service worker lived. The run kept going and persisted nothing.

Fixed by catching the synchronous throw and un-caching the attempt on any rejection, however it arrived.

### A-11 · HIGH · The PDF reader loses every stream after the first

_Not in the original audit — found by running `utils/pdf-text.js` against a PDF that Chrome printed, in the end-to-end suite._

`_readStreams` scanned for `/stream\r?\n/` and then set the cursor to the closing `endstream`. **`endstream` ends in `stream`**, so the very next search matched the tail of the token just consumed, restarted inside the following object's compressed bytes, and framed every later stream wrongly. Their inflate then failed, which cost the `/ToUnicode` CMaps, and a real PDF came back with no text and a "font ships no /ToUnicode map" note that was not true.

It also ignored `/Length` entirely, framing streams by the next `endstream` — which is wrong for binary font programs whose bytes contain that sequence.

Fixed with a negative lookbehind on the scan, a cursor that clears the whole `endstream` token, and `/Length` honoured where the dictionary states it directly (falling back to the delimiter for a wrong or indirect length). The hand-built fixtures in `tests/pdf-text.test.mjs` all passed throughout — this needed a PDF a real writer produced.

### A-12 · BLOCKER · `EXPORT` has never downloaded anything in a real browser

_Not in the original audit — found by running an export end to end in Chromium._

`_doExport` built a `Blob` and called `URL.createObjectURL`. **MV3 service workers do not have that function.** Every export therefore failed with `[EXPORT] URL.createObjectURL is not a function` and produced no file, on every run, in every browser.

It survived 442 unit tests because `tests/helpers/worker-harness.mjs` defined `URL.createObjectURL` for the worker — a mock more capable than the thing it stood in for. That stub is now deleted rather than corrected, so the harness is as poor as the real runtime.

Worse, the code was deliberate: the comment above it read _"A Blob URL, not a data: URL … a large export could exceed what a data: URL can carry."_ The `data:` route was removed in favour of one that cannot run at all. Chrome's downloads API takes a `data:` URL well into the tens of megabytes — verified at 20 MB in the e2e suite — and a Blob URL that cannot be created carries nothing.

Fixed by encoding to a `data:` URL in chunks (spreading a large array into `String.fromCharCode` throws), with the BOM inside the encoded bytes rather than dropped into the URL raw, and a stated 64 MB ceiling.

### A-13 · BLOCKER · Every page step after a navigation fails

_Not in the original audit — found by running a paginating pipeline in Chromium._

Content scripts are injected on demand rather than declared for every page (the C-09 fix), and a content script is destroyed with the document that hosts it. Injection happened once, when the run started. So the first navigation in a run — a `NAVIGATE`, a `PAGINATE`, a `CLICK` that follows a link — left every subsequent page step talking to nothing, and each failed with Chrome's `Could not establish connection. Receiving end does not exist.`

That is most of what a scraper does. A pipeline confined to one page worked; anything that turned a page collected the first page and then logged one error per step until the run ended. The paginating e2e check paginated all three pages correctly and came back with one row, which is what exposed it.

None of the 500 unit tests could see it: they mock `chrome.tabs`, and a mocked tab never navigates. The harness now models injection — a test can take the content script away and see whether the worker puts it back.

Fixed with `_sendToPage`, which sends optimistically, and on Chrome's "no receiver" errors re-injects and retries once. `_ensureInjected` pings before injecting, so a retry cannot double-register the listener. The one send deliberately excluded is the pagination click itself: a lost reply there means the click navigated, and re-sending it would turn a second page.

---

# B. Logic & correctness

### B-01 · HIGH · The "Bypass robots.txt" checkbox does nothing

The side panel reads it and sends it (`pipeline-builder.js:686`), but `service-worker.js:192` destructures only `{ targetOrigin, targetPath, captchaEnabled, captchaAuthorized }` from the payload and never forwards `bypassRobots` into `runEthicsGates()`. `_gate1_robots(origin, path, bypass)` therefore always receives `undefined`.

### B-02 · HIGH · Ethics warnings are computed and then thrown away

`runEthicsGates` returns up to five soft warnings; `service-worker.js:224` returns them to the caller — and `pipeline-builder.js`'s run handler reads only `res.result.runId`. The warnings are never logged, never shown, never confirmed. The run starts regardless. **All five soft gates are invisible to the user**, contradicting `README.md`'s "confirm to override" model.

### B-03 · HIGH · Gate 6 (domain lock) had the risk exactly backwards

`_gate6_domainLock` (`ethics-engine.js:138`) blocked the run if any `NAVIGATE`/`WEBSITE`/`API` step's origin differed from the active tab's. Three distinct problems, confirmed by running the gate:

1. **It blocked the safe case.** A cross-origin URL the author typed is visible in the step config and was chosen deliberately — yet multi-domain pipelines were impossible and every third-party API call was rejected, including the API step's own registry default (`https://api.example.com/resource`). Adding an API step and pressing Run hard-failed immediately.
2. **It only walked top-level steps.** Moving the same step inside a `LOOP` or an `IF_ELSE` branch bypassed it completely.
3. **It permitted the dangerous case.** `{{item.href}}` is not a valid URL at gate time, so `new URL()` threw and the step was waved through. That value comes from the page's own DOM via `QUERY_ELEMENTS` — meaning **the page chooses where the pipeline navigates**, and subsequent steps (a `FILL` carrying credentials, an `UPLOAD_ACTIVITY` carrying files) then run there.

Verified before fixing: an authored cross-origin `NAVIGATE` was `BLOCKED`; the same step inside a `LOOP` was `allowed`; and a page-controlled `{{item.href}}` was `allowed`.

### B-04 · HIGH · `AUTO_EXTRACT`'s `useLlm` toggle is ignored

`pipeline-builder.js:1892` renders a "Enable AI fallback (Gemini)" toggle, but `_executeAutoExtract` (`service-worker.js:359`) branches only on `extraction.needsLlm`. Turning the toggle off does not prevent the page content from being sent to Google.

### B-05 · HIGH · `AUTO_EXTRACT`'s `extractType` options are fiction

The dropdown offers "Product Page", "Article / Blog Post" and "Product Listing / Grid". `smart-extractor.js`'s `fsSmartExtract(config)` reads only `confidenceThreshold` — there is no article or listing extractor. Choosing either silently runs the product extractor.

### B-06 · HIGH · `confidenceThreshold` is mislabelled in the UI

Labelled "Min. confidence to accept (0–100)". It is actually the **LLM escalation threshold** — rows below it are still saved, just after an LLM attempt. Nothing is ever rejected for low confidence.

### B-07 · HIGH · `EXTRACT` field type "Attr" can never work

`injector.js:627` requires `field.type === "attribute" && field.attribute`, but the UI (`pipeline-builder.js`, `_addExtractField` and the EXTRACT config block) never provides an `attribute` key — there is no input for the attribute name. Selecting "Attr" silently falls through to text extraction.

### B-08 · HIGH · `EXTRACT` row alignment invents data

`injector.js:685-691` builds rows up to `maxLen` (the largest match count across fields) and pads short fields with `rawData[name][0]`. A page with 10 prices and 3 titles produces 10 rows where 7 repeat title #1 as though it were real data.

_Corrected while fixing:_ the entry also claimed `|| null` turned legitimately falsy values into `null`. Testing showed that expression sits only on the padding branch — a falsy value at a valid index was returned intact. The `??` change is still right, but the corruption was the padding alone.

### B-09 · HIGH · `CLICK` silently clicks the wrong element inside loops

`injector.js:494-498`: when the selector matches nothing inside a `LOOP` child, the step falls back to clicking the **loop item root** (`usedRootFallback`). A typo'd selector therefore produces a plausible-looking successful click on a random container. There is no config flag to disable it and the fallback is only reported in the return value, which nothing inspects.

### B-10 · HIGH · `FILL` cannot fill React/Vue-controlled inputs

`_typeInto` (`injector.js:959`) does `el.value += ch` plus a bubbling `input` event. Frameworks that own the value via a native setter descriptor will revert it. The React-fiber workaround that solves exactly this lives in `content/form-filler.js`, which is dead code (A-07). `FILL` also has no support for checkboxes, radios, `<select>`, or `contenteditable`.

### B-11 · HIGH · Template variables are not resolved in nested config

`_resolveConfig` (`service-worker.js`) maps only **top-level string** values of `step.config`. `_resolveAny` (which recurses) is used exclusively for API headers. So `{{item.href}}` inside `FILL.fields[].value` passes through literally. (`EXTRACT.fields[].selector` happens to survive because `injector.js` re-renders selectors from `__fsContext`, but that is incidental, not by design.) `docs/JinjaTemplateGuide.md` §3 implies nested resolution works.

### B-12 · HIGH · Script export always emits Python; the Node emitter is unreachable

`pipeline-builder.js:786`: `const format = "python"; // prompt() is blocked in sidepanel`. There is no format selector, so `emitNode()` (193 lines) can only be reached through MCP.

### B-13 · HIGH · Generated scripts silently drop most step types

Both emitters cover only `WEBSITE/NAVIGATE, API, CLICK, WAIT, EXTRACT, FORM_FILL, EXPORT, SCROLL, LOOP, IF_ELSE`. Everything else hits `default:` and emits `# TODO: implement step type "X"` (`python-emitter.js:172`, `node-emitter.js:122`). That silently drops **FILL, HOVER, SELECT, KEYBOARD, DRAG_DROP, UPLOAD_ACTIVITY, SCREENSHOT, PAGINATE, API_SNIFFER, PDF_EXTRACTION, AUTO_EXTRACT** — 11 of 21 step types. The exported script looks complete and runs, but does less than the pipeline.

### B-14 · HIGH · The "credentials are always redacted" claim is false for emitted scripts

**Fixed, with a limit worth stating.** Detection is by config key name, by HTTP header name, and by password-shaped selectors. A password typed into a field none of those recognise is still emitted as written — nothing in the config distinguishes it from any other text. The export reports every credential it replaced, so what it did _not_ find is visible by omission.
`README.md` §Script Export: _"Credentials are always redacted — replaced with `os.environ.get(...)`."_ The emitters only emit env-var lookups for the **proxy**. `serializePipeline()` has a `REDACT` regex but the emitters never call it. A `FILL` step containing a password or an `API` step with an `Authorization` header is emitted in plaintext.

### B-15 · MEDIUM · SCROLL emitters read the wrong config key

`python-emitter.js:131` / `node-emitter.js:80` use `config.value`, but the UI writes `config.amount` (`pipeline-builder.js` SCROLL block). Every exported scroll is the hard-coded default of 300 px.

### B-16 · MEDIUM · Emitted scripts contain unresolved `{{...}}` templates

Templates are a runtime feature of the SW executor. The emitters copy config strings verbatim, so `page.goto("https://x.com/p/{{loop.index}}")` appears literally in the generated Python.

### B-17 · MEDIUM · `robots.txt` empty `Disallow:` is treated as "block everything"

`ethics/robots-parser.js:97`: `if (!rulePattern) return true;`. Per RFC 9309 an empty `Disallow:` value means _allow all_, but here it becomes a rule that matches every path. A `robots.txt` containing only `User-agent: *` / `Disallow:` reports the site as disallowed. The inline comment ("matches nothing (treat as allow-all)") contradicts the code.

### B-18 · MEDIUM · `$` end-anchor handling in the robots parser is accidental

The escape character class at `robots-parser.js:100` omits `$`, so the subsequent `if (regex.endsWith('\\$'))` branch is unreachable. `$` leaks into the regex unescaped — which happens to anchor correctly at the end of a pattern, but a mid-pattern `$` silently corrupts the match.

### B-19 · MEDIUM · Proxy health checks race each other and leave the browser proxied

`testAllProxies` (`proxy-manager.js:513`) runs every `testProxy` concurrently via `Promise.allSettled`, and each `testProxy` calls `_applyProxy()` — which sets a **global, browser-wide** PAC script. N concurrent tests all fight over one global setting, so the latency and alive/dead results are meaningless. Worse, nothing calls `clearProxy()` afterwards: **after a health check the user's entire browser stays routed through whichever proxy was applied last.**

### B-20 · MEDIUM · Pasting a CSV proxy list does not work

`README.md` lists `CSV with header: host,port,username,password,type` as a supported paste format. The `proxy:update` handler calls `parseProxyText()` only; `parseProxyCSV()` is exported and never called. A pasted CSV is parsed line-by-line as `host:port` and every row is rejected.

### B-21 · MEDIUM · `_makeEntry` never throws, so proxy validation is dead

`parseProxyJSON` and `parseProxyCSV` wrap `_makeEntry` in `try/catch` to skip bad entries, but `_makeEntry` has no validation and cannot throw. Entries with `port: NaN` enter the pool.

### B-22 · MEDIUM · Loop `max: 0` means "unlimited" for elements but "zero iterations" for count

The UI labels the elements-mode field "Safety max (0 = unlimited)" and `_executeLoop` does `Math.min(len, max || 9999)` — correct. But in `count` mode `iters = max`, so `0` runs the loop zero times with no warning. The registry default (`max: 10`) also disagrees with the UI's displayed default (`c.max ?? 0`).

### B-23 · MEDIUM · `SELECT` sets `.value` without validating the option

`injector.js:1016` assigns `el.value = value` and fires `change` only. If no option matches, the select is silently cleared. No `input` event, no match-by-visible-label.

### B-24 · MEDIUM · `KEYBOARD` builds wrong `code` values for digits and symbols

`injector.js:1037`: `code = mainKey.length === 1 ? "Key" + upper : mainKey`. For `"1"` that yields `Key1` (should be `Digit1`); for `"-"`, `Key-`. Sites that read `event.code` will not react.

### B-25 · MEDIUM · `IF_ELSE` text comparisons do not trim or normalise

`injector.js:1133-1137` compares raw `el.textContent` — untrimmed and case-sensitive — so `text-equals` almost never matches real markup with surrounding whitespace. There are no numeric or regex conditions.

**Correction, made when fixing it.** `text-equals` _did_ call `.trim()`; only `text-contains` and `attr-equals` compared raw. Trimming is not the problem in any case — real markup indents its text, so the whitespace is _inside_ the string (`"\n      Add to cart\n    "`) where trim cannot reach. All four conditions now collapse internal whitespace runs before comparing. Numeric and regex conditions are still absent; adding them needs UI work and is not done here.

### B-26 · MEDIUM · `markRunCompleted()` is never called

`checkpoint/resume-manager.js:44` exports it; nothing imports it. `_executePipeline` never deletes the run's cursor. Once A-03 is fixed, every finished run stays flagged "incomplete" forever and cursors accumulate without bound.

### B-27 · MEDIUM · `_executeStepList` and `_executePipeline` are duplicated and have drifted

`service-worker.js` contains the same ~90-line step dispatch chain twice (once for top-level steps, once for loop/branch bodies). They already disagree: the nested `EXPORT` branch calls `finalizeBuffer()` + `initBuffer()` first, the top-level one does not — so exporting from the root exports without flushing the row buffer.

### B-28 · MEDIUM · `PDF_EXTRACTION` is a stub inside the extension

**Fixed by implementing it, with the limits stated.** `utils/pdf-text.js` handles uncompressed and FlateDecode content streams, literal and hex strings, PDF escapes, and per-font `/ToUnicode` CMaps (`bfchar` and `bfrange`). Encrypted PDFs, scanned pages and CID text whose font ships no `/ToUnicode` map are **reported**, never guessed at — a page it cannot read comes back with a note rather than mojibake. The MCP server keeps its pdfjs-based tool; the two are independent implementations and that is fine.

`_executePdfExtraction` (`service-worker.js`) never parses anything; it logs _"use MCP tool pdf_extract_text"_ and stores `{status: "pending"}`. The step appears in the palette with a full config UI (source, max pages, storeAs) that has no effect. Real extraction exists only in the MCP server.

### B-29 · MEDIUM · Screenshot capture force-activates the target tab

`_captureScreenshot` calls `chrome.tabs.update(tabId, {active: true})` and sleeps 400 ms. A pipeline with screenshots yanks focus away from whatever the user is doing, repeatedly.

### B-30 · MEDIUM · `quality` is passed to a PNG capture, where it has no effect

`_captureScreenshot` clamps `config.quality` to 0-100 and passes it with `format: "png"`. Chrome ignores `quality` for PNG. The UI presents a quality control that does nothing.

### B-31 · LOW · `_stepScroll` percent mode uses `document.body.scrollHeight`

Should be `document.documentElement.scrollHeight`; `body` height is wrong on many layouts.

### B-32 · LOW · Dead step handlers in the content script

`_stepScreenshot`, `_stepLoop`, `_stepNavigate` and `_waitForSelector` are unreachable — the SW handles SCREENSHOT/LOOP/NAVIGATE itself and never forwards those types.

### B-33 · LOW · `_poll2captcha` and friends recurse instead of looping

25 nested `await` frames per solve. Harmless at this depth, but the retry budget (`attempts > 24` × 5 s) is an undocumented 2-minute hang.

### B-34 · LOW · Round-robin index is shared across rotation modes

`_rrIndex` is advanced by both `round-robin` and `sticky` selection, so switching modes produces non-obvious ordering.

---

# C. Security & privacy

### C-01 · HIGH · Any web page can drive the step executor

`content/injector.js:129-131` — the listener's only guard is `if (event.source !== window) return;`, which **every script running in the page satisfies**. The module docblock claims _"All postMessage events are source-checked against `window.location.origin` to prevent page scripts from spoofing our event protocol."_ That check does not exist.

A hostile page can post `FS_STEP_EXEC` and invoke `CLICK`, `FILL`, `SELECT`, `DRAG_DROP`, `NAVIGATE`, `UPLOAD_ACTIVITY`, `QUERY_ELEMENTS` and the selector picker at will, on any site the user visits. Results are echoed back with `window.postMessage(..., "*")`, so the page reads them too. Add a nonce or drop the `window.postMessage` transport entirely (the `chrome.runtime` bridge is the one actually in use).

### C-02 · HIGH · The network sniffer hooks `fetch`/`XHR` on every site, always

`content/page-sniffer.js` is injected into the **MAIN world** on `<all_urls>` at `document_start` with no gating. It wraps `window.fetch` and `XMLHttpRequest`, buffers up to 500 KB of every response body and 50 KB of every request body, and posts each one to the content script, which forwards it to the service worker via `network:sniff` — on your bank, your webmail, everywhere, whether or not a pipeline is running. The SW discards it unless an `API_SNIFFER` run is active, but the capture and IPC happen regardless.

This is a significant privacy exposure and a performance tax on every page load. It should be injected on demand via `chrome.scripting.registerContentScripts` only while an `API_SNIFFER` run is active.

### C-03 · HIGH · Proxy credentials are written to the console

`utils/logger.js` claims _"NEVER logs secrets, API keys, proxy credentials, or PII"_, and `_sanitize` redacts by **key name** only. `proxy-manager.js:134` logs `{ line: line.slice(0, 50) }` on a parse failure — and a proxy line is `host:port:user:pass`. The key is `line`, which matches no redaction pattern, so credentials land in the console verbatim.

### C-04 · HIGH · Log messages are injected into the DOM as HTML

`pipeline-builder.js:2544`: `div.innerHTML = ... ${message}`. Log messages routinely contain page-derived text — selectors, extracted values, API URLs, thrown error messages. CSP blocks inline script execution, but markup injection (layout breakage, `<img>` beacons to arbitrary hosts, phishing-style content in the log pane) works. Use `textContent`.

### C-05 · MEDIUM · `esc()` does not escape `&` or `'`

`pipeline-builder.js:1920` replaces only `"` and `<`. Every config value rendered into the node cards goes through it. Unescaped `&` breaks entity round-tripping (`&quot;` in a value renders as `"`), and the function is unsafe for any single-quoted attribute context.

### C-06 · MEDIUM · The MCP HTTP server binds every interface and exposes file writes

`startHttpServer()` calls `app.listen(HTTP_PORT)` with no host, so the socket binds all interfaces, while `repo_write_file` is a registered tool and there is no authentication of any kind.

_Corrected while fixing:_ the entry also said there was no DNS-rebinding protection. There was — `createMcpExpressApp()` defaults its host to `127.0.0.1` and applies host-header validation automatically, so a LAN request was answered with 403. Verified by probing the machine's own LAN address: pre-fix it returns 403 (socket open, middleware refusing), post-fix the connection is refused outright. The exposure was an open port defended by one header check, not an open door — but the socket should not have been listening there at all.

### C-07 · MEDIUM · `web_accessible_resources` exposes the entire source tree to every site

`manifest.json` lists `sidepanel/*, icons/*, content/*, background/*, utils/*, data-sources/*, exporters/*, script-gen/*, ethics/*, checkpoint/*` with `matches: ["<all_urls>"]`. Any page can fetch and read all of them, and can fingerprint the extension by probing a known URL. Only the modules actually loaded via `import(chrome.runtime.getURL(...))` — `content/overlay-engine.js`, `content/form-filler.js` and their transitive imports — need to be listed.

### C-08 · MEDIUM · Four permissions are requested and never used

`declarativeNetRequest` (0 uses), `webRequest` (0), `notifications` (0), `scripting` (0 — the only occurrence of the string is a comment at `injector.js:15`), `activeTab` (0, and redundant beside `<all_urls>`). `KNOWN_LIMITATIONS.md` asserts _"`chrome.scripting.executeScript()` used for all DOM ops"_ — it is used nowhere. Unused high-privilege permissions are the single most common cause of Web Store review rejection.

### C-09 · MEDIUM · `host_permissions: ["<all_urls>"]` plus content scripts on `<all_urls>`

Three content scripts run on every page the user visits, for a tool that operates on one tab at a time. `activeTab` + on-demand injection would cut the attack surface dramatically.

### C-10 · LOW · `logger` runs at `debug` level with no production switch

`utils/logger.js:13`: `const CURRENT_LEVEL = LEVELS.debug;` — everything is logged, always, into a 2000-entry in-memory ring buffer that nothing ever reads or exports.

### C-11 · LOW · `_sanitize` does not recurse into arrays

`utils/logger.js:36` recurses into objects but explicitly excludes arrays, so a secret inside an array of objects is logged unredacted.

### C-12 · LOW · Storage files are held as base64 data URLs in `chrome.storage.local`

`_stageFilesInStorage` reads every file with `FileReader.readAsDataURL` and persists it. `chrome.storage.local` is capped at ~10 MB without the `unlimitedStorage` permission (which is not requested), and base64 inflates by ~33%. Two 4 MB PDFs exceed the quota. There is a `try/catch` that logs a quota message, but nothing prevents or pre-checks it.

---

# D. Data integrity & edge cases

### D-01 · HIGH · Run state is memory-only, contradicting the documented design

`service-worker.js:98`: `const _runStates = new Map()`. The file's own docblock says _"All state is persisted to storage before every await to survive SW termination."_ It is not. The only persisted artefact is `fs_run_log`, which nothing reads. If the SW is killed mid-run (routine in MV3), the run vanishes: no completion event, no error, the side panel's Stop button stays visible forever, and rows already in IDB are orphaned under a `runId` the UI has forgotten.

### D-02 · HIGH · The 20-second heartbeat does not do what it claims

`chrome.alarms.create(..., { periodInMinutes: 0.33 })` (`service-worker.js:117`). Chrome clamps `periodInMinutes` below 1 to 1 minute for packed extensions (30 s for unpacked). The SW's idle timeout is 30 s. So on an installed extension the alarm fires _after_ the SW has already been torn down — the heartbeat cannot keep it alive. The alarm is also only created inside `activate`, so it is not re-armed after a restart, and `PIPELINE_STOP` clears it whenever the last run ends.

### D-03 · MEDIUM · Three separate, inconsistent CSV serializers

`_doExport` (`service-worker.js`), `btn-download-partial` (`pipeline-builder.js`) and `exporters/text-exporters.js` each implement CSV independently. The first two quote every field unconditionally and do `String(r[h] || "")` — turning `0` and `false` into empty strings — while the exporter module (the only correct one, RFC-4180-ish) is never imported.

### D-04 · MEDIUM · Export drops XML and Markdown

`README.md` advertises six formats. The EXPORT step's dropdown offers four (csv/json/jsonl/tsv) and `_doExport` implements four. `exportXML()` and `exportMarkdown()` exist in `exporters/text-exporters.js` and are unreachable.

### D-05 · MEDIUM · The BOM is embedded raw into a `data:` URL

`service-worker.js:668` builds the download URL as a template literal `data:<mime>;charset=utf-8,\uFEFF<encodeURIComponent(dataContent)>`. The BOM is outside the `encodeURIComponent` call, so it is not percent-encoded and will be mangled by URL parsing. The ZIP branch does it correctly (`enc.encode("\uFEFF" + content)`).

### D-06 · MEDIUM · Blob URLs are never revoked in the service worker

`_doExport` creates `URL.createObjectURL(blob)` for the ZIP path and never calls `revokeObjectURL`. Every export leaks the full payload for the lifetime of the SW.

### D-07 · MEDIUM · Export deduplication is O(n) `JSON.stringify` per row

`_doExport` builds a `Set` of stringified rows and stringifies every IDB row again to compare. `utils/deduplicator.js` implements exactly this with a djb2 hash and is never imported. Key order differences between an in-memory row and its IDB round-trip also defeat the comparison, producing duplicates.

### D-08 · MEDIUM · CSV/JSON header derivation is inconsistent

`_doExport` uses `Array.from(new Set(allRows.flatMap(Object.keys)))` (union of all keys — correct), while `exporters/text-exporters.js` and the MCP `toCSV`/`toTSV`/`toMarkdown` use `Object.keys(rows[0])` only. Heterogeneous rows silently lose columns through the MCP path.

### D-09 · MEDIUM · Imported pipelines are not validated against the step registry

`_normalizeImportedStep` (`pipeline-builder.js:1315`) accepts any uppercase `type` string. An unknown type renders with a `?` icon and an undefined CSS colour, and fails at runtime with `Unknown step type`. Import also does not merge registry defaults into `config`, so a step missing keys renders a partially empty config form.

### D-10 · MEDIUM · Screenshots accumulate unboundedly in memory

`runState.screenshots` holds full PNG data URLs in the SW's heap for the whole run. A 200-iteration loop with a screenshot step will exhaust memory long before export.

**Bounded, not solved.** Captures now stop at 48 MB / 500 screenshots (32 MB / 5000 requests for D-11), warn once, count what was dropped and report it in the export line. The design fix is to stream captures to IndexedDB the way rows already are; that is not attempted here.

### D-11 · MEDIUM · Sniffed network payloads accumulate unboundedly

`runState.networks` grows without cap, at up to 550 KB per captured request.

### D-12 · LOW · `pushRow` swallows backpressure

`pushRow` awaits `flush()` only at the 50-row threshold; if the flush throws, rows are pushed back onto the buffer and the error propagates into `_executeStepList`, aborting the step. The docblock promises _"backpressure-safe `pushRow()` that never loses data"_.

### D-13 · LOW · Row buffer is not a ring buffer

The docblock claims a fixed-size ring buffer with head/tail pointers "to avoid O(n) copy costs". The implementation is `Array.push` + `splice(0, len)`.

### D-14 · LOW · `data:download` with `runId: "latest"`

`pipeline-builder.js` sends `_runState.runId || "latest"`; `readAllRows("latest")` matches no index key and returns `[]` → "No collected data available yet." There is no sentinel handling for "latest".

---

# E. UI / UX

### E-01 · HIGH · Pause is implemented in the backend and absent from the UI

`MSG.PIPELINE_PAUSE` and `runState.paused` are fully wired in the SW (`_executePipeline` polls `paused` every second). There is no pause button anywhere in `index.html`. Users get only Run and Stop.

### E-02 · HIGH · The selector picker can deadlock

`_activateSelectorPicker` (`injector.js:1274`) resolves its promise **only** on click. There is no Escape handler, no cancel affordance, no timeout. If the user changes their mind, `_pickerActive` stays `true` forever — every subsequent pick attempt returns `null` immediately — and the side panel's `await chrome.tabs.sendMessage(...)` never settles, leaving the picker button dead until the page is reloaded.

### E-03 · MEDIUM · The picker's "invisible blocker" does not block

The overlay is appended to `_shadow`, whose host has `pointer-events:none` (`injector.js:37`) and the overlay never resets it. The comment says it _"physically stops mouse events from reaching the page (thus freezing CSS hovers)"_ — it does not; page hover styles keep firing and can shift the very element being picked.

### E-04 · MEDIUM · The "Processed" metric counts steps, not rows

`listenToSystem` sets `mon-rows` from `info.progress.current`, which `_executePipeline` increments per step. The card is labelled "Processed" next to a "Download Data" button, strongly implying rows. Extracted row count is never surfaced.

### E-05 · MEDIUM · Drag-and-drop reorder works only at the root level

`bindDragAndDrop` (`pipeline-builder.js:2043`) looks both source and target up in `_pipeline.steps` only. Dragging a step inside a LOOP or an IF/ELSE branch, or between a branch and the root, silently does nothing — while the drop target still shows the accent outline, signalling success. (`KNOWN_LIMITATIONS.md` calls this "partial in v3".)

### E-06 · MEDIUM · Blocking `alert()` dialogs for routine errors

`_testStep`, `_pickSelector`, `_addExtractField` and `_addFillField` all use `alert()`. The panel already has a log pane built for exactly this.

### E-07 · MEDIUM · Test-step results are never shown

`_testStep` turns the card green on success and discards `res.result` — the user cannot see what a CLICK matched or what an EXTRACT returned. The success/error class is also never cleared until the next render.

### E-08 · MEDIUM · Missing CSS colour variables for three step types

`index.html` defines `--step-*` for 20 types, but the set has drifted from the registry: **`--step-FILL`, `--step-PDF_EXTRACTION` and `--step-AUTO_EXTRACT` are undefined**, while stale `--step-TYPE` and `--step-FORM_FILL` remain. `populatePalette()` uses `var(--step-${type})` **without a fallback**, so those three palette tiles render with no background. (The node cards do pass a fallback, so only the palette is visibly broken.)

### E-09 · MEDIUM · Nav pills and node headers are not keyboard accessible

`.nav-pill` is a `<div>` with a click handler — no `role`, no `tabindex`, no keyboard activation. Same for `.node-header`, `.insert-step`, `.accordion-header` and `.palette-item`. The panel cannot be operated without a mouse.

### E-10 · MEDIUM · `bindConfigInputs` clones every input on every render

`pipeline-builder.js:1955` does `el.cloneNode(true)` + `replaceChild` on all `.cfg-bind` elements to shed listeners. Any focus, caret position or selection is destroyed. Since `renderPipeline()` re-renders the whole canvas on expand/collapse/add/remove, editing is jumpy.

### E-11 · MEDIUM · Board wires are rebuilt via `innerHTML` on every transform

`_renderBoardWires()` regenerates the entire SVG string on every pan frame, zoom step and window resize. Pointer-move panning calls `_applyBoardTransform()` → `_renderBoardWires()` with no rAF throttle.

### E-12 · MEDIUM · Plain-wheel zoom is disabled without explanation

`initBoardSurface` requires Ctrl/Cmd/Shift for wheel zoom and there is no on-screen hint. Users on trackpads will assume zoom is broken.

### E-13 · MEDIUM · Tab switching mid-run silently swaps the pipeline

`chrome.tabs.onActivated` reassigns `_tabId`, reloads a different per-tab pipeline and re-renders — even while a run is in flight against the previous tab. The Stop button then targets the right `runId` but the board shows an unrelated pipeline, and Storage/activity panels are not re-rendered at all.

**Correction.** The last clause is wrong: the storage library and the upload activity list are not tab-scoped — only `SK.PIPELINE` is — so there is nothing there to re-render. The board/run mismatch is real and is fixed by holding the board on the running tab until the run ends.

### E-14 · MEDIUM · No confirmation on destructive actions

"🗑 Clear" wipes the whole pipeline and "🧹 Clear Library" deletes every stored file, both with no confirm and no undo.

### E-15 · LOW · `IF_ELSE` is the only step without an "optional" toggle

Every other config block ends with `toggle(step, "optional", "optional")`. The toggle's label is also the raw key name, lowercase, unlike every other human-readable label.

### E-16 · LOW · Multi-fill and extract field rows are `disabled` inputs

Existing field selectors/values render as `disabled` inputs — visually greyed and uneditable. Fixing a typo requires deleting the row and re-picking the element.

### E-17 · LOW · `_registerKey` has a 15 s timeout with no visible countdown

The button reverts to "🔴 Register Key" with no explanation of why.

### E-18 · LOW · Log pane grows without bound

`logToMonitor` appends forever; only the manual 🗑 button clears it. A long run will accumulate tens of thousands of nodes.

### E-19 · LOW · `stopRunUI()` does not clear `_runState.runId`

Stale `runId` persists after a run ends, so a later `pipeline:log` for that run is still accepted by the listener's filter.

### E-20 · LOW · Storage list is not virtualised and shows no total size

Every file is re-rendered on each change, with no aggregate size indicator to warn about the quota (see C-12).

---

# F. Dead code, wiring gaps, missing files

### F-01 · HIGH · Eight modules (≈1,700 lines) are never imported by anything

| Module                         | Lines | Status                                                                                    |
| ------------------------------ | ----- | ----------------------------------------------------------------------------------------- |
| `data-sources/csv-parser.js`   | 200   | No importer. There is no CSV input path in the product at all.                            |
| `data-sources/json-parser.js`  | 193   | No importer.                                                                              |
| `exporters/text-exporters.js`  | 149   | No importer — SW re-implements CSV/JSON/JSONL/TSV inline.                                 |
| `utils/deduplicator.js`        | 86    | No importer (see D-07).                                                                   |
| `utils/levenshtein.js`         | 108   | No importer — `field-auto-mapper.js` re-implements Levenshtein locally at line 53.        |
| `content/captcha-detector.js`  | 229   | Not in manifest, never imported (see A-06).                                               |
| `content/smart-sleep.js`       | 164   | Never imported; `injector.js` re-implements `_sleep`/`_waitForSelector`/`_waitDOMStable`. |
| `content/field-auto-mapper.js` | 333   | Never imported (see A-07).                                                                |
| `content/form-filler.js`       | 456   | Only via the unreachable `FS_FORM_FILL_ROW` path (see A-07).                              |

`exporters/stream-writer.js` is imported only by the dead `text-exporters.js`, making it transitively dead too.

### F-02 · MEDIUM · Data ingestion does not exist

`data-sources/` implements streaming CSV and JSON/JSONL parsers with BOM handling and delimiter detection. Nothing in the UI lets a user load a data file, and no step type consumes one. The `FORM_FILL`-from-dataset workflow that the ethics engine, the emitters and the README all describe has no entry point.

### F-03 · MEDIUM · `MSG.KEY_GET` handler imports two functions and uses neither

`service-worker.js`: the handler imports `getApiKey` and `validateApiKey`, then returns only `listProviders()`. Consequently **no key is ever validated** — all six `_validate*` functions in `api-key-manager.js` are dead, and the UI gives no feedback beyond "saved".

### F-04 · MEDIUM · Only 3 of the README's 15 advertised providers exist in code

**Resolved by the README rewrite** (`62bd304`): it no longer advertises providers the code does not have. Nothing was added to the code.

Implemented: 2captcha, Anti-Captcha, CapSolver (solve + validate), plus Hunter/OpenAI/Gemini validators. Advertised but entirely absent: Clearbit, Abstract API, IPinfo, Claude/Anthropic, DeathByCaptcha, NoCaptchaAI, and **all four notification channels** (Slack, Discord, Telegram, SMTP) — which is why the `notifications` permission is unused (C-08).

### F-05 · MEDIUM · `LICENSE` file does not exist

`README.md` ends with _"MIT — See LICENSE file."_ There is no LICENSE file in the repository. For a project distributed as "MIT", this is a real legal gap.

### F-06 · MEDIUM · `pipelines/` and `bin/` are referenced but absent

`docs/repo-readme.md` points at both. `bin/` is in `.gitignore`. `pipelines/` does not exist, and `pipeline_list` (`mcp/server.mjs`) calls `fs.readdir` on it without a guard, so the tool throws `ENOENT` instead of returning an empty list on a fresh clone.

### F-07 · LOW · `utils/strings.js` is imported once and barely used

203 lines of "all UI strings, i18n-ready, never hardcode UI strings elsewhere". Only `proxy-manager.js` imports it. Every user-facing string in the side panel, the injector and the SW is hardcoded.

### F-08 · MEDIUM · The overlay preferences panel renders but cannot affect anything

`sidepanel/overlay-panel.js` is loaded (`index.html:1658`) and does render into `#overlay-panel-root`. But every message it sends to the page — `overlay:reloadPrefs` on save, and `overlay:setMode`/`previewAll` from the "Preview now" button — is swallowed by injector's catch-all runtime listener (A-08) before `overlay-engine.js` can handle it. Prefs are persisted to `chrome.storage.local`, and `overlay-engine._loadPrefs()` reads them only once at content-script init, so a change takes effect no earlier than the next page load. Its `PALETTE_NAMES` array also still labels a swatch `FORM_FILL`, a step type that does not exist (A-07).

### F-09 · LOW · `rate-limiter.js` is imported but almost unused

`acquire()` is called only from the `form:rowStart` handler — part of the dead FORM_FILL path. `backoff()` and `estimateReqPerHr()` are imported or exported and never called. No pipeline step is rate-limited.

### F-10 · LOW · `examples/loop-select-click.json` uses a template that cannot work

`"selector": "{{item.tag}}.product-link"` — `item.tag` is the element's own tag name from `QUERY_ELEMENTS`, so this renders to e.g. `div.product-link` and is scoped inside the item root. The `JinjaTemplateGuide` explicitly warns against object templates in selectors; this example is at best confusing, and there is no README pointer to the `examples/` folder.

---

# G. MCP integration

### G-01 · HIGH · `pipeline_validate` rejects most real pipelines

`mcp/server.mjs:66` — `supportedStepTypes` contains 11 entries and is badly out of sync with `STEP_REGISTRY`'s 21:

- **Missing (11):** `FILL`, `HOVER`, `SELECT`, `KEYBOARD`, `DRAG_DROP`, `UPLOAD_ACTIVITY`, `PAGINATE`, `SCREENSHOT`, `API_SNIFFER`, `PDF_EXTRACTION`, `AUTO_EXTRACT` (plus the legacy `TYPE` alias that `injector.js` still accepts)
- **Listed but nonexistent (1):** `FORM_FILL`

Any pipeline built in the UI with a FILL or AUTO_EXTRACT step is reported `ok: false` with "Unsupported step types". The set should be derived from a single shared registry rather than hand-maintained in two places.

### G-02 · MEDIUM · Documented CLI flags do not match the parser

`mcp/README.md` documents `npm start -- --root "C:\..."` and `--port 3000` (space-separated). `resolveRootFromArgs` (`server.mjs:530`) and `resolveArgValue` both require the `--root=value` / `--port=value` form. Following the README, `--root` is silently ignored and the server roots itself at the repo directory instead — with no warning.

### G-03 · MEDIUM · `playwright` and `csv-parse` are dependencies that are never imported

`mcp/package.json` declares both. `server.mjs` imports neither. Playwright alone pulls hundreds of megabytes of browser binaries on `npm install`. (The emitted _scripts_ need them at their own runtime — but that is the end user's environment, not this package's.)

### G-04 · MEDIUM · `mcp/README.md` contains the original author's absolute Windows paths

Both usage examples hardcode `c:\MY SPACE\MY LAPTOP\project works\fully automated web scraper\flowscrape-v3`.

### G-05 · MEDIUM · The extension and the MCP server cannot talk to each other

`_executePdfExtraction` tells the user to "use MCP tool `pdf_extract_text`", and `_executeUploadActivityStep` tells them to "use MCP tool `upload_file_to_site`" for restricted sites — but there is **no** bridge between the extension and the MCP server, and `upload_file_to_site` is not among the 18 registered tools. These are instructions the user cannot act on from inside the product.

### G-06 · LOW · `pipeline_report` compiles and emits twice

It calls `emitPython(ast)` and `emitNode(ast)` purely to measure `.length`, discarding both.

### G-07 · LOW · `repo_search_text`'s `include` parameter is a path, not a glob

Described as `include: z.string().optional()` defaulting to `"."`, and passed straight to `resolveWorkspacePath`. Users will reasonably try `**/*.js`.

### G-08 · LOW · `repo_search_text` recompiles the regex per call but reuses it across files

`new RegExp(query, "g")` is created once and used with `String.match` in a loop. `match` with `/g` resets `lastIndex`, so this happens to work — but it is fragile if the code is ever changed to `regex.test`.

### G-09 · LOW · MCP CSV/TSV/Markdown use `Object.keys(rows[0])` for headers

See D-08 — heterogeneous rows silently lose columns.

_Verified as fine:_ `@modelcontextprotocol/sdk@1.30.0` does export `server/express.js` (`createMcpExpressApp`) and `server/streamableHttp.js`, and depends on `express` — so the imports in `server.mjs` resolve correctly. The declared `zod: ^4.3.6` is compatible with the SDK's `^3.25 || ^4.0`.

---

# H. Documentation

### H-01 · HIGH · `README.md` and `docs/repo-readme.md` are near-duplicate files that have already drifted

They are identical except that `repo-readme.md` has a subtitle block and a whole `## 🤖 MCP Server` section that the root README lacks. Two copies of the same document is a guarantee of future divergence; one should be deleted or reduced to a pointer.

### H-02 · HIGH · The README's project-structure tree is materially wrong

It omits nine files that exist and are important — `content/smart-extractor.js` (872 lines), `content/page-sniffer.js`, `content/overlay-engine.js`, `content/overlay-renderer.js`, `background/llm-extractor.js`, `sidepanel/overlay-panel.js`, `utils/color-utils.js`, `mcp/`, `docs/` — while presenting the dead modules (F-01) as live architecture. A newcomer reading the tree would have no idea the AUTO_EXTRACT/LLM subsystem exists.

### H-03 · MEDIUM · "Ethics Gates (Pre-Run, All 6)" — there are 7

`README.md` documents six; `ethics-engine.js` implements and documents seven (Gate 7 = overlay readiness). Gate 7 is also a no-op (A-08).

### H-04 · MEDIUM · The `injector.js < 40 KB` performance target is stated and missed

`README.md`'s performance table and `injector.js`'s own header both assert it. The file is **51,497 bytes** — 29% over. The stated mechanism for staying small ("heavy logic lives in form-filler.js, field-auto-mapper.js — injected via `chrome.scripting`") is doubly false: those files are dead, and `chrome.scripting` is never used.

### H-05 · MEDIUM · The master manual's step registry is missing the three newest step types

`docs/flowscrape-master-manual.md` §6 lists 18 types; the registry has 21. Missing: `UPLOAD_ACTIVITY`, `PDF_EXTRACTION`, `AUTO_EXTRACT` — i.e. everything added in the last three commits. §3 (Repository Map) omits the same files as H-02.

### H-06 · MEDIUM · The security model table describes behaviour that does not hold

`README.md` claims proxy credentials live in `chrome.storage.session` (true) and that the logger never logs secrets (false — C-03), and the storage-tier table omits the base64 file library in `chrome.storage.local` (C-12).

### H-07 · MEDIUM · `KNOWN_LIMITATIONS.md` documents fixed/absent things and misses the real ones

It lists `xlsx-parser.js`, `sqlite-writer.js`, `lua-emitter.js` and `config-emitter.js` as "referenced in the file map but not implemented" — but no file map in this repository references them, so the entries are noise from an older spec. Meanwhile none of the actual blockers (A-01 … A-09) appear.

### H-08 · MEDIUM · The service worker's own docblock contradicts its implementation

_"All state is persisted to storage before every await to survive SW termination"_ — see D-01.

### H-09 · MEDIUM · `injector.js`'s docblock claims a security check that is not in the code

_"All postMessage events are source-checked against `window.location.origin`"_ — see C-01. This is the most dangerous doc/code divergence in the repo, because it would stop a reviewer from looking closer.

### H-10 · LOW · `docs/TEST_CHECKLIST.md` tests features that cannot be exercised

35 manual test cases, including TC-01→07 (proxy rotation — A-05), TC-08→14 (form-fill caps — A-07), TC-19→22 (checkpoint/resume — A-03) and TC-34→35 (captcha gate — A-06). Roughly half the checklist covers unreachable code paths.

### H-11 · LOW · `JinjaTemplateGuide.md` overstates nested resolution

§3's `FILL` and `EXTRACT` examples imply templates resolve inside `config.fields[]`. See B-11. **Resolved by fixing the code rather than the doc:** nested resolution now works, so the guide is accurate.

### H-12 · LOW · No `CONTRIBUTING`, `CHANGELOG`, or architecture-decision record

For a repo with four "v3/v4" commits and a 1,483-line manual, there is no record of what changed between versions.

---

# I. Project hygiene

### I-01 · MEDIUM · No tests of any kind

No test runner, no test files, no CI. `docs/TEST_CHECKLIST.md` is a manual checklist. The pure-logic modules (`robots-parser`, `pii-detector`, `levenshtein`, `csv-parser`, `json-parser`, `pipeline-compiler`, the emitters) are trivially unit-testable in Node and would have caught B-17, B-15 and G-01 immediately.

### I-02 · MEDIUM · No linter or formatter config

No ESLint, no Prettier config. Style is visibly inconsistent — `background/api-key-manager.js` and `proxy-manager.js` use single quotes and aligned assignments, everything else uses Prettier-style double quotes. Several files carry `// eslint-disable-line` comments for a linter that is not configured.

### I-03 · MEDIUM · `.gitignore` contains one line (`bin/`)

No `node_modules/`, no `pipelines/`, no OS/editor artefacts. `mcp/.gitignore` covers `mcp/node_modules`, but `mcp/package-lock.json` is committed while the root has no package manifest at all — so the repo has no single install/build entry point.

### I-04 · MEDIUM · Version strings disagree across the project

**Correction, on fixing it:** by the time this was addressed the _values_ already agreed at `3.0.0` — only `mcp/package.json` was missing one. The finding still holds as written about the structure: five separate literals with nothing keeping them in step. `utils/version.js` is now the single definition, and `tests/version.test.mjs` fails if any copy drifts from `manifest.json`.

`manifest.json` → `3.0.0`; `utils/strings.js` → `3.0.0`; `mcp/package.json` → no version; MCP server identity → `3.0.0`; git history → commits titled `v3`, `v3`, `v4`; README title → "FlowScrape v3". `pipeline-compiler` stamps compiled ASTs with a hardcoded `version: '3.0.0'` default.

### I-05 · LOW · The repository directory is `Flowscrape`, everything else says `flowscrape-v3`

The README's quick-start instructs "Load unpacked → select the `flowscrape-v3/` folder", which does not exist.

### I-06 · LOW · No `package.json` at the repository root

The extension needs no build, but a root manifest would give the project a home for lint/test scripts and a canonical version number.

---

# J. Capability gaps — what the steps could not do

The A–I findings are about things that were wrong. These are about things that
were missing: a step whose configuration promises a capability the code does not
have is the same lie told in a different place, and it costs the user longer,
because a wrong result looks like a working one.

They were found by reading all 21 step types against their implementations,
after the audit was closed.

### J-01 · BLOCKER · `WAIT` can only sleep; its other modes are unreachable

`content/injector.js`'s `_stepWait` has handled `selector-visible` and
`DOM-stable` since the first commit. Nothing had ever sent it either one: the
service worker's `WAIT` case was `await _sleep(step.config.ms || 1000); return;`,
so the step never left the worker and the page code could not be reached. Both
script emitters emitted `page.waitForSelector` for a mode the extension itself
could not produce.

The only wait the product could perform was the one that is wrong on a page that
loads its content asynchronously, which is all of them. A fixed wait is a guess:
too short and the next step reads an empty page and reports success; too long and
every iteration of a loop pays for it.

Fixed: `fixed` still sleeps in the worker, where it needs no page and cannot be
broken by a closed tab; every other mode is forwarded. `selector-gone` was added
for spinners and overlays, and `selector-visible` now checks that the element is
actually rendered — an element that exists but is `display:none` is the exact
case that makes an existence check resolve early and hand the next step nothing.
A misconfigured wait throws instead of falling back to a sleep.

### J-02 · HIGH · `SCROLL` cannot scrape an infinite feed

Three modes — pixel, percent, to-element — each performing exactly one scroll.
Scraping a lazy-loaded list therefore meant stacking a guessed number of SCROLL
steps and hoping the network kept up with them.

Fixed with an `infinite` mode that scrolls to the bottom until the page stops
growing. It is bounded by a scroll limit and reports whether it stopped because
the feed ended or because it ran out of scrolls, so a truncated scrape is
visible rather than silent. Given an item selector it measures growth in items
rather than page height, which is more reliable on a feed that swaps
placeholders for cards.

### J-03 · BLOCKER · `PAGINATE` was a click with a different name

`case "PAGINATE": return _stepClick(config, context);`

Past the last page the click matched nothing, `_stepClick` reported
`clicked: 0` without failing, and a `LOOP` in paginate mode ran its body the
full "max pages" count regardless. A site with 3 pages and a loop set to 10
scraped page 3 eight times. The duplicate rows were then removed by the
exporter's dedup, so the run looked correct and simply took longer than it
should have.

Fixed by making PAGINATE answer the question it is named for. A Next control
that is absent, `disabled`, `aria-disabled`, styled disabled, hidden, or an
anchor with no `href` means the last page; the loop stops there and says why.
For a paginator whose Next button is never disabled — common in single-page
apps — `requireChange` compares a fingerprint of the page before and after.

The step is split across two messages, which is not incidental: clicking a real
`<a href>` navigates, the content script is destroyed with the document, and its
reply never arrives. A page-side step that both decides and clicks therefore
fails on precisely the sites pagination exists for. So the page answers first,
the worker clicks, and losing the page afterwards is the expected outcome.

### J-04 · HIGH · `NAVIGATE` slept three seconds and hoped

`await chrome.tabs.update(tabId, {url}); await _sleep(config.wait ? 3000 : 800);`

A slow page was scraped before it existed. A fast one cost three seconds every
time, which inside a loop over 200 links is ten minutes of waiting for nothing.
The "Wait for page load" toggle chose between two sleeps; neither waited for a
page load.

Fixed: the run polls the tab's status until Chrome reports it complete, with a
configurable ceiling, and logs when it gives up. Testing a single step from the
panel now waits the same way, so "Test step" and "Run" no longer disagree about
what the step did.

### J-05 · MEDIUM · Seven step types had no configuration UI

`generateConfigHtml` had a block for 14 types and a fallback that looped over the
config object rendering raw key names as labels. So WAIT offered a box labelled
"ms", DRAG_DROP offered "source" and "target", SCREENSHOT offered "quality", and
SELECT offered "value" with no indication of what it was matched against or what
happened when nothing matched. The steps were configurable in principle and
unusable in practice.

All seven now have their own block, each stating what the step does, what the
value means, and what happens when it fails.

### J-06 · HIGH · Extracted values are never cleaned, so every scrape ends in a spreadsheet

`EXTRACT` returned exactly what the page rendered. A price came back as
`"$25.50"` — a string, with a currency symbol inside it. A link came back as
`"/p/123"`, which is not a link anywhere except on the page it came from. A
review count came back as `"1,234 reviews"`. Nothing in the product could turn
any of those into a value you could sort, sum or follow.

So the last mile of every scrape was done by hand, in Excel, with find-and-
replace — which is the part of the job people actually mind, and the reason a
tool like this exists.

Fixed with a per-field transform, in `utils/value-transforms.js` so both script
emitters apply the same ones and an exported script produces the same values
rather than a plausible-looking approximation. Number reading handles European
decimals, where the comma is the point: `"1.234,56"` read as `1.234` is a
hundredfold error in a price column with nothing to signal it. Text with no
number in it becomes `null`, never `0` — `0` is a plausible price and would sit
in the column indistinguishable from a real one.

Detect Table picks the obvious ones automatically: link columns become absolute
URLs, and a column whose samples are mostly currency is read as a number.
Conservative on purpose — guessing wrong empties a column the user can see on
the page — and visible in the field row, so it can be changed.

Two escaping bugs in the emitters were found while doing it, and both produced
scripts that ran:

- in JavaScript, a user's pattern `SKU: (\S+)` went into a single-quoted
  literal, where `\S` is just `S` — so the pattern silently matched nothing;
- in Python it was emitted into an `r""` raw string with the backslash
  doubled, giving a literal backslash followed by `S`.

Both parse. The column simply came back empty. The suite now reads the emitted
pattern back out and checks what it _matches_, rather than how it is spelled —
and an unusable pattern is emitted as a refusal rather than repaired, because a
repaired pattern gives a script that runs and extracts something else.

### J-07 · HIGH · The structured data every site publishes is ignored

Most real sites embed JSON-LD, Schema.org microdata, or Open Graph tags: clean,
typed, already-structured data, put there deliberately for machines to read.
FlowScrape read none of it, and asked the user for CSS selectors instead —
selectors describing data the site was handing out for free, and which break the
next time a designer renames a class.

`smart-extractor.js` does read JSON-LD, but only hunting for `@type: Product`.
A recipe, a job posting, an article, an event, a business's address and opening
hours: all invisible.

This is also the honest answer to the question the user kept asking — "can we
just turn the page into JSON". For a **single-record** page, which the structure
detector cannot help with at all because there is nothing repeating to find,
`PAGE_DATA` is exactly that, with no selectors involved.

It handles what real pages do rather than what a clean example does: a `@graph`
is flattened into its nodes (which is what WordPress and Yoast publish, so
reading the wrapper and stopping finds nothing usable on a large share of the
web); one malformed block does not lose the others, and is reported rather than
swallowed; nested microdata scopes stay nested, so an offer's price does not get
hoisted onto the product; `<meta itemprop>` and `<time datetime>` are read for
their machine-readable value rather than their rendered text, which is the
difference between an ISO timestamp and "3 days ago"; a repeated `itemprop`
becomes a list. Flattening guards against the cycles JSON-LD graphs genuinely
contain, which would otherwise hang the tab.

In `auto` mode microdata is a fallback rather than an addition: a site
publishing both publishes the same record twice, and returning it twice would
double every row.

A page with nothing structured on it comes back `found: false` with a reason,
rather than a guess assembled from headings — a guess is indistinguishable from
a reading, and the user has no way to tell which they got. Detect Table offers
the step when it finds no repeating structure, and only when there is actually
something to read.

**Stated limitation.** Both script emitters carry the JSON-LD and meta reading
but not the microdata reader — that is a hundred lines of DOM walking, and a
second compact implementation would drift from the first. The emitted script
says so at run time when it finds no JSON-LD, at the moment it matters, rather
than differing in silence.

### J-08 · HIGH · `IF_ELSE` could only compare text and attributes

No "is this empty", no numeric comparison, no pattern match. So "only scrape
items under £50" and "skip the row when the price is missing" — the two things
a branch is most often for — could not be expressed at all.

The comparisons now live in `utils/conditions.js`, and the split is deliberate:
**the page reads the DOM and reports what it saw; the worker decides what that
means.** A numeric branch needs the same number reader `EXTRACT` uses — one
reading `"1.234,56"` as `1.234` would take the wrong path on every European
price — and a classic content script cannot import it, so evaluating in the
page would have meant a second parser drifting from the first.

Two failures were folded in while doing it:

- `_executeIfElse` swallowed every error into `met = false` and took the ELSE
  branch, so a broken condition, a bad pattern and a dead tab were all
  indistinguishable from a condition that was simply not met. It says which now.
- Both script emitters handled `exists` and emitted
  `if (true) { // TODO: impl extended condition … }` for everything else. The
  exported script therefore took the IF branch unconditionally — it ran,
  produced a file, and had silently ignored its own branching. The B-13 check
  could not see it: it looks for `# TODO` in the Python output, and the Node
  stub was a `//` comment. Every condition is emitted now, and one that cannot
  be is a refusal rather than an always-true.

### J-09 · MEDIUM · `KEYBOARD` typed at whatever had focus, once

No target and no repeat. "Type into the search box and press Enter" needed a
`CLICK` first, and worked only if that click happened to focus the right thing;
pressing a key twice needed two steps. A selector focuses the element first —
a key event dispatched at an input the page does not consider focused is
ignored by most frameworks — and a selector matching nothing throws rather than
falling back to `document.activeElement`, where the key lands on the page body
and does nothing while the step reports success. Repeat is clamped, because a
template can resolve to anything and 10,000 ArrowDowns locks the tab.

### J-10 · MEDIUM · `API_SNIFFER` recorded everything

On a real site that is analytics beacons, font files, session pings, ad auctions
and image lazy-loads, with the four calls you wanted somewhere inside them. The
capture buffer is bounded (D-10), so on a busy page the noise could push the
signal out of it before the run finished. `utils/sniffer-filter.js` filters
before the buffer, not after.

The filter's syntax was decided by a test rather than by taste: the obvious
spelling for a regular expression is `/…/`, and it is wrong here, because
`/api/` is the single most likely substring anyone will type **and** valid regex
syntax. Slashes would have silently reinterpreted the common case as a
case-sensitive pattern — caught by asking for `/api/` against a mixed-case URL.
So substrings keep the plain spelling and a regular expression says `re:`.

### J-11 · MEDIUM · `SCREENSHOT` could only photograph the visible strip

`captureVisibleTab` photographs the viewport and nothing else, so "screenshot
the page" gave you the top of it and photographing one element was impossible —
both under a control that said only "quality".

A full-page shot walks the page a viewport at a time and joins the strips with
`OffscreenCanvas`, puts the scroll position back (leaving the page at the bottom
breaks every step after it that depends on what is on screen), and truncates
past a cap, saying so — an endless feed has no bottom to reach. An element shot
crops to the element's box, and fails when nothing matches rather than returning
the whole page under a name that says otherwise.

Two things surfaced with it: a fixed header repeats in every strip of a stitched
shot, which is what stitching does and cannot be avoided from an extension —
stated rather than hidden; and testing a single `SCREENSHOT` step had never
worked at all, because the step runs in the worker and the test path forwarded
everything it did not special-case to the page, where `injector.js` refuses it
by design (B-32).

The stitching itself is proven in the e2e suite, where the image can be decoded
and measured. Node has neither `OffscreenCanvas` nor `createImageBitmap`, and
mocking them would have meant asserting against something more capable than the
runtime — which is exactly what hid A-12 for four hundred tests.

That decision paid immediately. The first full-page shot in a real browser came
back `This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota`:
**Chrome allows about two captures a second**, and a four-strip page asks for
four at once. The mocked `captureVisibleTab` has no quota, so in the unit suite
stitching looked instantaneous and free. Captures are paced now — waiting first
rather than retrying after a refusal, since the retry has to wait anyway — with
one patient retry for the case where something else spent the quota, and the
panel says a long page will take a few seconds.

### J-12 · HIGH · Detect Table returned a page's labels as columns

_Found by running the extension against a real site rather than against a
fixture._

A scrape of `scrapethissite.com/pages/simple/` came back with the right data in
eight columns, four of which were junk:

```
country name,strongnthoftype,country capital,strongnthoftype 2,
country population,strongnthoftype 3,country area,sup
Andorra,Capital:,Andorra la Vella,Population:,84000,Area (km2):,468.0,2
```

Real markup labels its fields inline — `<strong>Capital:</strong>` beside the
value — and those `<strong>`s have the same shape in every record, so they read
as a perfectly consistent column. Three of them held the same label repeated in
all 250 rows; the fourth held the `2` from `km<sup>2</sup>`.

**A column whose value never changes carries no information about the record.**
It is the form's label, printed once per row. Constant columns are dropped, and
samples are now kept for every record rather than the first three, because
constancy cannot be judged from three.

The same run exposed two number-reading faults:

- `"1.4E7"` — how that site reports Antarctica's area — was read as `1.4`. The
  numeric run stopped at the `E`, turning fourteen million into one point four:
  a wrong number that looks entirely plausible in a column of areas. Scientific
  notation is read whole now, and only where it is unambiguous, so `"3 EUR"`
  and `"Section 4E"` are still not exponents.
- Populations and areas carry no currency mark, so Detect Table's automatic
  transform left them as text. A column whose samples are _all_ cleanly numeric
  is read as numbers — all, not a majority, because a column that is 90% numbers
  and 10% `"N/A"` would otherwise turn that 10% into empty cells with nothing
  said.

### J-13 · HIGH · Detect Table stacked a second scrape of the same list, silently

_Found by counting the rows in a real run's export._

The same country scrape that produced J-12 returned **1,250 rows for 250
countries** — every row five times over.

The generated pipeline is not at fault: reproduced end to end in a real browser,
a detected table yields exactly one row per record. The five copies came from
the board carrying five identical loops. `_insertDetectedTable` appended one
each time the button was pressed, said "Added a loop", and gave no hint the
previous one was still there. Five presses, five full scrapes, one export.

Nothing downstream could have caught it either. The export's dedup (D-07)
reconciles the in-memory rows against the ones read back from IndexedDB — it is
about the same row arriving twice by two routes, not about a pipeline that
genuinely scraped a list five times, and collapsing those would be wrong: a
scrape can legitimately produce identical rows.

Fixed where the mistake is made. An existing element-loop over the same
selector is looked for first — depth-first, since a detected table can be
dropped inside another container — and the user is asked whether to replace it.
Declining leaves the pipeline untouched and says so.

### J-14 · BLOCKER · Nothing could reach inside an iframe

_Reported from a real session: "this tool cannot interact with the elements in
the iframe"._

The content script was injected with `allFrames` left at its default of false,
so it only ever existed in the top document. An iframe is a separate document
rather than a branch of its parent's DOM, so every selector was resolved
against a document that does not contain the frame's contents — and no step
could touch anything inside one, on any site.

Injection now reaches every frame, and the user's suggestion was the right
design: a **toggle on each page step** rather than searching frames always.
Searching every frame by default changes what an ambiguous selector matches,
and a page can carry a dozen advertising iframes that each happen to hold a
`.title`. With the toggle on, the step tries the page first and then each frame
in turn.

Two things surfaced with it, both caught in a real browser:

- `chrome.tabs.sendMessage` without a `frameId` delivers to **every** frame and
  returns whichever answers first. Once the script was in all frames, an
  advert's iframe could answer a step aimed at the page. Both the step message
  and the injection ping are addressed to frame 0 now.
- The walk has to know the difference between _ran_ and _found_. `EXTRACT` does
  not fail when a field misses — by design, since B-08 — so the top document
  "succeeded" with `[{t: null}]` and the walk stopped before reaching the frame
  that had the element.

`injector.js` also guards against being evaluated twice, because with
`allFrames` the same file lands in several documents and a frame that is
already set up gets it again on the next injection. Two listeners in one
document means every reply is sent twice and the second one loses, which is how
A-08 silently disabled the ethics gate.

### J-15 · HIGH · Half the step types could not be tested

_Reported as `Unknown step type: LOOP`, `Unknown step type: API_SNIFFER`, and
"pdf extract is not working"._

The single-step test path special-cased a handful of types and forwarded
everything else to the page. Ten of the twenty-two run in the **worker**, so
half of them arrived at `injector.js`, which refuses them by design (B-32), and
the panel showed a message that reads like the step is broken.

A hand-kept list of exceptions is what drifted. The registry already says where
each type runs, so the router asks it (G-01), and the three that genuinely
cannot be tested alone say why instead of failing:

| Step          | What "Test" now says                               |
| ------------- | -------------------------------------------------- |
| `LOOP`        | needs a pipeline to iterate; press Run             |
| `EXPORT`      | needs the rows a run collected                     |
| `API_SNIFFER` | records for the whole run, not at this point in it |

`PDF_EXTRACTION` and `AUTO_EXTRACT` are wired up, because they can genuinely
run on their own.

### J-16 · HIGH · The API sniffer captured, and threw the captures away

_Reported as "api sniffer is not working"._

It was working. Measured in a real browser it hooked the page and logged
`Sniffer: 1 request captured` — and then `data:download` returned `{runId,
rows}` and nothing else, and the run state holding the captures was deleted the
moment the run finished. So the only way to see a captured request was to open
the export archive, and a user who looked anywhere else saw a sniffer that had
apparently done nothing.

Captures now outlive the run that made them (bounded to the last few runs, on
top of the per-run caps from D-10), `data:download` returns them, and the
monitor says as they arrive — thinned, because a busy page makes hundreds of
requests and one line each would bury the run's own messages.

### J-17 · MEDIUM · Detect Table ignored a table's own header row

_Reported with the export it produced._

    tdnthoftype,tdnthoftype 2,tdnthoftype 3,tdnthoftype 4
    Clean Code,Robert C. Martin,4.5,26.56

An ordinary HTML table whose `<thead>` says, in so many words, what each column
is — and every column was named after the selector that found the cell, while
the page was holding up a sign saying "name". It reads the sign now.

Only where the markup actually says so: a `<thead>`, or a row of `<th>`. A
first row of plain `<td>` is genuinely ambiguous, and guessing wrong either
names every column after the first book or silently drops a real row from the
scrape — so it is left as data, where it can be seen and deleted.

### J-18 · MEDIUM · `HOVER` reported success whatever happened

_Reported as "hover not working". It half works, and the half that does not
cannot be fixed from a content script._

Measured in a real browser: a JavaScript `mouseover` listener fires, and a CSS
`:hover` rule does not apply. `:hover` follows the browser's real pointer
position, and no page may move the cursor — one that could would be able to
fake a click on anything. So a menu built in JavaScript opens and a CSS-only
menu does not, and no extension can change that without attaching a debugger to
the browser.

What was wrong is that the step reported success either way. Given
`revealSelector` it now waits for the thing the hover is meant to bring up and
fails with that explanation when nothing comes — silence here means every step
afterwards works on a menu that never opened. The panel says the same, next to
the field.

### J-19 · MEDIUM · A browser shortcut could not be registered, only triggered

_Reported as: pressing Ctrl+W to register it closed the tab._

It always will. Ctrl+W, Ctrl+T, Ctrl+N and their friends are handled by Chrome
before any page or extension page sees the keystroke, and `preventDefault` does
not reach that far — a page that could block Ctrl+W could trap you on itself.

So the combo can now be **typed** as well as captured, and a reserved one is
flagged with what will happen. The step still sends it to the page as a
synthetic event, which works when the page listens for it; the browser's own
action is what cannot be suppressed.

### J-20 · BLOCKER · A field picked inside a loop was described page-wide

_Reported as "bulk extract is not working properly … I want to scrape the data
of the products in cards", alongside a memory of a feature for "choosing the
elements of a particular element in loop to extract"._

The memory was right about what is needed and wrong that it ever existed.
`_addExtractField` asked the page for a selector with no idea that the `EXTRACT`
it was filling sat inside a `LOOP` over `.card`, so it got a page-wide one —
and `_buildBulkSelector` guessed at one by walking up five levels of
direct-child combinators and stopping at the first that matched **two**
elements. On a grid of product cards that lands almost anywhere: two matches is
nothing on a page of twenty cards, and the `>` chain breaks on the first
wrapper div a framework inserts.

The fix is not a better guess. **The loop already says what a record is**, so a
field picked inside it is described relative to that record — `.title`, not
`.grid > .card:nth-of-type(2) > .title`, which finds the second card's title in
every row. The same relative-selector idea the structure detector uses.

The picker is told the scope: it outlines the records, and a click outside every
one of them is refused with a note rather than answered with a page-wide
selector. Inside a loop the bulk-or-specific question is not asked at all — the
record is already chosen, and the field is a column within it.

### J-21 · HIGH · Nothing could be dragged into a loop

_Reported as "even if I keep any activity inside the loop it is not working"._

E-05 fixed `_moveStep` so a step could be dragged **between** containers and
left the harder half untouched: drops were only accepted on another
`.node-wrapper`. So an empty loop had nothing to drop onto at all, and dropping
on a loop's own card moved the step to where the loop is — beside it, not
inside — which is indistinguishable from nothing happening.

The body of a loop and each branch of an `IF_ELSE` are drop targets now, they
highlight while a step is over them, and a container cannot be dropped into
itself or into one of its own descendants (it would vanish from the board,
taking its children with it).

### J-22 · MEDIUM · No way to get the page itself as JSON

_Asked for twice: "I need an activity that returns the entire page in json
format", then "DOM as json or any type page content to json if user required"._

`PAGE_DATA` (J-07) reads the structured data a site _publishes_. That is the
clean answer where a site publishes any and no answer at all where it does not.

`PAGE_JSON` is the other one: the page as it actually is, no selectors, works on
anything. Three shapes, because "as JSON" means different things depending on
what happens next — a nested **tree** for something that will reason about the
page, the readable **text** in order for reading or handing to a model, and a
**flat** row per element, which is also the fastest way to find the selector you
were looking for.

The hard part was never walking the DOM. It is that a naive dump of a real page
is megabytes of scripts, minified CSS, SVG path data and layout wrappers, and
searching it is harder than writing the selector you were avoiding. So the
default keeps what a reader would call content, every exclusion is a switch, and
a page that hits the element or depth budget says so instead of quietly handing
back half of itself.

Not exportable to a standalone script: the walker is two hundred lines with its
own budgets and filters, and a second copy inlined into every emitted script
would drift from it. A script that dumps _different_ JSON than the pipeline is
worse than one that refuses.

### J-23 · HIGH · The board was a canvas in a four-hundred-pixel strip

_Reported as "I don't like how the UI works … even if I keep any activity
inside the loop it is not working because of UI constraints I think", and then
"fix the UI, colors, animations, UX properly … not like AI way"._

Two separate faults, one cause.

**The layout.** `#board-stage` was a 1400 x 1200 pannable, zoomable canvas
inside a `#board-viewport` about 400px wide with `overflow: hidden` — the
node-graph metaphor desktop automation tools use, in a strip where four hundred
pixels is the entire width. Steps were routinely laid out where they could not
be seen and had to be hunted for by dragging. A loop's body was the usual
casualty: it renders below and to the side of its loop, so the drop target for
"put this step inside the loop" was frequently off-screen. J-21 fixed the drop
handler; the drop target still had to be found first.

E-11 (throttle the wire redraw) and E-12 (say which modifier zooms) were
performance and discoverability fixes for that canvas. The canvas was the
defect. It is now a scrolling vertical list — which is also the honest shape,
because a pipeline _is_ a list — and the pan, zoom, fit, wire-render and
zoom-hint machinery is gone, along with the SVG redraw that ran on every
pointer move.

**The visual design.** It had never been designed, only assembled: Tailwind's
default indigo `#6366f1` on blue slate, twelve-pixel radii, soft drop shadows,
and an emoji in a rounded gradient tile for every step — the exact set of
defaults that reads as machine-generated. The panel is now a laboratory
instrument: warm graphite ground, one amber signal colour that means "you can
act on this", mint reserved so strictly for "running" that a glance answers
whether a run is alive, hairlines instead of blur, and 120-180ms mechanical
motion. Typography inverted to match — JetBrains Mono for every label, button
and number, Inter for prose only, which is what makes it read as lettered
rather than typeset. Both faces are already bundled, so this needed no new
asset and no CSP exception (A-09).

Fixed along the way, each of them a real defect rather than a taste call:

- The toolbar was a non-wrapping row of ~560px of controls in a 400px panel —
  the last two were outside the window with no way to reach them.
- The `border-left` a step card set inline could never be overridden by the
  stylesheet, so the card's hover and running states could not restyle it.
- IF/ELSE branches sat side by side, giving each about 170px — narrower than a
  single step card.
- Every toggle in the panel used `display: none` on its checkbox, which takes
  the control out of the tab order: no toggle could be reached or operated from
  the keyboard (a second E-09).
- Zoom in / zoom out / reset / fit were four buttons that, once the board
  became a list, did nothing.

### J-24 · BLOCKER · Neither selector mode did what it said

_Reported as "why is Specific working as Bulk and Bulk working as Specific in
the extract activity"._

Measured against a five-row books table, picking one price cell:

| mode     | selector returned | matched                         |
| -------- | ----------------- | ------------------------------- |
| Specific | `td.price`        | 5 — every price on the page     |
| Bulk     | `td`              | 15 — every cell of every column |

**Specific** walked up building an ancestor chain and returned the _best_
candidate — the one matching fewest elements — whether or not that was one
element. A positional path was tried only if the best had degraded to a bare
tag. Every level of a table has a class, so the walk never reached a count of
one and "this element" came back as the whole column.

**Bulk** did the opposite. On seeing that the target's siblings share its tag it
treated that level as the repetition and dropped the element's own class — so a
cell became `td`: names, authors and prices interleaved into one column of
nonsense. This is what "bulk extract is not working properly" was; the
loop-scoped picking of J-20 worked around it rather than fixing it.

The two were also indistinguishable on an anchor, both returning five matches,
which is how "bulk behaves like specific" looked from the outside.

Specific now falls back to a positional path whenever nothing names the element
uniquely, and that path names each level rather than counting it —
`tr.book:nth-of-type(2) > td.price`, not
`body:nth-of-type(1) > table:nth-of-type(1) > tbody:nth-of-type(1) > …`, which
is unique and useless. Bulk keeps whatever distinguishes the element from the
siblings it was being confused with, so it means "this field in every record"
rather than "every sibling".

### J-25 · HIGH · Detect Table dropped every column with no text

_Reported against a books table on a practice site: "the star column is not
identified" — it came back as 10 rows x 3 columns._

`columnsOf` read text, `href` and `src`, and skipped any element with none of
the three. A rating is the canonical value a page shows without writing down —
four filled star icons, `class="star-rating Three"`, an `aria-label`, a
`data-rating` — and all four shapes hit that skip.

A second bug hid the cell from anything that might have looked: the "sole child
carrying all its parent's text" wrapper guard compared two empty strings and
matched, so **any** single-child wrapper with no text was skipped before its
contents were considered.

An element with no text now offers whatever carries its value: the accessible
name (`aria-label`/`title`/`alt` — required for the widget to work for screen
readers at all), a `data-*` value, its class list, or a count of its repeated
icon children. The last two are offered together rather than guessed between,
because the existing constancy filter already drops a column whose value never
varies — a wrong guess costs a column that disappears on its own, a missing
guess costs the user their data.

That needed a reader on the other side, or the detector would produce columns a
run returns empty: EXTRACT gains a **Count** field type, and both script
emitters carry it, so an exported script counts the same thing the run does.
The detected column also had to carry the attribute name that makes it
readable — without it the run failed with "set to Attr but has no attribute
name", loudly at least, but still unusable.

### J-26 · BLOCKER · The API sniffer never captured anything after a navigation

_Reported as "this has an API that itself gives the JSON data back, still the
API sniffer is not finding anything"._

Two faults, both fatal on their own.

**The relay was missing.** `page-sniffer.js` runs in the MAIN world, where there
is no `chrome.runtime`, so it reports what it caught by posting a window
message. `injector.js` is what forwards that to the worker — and `injector.js`
is injected _on demand_, when a page step needs it. On a freshly navigated
document it is simply not there. Verified in a real browser: the hook was
installed (`fetchPatched: true`) and the relay was not (`injectorLoaded:
false`), so every capture was posted into a page with no listener and dropped.
Since a run almost always navigates before the traffic it cares about, the
sniffer captured nothing in practice. The relay is now registered with the same
matches and the same lifetime as the hook it serves.

**The page was the response.** Opening an API URL directly — the most obvious
thing to try — makes no fetch and no XHR: the JSON _is_ the document, and there
is no request to hook. A document whose content type says it is data is now
reported as a capture in its own right, once, and only stored if a run with the
sniffer on owns the tab.

### J-27 · HIGH · Paginate asked for a Next button and offered a bulk picker

_Found while reproducing the PAGINATE report against a 24-page paginator._

A LOOP's `selector` means two different things depending on its mode: the
records to iterate over (many) or the Next control (one). The picker keyed its
default off the step type alone, so a paginating loop opened in **Bulk** — and a
bulk pick of a paginator returns every page link. PAGINATE clicks the first,
which is "1", so the run re-scraped page one until Max pages ran out.

The field was also labelled with its raw key, `selector`, with nothing saying it
wanted the Next control; and `_executePaginate` honoured `settleMs` and
`requireChange`, neither of which the UI offered — so a paginator whose Next
button is never disabled could not be stopped at all.

PAGINATE's own logic was correct throughout: against a 24-page paginator with
Max pages set to 30 it collected 600 rows and stopped at page 24 with "no
element matched … this looks like the last page".

### J-28 · BLOCKER · The sniffer relay broke the content script it needed

_Reported while testing J-26: `Uncaught SyntaxError: Identifier 'FS_ORIGIN' has
already been declared`. Introduced by J-26's own fix._

Registering `injector.js` as a content script for the sniffer meant it could be
evaluated twice in one document — once by that registration, once by the
on-demand injection a page step triggers. The two genuinely race.

A classic content script's top-level `const` becomes a lexical binding on the
isolated world's global scope, and that binding is created when the script is
_instantiated_, before a single statement runs. So the second evaluation threw
before reaching anything, and took the whole content script with it. The
`__fsInjected` guard could not help: it sat 260 lines below the first `const`,
and was never reachable in the case it was written for.

`injector.js` is now wrapped in a function, so its bindings are local and a
second evaluation is harmless, with the guard moved to the first line so it is a
clean no-op rather than a second set of listeners. The sniffer's own injection
also goes through `_ensureInjected` rather than injecting blindly — surviving a
double injection is not a reason to do one.

Two tests were passing vacuously and were found while fixing this: both sliced a
function out of `injector.js` with a lazy `[\s\S]*?` anchored on a closing brace
at a fixed indent. Re-indenting the file made one stop at the first nested
brace, cutting `_handleEvent` to six of its cases while still asserting over
what remained. Both now anchor on their own indent and assert the slice reached
the end of what it claims to cover.

### J-29 · LOW · A designed refusal was logged as a crash

Pressing Test on `API_SNIFFER`, `LOOP` or `EXPORT` returns an explanation —
these only mean something inside a run (J-15). The explanation is the intended
answer, but it was thrown as a plain `Error` and logged through the same path as
a genuine fault, so the console showed a red `handler-error` for a step
behaving exactly as designed. Red that means nothing is red that hides the
errors next to it. These now carry a flag that logs them at info level; the
message the user reads is unchanged.

### J-30 · HIGH · The sniffer worked and the panel said it had not

_Reported as "I think the API sniffer is still not working — only for the link I
provided did it work, the rest not"._

With J-26's relay in place the capture engine is correct. Verified in a browser
against the four shapes real traffic takes, all four stored:

| traffic                                     | captured |
| ------------------------------------------- | -------- |
| `fetch` in `<head>`, before the relay loads | yes      |
| `XMLHttpRequest`                            | yes      |
| `fetch` to a different origin               | yes      |
| `fetch` fired on a timer, long after load   | yes      |

What was broken was everything the user could see.

**The download threw the captures away.** `_downloadRunRows` asked for
`data:download`, which returns rows _and_ networks — J-16 added them for exactly
this — then read `rows` alone, announced "That run stored no rows" and wrote no
file. A run whose whole purpose was the sniffer reported collecting nothing
while its captures sat unread in the reply it had just received. It now writes
`flowscrape_<run>_api.csv` alongside the row file, and the empty-run message
appears only when both are empty.

**The log went quiet.** Captures are named only for the first three, so that a
busy page cannot bury the run's own messages — sound, but it meant a site making
forty calls showed three lines and then nothing for the rest of the run. The
count is a readout in the monitor now, beside Rows Extracted, revealed the first
time a run captures anything.

So "only the link I provided worked" was precisely backwards: that link was the
one case with so little traffic that all of it fit in the first three log lines.

---

# Suggested repair order

**1 — Make the shipped path honest (blockers):**
A-03 (one shared IDB schema module), A-04 (persist the wrapped AES key, or re-init on `onStartup`/`onInstalled` and drop `_ensureKey`'s silent regeneration), A-08 (make `injector.js`'s runtime listener return `false` for types it does not own), A-09 (bundle the fonts), A-01/A-02 (either build the Upload Setup markup or remove the dead handlers).

**2 — Stop lying to the user (high, cheap):**
B-01/B-02 (forward `bypassRobots`; surface warnings and require confirmation), B-03 (make the domain lock a warning, or scope it to non-API steps), B-04/B-05/B-06 (honour `useLlm`, remove the fake `extractType` options, relabel the threshold), B-07 (add the attribute-name input), C-03 (stop logging raw proxy lines), C-04 (`textContent`).

**3 — Close the security gaps:**
C-01 (nonce or remove the postMessage transport), C-02 (gate the sniffer behind an active run), C-06 (bind MCP HTTP to localhost + host validation), C-07/C-08/C-09 (trim `web_accessible_resources` and drop the four unused permissions).

**4 — Decide the fate of the dead half of the codebase:**
F-01's nine modules and A-05/A-06/A-07's three subsystems are ~2,700 lines. Either wire them up (proxy application in `_executePipeline`; a FORM_FILL step; a CSV/JSON data-source step) or delete them and correct the README, the manual and the test checklist. Carrying them as-is is what makes the docs unreliable.

**5 — Then quality:**
G-01 (single shared step registry consumed by the UI, the emitters and MCP), B-13 (emitter coverage), I-01 (unit tests for the pure modules), I-02 (lint), B-27 (deduplicate the two step-dispatch chains).
