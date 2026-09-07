# Capability review

A pass over every activity, the three subsystems (MCP, captcha, proxies), and
where the runtime spends its time. Written against the code, not the docs —
every claim below names the file that supports it.

Companion to `ISSUE_AUDIT.md`, which records defects. This records **gaps**:
things that are not broken, because they were never built.

---

## 1. The headline findings

Five things matter more than everything else in this document.

| #   | Finding                                                                        | Why it matters                                                                                                                                            |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~**No shadow-DOM support.**~~ **Closed by K-01**                              | `_queryScoped` now falls back to a shadow-walking resolver, and `>>>` pierces on demand. Kept here because it was the headline gap                        |
| 2   | ~~**Proxy rotation never runs during a scrape.**~~ **Closed by A-05**          | A run can take a proxy from the pool and rotate on a page-load cadence. The part that matters is the giving back: Chrome's proxy setting is browser-wide  |
| 3   | **MCP cannot scrape.** 18 tools, none of which run a pipeline or read a page   | An AI agent can author a pipeline and never execute one. There is no bridge from the MCP process to the browser                                           |
| 4   | ~~**Captcha detection is dead code.**~~ **Closed by K-02, then K-14 and K-15** | The dead detector is gone; `captcha-check.js` pauses the run and now tiers what it finds. Free solving is wired; the paid tier is still the A-06 decision |
| 5   | ~~**185 KB of JS into every frame, every injection**~~ **Closed by K-31**      | The four one-step specialists are injected when their step runs. 119 KB always, not 201 KB — and the saving multiplies by the frame count                 |

---

## 2. Every activity, against what the job actually needs

25 user-facing step types (`utils/step-types.js`), plus 6 internal. Grouped by
how much is missing.

`FILL` gained one thing since this was written that belongs in the "solid"
column rather than a table row: it will not fill a bot trap. A field that is
hidden, offscreen, zero-sized, `aria-hidden` or named as bait is skipped and
named in the log, with no toggle (K-14).

### Solid — no change needed

| Step       | Why it holds up                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FILL`     | Uses the native value setter (`_setNativeValue`), so React and Vue controlled inputs keep the typed value instead of reverting. Fires `input` and `change`. Multi-field mode, per-key delay, append, submit selector |
| `SELECT`   | Matches by value, then visible text, then either case-insensitively; refuses a disabled option; lists the real options in the error; fires both events                                                               |
| `WAIT`     | Fixed, element-appears, element-disappears, DOM-settle                                                                                                                                                               |
| `EXTRACT`  | Text, HTML, attribute, count; value transforms; honest row assembly (1 match broadcasts, n matches are positional, misses are `null` not padded)                                                                     |
| `PAGINATE` | Probes before clicking, so a navigation is expected rather than an error; detects a dead Next control four ways; optional fingerprint check for SPAs                                                                 |

### Gaps worth closing

| Step              | Missing                                      | Real case it fails on                                                                                                                                                                  |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLICK`           | Wait-for-navigation-or-XHR after click       | Click "Load more", next step runs before the rows exist. Today you add a WAIT and guess the number                                                                                     |
| `CLICK`           | Right-click / middle-click / modifier        | Opening results in a new tab; context menus                                                                                                                                            |
| ~~`SCROLL`~~      | ~~Scroll a specific container~~              | **Closed by K-26.** A `container` selector routes every mode — pixel, percent, infinite/bottom, and item counting — at that element's own `scrollHeight` instead of the document's     |
| ~~`EXTRACT`~~     | ~~Download a matched file/image~~            | **Closed by K-23.** `DOWNLOAD_FILE` is its own step: point it at the links or images and the files land on disk                                                                        |
| ~~`EXTRACT`~~     | ~~Regex capture group as a field~~           | **Closed by K-11.** The transform existed but reached only group 1; it now takes a group number and flags                                                                              |
| ~~`SCREENSHOT`~~  | ~~Per-element scroll-into-view first~~       | **Closed by K-27.** Scroll-into-view already ran; what was missing was clamping the crop and warning when the element is taller than the viewport can show in one shot                 |
| ~~`API`~~         | ~~Pagination (cursor / page / Link header)~~ | **Closed by K-25.** All three shapes; `maxPages` is a safety cap, never the exit condition, and the same `rowsPath` a single call now uses reaches the run's results across every page |
| ~~`API`~~         | ~~Retry on 429/5xx with `Retry-After`~~      | **Closed by K-24.** Honours `Retry-After` (seconds or HTTP-date), falls back to backoff when there is none, and both the attempt count and total wait are capped                       |
| `UPLOAD_ACTIVITY` | Drag-drop upload zones                       | Sites with no `<input type=file>` — increasingly common                                                                                                                                |
| `IF_ELSE`         | Comparing two extracted values               | "If price < last-seen price". Conditions test one selector against a literal                                                                                                           |
| `LOOP`            | Loop over a list (an API result, a CSV)      | Iterating 500 product URLs from a file needs a data-source loop. Numbered and URL-pattern paginators are covered now (K-20); a data source is not                                      |
| `EXPORT`          | Append to an existing file                   | A run per day into one dataset                                                                                                                                                         |
| `PDF_EXTRACTION`  | Tables                                       | PDF tables come out as a text blob                                                                                                                                                     |

