// AUTO_EXTRACT for a schema the user names, not only for products.
//
// The step had seven field names hardcoded across two hundred lines of scoring
// rules and spelled out again in a prompt. A page of court listings, job
// adverts or conference talks got a step whose only question was "what is the
// price".
//
// Three things decide whether generalising it is honest rather than merely
// wider:
//
//   - **A page's own structured data answers for free.** A site publishing
//     `datePublished` should answer a request for "published date" with no
//     model and no cost. That means matching the user's names against the
//     site's keys, which is what `fieldMatchScore()` in utils/levenshtein.js
//     has always been for — and what nothing has ever called (audit A-07).
//   - **A heuristic must not answer for a field it was never taught.** Layer 2
//     knows products. Asked for "defendant" it has to say nothing, because a
//     guess there is indistinguishable from an answer in the export.
//   - **An empty schema must change nothing.** Every pipeline saved before this
//     has none.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as schemaModule from "../utils/extraction-schema.js";
import { STEP_TYPES } from "../utils/step-types.js";

const {
  parseSchema,
  mapNodeToSchema,
  mapModelKeys,
  weightsFor,
  DEFAULT_PRODUCT_FIELDS,
  MAX_FIELDS,
} = schemaModule;

// ── Reading the field list ───────────────────────────────────────────────────

test("an empty schema is the product default, so old pipelines are unchanged", () => {
  for (const empty of ["", "   ", undefined, null, []]) {
    const out = parseSchema(empty);
    assert.equal(out.isDefault, true, `"${empty}" should be the default`);
    assert.deepEqual(out.fields, [...DEFAULT_PRODUCT_FIELDS]);
  }
  assert.equal(STEP_TYPES.AUTO_EXTRACT.def.schema, "");
});

test("fields are read from commas or newlines, whichever the user used", () => {
  assert.deepEqual(parseSchema("title, author, published date").fields, [
    "title",
    "author",
    "published date",
  ]);
  assert.deepEqual(parseSchema("title\nauthor\n\npublished date").fields, [
    "title",
    "author",
    "published date",
  ]);
});

test("a field named twice is one column, not two", () => {
  assert.deepEqual(parseSchema("title, Title, TITLE").fields, ["title"]);
});

test("a name a page could never use is refused, and said out loud", () => {
  // Silently dropping it is the thing a user spends an afternoon on: the
  // column is simply missing from every row and nothing explains why.
  const out = parseSchema("title, {{oops}}, author");
  assert.deepEqual(out.fields, ["title", "author"]);
  assert.deepEqual(out.rejected, ["{{oops}}"]);
});

test("a schema stops being a schema at some point", () => {
  const many = Array.from({ length: MAX_FIELDS + 5 }, (_, i) => `f${i}`);
  const out = parseSchema(many);
  assert.equal(out.fields.length, MAX_FIELDS);
  assert.equal(out.rejected.length, 5);
});

// ── Matching the user's names against the site's keys ────────────────────────

test("a site's own key answers a differently-spelled request", () => {
  const node = {
    "@type": "Article",
    datePublished: "2026-01-02",
    author: { "@type": "Person", name: "Ada Lovelace" },
  };
  const { values, matchedKeys } = mapNodeToSchema(node, [
    "published date",
    "author",
  ]);
  assert.equal(values["published date"], "2026-01-02");
  assert.equal(matchedKeys["published date"], "datePublished");
  assert.equal(
    values.author,
    "Ada Lovelace",
    "a nested node should give up the string it is plainly about",
  );
});

test("an exact match is never second-guessed by a similarity score", () => {
  // `price` and `priceCurrency` are both close to "price"; the exact one wins.
  const node = { priceCurrency: "GBP", price: "10.00" };
  const { values } = mapNodeToSchema(node, ["price"]);
  assert.equal(values.price, "10.00");
});

test("one key answers one field", () => {
  // Without this, "price" and "originalPrice" both take `price` and the row
  // reports the same number twice as though the page had said it twice.
  const node = { price: "10.00" };
  const { values } = mapNodeToSchema(node, ["price", "originalPrice"]);
  assert.equal(values.price, "10.00");
  assert.equal(values.originalPrice, undefined);
});

test("a key that is merely nearby is not an answer", () => {
  // The honest outcome for a page that does not publish the field: nothing,
  // so the next layer gets a turn. Filling it with the closest thing lying
  // around would be a wrong value that looks like a right one.
  const { values } = mapNodeToSchema({ manufacturer: "Acme", colour: "blue" }, [
    "defendant",
  ]);
  assert.deepEqual(values, {});
});

test("a nested value with nothing readable in it is refused, not stringified", () => {
  // "[object Object]" in a cell is worse than an empty one.
  const { values } = mapNodeToSchema({ author: { age: 42 } }, ["author"]);
  assert.equal(values.author, undefined);
});

test("a list becomes a cell rather than a shrug", () => {
  const { values } = mapNodeToSchema({ keywords: ["a", "b", "c"] }, [
    "keywords",
  ]);
  assert.equal(values.keywords, "a, b, c");
});

test("a model's answer is mapped the same way", () => {
  const said = { publishedDate: "2026-01-02", Title: "A Headline" };
  const out = mapModelKeys(said, ["published date", "title"]);
  assert.equal(out["published date"], "2026-01-02");
  assert.equal(out.title, "A Headline");
});

// ── Weights ──────────────────────────────────────────────────────────────────

test("product fields keep their ordering; a custom schema has none", () => {
  const product = weightsFor(DEFAULT_PRODUCT_FIELDS, true);
  assert.ok(
    product.name > product.sku,
    "a page with no price is a worse product extraction than one with no SKU",
  );
  const custom = weightsFor(["a", "b", "c"], false);
  assert.deepEqual(
    new Set(Object.values(custom)),
    new Set([1]),
    "the user named these, so none of them is the optional one",
  );
});

// ── The page and the worker ──────────────────────────────────────────────────

test("the page reports the site's raw keys, because the matcher cannot go there", () => {
  const src = readFileSync(
    new URL("../content/smart-extractor.js", import.meta.url),
    "utf8",
  );
  // A classic content script cannot import an ES module, so the fuzzy matcher
  // stays in the worker and the page hands over what it saw.
  // An actual import statement, not the word in a comment explaining why
  // there isn't one.
  assert.ok(
    !/^\s*import\s.+from\s/m.test(src),
    "smart-extractor must stay free of module imports",
  );
  assert.match(src, /_readAnyStructuredNode/);
  assert.match(src, /structuredNode/);
  assert.match(src, /metaNode/);
});

test("a schema is only carried when one was asked for", () => {
  const src = readFileSync(
    new URL("../content/smart-extractor.js", import.meta.url),
    "utf8",
  );
  // Reading and posting the whole structured node on every product run is
  // work and message size nobody asked for.
  assert.match(src, /if \(schema\) \{/);
});

test("the LLM merge covers the fields that were asked for", () => {
  const src = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  // A merge over a hardcoded product list would drop every field a user named
  // for themselves: the model answers and the answer is discarded on the way
  // back, which looks exactly like the model failing.
  assert.match(src, /const fieldList = l12\.fields \?\?/);
});

test("a field nothing answered escalates, even when the average looks fine", () => {
  const src = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /overallConfidence < threshold \|\| answered < fields\.length/,
    "four fields at 95 and one empty averages well above any threshold",
  );
});

test("the panel offers the schema, or it is unreachable", () => {
  const src = readFileSync(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /data-key="schema"/);
  assert.ok(
    !/Smart Product Auto-Extractor/.test(src),
    "the step is no longer product-only, and the heading said it was",
  );
});
