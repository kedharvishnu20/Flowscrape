# How this project documents itself

The format every document and every module header in this repository follows,
and — more usefully — the reasoning behind each rule, so you can tell when a new
case is covered and when it is genuinely new.

This is descriptive, not aspirational. Everything below is already the
convention in the tree. If a rule here and the code disagree, the code is the
one that has been reviewed 192 times.

---

## 1. The one rule the rest follows from

**Write down what is not visible from reading the code.**

The code says what happens. A comment that also says what happens is a second
copy that will disagree with the first one eventually, and the copy that drifts
is the one people trust and should not. So documentation here carries the things
the code cannot:

- the constraint that made an obvious approach impossible
- the failure that caused this shape
- what was considered and rejected, and why
- where the limits are, stated plainly rather than discovered

`utils/row-dedupe.js` does not explain that it hashes a key. It explains why the
key is the user's choice rather than the whole row, and that the seen-set is
bounded so an old duplicate can slip through — "said out loud rather than
presented as exact."

A practical test: if deleting a sentence loses nothing a careful reader could
not reconstruct from the code in a minute, delete it.

---

## 2. Source files

### 2.1 The sentinel and the module block

Every source file opens and closes with a sentinel, and opens with a JSDoc
module block. All 59 source files do; the format is not optional.

```js
// === row-dedupe.js ===
/**
 * @module row-dedupe
 * @description Deciding whether a row has been seen before.
 *
 *   Prose. Indented three spaces from the asterisk so it reads as a block
 *   rather than a list of tags. This is where the reasoning goes.
 *
 *   Two decisions worth stating:
 *
 *   - **The key is the user's, not ours.** Bold lead, then the reason.
 *   - **The seen-set is bounded.** Same.
 *
 * @dependencies none
 */

// … the module …

// === END row-dedupe.js ===
```

| Element                  | Rule                                                                           |
| ------------------------ | ------------------------------------------------------------------------------ |
| `// === name.js ===`     | First line. Bare filename, no path                                             |
| `@module`                | Filename without the extension                                                 |
| `@description`           | One sentence naming the job, in the gerund — "Deciding whether…", "Turning a…" |
| Prose block              | Indented three spaces under the description. As long as the reasoning needs    |
| `@dependencies`          | Sibling modules by bare name, or the literal `none`                            |
| `// === END name.js ===` | Last line                                                                      |

The sentinels exist because this project is read by agents as well as people,
and a file boundary that survives being pasted into a chat window is worth two
lines.

### 2.2 Section rules inside long files

Files past a few hundred lines divide with a box-drawing rule. `service-worker.js`
has 25 of them; `pipeline-builder.js` has 27.

```js
// ── SOLVE_CAPTCHA ───────────────────────────────────────────────────────────
```

Em-dash box characters (`──`), padded to column 79. A section name, not a verb
phrase.

### 2.3 Function docblocks

JSDoc types on anything exported or crossing a module boundary. Prose above the
tags when there is something to say, not below them.

```js
/**
 * Skip the current test when there is no interpreter.
 *
 * The explicit `return` is the caller's, deliberately: `t.skip()` marks the
 * test skipped but does not stop the function body, and a helper that looked
 * like it did would leave the spawn running underneath a green "skipped".
 *
 * @param {import("node:test").TestContext} t
 * @returns {string|null}
 */
```

That second paragraph is the whole point of the docblock. The signature was
already visible.

### 2.4 Inline comments

Reserved for a line whose reason is not local. A comment explaining the line
above it is usually a sign the line should be clearer.

```js
// "Python 3.12.1". Python 2 is not what these emitters target, and the
// Store stub prints nothing at all.
if (/^Python 3\./.test(out.trim())) {
```

---

## 3. Markdown documents

### 3.1 Shape

```markdown
# Title in sentence case

One or two paragraphs saying what this document is and, where it is not
obvious, what it is not. Name the companion document if there is one.

---

## 1. First section
```

| Element    | Rule                                                                                 |
| ---------- | ------------------------------------------------------------------------------------ |
| Title      | `#`, sentence case, no project name unless the file stands alone (`PRIVACY.md` does) |
| Standfirst | Immediately after the title. Never a table of contents — the headings are one        |
| `---`      | Between major sections. Not between subsections                                      |
| Headings   | Sentence case throughout. `## 1.` numbering only in long reference documents         |
| Line width | Wrapped near 80. Prettier enforces the rest                                          |
| Emphasis   | `**bold**` to open a point; `_italic_` for a term being introduced                   |

### 3.2 Tables

For enumerable facts — a file and its job, a limitation and its cause, a step
and why it cannot be exported. Never for reasoning: a table forces prose into
cells too small to hold a because.

The left column is the thing; the right column is the part a reader came for.

### 3.3 Sentence case and the em dash

Sentence case for every heading. Em dashes for the aside that carries the
reason — this repository uses a lot of them, and that is a deliberate register
rather than an accident.

