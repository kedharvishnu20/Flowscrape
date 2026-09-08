// Picking a field from inside a loop.
//
// Reported from real use: "bulk extract is not working properly … I want to
// scrape the data of the products in cards", and a memory of a feature for
// "choosing the elements of a particular element in loop to extract when there
// are multiple product cards".
//
// The memory is right about what is needed and wrong that it ever existed.
// `_addExtractField` asked the page for a selector with no idea that the
// EXTRACT it was filling sat inside a LOOP over `.card`, so it produced a
// page-wide selector — and `_buildBulkSelector` guessed at one by walking up
// five levels of direct-child combinators and stopping at the first that
// matched two elements. On a grid of product cards that lands almost anywhere.
//
// The fix is not a better guess. The loop already says what a record is; a
// field picked inside it should be described *relative to that record*, which
// is the same relative-selector idea the structure detector uses.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadInjector } from "./helpers/content-harness.mjs";

const panel = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);

/** _loopScopeFor, lifted out of the panel module, which cannot be imported. */
function makeScopeFinder() {
  const locate = panel.match(
    /function _locateStep\(steps, id, parent = null\) \{[\s\S]*?\n\}/,
  );
  const fn = panel.match(/function _loopScopeFor\(stepId\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "no _loopScopeFor in the panel");
  return (steps, id) =>
    new Function("_pipeline", `${locate[0]}\n${fn[0]}; return _loopScopeFor;`)({
      steps,
    })(id);
}

const loop = (selector, children) => ({
  id: `loop_${selector}`,
  type: "LOOP",
  config: { type: "elements", selector },
  children,
});
const extract = (id) => ({ id, type: "EXTRACT", config: { fields: [] } });

test("a field picked inside a loop knows the loop's container", () => {
  const scopeFor = makeScopeFinder();
  assert.equal(scopeFor([loop(".card", [extract("e1")])], "e1"), ".card");
});

test("a field picked outside any loop has no scope", () => {
  const scopeFor = makeScopeFinder();
  assert.equal(scopeFor([extract("e1")], "e1"), "");
});

test("the nearest enclosing loop wins", () => {
  // A loop over rows inside a loop over tables: the field belongs to the row.
  const scopeFor = makeScopeFinder();
  const steps = [loop(".table", [loop(".row", [extract("e1")])])];
  assert.equal(scopeFor(steps, "e1"), ".row");
});

test("a loop that is not over elements is not a scope", () => {
  // A count loop has no container to be relative to.
  const scopeFor = makeScopeFinder();
  const steps = [
    {
      id: "l",
      type: "LOOP",
      config: { type: "count", max: 5 },
      children: [extract("e1")],
    },
  ];
  assert.equal(scopeFor(steps, "e1"), "");
});

test("a field inside an IF branch inside a loop still knows the loop", () => {
  const scopeFor = makeScopeFinder();
  const steps = [
    loop(".card", [
      {
        id: "if",
        type: "IF_ELSE",
        config: {},
        ifBranch: [extract("e1")],
        elseBranch: [],
      },
    ]),
  ];
  assert.equal(scopeFor(steps, "e1"), ".card");
});

// ── the selector the page hands back ────────────────────────────────────────

const CARDS = `
  <div class="grid">
    <div class="card">
      <h3 class="title">Widget</h3>
      <span class="price">$10.00</span>
      <a class="buy" href="/p/1">Buy</a>
    </div>
    <div class="card">
      <h3 class="title">Gadget</h3>
      <span class="price">$25.50</span>
      <a class="buy" href="/p/2">Buy</a>
    </div>
    <div class="card">
      <h3 class="title">Doohickey</h3>
      <span class="price">$7.99</span>
      <a class="buy" href="/p/3">Buy</a>
    </div>
  </div>`;

test("a scoped pick describes the element relative to its card", async () => {
  // `.title`, not `.grid > .card:nth-of-type(1) > .title`. The loop supplies
  // the card; the field only has to say where in it to look.
  const page = await loadInjector(CARDS);
  const el = page.document.querySelectorAll(".card .title")[1];
  const sel = page.api._buildScopedSelector(el, ".card");
  assert.equal(sel, ".title");

  // And it finds the right thing in every card, not just the one clicked.
  const found = [...page.document.querySelectorAll(".card")].map(
    (card) => card.querySelector(sel)?.textContent,
  );
  assert.deepEqual(found, ["Widget", "Gadget", "Doohickey"]);
  page.close();
});

test("a scoped pick works for a nested element", async () => {
  const page = await loadInjector(`
    <div class="card"><div class="meta"><span class="sku">A-1</span></div></div>
    <div class="card"><div class="meta"><span class="sku">A-2</span></div></div>
    <div class="card"><div class="meta"><span class="sku">A-3</span></div></div>`);
  const el = page.document.querySelector(".card .sku");
  const sel = page.api._buildScopedSelector(el, ".card");
  const found = [...page.document.querySelectorAll(".card")].map(
    (c) => c.querySelector(sel)?.textContent,
  );
  assert.deepEqual(found, ["A-1", "A-2", "A-3"]);
  page.close();
});

test("clicking outside every card is refused rather than guessed at", async () => {
  // Picking the page heading while scoped to `.card` cannot mean anything —
  // and returning a page-wide selector would put the same value in every row,
  // which is what the unscoped picker did.
  const page = await loadInjector(`<h1 class="page-title">Shop</h1>${CARDS}`);
  const el = page.document.querySelector(".page-title");
  assert.equal(page.api._buildScopedSelector(el, ".card"), null);
  page.close();
});

test("the card itself yields a selector meaning 'this record'", async () => {
  const page = await loadInjector(CARDS);
  const el = page.document.querySelector(".card");
  assert.equal(page.api._buildScopedSelector(el, ".card"), ":scope");
  page.close();
});

test("the picker is told the scope, and only offers elements inside it", async () => {
  assert.match(panel, /scopeSelector/, "the panel never sends a scope");
  const injector = await readFile(
    new URL("../content/injector.js", import.meta.url),
    "utf8",
  );
  assert.match(injector, /scopeSelector/, "the picker never receives a scope");
});
