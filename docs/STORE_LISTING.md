# Chrome Web Store listing

Everything the store form asks for, written out so submitting is filling in
fields rather than composing under pressure.

Publishing itself needs a developer account, a one-off fee and a person to
click through the review — none of which can be done from here. What follows
is the part that can be.

---

## Store fields

**Name:** FlowScrape

**Short description** (132 characters max):

> Build a scraping pipeline visually, run it on any page, export the rows. Free
> AI extraction with a local model. No account.

**Category:** Developer Tools

**Language:** English

---

## Detailed description

> FlowScrape turns a page into a pipeline you can see: click steps together,
> run them against the tab in front of you, watch each one succeed or fail, and
> export the rows as CSV, JSON, XML or Markdown.
>
> **It runs on your machine.** There is no account, no server and no
> subscription. Nothing is uploaded, because there is nowhere to upload it to.
>
> **The AI layer is free.** AUTO_EXTRACT reads a page in three passes: the
> site's own structured data, then a set of DOM heuristics, and only then a
> model — and the model can be a local Ollama or LM Studio server, in which case
> nothing leaves your machine and no key is needed. Point it at Anthropic,
> OpenAI or Google instead if you would rather.
>
> **The AI's answers are checked.** Every value a model returns is looked for in
> the page text it was shown; anything that is not there is dropped and named in
> the log. Each field records which layer answered it and how confident it was.
> And the model is asked for CSS selectors as well as values — the ones that
> actually produce the reported value are offered as a plain EXTRACT step, after
> which the site is scraped with no model at all.
>
> **It exports to code.** Any pipeline can be emitted as a runnable Playwright
> (Node) or Python script, so a visual prototype becomes something you can put
> in CI.
>
> **It tells you what it is doing.** robots.txt is checked before a run.
> Requests are paced. A scrape that comes back carrying personal data says so.
> A schedule that missed a window because the browser was shut reports the gap
> rather than hiding it.
>
> 29 step types, including loops, conditionals, pagination, infinite scroll,
> session save/restore, custom headers, PDF table extraction, file uploads and
> deduplication.

---

## Permission justifications

Reviewers reject broad permissions without a stated reason, and `<all_urls>` in
particular. Each of these is what the store form calls for.

### Required

**`scripting`** — The extension's steps run inside the page: clicking, filling,
reading text. Content scripts are injected on demand into the tab the user is
running a pipeline against, rather than declared for every page they visit.

**`storage`** — Pipelines, settings and schedules are kept in
`chrome.storage.local`; API keys in `chrome.storage.session`, encrypted, so they
are gone when the browser closes. Nothing is sent anywhere.

**`alarms`** — Schedules. A pipeline can be set to run every N minutes; each
schedule holds one alarm. Also used for a service-worker keep-alive during a
run.

**`sidePanel`** — The entire interface is the side panel. The extension has no
other UI surface.

**`tabs`** — A run needs to know which tab it is driving, wait for it to finish
loading, and follow it if the page opens a new tab (a paginator with
`target="_blank"`). A schedule opens the page it was given in a background tab.

**`downloads`** — The EXPORT step writes the collected rows to a file through
Chrome's own download flow. The extension only writes; it never reads the
Downloads folder.

**`proxy`** — Optional, off by default, and only while a run has asked for it: a
user supplying their own proxy list can route a scrape through it. Chrome has
one browser-wide proxy setting, so the extension sets it for the run and clears
it afterwards — including on the next worker start, if a crash left it set.

**`host_permissions: <all_urls>`** — The user chooses which site to scrape. The
extension has no list of supported sites and cannot have one: it is a general
tool, pointed at whatever page the person is looking at. Nothing runs on a page
until the user starts a pipeline against that tab, and content scripts are
injected on demand rather than declared for every page.

### Optional — requested only when the feature is used

**`cookies`** — The SESSION step saves and restores a logged-in session, so a
pipeline that needs authentication does not have to log in on every run. Never
requested unless a pipeline contains that step.

**`declarativeNetRequestWithHostAccess`** — The SET_HEADERS step sends headers
the user specified with the run's requests. The rules are session-scoped and
swept on the next worker start, so a crashed run cannot leave headers applying
to ordinary browsing.

---

## Data-use disclosures

The store asks a series of yes/no questions. The answers:

| Question                                                      | Answer                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Collects personally identifiable information                  | No                                                                             |
| Collects health information                                   | No                                                                             |
| Collects financial and payment information                    | No                                                                             |
| Collects authentication information                           | No — API keys stay in encrypted session storage on the user's machine          |
| Collects personal communications                              | No                                                                             |
| Collects location                                             | No                                                                             |
| Collects web history                                          | No                                                                             |
| Collects user activity                                        | No                                                                             |
| Collects website content                                      | No — extracted rows are stored in the user's own browser and never transmitted |
| Sells or transfers data to third parties                      | No                                                                             |
| Uses data for purposes unrelated to the item's single purpose | No                                                                             |
| Uses data to determine creditworthiness or for lending        | No                                                                             |

**One thing worth stating beyond the form**, because a reviewer will ask and
because it is true: if the user configures a _hosted_ AI provider, the
AUTO_EXTRACT step sends the simplified text of the page being scraped to that
provider, with the user's own key. That is the user's arrangement with that
provider, disclosed in [PRIVACY.md](../PRIVACY.md). The default configuration
has no provider at all, and a local model sends nothing off the machine.

**Single purpose:** extracting structured data from web pages the user chooses,
under the user's direct control.

---

## Before submitting

- [ ] `npm test`, `npm run e2e` and `npm run challenges` all pass
- [ ] `node scripts/build-dist.mjs` reports no problems
- [ ] `manifest.json` and `package.json` versions match, and are higher than the
      last uploaded build
- [ ] Screenshots: 1280×800 or 640×400, at least one, no more than five
- [ ] The privacy policy is reachable at a public URL (the store requires a
      link, not a file)

## Assets still needed

These need a person, not a build script:

- Screenshots of the panel mid-run, an AUTO_EXTRACT result with provenance
  showing, and the exported Playwright script side by side with the pipeline
- A 440×280 small promo tile
- A hosted copy of `PRIVACY.md` at a stable URL
