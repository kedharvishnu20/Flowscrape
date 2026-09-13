# What is left, and why it is yours

Everything in this repository that could be finished from a terminal has been.
This is the remainder: work that needs an account you own, a judgement that is
yours to make, a machine this environment does not have, or a pair of eyes.

Each item says **why it could not be done here** — not as an excuse, but so you
can tell the ones that are genuinely blocked from the ones that are just next.

Nothing here is a known defect. The audit's 192 findings are all fixed; the
tree is green on 1427 unit tests, 85 browser checks and 8 real-page checks.

---

## 1. Repository settings — 15 minutes, do these first

All four are GitHub settings pages. None of them can be set from a commit,
which is the only reason they are here rather than done.

### 1.1 Turn on private vulnerability reporting

**Settings → Security → Private vulnerability reporting → Enable.**

`SECURITY.md` tells people to use it. Until it is enabled, that instruction
points at a button they cannot see, and the next person with a real finding
opens a public issue instead.

### 1.2 Require the CI checks before merge

**Settings → Branches → Add rule** on `master`: require a pull request, and
require the `ubuntu-latest` and `windows-latest` status checks to pass.

The gates exist and run. Nothing currently stops a red branch being merged
anyway — which is precisely how a rewrite landed on `dev` with eight tests
failing and nobody noticed. The workflow closes half that gap; this closes the
other half.

### 1.3 Let Dependabot open pull requests

**Settings → Code security → Dependabot alerts and security updates → Enable.**

`.github/dependabot.yml` is committed and configured (monthly, grouped, three
ecosystems). It does nothing until the repository-level toggle is on.

### 1.4 Decide whether `dev` still exists

Work has been landing on `master`. If `dev` is still the integration branch,
say so in `CONTRIBUTING.md`; if it is not, delete it. A stale branch that
people half-believe in is where the eight silent failures lived.

---

## 2. Chrome Web Store — the real remaining work

`npm run build` produces a verified `verquill-3.0.0.zip`: built from an
allowlist, with every manifest file proven present and every import inside the
package proven to resolve. `docs/STORE_LISTING.md` has the copy and a
justification for every permission, which is what reviewers reject `<all_urls>`
extensions for lacking.

What is left needs you:

| Item                        | Why it is yours                                                         |
| --------------------------- | ----------------------------------------------------------------------- |
| Developer account, $5 fee   | An identity and a payment                                               |
| Screenshots (1–5, 1280×800) | Requires running the extension and deciding what represents it          |
| 440×280 promo tile          | A design decision                                                       |
| A public URL for PRIVACY.md | The store wants a link, not a file. GitHub Pages on this repo is enough |
| The submission itself       | See below                                                               |

**On automating the upload.** `.github/workflows/release.yml` deliberately
stops at a draft release with a verified zip attached. Publishing from CI needs
an OAuth refresh token held as a repository secret — a secret that can push an
update to every installed copy of the extension. That is a larger thing to hold
than a manual upload is a burden, and it is your call rather than a default.
If you decide the trade is worth it, the step to add is one `curl` to the
Chrome Web Store API; the credentials are the hard part, not the YAML.

**The screenshots worth taking**, since deciding is most of the work: the panel
mid-run with the log visible; an AUTO_EXTRACT result with per-field provenance
showing which layer answered; and a learned selector saved as an EXTRACT step
next to the Playwright script it exports to. That last one is the story no
competitor can tell.

---

## 3. The registry website

`site/` builds and lints, shares `utils/pipeline-capabilities.js` with the
extension so the publish gate cannot drift from the import gate, and CI proves
that import still resolves on every push.

It has never been deployed. That needs:

- **A host.** It is a static Vite build; Pages, Netlify and Vercel all work.
- **The repository the registry writes to.** `publishToGlobal` commits into
  `global/` of whatever repository the user configures. You have not decided
  whether that is this repository, a separate one, or one per user.
- **Guidance on the token.** The site asks for a GitHub PAT with
  Contents: Read & Write. It is held in `chrome.storage.session`, encrypted,
  and swept out of `local` if an older version left one there — but a user
  handing a write-scoped token to a website deserves a sentence telling them to
  scope it to one repository. Write that sentence where they will see it.

