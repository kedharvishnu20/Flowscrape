// Tests for content/structure-detector.js — reading a page's repeating
// structures so a scrape can be built without knowing any CSS selectors.
//
// The three things worth testing are the three a naive version gets wrong,
// because real pages do all of them constantly:
//
//   * a sponsored row has an extra badge and a sold-out row has no rating, so
//     grouping by exact shape splits one list into three and the user silently
//     scrapes a subset;
//   * a price written <span>$</span><span>10</span> is one column, not two;
//   * a list and each of its items are one column, not four.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import vm from "node:vm";

const SOURCE = await readFile(
  new URL("../content/structure-detector.js", import.meta.url),
  "utf8",
);

/** Load the detector into a page and return its entry point. */
function detectorFor(bodyHtml) {
  const dom = new JSDOM(
    `<!doctype html><html><body>${bodyHtml}</body></html>`,
    { url: "https://shop.test/list", runScripts: "outside-only" },
  );
  const context = dom.getInternalVMContext();
  vm.runInContext(SOURCE, context, { filename: "structure-detector.js" });
  return {
    detect: () => dom.window.__fsDetectStructure(),
    window: dom.window,
    close: () => dom.window.close(),
  };
}

const product = (name, price, extra = "") => `
  <article class="s-item">
    <a class="s-link" href="/p/${name.toLowerCase()}"><img class="s-img" src="/i/${name}.jpg"></a>
    <h2 class="s-title">${name}</h2>
    <div class="s-price"><span class="cur">$</span><span class="amt">${price}</span></div>
    ${extra}
  </article>`;

const LIST = `
  <header><nav><a href="/">Home</a><a href="/a">A</a><a href="/b">B</a></nav></header>
  <main><div class="results">
    ${product("Alpha", "10.00", '<div class="s-rating">4.5</div>')}
    ${product("Beta", "20.00", '<div class="s-rating">4.8</div>')}
    ${product("Gamma", "30.00", '<div class="s-rating">4.1</div>')}
    ${product("Delta", "40.00", '<div class="s-rating">3.9</div>')}
  </div></main>`;

// ── the basics ───────────────────────────────────────────────────────────────

test("it finds the list and ignores the page chrome", () => {
  const d = detectorFor(LIST);
  const { candidates } = d.detect();

  assert.ok(candidates.length >= 1, "found nothing");
  const top = candidates[0];
  assert.equal(top.selector, ".s-item");
  assert.equal(top.count, 4);

  // The nav is three links in a row; it must not outrank the products.
  assert.ok(
    !candidates.some((c) => c.selector.includes("nav")),
    "the nav was offered as a table",
  );
  d.close();
});

test("it names the columns from the markup", () => {
  const d = detectorFor(LIST);
  const names = d.detect().candidates[0].fields.map((f) => f.name);
  assert.ok(names.includes("title"), `no title in ${names.join(", ")}`);
  assert.ok(names.includes("price"), `no price in ${names.join(", ")}`);
  const fields = d.detect().candidates[0].fields;
  assert.ok(
    fields.some((f) => f.kind === "href"),
    `no link column in ${names.join(", ")}`,
  );
  assert.ok(
    fields.some((f) => f.kind === "src"),
    "the product image was dropped",
  );
  d.close();
});

test("it returns sample rows a person can read", () => {
  const d = detectorFor(LIST);
  const top = d.detect().candidates[0];
  assert.ok(top.sampleRows.length >= 2, "not enough samples to judge by");
  assert.equal(top.sampleRows[0].title, "Alpha");
  assert.equal(top.sampleRows[1].title, "Beta");
  d.close();
});

test("every field carries its coverage, so a patchy column is visible", () => {
  const d = detectorFor(LIST);
  for (const f of d.detect().candidates[0].fields) {
    assert.ok(f.coverage > 0 && f.coverage <= 100, `${f.name}: ${f.coverage}%`);
    assert.ok(f.selector.length > 0);
    assert.ok(["text", "href", "src"].includes(f.kind));
  }
  d.close();
});

