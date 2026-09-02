// End-to-end checks against a real Chromium with the extension loaded.
//
// Run with: npm run e2e
import test from "node:test";
import assert from "node:assert/strict";
import { launch, startSite } from "./harness.mjs";

const PRODUCTS = `<!doctype html><html><head><title>Shop</title></head><body>
  <h1 id="title">Test Shop</h1>
  <div class="product-card"><a class="product-link" href="/p/1">Widget</a>
    <span class="price">$10.00</span><span class="stock">In stock</span></div>
  <div class="product-card"><a class="product-link" href="/p/2">Gadget</a>
    <span class="price">$25.50</span><span class="stock">In stock</span></div>
  <div class="product-card"><a class="product-link" href="/p/3">Doohickey</a>
    <span class="price">$7.99</span><span class="stock">Out of stock</span></div>
  <input id="search" type="text">
  <input id="pw" type="password">
  <input id="agree" type="checkbox">
  <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
  <div id="editable" contenteditable="true"></div>
  <button id="go">Go</button>
  <div id="clicked">no</div>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      document.getElementById('clicked').textContent = 'yes';
    });
  </script>
</body></html>`;

// A controlled input that behaves like React's: it caches the last value it saw
// and overwrites anything it did not notice. This is the B-10 failure mode, in
// a real browser rather than a jsdom simulation of one.
const CONTROLLED = `<!doctype html><html><body>
  <input id="ctl" type="text">
  <div id="state"></div>
  <script>
    (function () {
      var node = document.getElementById('ctl');
      var proto = Object.getPrototypeOf(node);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      var tracked = '';
      var state = '';
      Object.defineProperty(node, 'value', {
        configurable: true,
        get: function () { return desc.get.call(this); },
        set: function (v) { tracked = String(v); desc.set.call(this, v); }
      });
      node._valueTracker = {
        getValue: function () { return tracked; },
        setValue: function (v) { tracked = String(v); }
      };
      node.addEventListener('input', function () {
        var next = desc.get.call(node);
        if (next === tracked) return;
        tracked = next;
        state = next;
      });
      node.addEventListener('input', function () {
        desc.set.call(node, state);
        document.getElementById('state').textContent = state;
      });
    })();
  </script>
</body></html>`;

// A page whose content arrives late, and a feed that grows as you scroll. Both
// are what the WAIT and SCROLL steps exist for, and neither can be simulated in
// jsdom: there is no layout, so nothing is ever really below the fold.
const LAZY = `<!doctype html><html><body>
  <div id="feed"></div>
  <div id="late-host"></div>
  <script>
    // A results panel that shows up after a moment, hidden first — the shape
    // that makes "wait until it exists" the wrong check.
    var late = document.createElement('div');
    late.className = 'results';
    late.style.display = 'none';
    late.textContent = 'Results';
    document.getElementById('late-host').appendChild(late);
    setTimeout(function () { late.style.display = 'block'; }, 700);

    // Ten items per screenful, four screenfuls, then nothing more.
    var pages = 0;
    function grow() {
      if (pages >= 4) return;
      pages++;
      var feed = document.getElementById('feed');
      for (var i = 0; i < 10; i++) {
        var d = document.createElement('div');
        d.className = 'post';
        d.style.height = '120px';
        d.textContent = 'post ' + (pages * 10 + i);
        feed.appendChild(d);
      }
    }
    grow();
    window.addEventListener('scroll', function () {
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 50) {
        setTimeout(grow, 100);
      }
    });
  </script>
</body></html>`;

/** Page N of a three-page list; page 3's Next button is disabled. */
const paged = (n) => `<!doctype html><html><body>
  <h1 id="title">Page ${n}</h1>
  <div class="row">item ${n}a</div>
  <div class="row">item ${n}b</div>
  ${
    n < 3
      ? `<a class="next" href="/page/${n + 1}">Next</a>`
      : `<button class="next" disabled>Next</button>`
  }
</body></html>`;

let env;
let site;

test.before(async () => {
  site = await startSite({
    "/": PRODUCTS,
    "/controlled": CONTROLLED,
    "/lazy": LAZY,
    "/page/1": paged(1),
    "/page/2": paged(2),
    "/page/3": paged(3),
  });
  env = await launch();
});

test.after(async () => {
  await env?.close();
  await site?.close();
});

// ── loading ──────────────────────────────────────────────────────────────────

test("Chrome loads the extension and starts the service worker", () => {
  assert.match(env.sw.url(), /background\/service-worker\.js$/);
  assert.match(env.extensionId, /^[a-p]{32}$/);
});

