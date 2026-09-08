// Regression tests for audit finding B-08, run against a real DOM.
//
// _stepExtract builds rows up to the largest match count across fields. Short
// fields used to be padded with that field's FIRST match, so a page with 10
// prices and 3 titles produced 10 rows in which 7 repeated title #1 as though
// it were real data. And `|| null` turned legitimately falsy extractions —
// "0", "", "false" — into null.
import test from "node:test";
import assert from "node:assert/strict";
import { loadInjector } from "./helpers/content-harness.mjs";

const field = (name, selector, extra = {}) => ({ name, selector, ...extra });

// Rows come back from the jsdom realm, so their prototype is not this realm's
// Object and deepEqual would reject them on identity alone.
const plain = (value) => JSON.parse(JSON.stringify(value));

test("fields with equal match counts pair positionally", async () => {
  const h = await loadInjector(`
    <div class="p"><h2>Widget</h2><span class="pr">10</span></div>
    <div class="p"><h2>Gadget</h2><span class="pr">20</span></div>
  `);
  const rows = await h.api._stepExtract({
    fields: [field("title", ".p h2"), field("price", ".p .pr")],
  });
  assert.deepEqual(plain(rows), [
    { title: "Widget", price: "10" },
    { title: "Gadget", price: "20" },
  ]);
  h.close();
});

test("a field matching exactly once is broadcast to every row", async () => {
  // The legitimate case the old padding was reaching for: one page-level value
  // that belongs on all rows.
  const h = await loadInjector(`
    <h1 class="page">Summer Sale</h1>
    <div class="p"><h2>Widget</h2></div>
    <div class="p"><h2>Gadget</h2></div>
    <div class="p"><h2>Doohickey</h2></div>
  `);
  const rows = await h.api._stepExtract({
    fields: [field("page", ".page"), field("title", ".p h2")],
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(
    plain(rows).map((r) => r.page),
    ["Summer Sale", "Summer Sale", "Summer Sale"],
  );
  assert.deepEqual(
    plain(rows).map((r) => r.title),
    ["Widget", "Gadget", "Doohickey"],
  );
  h.close();
});

test("a partially-matching field yields null, not a repeat of the first value", async () => {
  // This is the corruption: 4 prices, 2 titles. Rows 3 and 4 have no title.
  const h = await loadInjector(`
    <span class="pr">10</span><span class="pr">20</span>
    <span class="pr">30</span><span class="pr">40</span>
    <h2 class="t">Widget</h2><h2 class="t">Gadget</h2>
  `);
  const rows = await h.api._stepExtract({
    fields: [field("price", ".pr"), field("title", ".t")],
  });

  assert.equal(rows.length, 4);
  assert.deepEqual(
    plain(rows).map((r) => r.price),
    ["10", "20", "30", "40"],
  );
  assert.deepEqual(
    plain(rows).map((r) => r.title),
    ["Widget", "Gadget", null, null],
    "rows 3 and 4 used to claim the title was 'Widget'",
  );
  h.close();
});

test("falsy extracted values survive", async () => {
  const h = await loadInjector(`
    <div class="row"><span class="stock">0</span><span class="note"></span></div>
    <div class="row"><span class="stock">5</span><span class="note">x</span></div>
  `);
  const rows = await h.api._stepExtract({
    fields: [field("stock", ".row .stock"), field("note", ".row .note")],
  });

  assert.equal(rows[0].stock, "0", '"0" is a real stock count, not null');
  assert.equal(rows[0].note, "", "an empty string is a real extraction");
  assert.equal(rows[1].stock, "5");
  h.close();
});

test("a field matching nothing is null on every row", async () => {
  const h = await loadInjector(
    `<h2 class="t">Widget</h2><h2 class="t">Gadget</h2>`,
  );
  const rows = await h.api._stepExtract({
    fields: [field("title", ".t"), field("missing", ".nope")],
  });
  assert.deepEqual(
    plain(rows).map((r) => r.missing),
    [null, null],
  );
  h.close();
});

test("no fields and no matches produce no rows", async () => {
  const h = await loadInjector(`<p>nothing here</p>`);
  assert.deepEqual(plain(await h.api._stepExtract({ fields: [] })), []);

  const rows = await h.api._stepExtract({ fields: [field("x", ".nope")] });
  assert.deepEqual(
    plain(rows),
    [{ x: null }],
    "one row of nulls, since maxLen floors at 1",
  );
  h.close();
});

test("attribute extraction reads the named attribute", async () => {
  const h = await loadInjector(`
    <a class="l" href="/one" data-sku="A1">One</a>
    <a class="l" href="/two" data-sku="B2">Two</a>
  `);
  const rows = await h.api._stepExtract({
    fields: [
      field("href", ".l", { type: "attribute", attribute: "href" }),
      field("sku", ".l", { type: "attribute", attribute: "data-sku" }),
    ],
  });
  assert.deepEqual(plain(rows), [
    { href: "/one", sku: "A1" },
    { href: "/two", sku: "B2" },
  ]);
  h.close();
});

test("attribute extraction without a name is an error, not silent text", async () => {
  const h = await loadInjector(`<a class="l" href="/one">One</a>`);
  await assert.rejects(
    () =>
      h.api._stepExtract({
        fields: [field("href", ".l", { type: "attribute" })],
      }),
    /set to Attr but has no attribute name/,
  );
  h.close();
});
