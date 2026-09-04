# Capability review

A pass over every activity, the three subsystems (MCP, captcha, proxies), and
where the runtime spends its time. Written against the code, not the docs —
every claim below names the file that supports it.

Companion to `ISSUE_AUDIT.md`, which records defects. This records **gaps**:
things that are not broken, because they were never built.

---

## 1. The headline findings

Five things matter more than everything else in this document.

| #   | Finding                                                                                                        | Why it matters                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No shadow-DOM support.** `_queryScoped` uses plain `querySelectorAll`                                        | Every web-component site is invisible. Identical in kind to the iframe gap (J-14) the user hit — a boundary selectors do not cross |
| 2   | **Proxy rotation never runs during a scrape.** `selectProxy` is only reachable from the `proxy:select` message | The pool parses, tests, dedupes and rotates. No run consults it. The feature looks complete and does nothing                       |
| 3   | **MCP cannot scrape.** 18 tools, none of which run a pipeline or read a page                                   | An AI agent can author a pipeline and never execute one. There is no bridge from the MCP process to the browser                    |
| 4   | **Captcha detection is dead code.** `content/captcha-detector.js` is in no manifest entry and no import        | 342 lines, self-documented as unreachable (A-06). `solveCaptcha` exists and nothing sends `captcha:solve`                          |
| 5   | **167 KB of JS into every frame, every injection**                                                             | `CONTENT_FILES` is five files totalling 170,799 bytes, injected with `allFrames: true`. A page with 20 iframes parses 3.4 MB       |

---

## 2. Every activity, against what the job actually needs

24 user-facing step types (`utils/step-types.js`), plus 6 internal. Grouped by
how much is missing.

### Solid — no change needed

| Step       | Why it holds up                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FILL`     | Uses the native value setter (`_setNativeValue`), so React and Vue controlled inputs keep the typed value instead of reverting. Fires `input` and `change`. Multi-field mode, per-key delay, append, submit selector |
| `SELECT`   | Matches by value, then visible text, then either case-insensitively; refuses a disabled option; lists the real options in the error; fires both events                                                               |
| `WAIT`     | Fixed, element-appears, element-disappears, DOM-settle                                                                                                                                                               |
| `EXTRACT`  | Text, HTML, attribute, count; value transforms; honest row assembly (1 match broadcasts, n matches are positional, misses are `null` not padded)                                                                     |
| `PAGINATE` | Probes before clicking, so a navigation is expected rather than an error; detects a dead Next control four ways; optional fingerprint check for SPAs                                                                 |

### Gaps worth closing

| Step              | Missing                                  | Real case it fails on                                                                                                                                     |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLICK`           | Wait-for-navigation-or-XHR after click   | Click "Load more", next step runs before the rows exist. Today you add a WAIT and guess the number                                                        |
| `CLICK`           | Right-click / middle-click / modifier    | Opening results in a new tab; context menus                                                                                                               |
| `SCROLL`          | Scroll a specific container              | `selector` exists, but infinite-scroll inside a `div` with its own scrollbar is the common shape and needs the container's own height, not the document's |
| `EXTRACT`         | Download a matched file/image            | "Get every product image" ends with a column of URLs and no files                                                                                         |
| `EXTRACT`         | Regex capture group as a field           | Pulling an ID out of `/product/1234-name`. Transforms clean values, they do not parse them                                                                |
| `SCREENSHOT`      | Per-element scroll-into-view first       | An element below the fold crops to whatever the viewport held                                                                                             |
| `API`             | Pagination (cursor / page / Link header) | Any paged JSON API needs a LOOP whose exit condition it cannot express                                                                                    |
| `API`             | Retry on 429/5xx with `Retry-After`      | The rate limiter paces steps, but a single API step that gets a 429 just fails                                                                            |
| `UPLOAD_ACTIVITY` | Drag-drop upload zones                   | Sites with no `<input type=file>` — increasingly common                                                                                                   |
| `IF_ELSE`         | Comparing two extracted values           | "If price < last-seen price". Conditions test one selector against a literal                                                                              |
| `LOOP`            | Loop over a list (an API result, a CSV)  | Iterating 500 product URLs from a file needs a data-source loop; only elements/count/paginate exist                                                       |
| `EXPORT`          | Append to an existing file               | A run per day into one dataset                                                                                                                            |
| `PDF_EXTRACTION`  | Tables                                   | PDF tables come out as a text blob                                                                                                                        |

### Missing entirely

