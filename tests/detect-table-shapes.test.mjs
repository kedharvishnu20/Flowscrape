// K-09: Detect Table across the shapes real pages actually use.
//
// Reported as "auto detection in table is not working properly in all cases".
// Measured against a battery of 37 page shapes rather than guessed at; three
// were genuinely wrong, and all three were wrong in a way that made the feature
// look broken rather than imperfect.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../content/structure-detector.js", import.meta.url),
  "utf8",
);

function detect(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://shop.test/list",
    runScripts: "outside-only",
  });
  vm.runInContext(source, dom.getInternalVMContext(), { filename: "sd.js" });
  const out = dom.window.__fsDetectStructure();
  dom.window.close();
  return out;
}

const top = (html) => detect(html).candidates[0] ?? null;
const names = (t) => (t ? t.fields.map((f) => f.name) : []);

const B = [
  ["Widget", "10.00"],
  ["Gadget", "25.50"],
  ["Doohickey", "5.75"],
  ["Thingamajig", "99.99"],
  ["Gizmo", "7.10"],
];

// ── The wrapper chain ───────────────────────────────────────────────────────
//
// Markup nests. `<td><div class="wrap"><div class="title">X</div></div></td>`
// is three elements holding one value. The guard against that redundancy looked
// *up* — "my parent has one child and my text, so I am the artefact" — which is
// true of every element in such a chain including the one that actually holds
// the text. Both were skipped, the cell yielded nothing, and a table whose
// cells wrap their contents in divs came back as "no tables found".

test("a table whose cells wrap their contents is still a table", () => {
  const t = top(
    `<table><tbody>${B.map(
      ([n, p]) =>
        `<tr><td><div class="wrap"><div class="title">${n}</div></div></td>` +
        `<td><div class="wrap"><div class="price">${p}</div></div></td></tr>`,
    ).join("")}</tbody></table>`,
  );
  assert.ok(t, "no table found at all");
  assert.equal(t.count, 5);
  assert.ok(names(t).includes("title"), names(t).join(", "));
  assert.ok(names(t).includes("price"), names(t).join(", "));
});

test("four levels of wrappers still resolve to the value", () => {
  const t = top(
    `<div>${B.map(
      ([n, p]) =>
        `<article class="card"><div class="a"><div class="b"><div class="c">` +
        `<h3 class="title">${n}</h3></div></div></div>` +
        `<div class="x"><div class="y"><span class="price">${p}</span></div></div></article>`,
    ).join("")}</div>`,
  );
  assert.equal(t?.count, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(names(t).slice(0, 2).sort())), [
    "price",
    "title",
  ]);
});

test("a link around an image still yields both columns", () => {
  // The guard has to keep an element that carries something of its own: an <a>
  // wrapping an <img> is the wrapper shape, and both columns are wanted.
  const t = top(
    `<div>${B.map(
      ([n]) =>
        `<div class="card"><a class="lnk" href="/p/${n}"><img class="thumb" src="/i/${n}.jpg"></a>` +
        `<span class="title">${n}</span></div>`,
    ).join("")}</div>`,
  );
  assert.ok(
    names(t).some((n) => n.includes("url")),
    names(t).join(", "),
  );
  assert.ok(
    names(t).some((n) => n.includes("image")),
    names(t).join(", "),
  );
});

// ── Page furniture ──────────────────────────────────────────────────────────
//
// A menu, a pager and a footer link list repeat perfectly regularly — that is
// what makes them menus — so they scored exactly like a product grid. On a real
// page the nav is often the longer list, and a twelve-item menu beat a
// four-product grid outright.

const NAV = `<nav><ul class="menu">${Array(12)
  .fill(0)
  .map((_, i) => `<li><a href="/s/${i}">Section ${i}</a></li>`)
  .join("")}</ul></nav>`;
const PAGER = `<ul class="pagination">${[1, 2, 3]
  .map((n) => `<li><a href="?p=${n}">${n}</a></li>`)
  .join("")}</ul>`;
const FOOT = `<footer><ul class="links">${["Terms", "Privacy", "Cookies"]
  .map((n) => `<li><a href="/${n}">${n}</a></li>`)
  .join("")}</ul></footer>`;
const GRID = `<div class="products">${B.slice(0, 4)
  .map(
    ([n, p]) =>
      `<div class="product"><h3 class="title">${n}</h3><span class="price">$${p}</span></div>`,
  )
  .join("")}</div>`;

test("the data grid beats the page's own furniture", () => {
  const t = top(NAV + GRID + PAGER + FOOT);
  assert.equal(t?.selector, ".product");
  assert.equal(t.count, 4);
});

