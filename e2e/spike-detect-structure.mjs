// SPIKE — deliberately not wired into the extension.
//
// "Can we turn the whole page into JSON and scrape from that?" This answers it
// with real output rather than an opinion. Run:
//
//     node e2e/spike-detect-structure.mjs
//
// It serves a page shaped like a real listing site — nested markup, a sponsored
// row with a different shape, a second unrelated list to compete with the
// first, nav and footer noise — then detects the repeating structures in it.
//
// What it gets right today: finds all six products including the odd one out,
// finds the reviews as a separate list, ignores the chrome, names the columns
// from the markup, and merges a price split across two spans.
//
// What it still gets wrong: emits redundant nested columns (`price` alongside
// `cur` and `amt`; `specs` three times). That is one filtering pass away, and
// is the main thing to fix before this becomes a feature.
import { chromium } from "playwright";
import http from "node:http";

// A page shaped like a real listing site: nested markup, inconsistent fields,
// noise around the edges, a second unrelated list to compete with the first.
const PAGE = `<!doctype html><html><head><title>Acme Store — Laptops</title></head>
<body>
<header><nav><a href="/">Home</a><a href="/deals">Deals</a><a href="/help">Help</a></nav></header>
<aside class="filters">
  <ul><li class="f"><label>Brand</label></li><li class="f"><label>Price</label></li>
      <li class="f"><label>Screen</label></li></ul>
</aside>
<main>
  <h1>Laptops</h1>
  <div class="results" data-count="6">
    <article class="s-item">
      <a class="s-link" href="/p/aurora-14"><img class="s-img" src="/i/1.jpg" alt="Aurora 14"></a>
      <h2 class="s-title"><a href="/p/aurora-14">Aurora 14 Ultrabook</a></h2>
      <div class="s-price"><span class="cur">$</span><span class="amt">1,299.00</span></div>
      <div class="s-rating" data-stars="4.5">4.5 out of 5</div>
      <span class="s-stock in">In stock</span>
      <ul class="s-specs"><li>16 GB RAM</li><li>512 GB SSD</li></ul>
    </article>
    <article class="s-item">
      <a class="s-link" href="/p/nimbus-15"><img class="s-img" src="/i/2.jpg" alt="Nimbus 15"></a>
      <h2 class="s-title"><a href="/p/nimbus-15">Nimbus 15 Pro</a></h2>
      <div class="s-price"><span class="cur">$</span><span class="amt">1,749.50</span></div>
      <div class="s-rating" data-stars="4.8">4.8 out of 5</div>
      <span class="s-stock in">In stock</span>
      <ul class="s-specs"><li>32 GB RAM</li><li>1 TB SSD</li></ul>
    </article>
    <article class="s-item sponsored">
      <a class="s-link" href="/p/vertex-13"><img class="s-img" src="/i/3.jpg" alt="Vertex 13"></a>
      <h2 class="s-title"><a href="/p/vertex-13">Vertex 13 Air</a></h2>
      <div class="s-price"><span class="cur">$</span><span class="amt">899.00</span></div>
      <span class="s-stock out">Out of stock</span>
      <ul class="s-specs"><li>8 GB RAM</li></ul>
    </article>
    <article class="s-item">
      <a class="s-link" href="/p/quasar-16"><img class="s-img" src="/i/4.jpg" alt="Quasar 16"></a>
      <h2 class="s-title"><a href="/p/quasar-16">Quasar 16 Studio</a></h2>
      <div class="s-price"><span class="cur">$</span><span class="amt">2,399.00</span></div>
      <div class="s-rating" data-stars="4.2">4.2 out of 5</div>
      <span class="s-stock in">In stock</span>
      <ul class="s-specs"><li>64 GB RAM</li><li>2 TB SSD</li></ul>
    </article>
    <article class="s-item">
      <a class="s-link" href="/p/pulsar-14"><img class="s-img" src="/i/5.jpg" alt="Pulsar 14"></a>
      <h2 class="s-title"><a href="/p/pulsar-14">Pulsar 14 Lite</a></h2>
      <div class="s-price"><span class="cur">$</span><span class="amt">649.99</span></div>
      <div class="s-rating" data-stars="3.9">3.9 out of 5</div>
      <span class="s-stock in">In stock</span>
      <ul class="s-specs"><li>8 GB RAM</li><li>256 GB SSD</li></ul>
    </article>
    <article class="s-item">
      <a class="s-link" href="/p/comet-17"><img class="s-img" src="/i/6.jpg" alt="Comet 17"></a>
      <h2 class="s-title"><a href="/p/comet-17">Comet 17 Workstation</a></h2>
      <div class="s-price"><span class="cur">$</span><span class="amt">3,150.00</span></div>
      <div class="s-rating" data-stars="4.7">4.7 out of 5</div>
      <span class="s-stock in">In stock</span>
      <ul class="s-specs"><li>64 GB RAM</li><li>4 TB SSD</li></ul>
    </article>
  </div>
  <div class="reviews">
    <div class="rv"><b class="rv-who">Ada</b><p class="rv-txt">Fast and quiet.</p></div>
    <div class="rv"><b class="rv-who">Grace</b><p class="rv-txt">Battery is excellent.</p></div>
    <div class="rv"><b class="rv-who">Alan</b><p class="rv-txt">Screen could be brighter.</p></div>
    <div class="rv"><b class="rv-who">Katherine</b><p class="rv-txt">Great value.</p></div>
  </div>
</main>
<footer><p>&copy; Acme</p></footer>
</body></html>`;

