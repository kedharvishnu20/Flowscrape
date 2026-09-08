# FlowScrape — Privacy

Last updated: 2026-09-08

This is the whole policy. It is short because there is not much to say.

## What is collected

**Nothing.** There is no analytics, no telemetry, no crash reporting, no
usage counter, and no account. The extension has no server of its own, so
there is nowhere for anything to be collected to.

That is a claim you can check rather than take on trust: the extension makes
network requests to exactly three kinds of place, and they are all listed
below.

## Where your data actually lives

| What                          | Where                                        | Survives                              |
| ----------------------------- | -------------------------------------------- | ------------------------------------- |
| Pipelines you build           | `chrome.storage.local`                       | Yes, until you delete them            |
| Rows a run extracts           | IndexedDB (`flowscrape_v3`), in your browser | Until you clear them                  |
| Datasets an EXPORT appends to | The same IndexedDB                           | Yes                                   |
| Cached AI answers             | The same IndexedDB, capped at 500 entries    | Until evicted                         |
| Schedules                     | `chrome.storage.local`                       | Yes                                   |
| **API keys**                  | `chrome.storage.session`, encrypted          | **No — gone when the browser closes** |

Keys are held in session storage, encrypted with a key that itself lives only
in memory for the browser session. Closing the browser loses them, on purpose:
a scraping tool holding a credential on disk forever is a worse trade than
retyping it.

Exported files go where you tell the browser to put them, through Chrome's own
download flow. The extension cannot read your Downloads folder — `chrome.downloads`
writes and never reads — which is also why "append to a file" is implemented as
"remember the rows and write the whole file again".

## What leaves your machine

Three things, and only these:

1. **The pages you told it to scrape.** Ordinary requests to the site you
   pointed a pipeline at, made by your browser as your browser. If you enable a
   proxy, they go through the proxy you configured instead.
2. **`robots.txt` from that same site**, so the ethics gates can check it.
3. **Page text to an AI provider — only if you configure one.** This is the one
   that matters, so it is stated plainly rather than buried:

   `AUTO_EXTRACT` has three layers. The first two run entirely in the page and
   send nothing anywhere. The third asks a model, and only when the first two
   are not confident enough.

   If you have configured a hosted provider (Anthropic, OpenAI, Google), that
   third layer sends the simplified text of the page you are scraping to that
   provider, under their privacy policy and not this one, along with your API
   key. The extension does not see, store or transmit their response anywhere
   else.

   **If you point it at a local model instead** — Ollama, LM Studio, or anything
   else speaking the OpenAI-compatible protocol on your own machine — nothing
   leaves the machine at all, and no key is sent, because a local server that
   asks for no authentication is not given one. This is the default posture the
   tool is built around: the AI layer is free and local unless you deliberately
   choose otherwise.

   You can also turn the AI layer off entirely, per step.

## Personal data in what you scrape

A scrape can come back carrying personal data — a directory of businesses is
full of email addresses. The extension checks the rows as they are collected
and says so once in the run log, naming the type of data and the column but
**never the value itself**: a warning about personal data that puts that data
into a log has made things worse rather than better.

It is a note, not a block. What you are allowed to collect and keep is your
decision and your jurisdiction's; the extension's job is to make sure you know
before you export and share the file, rather than afterwards from someone else.

## Permissions

Every permission the extension requests, and why, is in
[docs/STORE_LISTING.md](docs/STORE_LISTING.md). Two are optional and are only
requested when you use the feature that needs them.

## Contact

FlowScrape is open source. Issues, questions and corrections belong in the
repository's issue tracker, where the answers are visible to everyone.