// ── the three real-page problems ─────────────────────────────────────────────

test("an odd row is kept, not silently dropped", () => {
  // The sponsored row has an extra badge; the last has no rating. Grouping by
  // exact shape would give three lists of one or two, and whichever won would
  // quietly scrape a subset.
  const mixed = `<div class="results">
    ${product("Alpha", "10", '<div class="s-rating">4.5</div>')}
    ${product("Beta", "20", '<span class="badge">Sponsored</span><div class="s-rating">4.8</div>')}
    ${product("Gamma", "30", '<div class="s-rating">4.1</div>')}
    ${product("Delta", "40", "")}
    ${product("Epsilon", "50", '<div class="s-rating">4.4</div>')}
  </div>`;
  const d = detectorFor(mixed);
  const top = d.detect().candidates[0];
  assert.equal(top.count, 5, "rows went missing");
  assert.deepEqual(
    JSON.parse(JSON.stringify(top.sampleRows.map((r) => r.title))),
    ["Alpha", "Beta", "Gamma"],
  );
  d.close();
});

test("a value split across children is one column", () => {
  const d = detectorFor(LIST);
  const fields = d.detect().candidates[0].fields;
  const price = fields.find((f) => f.name === "price");
  assert.ok(price, "no price column at all");
  assert.equal(
    price.samples[0],
    "$10.00",
    "the currency and amount were split",
  );
  assert.ok(
    !fields.some((f) => f.name === "cur" || f.name === "amt"),
    "the halves were offered as columns of their own",
  );
  d.close();
});

test("a list is one column, not one per item", () => {
  const withSpecs = `<div class="results">
    ${product("Alpha", "10", '<ul class="s-specs"><li>16 GB</li><li>512 GB</li></ul>')}
    ${product("Beta", "20", '<ul class="s-specs"><li>32 GB</li><li>1 TB</li></ul>')}
    ${product("Gamma", "30", '<ul class="s-specs"><li>8 GB</li><li>256 GB</li></ul>')}
  </div>`;
  const d = detectorFor(withSpecs);
  const fields = d.detect().candidates[0].fields;
  const specs = fields.filter((f) => f.name === "specs");
  assert.equal(specs.length, 1, `specs appeared ${specs.length} times`);
  d.close();
});

test("an anchor's text and href are two columns with two names", () => {
  // Rows are plain objects, so two columns sharing a name means one silently
  // overwrites the other and a column disappears without a word.
  const d = detectorFor(LIST);
  const fields = d.detect().candidates[0].fields;
  const names = fields.map((f) => f.name);
  assert.equal(new Set(names).size, names.length, `duplicates: ${names}`);

  const link = fields.find((f) => f.kind === "href");
  assert.ok(link.name.endsWith("url"), `href column named "${link.name}"`);

  // And the sample row carries both.
  const row = d.detect().candidates[0].sampleRows[0];
  assert.equal(Object.keys(row).length, fields.length, "a column was lost");
  d.close();
});

test("a name collision falls back to numbering rather than dropping a column", () => {
  const twins = `<div class="results">
    <div class="rec"><span class="v">a1</span><span class="v">b1</span><em class="w">c1</em></div>
    <div class="rec"><span class="v">a2</span><span class="v">b2</span><em class="w">c2</em></div>
    <div class="rec"><span class="v">a3</span><span class="v">b3</span><em class="w">c3</em></div>
  </div>`;
  const d = detectorFor(twins);
  const names = d.detect().candidates[0].fields.map((f) => f.name);
  assert.equal(new Set(names).size, names.length, `duplicates: ${names}`);
  d.close();
});

// ── several lists on one page ────────────────────────────────────────────────