test("furniture is not offered at all", () => {
  // Not merely outranked: a list of candidates half made of menus is its own
  // kind of broken, because the user has to know which ones to ignore.
  const sels = detect(NAV + GRID + PAGER + FOOT).candidates.map(
    (c) => c.selector,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(sels)), [".product"]);
});

test("a page that is only a menu offers nothing", () => {
  assert.equal(top(NAV), null);
});

test("a sidebar of links does not outrank a smaller grid", () => {
  // <aside> is not a nav landmark, so this one is settled by scoring: an
  // anchor's text and its href are two columns describing one element, and a
  // record with one piece of information is a list rather than a table.
  const t = top(
    `<aside><ul class="cats">${Array(10)
      .fill(0)
      .map((_, i) => `<li><a href="/c/${i}">Category ${i}</a></li>`)
      .join("")}</ul></aside>` + GRID,
  );
  assert.equal(t?.selector, ".product");
});

test("a list whose records carry more than a link is still data", () => {
  // The rule must not throw away a real list of results.
  const t = top(
    `<main><ul class="results">${B.map(
      ([n, p]) =>
        `<li class="r"><a class="t" href="/p/${n}">${n}</a><span class="d">${p}</span></li>`,
    ).join("")}</ul></main>`,
  );
  assert.equal(t?.count, 5);
  assert.ok(names(t).includes("t"), names(t).join(", "));
});

// ── ARIA tables ─────────────────────────────────────────────────────────────
//
// A <th> cell differs in tag from a <td>, so a real table's header row falls out
// of the record set on shape alone. An ARIA table spells both with the same
// element and tells them apart by role — so the header row matched the data
// rows perfectly and became row one of the scrape.

const ARIA = `<div role="table">
  <div role="row" class="hdr"><span role="columnheader">Name</span><span role="columnheader">Price</span></div>
  ${B.map(
    ([n, p]) =>
      `<div role="row" class="r"><span class="n" role="cell">${n}</span><span class="p" role="cell">${p}</span></div>`,
  ).join("")}</div>`;

test("an ARIA table's header row is not a data row", () => {
  const t = top(ARIA);
  assert.equal(t?.count, 5, "the header row was counted as data");
  assert.equal(t.selector, ".r");
});

test("an ARIA table's own column names are used", () => {
  const t = top(ARIA);
  assert.deepEqual(JSON.parse(JSON.stringify(names(t))), ["name", "price"]);
  assert.deepEqual(JSON.parse(JSON.stringify(t.sampleRows[0])), {
    name: "Widget",
    price: "10.00",
  });
});

test("a <th> header row is still excluded", () => {
  const t = top(
    `<table><tbody><tr><th>Name</th><th>Price</th></tr>
     ${B.map(([n, p]) => `<tr><td>${n}</td><td>${p}</td></tr>`).join("")}</tbody></table>`,
  );
  assert.equal(t?.count, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(names(t))), ["name", "price"]);
});

// ── Shapes that must keep working ───────────────────────────────────────────

test("the ordinary shapes are unchanged", () => {
  const table = top(
    `<table><thead><tr><th>Name</th><th>Price</th></tr></thead><tbody>
     ${B.map(([n, p]) => `<tr><td>${n}</td><td>${p}</td></tr>`).join("")}</tbody></table>`,
  );
  assert.equal(table?.selector, "tr");
  assert.deepEqual(JSON.parse(JSON.stringify(names(table))), ["name", "price"]);

  const cards = top(
    `<ul>${B.map(
      ([n, p]) =>
        `<li class="item"><h3 class="title">${n}</h3><span class="price">${p}</span></li>`,
    ).join("")}</ul>`,
  );
  assert.equal(cards?.count, 5);

  // Fewer than three records is a coincidence, not a pattern.
  assert.equal(
    top(
      `<table><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></table>`,
    ),
    null,
  );

  // A single-column layout table is not a table.
  assert.equal(
    top(`<table>${B.map(([n]) => `<tr><td>${n}</td></tr>`).join("")}</table>`),
    null,
  );
});

test("a value split across spans is one column, not three", () => {
  const t = top(
    `<ul>${B.map(
      ([n, p]) =>
        `<li class="i"><span class="t">${n}</span>` +
        `<span class="price"><span class="cur">$</span><span class="amt">${p}</span></span></li>`,
    ).join("")}</ul>`,
  );
  assert.ok(names(t).includes("price"), names(t).join(", "));
  assert.ok(!names(t).includes("cur"), "the currency became its own column");
});

test("a column that never varies is a label, not data", () => {
  const t = top(
    `<ul>${B.map(
      ([n, p]) =>
        `<li class="i"><strong>Price:</strong><span class="t">${n}</span><span class="p">${p}</span></li>`,
    ).join("")}</ul>`,
  );
  assert.ok(!names(t).includes("strong"), names(t).join(", "));
});
