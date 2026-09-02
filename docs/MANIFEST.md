# manifest.json, annotated

JSON has no comments, and Chrome warns about any key it does not recognise:

```
Unrecognized manifest key '_comment_permissions'.
```

The notes that used to live in `_comment_*` keys are here instead. They explain
choices that look arbitrary in the file itself.

---

## `permissions`

```json
["scripting", "storage", "alarms", "sidePanel", "proxy", "tabs", "downloads"]
```

Every entry here must have a caller. Dropped in the C-08 trim: activeTab (redundant beside <all_urls> host access), declarativeNetRequest and webRequest (zero uses), notifications (zero uses; the notification providers the README advertises do not exist).

`tests/manifest.test.mjs` asserts every one of these has a call site, so an
unused permission fails the suite rather than shipping.

---

## `content_scripts`

There is no such key, deliberately.

There are none, deliberately. content/injector.js and content/smart-extractor.js used to be declared here for <all_urls>, so both ran in every page the user visited — for a tool that acts on one tab at a time (audit C-09). They are injected on demand by _ensureInjected in background/service-worker.js, into the tab a run or a picker is about to touch. page-sniffer.js has always been runtime-registered: it wraps fetch/XHR in the page's own world, so it is scoped to an active API_SNIFFER run's origin. <all_urls> host access is still needed for API steps and robots.txt fetches, which the worker makes, not the page.

---

## `web_accessible_resources`

Only modules a content script dynamically imports belong here; anything listed is readable by every page and can be probed to fingerprint the extension. This is the transitive closure of the two import(chrome.runtime.getURL(...)) calls in content/injector.js.

---

## `host_permissions`

`<all_urls>` stays. It is what lets the **worker** `fetch` — API steps and
robots.txt — and has nothing to do with running code in pages. Only the second
was the C-09 problem, and that is fixed by the absence of `content_scripts`
above.

---

## `description`

Shown on `chrome://extensions` and in the Web Store listing. It used to advertise
"proxy rotation, form filling", both of which are unreachable subsystems
(A-05, A-07) — a claim to the user's face that the product does not honour. It
now describes what the extension actually does.