test("two unrelated lists come back as two tables, best first", () => {
  const two = `<main>
    <div class="results">
      ${product("Alpha", "10", '<div class="s-rating">4.5</div>')}
      ${product("Beta", "20", '<div class="s-rating">4.8</div>')}
      ${product("Gamma", "30", '<div class="s-rating">4.1</div>')}
    </div>
    <div class="reviews">
      <div class="rv"><b class="rv-who">Ada</b><p class="rv-txt">Fast.</p></div>
      <div class="rv"><b class="rv-who">Grace</b><p class="rv-txt">Quiet.</p></div>
      <div class="rv"><b class="rv-who">Alan</b><p class="rv-txt">Bright.</p></div>
    </div>
  </main>`;
  const d = detectorFor(two);
  const { candidates } = d.detect();
  const selectors = candidates.map((c) => c.selector);
  assert.ok(selectors.includes(".s-item"), selectors.join(", "));
  assert.ok(selectors.includes(".rv"), selectors.join(", "));
  assert.equal(
    candidates[0].selector,
    ".s-item",
    "the richer table should be offered first",
  );
  d.close();
});

test("the same list is not offered twice under different selectors", () => {
  const d = detectorFor(LIST);
  const selectors = d.detect().candidates.map((c) => c.selector);
  assert.equal(new Set(selectors).size, selectors.length, selectors.join(", "));
  d.close();
});

// ── when there is nothing to find ────────────────────────────────────────────

test("a single-record page reports no tables rather than guessing", () => {
  const detail = `<main>
    <h1 class="title">Alpha</h1>
    <div class="price">$10.00</div>
    <p class="desc">One product, one page.</p>
  </main>`;
  const d = detectorFor(detail);
  assert.equal(d.detect().candidates.length, 0);
  d.close();
});

test("a bare list of strings is not a table — it has no columns", () => {
  const d = detectorFor(`<ul class="tags"><li>a</li><li>b</li><li>c</li></ul>`);
  const { candidates } = d.detect();
  assert.ok(
    !candidates.some((c) => c.selector === ".tags"),
    "a single-column list is not worth offering",
  );
  d.close();
});

test("an empty page does not throw", () => {
  const d = detectorFor("");
  const out = d.detect();
  assert.equal(out.candidates.length, 0);
  assert.equal(typeof out.url, "string");
  assert.equal(typeof out.title, "string");
  d.close();
});

// ── the container selector has to work on the page ───────────────────────────

test("every container selector finds at least the rows it claims", () => {
  const d = detectorFor(LIST);
  for (const c of d.detect().candidates) {
    const found = d.window.document.querySelectorAll(c.selector).length;
    assert.ok(
      found >= 3,
      `${c.selector} matches ${found} elements, not the ${c.count} claimed`,
    );
    assert.equal(c.matched, found, "the reported match count is wrong");
  }
  d.close();
});

test("every field selector resolves inside its container", () => {
  const d = detectorFor(LIST);
  const top = d.detect().candidates[0];
  const record = d.window.document.querySelector(top.selector);
  for (const f of top.fields) {
    assert.ok(
      record.querySelector(f.selector),
      `${f.selector} matches nothing inside ${top.selector}`,
    );
  }
  d.close();
});

test("state classes are skipped, but record-ish ones are not", () => {
  // .active and .is-open are state, not meaning. But "row", "item" and "card"
  // read like layout and are also the commonest names for an actual record —
  // treating them as junk makes the detector fall back to a bare `li`, which is
  // worse in every way. Bootstrap's real layout classes carry a digit.
  const noisy = `<div class="results">
    <div class="active card"><b class="n">A</b><i class="w">1</i></div>
    <div class="card"><b class="n">B</b><i class="w">2</i></div>
    <div class="card"><b class="n">C</b><i class="w">3</i></div>
  </div>`;
  const d = detectorFor(noisy);
  assert.equal(d.detect().candidates[0].selector, ".card");
  d.close();

  const rows = `<ul class="list">
    <li class="row"><a class="lbl" href="/1">A</a><b class="amt">1</b></li>
    <li class="row"><a class="lbl" href="/2">B</a><b class="amt">2</b></li>
    <li class="row"><a class="lbl" href="/3">C</a><b class="amt">3</b></li>
  </ul>`;
  const d2 = detectorFor(rows);
  assert.equal(
    d2.detect().candidates[0].selector,
    ".row",
    "a bare tag selector would have been chosen instead",
  );
  d2.close();

  const bootstrap = `<div class="results">
    <div class="col-md-4 tile"><b class="n">A</b><i class="w">1</i></div>
    <div class="col-md-4 tile"><b class="n">B</b><i class="w">2</i></div>
    <div class="col-md-4 tile"><b class="n">C</b><i class="w">3</i></div>
  </div>`;
  const d3 = detectorFor(bootstrap);
  assert.equal(
    d3.detect().candidates[0].selector,
    ".tile",
    "a class with a digit in it is a grid column, not a record name",
  );
  d3.close();
});

