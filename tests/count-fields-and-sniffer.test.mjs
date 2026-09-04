// Regression tests for the two halves of J-25 and J-26.
//
// J-25 (second half): the detector can now find a rating rendered as four star
// icons, but a column EXTRACT cannot read back is no better than a missing one.
// "count" is the reader for it, and it has to exist in the injector, in the two
// script emitters, and in the panel's kind-to-type mapping — G-01's rule that a
// capability lives in one place and every consumer is checked against it.
//
// J-26: API_SNIFFER captured nothing on any run that navigated — which is
// nearly all of them. page-sniffer.js runs in the MAIN world, where there is no
// chrome.runtime, so it reports by posting a window message; injector.js is
// what forwards that to the worker, and injector.js is injected on demand. On a
// freshly loaded document it is simply not there, so the hook fired into a page
// with no listener and every capture was dropped.
//
// And on a URL that *is* an API — open https://fakestoreapi.com/products and
// the JSON is the document — there is no fetch or XHR to hook at all.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadInjector } from "./helpers/content-harness.mjs";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
const injector = await read("content/injector.js");
const worker = await read("background/service-worker.js");
const builder = await read("sidepanel/pipeline-builder.js");
const py = await read("script-gen/python-emitter.js");
const node = await read("script-gen/node-emitter.js");

const STARS = `
  <ul>
    <li class="row"><span class="t">Gut</span>
      <span class="stars"><i class="s f"></i><i class="s f"></i><i class="s f"></i><i class="s f"></i><i class="s"></i></span></li>
    <li class="row"><span class="t">Sapiens</span>
      <span class="stars"><i class="s f"></i><i class="s f"></i><i class="s f"></i><i class="s f"></i><i class="s f"></i></span></li>
    <li class="row"><span class="t">Grit</span>
      <span class="stars"><i class="s f"></i><i class="s f"></i><i class="s"></i><i class="s"></i><i class="s"></i></span></li>
  </ul>`;

// ── The count reader ─────────────────────────────────────────────────────────

test("a count field returns how many children match", async () => {
  const h = await loadInjector(STARS);
  const rows = await h.api._stepExtract({
    fields: [
      { name: "title", selector: ".t", type: "text" },
      {
        name: "rating",
        selector: ".stars",
        type: "count",
        countSelector: "i.f",
      },
    ],
  });
  // JSON round-trip: the rows come from jsdom's realm, so deepEqual on the
  // arrays themselves compares across realms and never matches.
  assert.deepEqual(
    JSON.parse(JSON.stringify(rows.map((r) => [r.title, r.rating]))),
    [
      ["Gut", "4"],
      ["Sapiens", "5"],
      ["Grit", "2"],
    ],
  );
});

test("counting nothing is zero, not a missing value", async () => {
  const h = await loadInjector(`<div class="stars"></div>`);
  const rows = await h.api._stepExtract({
    fields: [
      { name: "n", selector: ".stars", type: "count", countSelector: "i.f" },
    ],
  });
  assert.equal(rows[0].n, "0");
});

test("a count field with no selector refuses instead of returning 0", async () => {
  // Same contract as "attribute": a plausible wrong answer is worse than an
  // error, because nothing downstream can tell 0 from "never configured".
  const h = await loadInjector(STARS);
  await assert.rejects(
    () =>
      h.api._stepExtract({
        fields: [{ name: "rating", selector: ".stars", type: "count" }],
      }),
    /Count but has no selector/,
  );
});

test("a count field with a broken selector says so", async () => {
  const h = await loadInjector(STARS);
  await assert.rejects(
    () =>
      h.api._stepExtract({
        fields: [
          {
            name: "rating",
            selector: ".stars",
            type: "count",
            countSelector: "i[",
          },
        ],
      }),
    /not a valid selector/,
  );
});

// ── Every consumer knows the kind (G-01) ─────────────────────────────────────

