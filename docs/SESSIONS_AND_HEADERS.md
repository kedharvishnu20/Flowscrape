# Sessions and headers

Two things a scraper needs that a browser will not hand over for free: the
state that says _you are logged in_, and control over the headers a request
carries. Both are off by default here, both are switched on by you, and this
page says exactly what each one buys and what it costs.

---

## 1. Why sessions need a permission at all

A logged-in session is usually **one cookie marked `HttpOnly`**. That flag
exists to stop JavaScript on the page reading the cookie — which is exactly the
defence that stops a cross-site script from stealing your login, and exactly
what makes the cookie invisible to `document.cookie`.

So there are two ways for Verquill to read your session, and they are not
equally good:

|                                               | What it can see                                | What you get back                              |
| --------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| `document.cookie` — no permission             | Everything except `HttpOnly` cookies           | Usually a session **without** the login cookie |
| `chrome.cookies` — the **Cookies** permission | Every cookie for the site, `HttpOnly` included | The real session                               |

Without the permission the step still runs, still saves what it can, and
**tells you in the log that it saved the partial version**. It does not fail
silently, because the way this goes wrong is quiet: the run restores a session
that is missing the login cookie, the site serves a login page, and the scrape
collects a hundred rows of nothing.

### Turning it on

Side panel → **Settings → Permissions → Cookies → Grant**. Chrome shows its own
confirmation dialog; Verquill never sees your answer until you give it. Take
it back from the same place, or from `chrome://extensions`. Nothing else in the
extension needs it, and a run that never touches SESSION never asks.

---

## 2. Saving a session

1. Open the site and **log in by hand**, in the tab, like a person.
2. Add a **SESSION** step, set it to _Save this tab's session_, and give it a
   name (`shop`, `client-a`, whatever you will recognise later).
3. Press **Test** on that step. That is the whole flow — saving is a
   once-per-login act, not something a run should repeat.

What gets saved:

- **Cookies** for the site's origin — all of them with the permission, the
  visible ones without it.
- **localStorage** and **sessionStorage** for that origin. Many sites keep the
  real token here rather than in a cookie, so leaving both switches on is the
  safe default.

What does _not_ get saved: your password (it was never on the page after
submit), anything from another site, and anything larger than 100 KB in a
single storage entry — that is cached page content, not a session.

---

## 3. Restoring one

Add a **SESSION** step set to _Restore a saved session_, with the same name,
as the **first** step of the run, and put a **NAVIGATE** (or a reload) after
it. Restoring writes the session into the browser; the site only sees it on the
next request.

Two rules the step enforces rather than trusting you to remember:

- **A session only restores onto the origin it was saved from.** A session
  saved on `https://shop.test` will refuse to load while the tab is on
  `https://other.test`, and say so. Writing one site's cookies while another is
  open is how a login ends up somewhere it was never meant to go.
- **Without the Cookies permission, `HttpOnly` cookies are skipped, not
  faked.** The count in the log is what actually got written.

_Forget a saved session_ is the third mode, and it does what it says: the
stored copy is deleted. It does not log you out of the site — that is the
site's own session, and yours to end.

---

## 4. Where a saved session lives, honestly

In `chrome.storage.local`, inside the extension, **AES-GCM encrypted** with a
key kept beside it.

Read that last part again, because it decides what this is worth:

- **It protects against** a session sitting in plain text where anything that
  glances at extension storage would read it, and against a pipeline you export
  and share carrying your cookies out with it. A pipeline's JSON holds only the
  session's _name_. The values never leave this store.
- **It does not protect against** someone who can read your Chrome profile
  directory. They have the key and the ciphertext both. If that is your threat
  model, do not save sessions — log in during the run instead.

The store persists across browser restarts on purpose. The API-key store next
to it does not, because a key you re-paste occasionally is a fair price for a
secret that never survives a reboot; a session that forgot overnight would
defeat the entire point of saving one.

Fifty saved sessions is the cap. Delete one to add another.

---

## 5. Why a SESSION step cannot be exported

Export a pipeline to a Node or Python script and the SESSION step is refused,
by name, before anything is written.

That is deliberate twice over. A standalone script has no way to reach the
extension's encrypted store — and it should not: a script you commit or send to
a colleague would carry your login with it.

Playwright has the right tool on that side. Capture the state once:

```js
await context.storageState({ path: "session.json" });
```

and start the run with it:

```js
const context = await browser.newContext({ storageState: "session.json" });
```

Same idea, kept in a file you own and can see, rather than smuggled inside a
generated script.

---

# Headers

## 6. Why a header needs a permission too

A page cannot change its own request headers. `User-Agent`, `Host`,
`Referer`, `Cookie` and about a dozen others are on the _forbidden header_
list precisely so that a script on a page cannot lie about where a request came
from. That rule is doing its job, and it applies to an extension's content
script exactly as it applies to the site.

The only way around it is `declarativeNetRequest`, which is a rules engine the
browser itself applies — you describe the change, Chrome makes it, and no page
code ever touches the request. Verquill asks for the
**`declarativeNetRequestWithHostAccess`** variant on purpose: it can only act
on hosts you have already granted, where the plain version is a broader grant
than this needs.

Turn it on at **Settings → Permissions → Request headers**. Without it the
SET_HEADERS step refuses and says so; nothing else in the extension asks.

## 7. Using SET_HEADERS

Put it early in the pipeline — before the NAVIGATE whose request should carry
the headers — and type one header per line, the way a header actually looks:

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
Accept-Language: en-GB,en;q=0.9
```

- **Leave a value empty** to _remove_ that header instead of setting it. Some
  sites treat the mere presence of a header as a signal.
- **A second SET_HEADERS replaces the first**, rather than merging both. That
  is what reading the pipeline top to bottom leads you to expect.
- **Refusals are named.** `Host`, `Content-Length`, `Connection`, the `Sec-`
  family and the rest of the browser's own headers come back in the log by
  name. A header that was silently dropped would look exactly like a step that
  does not work.

## 8. Where the rules stop

Two boundaries, both deliberate:

- **This run's tab only.** The rule carries a `tabIds` condition, so the tabs
  you are browsing by hand are untouched. This is the lesson of the proxy bug
  (A-05), where a run set something browser-wide and never gave it back.
- **Until the run ends.** The rules are removed on every exit — finished,
  stopped, or crashed — and swept again when the extension next starts, for
  anything a crash left behind.

## 9. And the honest caveat

A convincing `User-Agent` is not a disguise. A site that fingerprints in
earnest also reads your header _order_, your TLS handshake, and what your
JavaScript environment looks like — none of which this changes, and the last of
which is real Chrome, because it is real Chrome. This step is for the very
common case of a site that rejects an obviously-automated UA string out of
hand. It is not a defeat for a serious bot-detection service, and treating it
as one will waste your afternoon.

A SET_HEADERS step is not exported into a generated script, for the same reason
SESSION is not: the run-scoped lifecycle has no equivalent there. A Playwright
script sets its headers when it creates the context, which is the right shape
on that side:

```js
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (…) Chrome/120.0.0.0 Safari/537.36",
  extraHTTPHeaders: { "Accept-Language": "en-GB,en;q=0.9" },
});
```