### Missing entirely

| Proposed step                  | Why                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`DOWNLOAD_FILE`~~            | **Closed by K-23.** A selector, an optional attribute and a filename template; loop-scoped, paced by the rate limiter, and it says what it failed to save |
| `COOKIES` / `SESSION`          | Save the logged-in state after a manual login and reuse it. Today every run re-logs-in, which is slow and gets accounts flagged                           |
| `SET_HEADERS`                  | User-agent and `Accept-Language` per run. Fixed values are a fingerprint                                                                                  |
| ~~`SOLVE_CAPTCHA`~~            | **Closed by K-15,** for what can be answered without paying. See §4                                                                                       |
| ~~`RETRY` / step-level retry~~ | **Closed by K-12.** Any step takes `retries` and `retryDelayMs`; a retry queues behind the rate limiter like a first attempt                              |
| `DEDUPE`                       | "Scrape only what is new since last run". Needs a key column and a persisted seen-set                                                                     |
| ~~`ASSERT`~~                   | **Closed by K-13.** Exists, does not exist, a count comparison, or text equals/contains — and `optional` still lets a run past one                        |

---

## 3. Cross-cutting: shadow DOM — closed (K-01)

**This section described the gap. The gap is now closed; what follows is what
was built, so the recommendation is not read as outstanding work.**

`_queryScoped` — the resolver behind CLICK, FILL, EXTRACT, HOVER, SELECT,
IF_ELSE, PAGINATE, SCROLL and the picker — used to call `root.querySelectorAll`,
which does not cross a shadow root. On a site built from web components every
selector matched nothing and the tool said "not found" for elements plainly on
the screen: the same user experience as the iframe gap, and it needed the same
shape of answer.

It now resolves through `_resolveIn`, which runs the plain query first and only
walks open shadow roots (`_deepQueryAll`) when that finds nothing, so the cost
is paid on a miss rather than on every lookup. A selector can also pierce
explicitly with `>>>` (`_pierceQueryAll`), which is what the picker records and
what `relSelector` in `structure-detector.js` emits when a path crosses a shadow
boundary — CSS has no way to express one, so the notation is ours and our own
resolver reads it. The script emitters translate `>>>` to Playwright's `>>`.

Closed shadow roots stay unreachable. Nothing can reach into one from outside,
so the honest answer there is to say so rather than to appear to try.

---

## 4. Captcha — detection closed (K-02), free solving closed (K-14, K-15)

**State when this was written:** `content/captcha-detector.js` was 342 lines
that detected reCAPTCHA v2/v3, hCaptcha, Turnstile and image captchas, in no
`content_scripts` entry and imported by nothing (A-06).

**Now:** that file is deleted and `content/captcha-check.js` replaces it —
injected on demand by the worker and consulted when a captcha-suspect step
fails _or comes back empty_, because EXTRACT deliberately does not fail on a
miss (B-08), so a blocked page looks like empty rows rather than an error. It
asks whether a captcha is **in the way**, not whether one is present: reCAPTCHA
v3 runs invisibly on a large share of the web, so a rendered box of a usable
size or a full-page interstitial is the bar. When one is in the way the run
pauses and the panel says which kind and where, and the user resumes it.