---

## 4. Which document a thing belongs in

The most common mistake is putting a true sentence in the wrong file, where it
duplicates and then drifts.

| Document                         | Holds                                                          | Does not hold                                |
| -------------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| `README.md`                      | What it is, how to install, the file tree, the step vocabulary | Reasoning — that is ARCHITECTURE             |
| `docs/ARCHITECTURE.md`           | Why the parts are shaped this way. Constraint first            | How to use anything                          |
| `CHANGELOG.md`                   | What changed and why, per finding, newest first                | Current state — it is a record, not a mirror |
| `docs/ISSUE_AUDIT.md`            | The 192 findings, each with evidence and resolution            | Anything not found by the audit              |
| `docs/KNOWN_LIMITATIONS.md`      | What the tool does not do, and why not                         | Bugs — those are findings                    |
| `docs/CAPABILITY_REVIEW.md`      | Gaps: things not broken because never built                    | Defects — that is ISSUE_AUDIT                |
| `docs/verquill-master-manual.md` | The full per-module reference, for agents and for depth        | Judgement calls — those live in the source   |
| `SECURITY.md`                    | What counts as a vulnerability, where the boundaries are       | A list of fixed bugs                         |
| `PRIVACY.md`                     | Where data lives and what leaves the machine                   | Security posture                             |
| `CONTRIBUTING.md`                | How to run the gates, the conventions, what review looks for   | Architecture                                 |

**The one-definition rule applies to prose.** If a fact belongs in two
documents, one of them links to the other. Three copies of the capability rules
existed in code once and had begun to drift; the same happens to sentences.

---

## 5. What must be checked rather than asserted

This is the section that exists because of a specific failure. The README
claimed 660 tests when there were 1422, the CHANGELOG claimed 818, and the
master manual linked to six deleted files while documenting sixteen removed
functions. Each was true when written.

**A number or a path in prose that is derived from the code must be checked by
a test.** `tests/doc-drift.test.mjs` and `tests/dead-code-and-defects.test.mjs`
hold those checks today:

- every `Source:` link in the master manual resolves
- every export it documents appears in the file it cites
- no section promises exports and lists none
- no current-state document describes a deleted file
- the README's step-type counts match the registry
- the README's test count is not far below reality

When you add a derived claim, add its check in the same commit. When you cannot
check one — a claim about behaviour, a design rationale — that is fine and is
most of this repository; just do not put a number in it.

Two exclusions, both deliberate:

- **`CHANGELOG.md` and `docs/ISSUE_AUDIT.md` are historical.** "It passed 442
  unit tests" is a fact about the moment a bug was found. Rewriting it to
  today's number destroys the only thing it was there to say. They are excluded
  from the deleted-file check for the same reason — naming a file in order to
  record its removal is their job.
- **Prose is not linted.** A check that cannot tell a command from a sentence
  about that command would forbid a file from documenting its own reasoning.
  Two tests here were written badly enough to do exactly that, matching their
  own explanatory comments, and were fixed to read assignments and `run:` steps
  instead.

---

## 6. Voice

Not a style preference. Each of these exists because its opposite caused a
problem in this repository.

**Say what is true, including when it is unflattering.** "A large rewrite landed
on `dev` with eight tests failing and nobody noticed" is in a workflow header
because it is the reason the workflow exists.

**Never claim enforcement that does not exist.** README and CONTRIBUTING both
described checks running "in CI" while no CI existed. A claim about enforcement
is worth nothing unless something enforces it.

**State a limit rather than let it be discovered.** The scheduler's header says
Chrome must be running and that MV3 clamps alarms to a minute. A schedule that
fired while the browser was shut is reported as missed, not silently skipped —
and the document says that too.

**Name the decision you did not take.** "Deferred, and here is why" is an
answer. Silence looks like an oversight and gets re-litigated.

**No marketing.** No "powerful", "seamless", "robust", "blazing". If a thing is
fast, give the number.

**Prefer the concrete failure to the abstract risk.** Not "this could cause
issues" but "headers came from `Object.keys(rows[0])`, so a column missing from
the first row was dropped."

---

## 7. Commit messages

The same rules, in the same voice. A subject line under about 72 characters
saying what changed, then prose explaining why — the problem first, the fix
second.

Numbers in a commit message are a claim about a run that happened. State what
was verified, in the form it came back:

```
Verified: 1427 unit tests, 85 e2e in a real browser, check, lint, format
and build all clean.
```

If something could not be verified, say which and why. That is always an
acceptable answer here.

---

## 8. A checklist, for when you are adding rather than reading

- [ ] Sentinel, `@module`, `@description`, `@dependencies`, END sentinel
- [ ] The docblock says why, not what
- [ ] Any derived number has a test in the same commit
- [ ] The fact lives in exactly one document; the others link
- [ ] Limits are stated, not left to be found
- [ ] No claim of enforcement without something enforcing it
- [ ] `npm run format:check` and `npm test` pass