test("the side panel renders", async () => {
  const title = await env.panel.title();
  assert.ok(title.length > 0, "the panel page has a title");

  // The board, the palette trigger and the run controls all exist.
  for (const id of ["btn-master-run", "run-controls", "btn-master-pause"]) {
    assert.equal(
      await env.panel.locator(`#${id}`).count(),
      1,
      `#${id} is missing from the rendered panel`,
    );
  }
});

test("the panel loads with no uncaught errors", () => {
  assert.deepEqual(env.consoleErrors, []);
});

// ── the message bus ──────────────────────────────────────────────────────────

test("the worker answers on its message bus", async () => {
  const res = await env.send("checkpoint:check");
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(typeof res.result.hasResumable, "boolean");
});

test("an unknown message type is refused by name", async () => {
  const res = await env.send("nonsense:type");
  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown message type/);
});

// ── on-demand injection (C-09) ───────────────────────────────────────────────

test("a step reaches a page with no declared content script", async () => {
  const page = await env.ctx.newPage();
  await page.goto(site.url("/"));
  const tabId = await page.evaluate(() => 0); // placeholder; real id below

  // The worker needs the tab id Chrome assigned. Ask the extension for it.
  const id = await env.panel.evaluate(
    (url) =>
      new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) =>
          resolve(tabs.find((t) => t.url === url)?.id ?? null),
        );
      }),
    site.url("/"),
  );
  assert.ok(id, "the test page has a tab id");
  void tabId;

  const res = await env.send("step:execute", {
    step: {
      id: "s1",
      type: "EXTRACT",
      config: { fields: [{ name: "t", selector: "#title" }] },
    },
    tabId: id,
  });

  assert.equal(res.ok, true, `injection failed: ${JSON.stringify(res)}`);
  assert.deepEqual(res.result, [{ t: "Test Shop" }]);
  await page.close();
});

// ── the page steps, against a real DOM ───────────────────────────────────────

async function onSite(path = "/") {
  const page = await env.ctx.newPage();
  await page.goto(site.url(path));
  const id = await env.panel.evaluate(
    (url) =>
      new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) =>
          resolve(tabs.find((t) => t.url === url)?.id ?? null),
        );
      }),
    site.url(path),
  );
  return { page, tabId: id };
}

const step = (type, config) => ({ id: `s_${type}`, type, config });