| Proposed step              | Why                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DOWNLOAD_FILE`            | Images, PDFs and CSVs from a scrape. The single most common thing a scraper does that this cannot do at all                          |
| `COOKIES` / `SESSION`      | Save the logged-in state after a manual login and reuse it. Today every run re-logs-in, which is slow and gets accounts flagged      |
| `SET_HEADERS`              | User-agent and `Accept-Language` per run. Fixed values are a fingerprint                                                             |
| `SOLVE_CAPTCHA`            | See §4                                                                                                                               |
| `RETRY` / step-level retry | The registry has `optional` (keep going on failure) but no "try three times". A flaky selector fails the row rather than the attempt |
| `DEDUPE`                   | "Scrape only what is new since last run". Needs a key column and a persisted seen-set                                                |
| `ASSERT`                   | Fail the run loudly when the page shape changes, instead of exporting 500 empty rows                                                 |

---

## 3. Cross-cutting: shadow DOM

The one gap that silently breaks whole sites.

`_queryScoped` — the resolver behind CLICK, FILL, EXTRACT, HOVER, SELECT,
IF_ELSE, PAGINATE, SCROLL and the picker — calls `root.querySelectorAll(sel)`.
That does not cross a shadow root. Shadow-DOM piercing exists in exactly one
place in the codebase, `_deepQueryAll` inside `_stepUploadActivity`, written to
find file inputs.

So on a site built from web components, every selector matches nothing and the
tool reports "not found" for elements plainly on the screen. That is the same
user experience as the iframe gap, and it needs the same shape of answer: a
resolver that walks open shadow roots, with the cost paid only when the plain
query finds nothing.

**Recommendation:** promote `_deepQueryAll` to the shared resolver, tried as a
second pass. Closed shadow roots stay unreachable and should say so.

---

## 4. Captcha

**State:** `content/captcha-detector.js` is 342 lines that detect reCAPTCHA
v2/v3, hCaptcha, Turnstile and image captchas. It is in no `content_scripts`
entry and nothing imports it. `solveCaptcha` lives in
`background/api-key-manager.js`, reachable through the `captcha:solve` message,
which nothing sends. The panel has a 2Captcha key field that stores a key
nothing spends.

This is recorded as A-06 and was deliberately left. It is now worth deciding
properly, because the parts are all present.

**Recommendation — in this order:**

1. **Detect and stop.** Load the detector; when a captcha appears mid-run,
   pause and tell the user which kind and where. This alone turns "the run
   produced 40 empty rows" into "the site asked for a captcha at row 41", and
   needs no solver, no key and no ethical argument.
2. **Then, optionally, solve.** Wire `captcha:solve` to a `SOLVE_CAPTCHA` step,
   gated behind the existing `captchaAuthorized` flag the run payload already
   carries.

Step 1 is most of the value. A scraper that stops and says why is far more
useful than one that silently returns nothing, and it is the honest default.

---

## 5. Proxies

**What works:** parsing (text, JSON, CSV), protocol inference, dedupe, health
checks with latency, failure counts, sticky and round-robin cursors, credential
redaction in logs.

**What does not:** nothing in `_executePipeline` ever asks for a proxy.
`selectProxy` is called from exactly one place — the `proxy:select` message
handler — which returns a descriptor to whoever asked. A scrape never asks.

**The constraint that explains it:** MV3 has no per-request proxy. The only
mechanism is `chrome.proxy.settings.set()` with a PAC script, which is
**browser-wide** — every tab, including the user's own. B-19 already dealt with
the fallout: a health check used to leave the whole browser routed through the
last proxy tested.

So the honest options are:

| Option                                        | Cost                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apply the proxy for the run, restore it after | Correct and achievable — `testProxy` already snapshots and restores. The user's other tabs are proxied for the duration, which must be said plainly before the run starts |
| Rotate per domain or per N pages within that  | Same mechanism, a PAC update between pages                                                                                                                                |
| Per-request proxying                          | Not possible in MV3. It needs the emitted Playwright script, where `--proxy-server` is per-context                                                                        |

**Recommendation:** wire option 1, with an explicit warning in the pre-flight
that already exists for robots and ethics. Emit per-context proxies in the
generated scripts, where the platform actually supports it. And either wire the
`ROTATE_PROXY` control into LOOP or remove the pool UI — a settings page for a
feature no run consults is worse than no settings page.

---

## 6. MCP — what an AI agent can and cannot do

18 tools in `mcp/server.mjs`:

| Group     | Tools                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Workspace | `repo_list_files`, `repo_read_file`, `repo_write_file`, `repo_search_text`                                                          |
| Pipelines | `pipeline_compile`, `pipeline_validate`, `pipeline_list`, `pipeline_save`, `pipeline_load`, `pipeline_serialize`, `pipeline_report` |
| Codegen   | `pipeline_emit_python`, `pipeline_emit_node`                                                                                        |
| Utilities | `pdf_extract_text`, `pii_scan_text`, `pii_scan_rows`, `robots_check`, `rows_to_text`                                                |

**Not one of them runs a scrape.** There is no `run_pipeline`, no
`get_results`, no `read_page`, no `detect_structure_at_url`. The MCP process is
a standalone Node server with no channel to the extension — no native
messaging, no socket, nothing.

So the agent story today is: _an agent can write a pipeline file and generate a
Playwright script from it._ Which is useful, and is not what "every AI agent
should easily work" means.

**The gap is a bridge.** Two viable shapes:

| Approach                                                              | What it gives                                                                                     | Cost                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Headless runner** — MCP shells out to the emitted Playwright script | `run_pipeline` works with no browser open; deterministic; already 80% built (both emitters exist) | Steps marked `exportable: false` (PAGE_JSON, PDF, AUTO_EXTRACT, sniffer, uploads) cannot run this way |
| **Native-messaging bridge** to the live extension                     | Full step coverage, real browser, the user's session and logins                                   | A native host binary the user must install; a much larger surface                                     |

**Recommendation:** the headless runner first. It reuses the emitters, needs no
install, and covers the steps an agent actually composes. Add `run_pipeline`,
`run_status`, `get_rows`, and a `detect_structure(url)` that fetches and runs
the detector under jsdom — that last one would let an agent build a working
pipeline from a URL alone, which is the thing agents most want and cannot do.

Also worth adding regardless: `list_step_types` returning the registry, so an
agent discovers the vocabulary instead of guessing it.

---

## 7. System load

| Cost                           | Measured / found                                                           | Fix                                                                                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **167 KB injected per frame**  | `CONTENT_FILES` = 170,799 bytes across 5 files, injected `allFrames: true` | Only `injector.js` (98 KB) is needed for most steps. Load `smart-extractor` (31 KB), `structure-detector` (21 KB), `page-data` (13 KB) and `page-json` (8 KB) on demand — they are already only used by one step each. Saves ~42% of the payload on every injection, more on iframe-heavy pages |
| **Injection into every frame** | `target: { tabId, allFrames: true }`                                       | Needed for the iframe fix (J-14), but only when a step asks for it. Steps carry `inFrame` already — inject `allFrames` only when it is set                                                                                                                                                      |
| **Keepalive during runs**      | `setInterval` + a 1-minute alarm while any run is live (`_startHeartbeat`) | Correct for MV3, no change                                                                                                                                                                                                                                                                      |
| **Rate limiting**              | `acquire(domain)` per step — works                                         | No change                                                                                                                                                                                                                                                                                       |
| **Capture buffers**            | Bounded by count and bytes, drops are reported                             | No change                                                                                                                                                                                                                                                                                       |
| **Dead import**                | `backoff` imported in `service-worker.js`, never called                    | Remove                                                                                                                                                                                                                                                                                          |

The injection payload is the only load finding that matters. Everything else in
the runtime is already bounded.

---

## 8. UX — the changes with the best ratio

Ordered by (pain removed ÷ work).

1. **Say what a step will do before it runs.** A dry-run that resolves every
   selector against the live page and reports "3 of 5 steps match" catches the
   commonest failure — a stale selector — before a 40-minute run produces
   nothing.
2. **Show match counts inline.** Every selector field should say `12 matches`
   as you type. Most of the confusion this project has produced —
   bulk-vs-specific, the wrong Next control, the loop that scraped page one 24
   times — would have been visible instantly with a number next to the box.
3. **A results preview in the panel.** There is still no way to see the rows a
   run collected without exporting them. J-30 was exactly this problem for the
   sniffer.
4. **Templates.** "Scrape a table", "Scrape product cards", "Follow every link
   and extract" as three starting pipelines. Detect Table already does the hard
   half.
5. **Name the run.** Runs are `run_1788524866671_8v95v2` in every message. A
   title from the page would make the storage list readable.

---

## 9. Suggested order

**First — correctness gaps that silently return nothing:**
shadow DOM; captcha detect-and-stop; per-step retry; ASSERT.

**Second — the features that look present and are not:**
proxy application during a run; MCP `run_pipeline`.

**Third — reach:**
`DOWNLOAD_FILE`; `COOKIES`; loop over a data source; API pagination.

**Fourth — load and polish:**
split `CONTENT_FILES`; conditional `allFrames`; match counts in the UI; dry run.
