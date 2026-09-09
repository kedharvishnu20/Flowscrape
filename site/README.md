# The registry site

A community catalogue and forum for Verquill pipelines. One static file,
`index.html`, with no build step and no dependencies — open it, or serve the
directory with anything.

```
npx serve site        # or: python3 -m http.server -d site
```

## Why it is not part of the extension

`scripts/build-dist.mjs` packages from an allowlist, and `site/` is not on it.
A test in `tests/build-dist.test.mjs` asserts that nothing under `site/` ever
reaches the extension package, for the same reason `tests/` and `e2e/` are
checked: an allowlist that quietly grows is a blocklist with extra steps.

This separation is also what keeps `PRIVACY.md` true. The extension does not
fetch the registry, does not know it exists, and gains no new network
destination from it. Installing a pipeline is still what it always was —
**Save JSON** on one side, **Load** on the other. That is deliberate: an
extension that phoned a catalogue home on every panel open would have to
rewrite the sentence about contacting exactly three kinds of place, and the
sentence is worth more than the convenience.

## The capability check appears twice, on purpose

`utils/pipeline-capabilities.js` is the real gate — it runs in the side panel
on every import, refuses what has to be refused, and is what actually protects
anyone.

The copy inside `index.html` is a **filter on the catalogue**, so a refused
pipeline can be caught before it is ever listed and so a visitor can paste
something a stranger sent them and see the verdict without installing
anything. It is not a substitute for the gate on the door: the extension
re-runs its own check regardless of where a pipeline came from.

The two must agree. If you change the rules in `utils/pipeline-capabilities.js`,
change them here too — `tests/pipeline-capabilities.test.mjs` covers the
module, and the page is checked by eye.

## The one rule

A pipeline that **reads credentials** and **also sends requests to a site it
never declared it scrapes** is refused. Not warned about — refused, with no
button to proceed.

Everything else is disclosed and left to the reader: cookies alone, a
third-party API alone, AI extraction, uploads, captcha answering. A gate that
fires on everything is one people learn to click through, and then it protects
nobody. That reasoning is the same one `ethics/pii-detector.js` is built on.

## What is real and what is illustrative

The pipelines and forum threads in `index.html` are seed content, written to
show the shape of the thing. The **capability analysis on every one of them is
computed, not typed** — including `FS-0666`, which is listed as refused because
the analyser refuses it when the page loads. Left visible on purpose: a
registry that hides what it caught is asking to be trusted rather than read.

Serving a real registry means replacing the `REGISTRY` and `THREADS` arrays
with data fetched from wherever the listings actually live.