test("EXTRACT reads several rows from a real page", async () => {
  const { page, tabId } = await onSite();
  const res = await env.send("step:execute", {
    step: step("EXTRACT", {
      fields: [
        { name: "name", selector: ".product-link" },
        { name: "price", selector: ".price" },
      ],
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.result, [
    { name: "Widget", price: "$10.00" },
    { name: "Gadget", price: "$25.50" },
    { name: "Doohickey", price: "$7.99" },
  ]);
  await page.close();
});

test("EXTRACT reads an attribute when asked to", async () => {
  const { page, tabId } = await onSite();
  const res = await env.send("step:execute", {
    step: step("EXTRACT", {
      fields: [
        {
          name: "href",
          selector: ".product-link",
          type: "attribute",
          attribute: "href",
        },
      ],
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(
    res.result.map((r) => r.href),
    ["/p/1", "/p/2", "/p/3"],
  );
  await page.close();
});

test("CLICK actually clicks", async () => {
  const { page, tabId } = await onSite();
  const res = await env.send("step:execute", {
    step: step("CLICK", { selector: "#go" }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(await page.locator("#clicked").textContent(), "yes");
  await page.close();
});

test("FILL types into a plain input", async () => {
  const { page, tabId } = await onSite();
  const res = await env.send("step:execute", {
    step: step("FILL", {
      selector: "#search",
      text: "running shoes",
      delayMs: 0,
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(await page.locator("#search").inputValue(), "running shoes");
  await page.close();
});

test("FILL beats a controlled input — the B-10 fix, in a real browser", async () => {
  const { page, tabId } = await onSite("/controlled");
  const res = await env.send("step:execute", {
    step: step("FILL", { selector: "#ctl", text: "sneakers", delayMs: 0 }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(
    await page.locator("#ctl").inputValue(),
    "sneakers",
    "the DOM value",
  );
  assert.equal(
    await page.locator("#state").textContent(),
    "sneakers",
    "and the component state behind it",
  );
  await page.close();
});

test("FILL handles a checkbox, a select and a contenteditable", async () => {
  const { page, tabId } = await onSite();

  assert.equal(
    (
      await env.send("step:execute", {
        step: step("FILL", { selector: "#agree", text: "true", delayMs: 0 }),
        tabId,
      })
    ).ok,
    true,
  );
  assert.equal(await page.locator("#agree").isChecked(), true);

  assert.equal(
    (
      await env.send("step:execute", {
        step: step("SELECT", { selector: "#size", value: "Large" }),
        tabId,
      })
    ).ok,
    true,
  );
  assert.equal(await page.locator("#size").inputValue(), "l");

  assert.equal(
    (
      await env.send("step:execute", {
        step: step("FILL", {
          selector: "#editable",
          text: "a note",
          delayMs: 0,
        }),
        tabId,
      })
    ).ok,
    true,
  );
  assert.equal(await page.locator("#editable").textContent(), "a note");

  await page.close();
});

test("a step that cannot succeed fails loudly", async () => {
  const { page, tabId } = await onSite();
  const missing = await env.send("step:execute", {
    step: step("CLICK", { selector: "#does-not-exist" }),
    tabId,
  });
  assert.equal(missing.ok, false);

  const wrongTarget = await env.send("step:execute", {
    step: step("FILL", { selector: "#title", text: "x", delayMs: 0 }),
    tabId,
  });
  assert.equal(wrongTarget.ok, false, "an h1 is not fillable");
  assert.match(
    wrongTarget.error,
    /not an input, textarea, select or contenteditable/,
  );

  const noOption = await env.send("step:execute", {
    step: step("SELECT", { selector: "#size", value: "Enormous" }),
    tabId,
  });
  assert.equal(noOption.ok, false);
  assert.match(noOption.error, /no option matching/);
  assert.equal(
    await page.locator("#size").inputValue(),
    "s",
    "left at its default rather than cleared",
  );

  await page.close();
});

test("IF_ELSE reads text as rendered, not as indented", async () => {
  const { page, tabId } = await onSite();
  const res = await env.send("step:execute", {
    step: step("IF_ELSE", {
      condition: "text-equals",
      selector: ".stock",
      value: "In stock",
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.conditionMet, true);
  await page.close();
});

// ── a whole pipeline ─────────────────────────────────────────────────────────

test("a pipeline runs end to end and its rows reach IndexedDB", async () => {
  const { page, tabId } = await onSite();

  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: {
      name: "e2e",
      steps: [
        step("EXTRACT", {
          fields: [
            { name: "name", selector: ".product-link" },
            { name: "price", selector: ".price" },
          ],
        }),
      ],
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const runId = started.result.runId;
  assert.ok(runId, "a run id came back");

  // Wait for the run to finish, then read what it stored.
  let rows = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const dl = await env.send("data:download", { runId });
    if (dl.ok && dl.result.rows?.length) {
      rows = dl.result.rows;
      break;
    }
  }

  assert.equal(rows.length, 3, "three products were stored");
  assert.deepEqual(rows.map((r) => r.name).sort(), [
    "Doohickey",
    "Gadget",
    "Widget",
  ]);
  await page.close();
});

test("the ethics gates run and report", async () => {
  const { page, tabId } = await onSite();
  const res = await env.send("pipeline:preflight", {
    tabId,
    targetOrigin: site.origin,
    pipeline: { name: "p", steps: [step("CLICK", { selector: "#go" })] },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.result.warnings));
  assert.equal(typeof res.result.blocked, "boolean");
  await page.close();
});

// ── PDF, against a real PDF ──────────────────────────────────────────────────

test("PDF_EXTRACTION reads a PDF over HTTP", async () => {
  // Chrome's own print-to-PDF gives a real, Flate-compressed PDF to read.
  const page = await env.ctx.newPage();
  await page.setContent(
    "<h1>Quarterly Report</h1><p>Revenue was 42 million.</p>",
  );
  const pdf = await page.pdf({ format: "A4" });
  await page.close();

  const { extractPdfText } = await import("../utils/pdf-text.js");
  const out = await extractPdfText(new Uint8Array(pdf));

  assert.ok(
    out.pageCount >= 1,
    `no content streams found: ${JSON.stringify(out.warnings)}`,
  );
  assert.match(out.text, /Quarterly Report/);
  assert.match(out.text, /42 million/);
});

// ── the steps that only a real browser can prove ─────────────────────────────

test("WAIT for an element waits for it to become visible, not merely to exist", async () => {
  // The element is in the DOM from the first paint and display:none for 700ms.
  // A wait that only checks existence returns at once, and whatever runs next
  // reads an empty panel — which is the failure this mode is meant to prevent.
  const { page, tabId } = await onSite("/lazy");
  const t0 = Date.now();
  const res = await env.send("step:execute", {
    step: step("WAIT", {
      mode: "selector-visible",
      selector: ".results",
      timeout: 5000,
    }),
    tabId,
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(elapsed > 500, `returned after ${elapsed}ms — it did not wait`);
  assert.ok(elapsed < 4000, `took ${elapsed}ms — it waited too long`);
  await page.close();
});

test("a WAIT that never comes true fails the step", async () => {
  const { page, tabId } = await onSite("/lazy");
  const res = await env.send("step:execute", {
    step: step("WAIT", {
      mode: "selector-visible",
      selector: ".never",
      timeout: 800,
    }),
    tabId,
  });
  assert.equal(res.ok, false, "a wait that timed out is not a success");
  await page.close();
});

test("infinite scroll loads a lazy feed to the end", async () => {
  const { page, tabId } = await onSite("/lazy");
  const before = await page.locator(".post").count();
  assert.equal(before, 10, "the page starts with one screenful");

  const res = await env.send("step:execute", {
    step: step("SCROLL", {
      mode: "infinite",
      maxScrolls: 15,
      settleMs: 400,
      selector: ".post",
    }),
    tabId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.exhausted, true, "it reached the end of the feed");

  const after = await page.locator(".post").count();
  assert.equal(after, 40, `loaded ${after} posts of 40`);
  await page.close();
});

test("PAGINATE turns the page, and knows when it cannot", async () => {
  const { page, tabId } = await onSite("/page/1");

  const first = await env.send("step:execute", {
    step: step("PAGINATE", { selector: ".next", settleMs: 600 }),
    tabId,
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.result.exhausted, false);
  assert.equal(await page.locator("#title").textContent(), "Page 2");

  await page.goto(site.url("/page/3"));
  const last = await env.send("step:execute", {
    step: step("PAGINATE", { selector: ".next", settleMs: 300 }),
    tabId,
  });
  assert.equal(last.ok, true, JSON.stringify(last));
  assert.equal(
    last.result.exhausted,
    true,
    "the disabled Next button is the last page",
  );
  await page.close();
});

test("a paginating pipeline scrapes each page once and stops", async () => {
  // The whole point of the PAGINATE change: max is 10, there are 3 pages, and
  // the run has to stop at 3 rather than re-scraping page 3 seven more times.
  const { page, tabId } = await onSite("/page/1");

  const started = await env.send("pipeline:start", {
    tabId,
    targetOrigin: site.origin,
    pipeline: {
      name: "paged",
      steps: [
        {
          id: "loop",
          type: "LOOP",
          config: { type: "paginate", selector: ".next", max: 10 },
          children: [
            step("EXTRACT", { fields: [{ name: "page", selector: "#title" }] }),
          ],
        },
      ],
    },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const runId = started.result.runId;

  let rows = [];
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const dl = await env.send("data:download", { runId });
    if (dl.ok && dl.result.rows?.length >= 3) {
      rows = dl.result.rows;
      break;
    }
  }
  // Give a wrong implementation time to over-run before counting.
  await new Promise((r) => setTimeout(r, 1500));
  const dl = await env.send("data:download", { runId });
  rows = dl.result?.rows ?? rows;

  assert.equal(
    rows.length,
    3,
    `scraped ${rows.length} pages; the site has 3 (max was 10)`,
  );
  assert.deepEqual(
    rows.map((r) => r.page),
    ["Page 1", "Page 2", "Page 3"],
    "each page once, in order",
  );
  await page.close();
});

test("NAVIGATE returns as soon as the page is loaded", async () => {
  const { page, tabId } = await onSite("/page/1");
  const t0 = Date.now();
  const res = await env.send("step:execute", {
    step: step("NAVIGATE", { url: site.url("/page/2"), wait: true }),
    tabId,
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(
    elapsed < 2500,
    `a local page took ${elapsed}ms — the fixed 3s sleep is still there`,
  );
  assert.equal(await page.locator("#title").textContent(), "Page 2");
  await page.close();
});

test("a page step works after the run has navigated away", async () => {
  // The bug the paginating check above found. Content scripts are injected on
  // demand and die with their document, and only the start of a run injected
  // them — so every page step after any navigation failed with Chrome's
  // "Receiving end does not exist". Nothing in 500 unit tests could see it:
  // they mock chrome.tabs, and a mocked tab never navigates.
  const { page, tabId } = await onSite("/page/1");

  const nav = await env.send("step:execute", {
    step: step("NAVIGATE", { url: site.url("/page/2"), wait: true }),
    tabId,
  });
  assert.equal(nav.ok, true, JSON.stringify(nav));

  const res = await env.send("step:execute", {
    step: step("EXTRACT", { fields: [{ name: "t", selector: "#title" }] }),
    tabId,
  });
  assert.equal(
    res.ok,
    true,
    `the step could not reach the new page: ${JSON.stringify(res)}`,
  );
  assert.deepEqual(res.result, [{ t: "Page 2" }]);
  await page.close();
});