test("the panel maps every detector kind to a reader", () => {
  const map = builder.slice(
    builder.indexOf("async function _insertDetectedTable"),
    builder.indexOf("const loop = {", builder.indexOf("_insertDetectedTable")),
  );
  for (const kind of ["count", "attr", "href", "src"]) {
    assert.ok(
      map.includes(`"${kind}"`),
      `_insertDetectedTable never mentions the "${kind}" kind`,
    );
  }
  assert.match(map, /countSelector: f\.countSelector/);
  assert.match(map, /attribute: f\.attribute/);
});

test("the detector carries what makes its columns readable", () => {
  // The columns were shaped for output with only name/selector/kind, so an
  // attr column arrived without its attribute name and failed at run time.
  return read("content/structure-detector.js").then((src) => {
    const shaped = src.slice(src.indexOf("const named = columns"));
    assert.match(shaped, /attribute: c\.attribute/);
    assert.match(shaped, /countSelector: c\.countSelector/);
  });
});

test("both emitters can carry a count field", () => {
  for (const [name, src] of [
    ["python", py],
    ["node", node],
  ]) {
    assert.ok(
      src.includes('field.type === "count"'),
      `the ${name} emitter drops count fields silently`,
    );
    assert.ok(
      src.includes("countSelector"),
      `the ${name} emitter never reads countSelector`,
    );
    assert.match(
      src,
      /\.count\(\)/,
      `the ${name} emitter does not actually count anything`,
    );
  }
});

// ── The sniffer relay ────────────────────────────────────────────────────────

test("the relay is registered with the same reach as the hook", () => {
  assert.match(worker, /SNIFFER_RELAY_ID/, "no relay registration at all");
  const enable = worker.slice(
    worker.indexOf("async function _enableSniffer"),
    worker.indexOf("async function _disableSniffer"),
  );
  assert.match(enable, /id: SNIFFER_RELAY_ID/);
  assert.match(enable, /js: \[INJECTOR_FILE\]/);
  assert.match(enable, /world: "ISOLATED"/);
  // Same matches as the MAIN-world hook: a relay with narrower reach drops
  // captures just as silently as no relay at all.
  const matches = [
    ...enable.matchAll(/matches: _snifferMatches\(targetOrigin\)/g),
  ];
  assert.equal(matches.length, 2, "the two scripts do not share their matches");
});

test("the relay is unregistered when the sniffer is", () => {
  const disable = worker.slice(
    worker.indexOf("async function _disableSniffer"),
  );
  assert.match(
    disable.slice(0, 800),
    /SNIFFER_SCRIPT_ID, SNIFFER_RELAY_ID/,
    "the relay would outlive the run that asked for it",
  );
});

test("a document that is itself an API response is reported", () => {
  assert.match(injector, /_reportDataDocument/);
  const fn = injector.slice(
    injector.indexOf("function _reportDataDocument"),
    injector.indexOf('if (document.readyState === "loading")'),
  );
  assert.match(fn, /document\.contentType/);
  assert.match(fn, /type: "network:sniff"/);
  assert.match(fn, /__fsDataDocReported/, "it would report on every call");
  assert.match(
    fn,
    /querySelector\("pre"\)/,
    "the JSON viewer keeps the raw bytes in a <pre>",
  );
});

test("the data-document type test accepts what APIs actually send", () => {
  const m = injector.match(/const _DATA_DOC_TYPE =\s*(\/.*\/i);/);
  assert.ok(m, "no content-type test found");
  const re = new RegExp(m[1].slice(1, -2), "i");
  for (const t of [
    "application/json",
    "application/vnd.api+json",
    "application/ld+json",
    "text/json",
    "application/xml",
    "text/csv",
    "application/x-ndjson",
  ]) {
    assert.ok(re.test(t), `${t} is not recognised as data`);
  }
  for (const t of ["text/html", "image/png", "application/pdf"]) {
    assert.ok(!re.test(t), `${t} should not be captured as an API response`);
  }
});