// ── the wiring around it ─────────────────────────────────────────────────────

test("the detector is injected with the other content scripts", async () => {
  const sw = await readFile(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(sw, /"content\/structure-detector\.js"/);
  // Before injector.js, which dispatches to the global it defines.
  const files = sw.match(/const CONTENT_FILES = \[[\s\S]*?\];/)[0];
  assert.ok(
    files.indexOf("structure-detector") < files.indexOf("injector"),
    "the detector has to be there before injector dispatches to it",
  );
  assert.match(sw, /_registerHandler\("content:detect"/);
});

test("the content script answers the detect message", async () => {
  const injector = await readFile(
    new URL("../content/injector.js", import.meta.url),
    "utf8",
  );
  assert.match(injector, /"FS_DETECT_STRUCTURE",/, "the type is owned");
  assert.match(injector, /globalThis\.__fsDetectStructure/);
  assert.match(
    injector,
    /Structure detector is not loaded in this page/,
    "a missing detector says so rather than throwing something opaque",
  );
});

test("picking a table builds a loop, not one flat extract", async () => {
  // EXTRACT lines its columns up positionally, so a record missing a rating
  // shifts every later rating up a row. Scoping each iteration to its own
  // container is what makes a row a row.
  const panel = await readFile(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  const fn = panel.match(
    /function _insertDetectedTable\(table\) \{[\s\S]*?\n\}/,
  )[0];
  assert.match(fn, /type: "LOOP"/);
  assert.match(fn, /type: "elements"/);
  assert.match(fn, /children: \[extract\]/);
  assert.match(fn, /max: 0/, "every match, not the registry default of 10");
  assert.match(fn, /f\.kind === "href" \? \{ attribute: "href" \}/);
});

test("the sample rows are rendered as nodes, never as markup", async () => {
  const panel = await readFile(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  const fn = panel.match(
    /function _chooseDetectedTable\(candidates\) \{[\s\S]*?\n\}\n/,
  )[0];
  assert.ok(!/innerHTML/.test(fn), "every value here is page content");
  assert.match(fn, /document\.createElement\("table"\)/);
  assert.match(fn, /td\.textContent = /);
  assert.match(fn, /if \(e\.key === "Escape"\) done\(null\)/);
});

test("a page with nothing repeating is offered the page's own data instead", async () => {
  // A single-record page — a product, an article — has nothing to loop over,
  // and that is most of what people point this at after scraping a list.
  // Sending them straight to picking elements by hand skips the thing that
  // needs no selectors at all.
  const panel = await readFile(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  const detect = panel.match(
    /async function _detectStructure\(\) \{[\s\S]*?\n\}/,
  )[0];
  assert.match(detect, /_offerPageData/, "no fallback is offered");

  const offer = panel.match(
    /async function _offerPageData\(tabId\) \{[\s\S]*?\n\}\n/,
  )[0];
  // Only offered when there is something to read: suggesting a step that comes
  // back empty costs the user a run to find out.
  assert.match(offer, /if \(!data\?\.found\)/);
  assert.match(
    offer,
    /Pick the fields you want by hand/,
    "and when there is nothing either way, it says what to do next",
  );
  assert.match(offer, /PAGE_DATA/);
});