That was step 1 of the recommendation below, and it is most of the value: a
scraper that stops and says why beats one that silently returns nothing.

**Now, part two (K-14, K-15):** everything that can be done for nothing is
done, and it is not much, which is the honest shape of the problem.

The checker reports a `tier` alongside the type — `solvable-locally`,
`needs-a-service`, `not-solvable` — so nobody has to guess what a challenge is
worth attempting. Cloudflare and Akamai interstitials are `not-solvable` and say
why: they are bot management, and a wall that lifts on a browser fingerprint has
no answer for any solver to sell.

`utils/captcha-solvers.js` answers the written challenges a small site writes
for itself — arithmetic, letter counts, "the third word of this sentence" — in
the worker, and refuses the moment it is not certain, because a guess is a
failed attempt the site records and a refusal is a pause the user was going to
see anyway. `SOLVE_CAPTCHA` is the step that uses it, and it will not act
without both the run's `captchaAuthorized` flag and a per-domain attestation
given once on the step's own card. Without either it refuses and says which is
missing; on a `not-solvable` type it refuses rather than trying; where no local
solver applies it pauses exactly as K-02 left it.

Past what is free, `SOLVE_CAPTCHA` will ask a model **you** configured
(K-22) — your key, or your own machine through a local OpenAI-compatible
endpoint, which costs nothing and sends nothing off it. Only image captchas,
only after the local solver has declined, and only with both gates given. The
image is drawn off the rendered `<img>` through a canvas rather than re-fetched,
because a captcha endpoint issues a new challenge per request and the fetched
one is not the picture the page is asking about. A widget captcha is refused
rather than photographed: its token comes from a solving service, so sending it
to a vision model spends money to be told nothing.

**Still open:** the paid tier. `solveCaptcha` still lives in
`background/api-key-manager.js` behind the `captcha:solve` message, which
nothing sends, and the panel still stores a 2Captcha key nothing spends. That is
deliberately untouched here — whether the tool should buy its way past a widget
captcha is the decision A-06 records, and it is a different decision from
answering arithmetic on a site you own.

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

| Cost                           | Measured / found                                                           | Fix                                                                                                                                                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **185 KB injected per frame**  | `CONTENT_FILES` = 189,462 bytes across 5 files, injected `allFrames: true` | Only `injector.js` (106 KB) is needed for most steps. Load `smart-extractor` (30 KB), `structure-detector` (28 KB), `page-data` (13 KB) and `page-json` (8 KB) on demand — they are already only used by one step each. Saves ~43% of the payload on every injection, more on iframe-heavy pages |
| **Injection into every frame** | `target: { tabId, allFrames: true }`                                       | Needed for the iframe fix (J-14), but only when a step asks for it. Steps carry `inFrame` already — inject `allFrames` only when it is set                                                                                                                                                       |
| **Keepalive during runs**      | `setInterval` + a 1-minute alarm while any run is live (`_startHeartbeat`) | Correct for MV3, no change                                                                                                                                                                                                                                                                       |
| **Rate limiting**              | `acquire(domain)` per step — works                                         | No change                                                                                                                                                                                                                                                                                        |
| **Capture buffers**            | Bounded by count and bytes, drops are reported                             | No change                                                                                                                                                                                                                                                                                        |
| **Dead import**                | `backoff` imported in `service-worker.js`, never called                    | Remove                                                                                                                                                                                                                                                                                           |

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
~~shadow DOM~~ (K-01); ~~captcha detect-and-stop~~ (K-02); ~~per-step retry~~
(K-12); ~~ASSERT~~ (K-13).

**Second — the features that look present and are not:**
proxy application during a run; MCP `run_pipeline`.

**Third — reach:**
~~`DOWNLOAD_FILE`~~ (K-23); `COOKIES`; loop over a data source; API pagination.

**Fourth — load and polish:**
split `CONTENT_FILES`; conditional `allFrames`; match counts in the UI; dry run.