// ── the detector, as it would run in the page ────────────────────────────────
const DETECT = () => {
  const MIN_RECORDS = 3;
  const MAX_CANDIDATES = 5;
  const NOISE = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "BR"]);

  /**
   * A shape fingerprint: what this element *is*, not what it says.
   *
   * Classes are deliberately excluded. Real listings mark some rows
   * "sponsored", "featured", "sold-out" — a class fingerprint splits those into
   * their own group and the user silently loses rows.
   */
  const sig = (el, depth = 2) => {
    if (depth === 0) return el.tagName;
    const kids = [...el.children]
      .filter((c) => !NOISE.has(c.tagName))
      .map((c) => sig(c, depth - 1))
      .join(",");
    return `${el.tagName}(${kids})`;
  };

  /** Shortest selector that identifies `el` relative to `root`. */
  const relSelector = (el, root) => {
    const parts = [];
    let node = el;
    while (node && node !== root) {
      const cls = [...node.classList].filter((c) => !/\d/.test(c));
      if (cls.length) {
        const short = `.${cls[0]}`;
        if (
          root.querySelector(short) === el ||
          root.querySelectorAll(short).length
        ) {
          return parts.length ? `${short} ${parts.join(" > ")}` : short;
        }
        parts.unshift(`${node.tagName.toLowerCase()}${short}`);
      } else {
        const i = [...node.parentElement.children].indexOf(node) + 1;
        parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${i})`);
      }
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  /** A column name, guessed from the markup rather than asked for. */
  const nameFor = (selector, kind) => {
    const raw = selector.replace(/^\./, "").split(/[ >]/)[0];
    const cleaned = raw
      .replace(/^(s|p|c|js|is)[-_]/, "")
      .replace(/[-_]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim();
    const base = cleaned || raw || "field";
    if (kind === "href") return base === "link" ? "link" : `${base} link`;
    if (kind === "src") return `${base} image`;
    return base;
  };

  // 1. Group siblings that share a shape.
  //
  // Not by exact fingerprint. A real listing gives the sponsored row an extra
  // badge and the sold-out row no rating, so exact matching splits one list
  // into three and the user silently scrapes a subset. Group by tag, then keep
  // siblings whose child-tag makeup overlaps the majority shape.
  const childBag = (el) =>
    [...el.children].filter((c) => !NOISE.has(c.tagName)).map((c) => c.tagName);

  const overlap = (a, b) => {
    const counts = new Map();
    for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
    let shared = 0;
    for (const t of b) {
      if ((counts.get(t) ?? 0) > 0) {
        counts.set(t, counts.get(t) - 1);
        shared++;
      }
    }
    return shared / Math.max(a.length, b.length, 1);
  };

  const groups = [];
  for (const parent of document.querySelectorAll("*")) {
    const kids = [...parent.children].filter((c) => !NOISE.has(c.tagName));
    if (kids.length < MIN_RECORDS) continue;

    const byTag = new Map();
    for (const kid of kids) {
      if (!byTag.has(kid.tagName)) byTag.set(kid.tagName, []);
      byTag.get(kid.tagName).push(kid);
    }

    for (const sameTag of byTag.values()) {
      if (sameTag.length < MIN_RECORDS) continue;
      // The most common child-shape is the reference; anything close enough
      // belongs to the same list.
      const bags = sameTag.map(childBag);
      let best = null;
      let bestCount = 0;
      for (const bag of bags) {
        const n = bags.filter((b) => overlap(bag, b) >= 0.6).length;
        if (n > bestCount) {
          bestCount = n;
          best = bag;
        }
      }
      if (!best) continue;
      const members = sameTag.filter((_, i) => overlap(bags[i], best) >= 0.6);
      if (members.length >= MIN_RECORDS) groups.push(members);
    }
  }

  // 2. For each group, work out its columns.
  const candidates = [];
  for (const members of groups) {
    const first = members[0];
    const fieldMap = new Map();

    for (const record of members) {
      const seenHere = new Set();
      for (const el of record.querySelectorAll("*")) {
        if (NOISE.has(el.tagName)) continue;

        // Prefer the parent when its children are only pieces of one value —
        // otherwise a price split across <span>$</span><span>10</span> comes
        // out as two useless columns instead of one.
        const full = el.textContent.trim().replace(/\s+/g, " ");
        const parentFull = el.parentElement?.textContent
          .trim()
          .replace(/\s+/g, " ");
        const isOnlyPieceOfParent =
          el.parentElement &&
          el.parentElement !== record &&
          parentFull === full &&
          el.parentElement.children.length === 1;
        if (isOnlyPieceOfParent) continue;

        const ownText = [...el.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim())
          .join(" ")
          .trim();
        const href = el.getAttribute?.("href");
        const src = el.getAttribute?.("src");

        // An element whose children carry all the text is a wrapper, unless the
        // whole of it reads as one value (a price, a rating).
        const childrenAreLeaves =
          el.children.length > 0 &&
          [...el.children].every((c) => c.children.length === 0);
        const value = ownText || (childrenAreLeaves ? full : "");

        if (!value && !href && !src) continue;

        const key = relSelector(el, record);
        if (!key) continue;

        for (const [kind, sample] of [
          ["text", value],
          ["href", href],
          ["src", src],
        ]) {
          if (!sample) continue;
          const id = `${key}|${kind}`;
          if (!fieldMap.has(id)) {
            fieldMap.set(id, { selector: key, kind, hits: 0, samples: [] });
          }
          const f = fieldMap.get(id);
          // Counted once per record, so coverage is a percentage and not 200%.
          if (!seenHere.has(id)) {
            f.hits++;
            seenHere.add(id);
          }
          if (f.samples.length < 2) f.samples.push(sample);
        }
      }
    }

    // A column has to appear in most records to be a column.
    const fields = [...fieldMap.values()]
      .filter((f) => f.hits >= members.length * 0.6)
      .slice(0, 12);
    if (fields.length < 2) continue;

    candidates.push({
      selector:
        relSelector(first, document.body) || first.tagName.toLowerCase(),
      containerClass: [...first.classList][0] ?? null,
      count: members.length,
      fields: fields.map((f) => ({
        name: nameFor(f.selector, f.kind),
        selector: f.selector,
        kind: f.kind,
        coverage: Math.round((f.hits / members.length) * 100),
        sample: f.samples[0] ?? "",
      })),
      score: members.length * fields.length,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return {
    url: location.href,
    title: document.title,
    candidates: candidates.slice(0, MAX_CANDIDATES),
  };
};

// ── run it ───────────────────────────────────────────────────────────────────
const server = http.createServer((_q, r) => {
  r.writeHead(200, { "Content-Type": "text/html" });
  r.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const b = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${port}/`);
const out = await p.evaluate(DETECT);
console.log(JSON.stringify(out, null, 2));
await b.close();
server.close();