**An open question I could not answer.** `scripts/build-dist.mjs` excludes
`site/dist` from the extension package, with a comment saying the registry is a
separate deployment. If you ever intended the registry to be browsable _inside_
the extension, that exclusion is wrong and the fix is not just re-including it:
it needs a manifest surface and a build ordering that puts the site build before
the package. I left it excluded because that is what the current wiring implies,
not because I know your intent.

---

## 4. Two verifications I could not run

Stated plainly rather than quietly skipped.

### 4.1 A real local model

The plan's verification list included running AUTO_EXTRACT against a live
Ollama endpoint on a real product page. **This environment has no Ollama and no
local model**, so it was not run.

What _was_ proven: the e2e suite stands up a fake OpenAI-compatible server and
drives the entire AI path through it — provider config, key handling, JSON
mode, grounding, selector verification — with no key and no cost. That proves
the plumbing. It does not prove a 7B model returns usable JSON for a real
page, which is the thing a user will judge the feature on.

**Fifteen minutes on your machine settles it:** `ollama serve`, point the
gateway at `http://localhost:11434/v1` as `openai-compatible`, run AUTO_EXTRACT
on a product page, and see what comes back. If grounding drops most fields,
that is a finding worth having before the store listing claims local models
work.

### 4.2 The panel, looked at by a person

The e2e suite proves the panel boots without an uncaught error, that steps run,
and that scrolling reaches the AI gateway's save button. It cannot tell you
whether the board reads as clumsy, whether an ethics warning reads as a
warning, or whether the import-review sheet is understood by someone who did
not write it.

`docs/TEST_CHECKLIST.md` keeps a manual checklist for exactly this, and it is
now honest about being the part automation cannot reach.

---

## 5. Judgement calls I deliberately left open

Not work items. Decisions where I had a view but no standing.

**Vision fallback for AUTO_EXTRACT.** `askVision()` exists and SOLVE_CAPTCHA
uses it, so it is cheap to add. It was deferred because a vision answer cannot
be grounded — there is no page text to check it against, so it is the one path
where the tool has to say "trust me." Adding it alongside grounding would
undercut the property grounding introduces. If you add it, label it in the
interface as the unverifiable path; that is the whole cost of having it.

**First-run auto-detect.** Running structure detection the moment the panel
opens means reading the page before the user asked for anything. For a tool
that leads on ethics gates, that is a design decision rather than a
convenience, and its value cannot be judged without a person using it.

**The master manual's future.** `docs/verquill-master-manual.md` is 1490 lines
of hand-maintained API reference. Its links and export lists are now checked by
`tests/doc-drift.test.mjs`, so it can no longer rot silently — but it still
duplicates JSDoc that already exists in the source. My honest recommendation is
to generate the reference half from the source and hand-write only the prose
chapters. I did not do it because it changes a document you may value in its
current form, and it is a structural decision, not a fix.

---

## 6. Legal and positioning

The only items here with no technical component.

- **A hosted privacy policy.** Required by the store as a URL.
- **Terms, if you distribute.** `PRIVACY.md` covers data; it is not terms of
  use. A tool that scrapes is one where the boundary between your
  responsibility and the user's is worth stating once, in writing.
- **The ethics stance as a position, not just as code.** The gates are real:
  robots.txt is read, overrides are recorded, PII in extracted rows is flagged
  by type and count without the value ever reaching a log, and a pipeline
  carrying credentials to an undeclared destination is refused at three
  separate points. That is a genuine differentiator against tools that charge
  for extraction you cannot audit. Nobody outside this repository knows it yet.

---

## 7. Ordered, if you want one list

1. The four repository settings (§1) — 15 minutes, and 1.1 closes a real gap
2. Ollama against a real page (§4.1) — cheap, and it either confirms or
   contradicts a claim the store listing is about to make
3. Screenshots and the promo tile (§2) — the longest pole for the store
4. Host `PRIVACY.md`, then submit
5. Decide the registry's repository and deploy the site (§3)
6. The judgement calls (§5), in your own time

---

_Last reviewed against the tree at the industrial-readiness pass. Every claim
about what passes was run, not assumed; the two things that were not run are
§4, and they say so._
