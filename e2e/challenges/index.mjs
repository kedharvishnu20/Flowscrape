// The tryscrapeme.com challenges, as local fixtures.
//
// This sandbox has no outbound network at all — every external host is refused
// by the egress proxy, so the real challenge pages cannot be opened here. What
// it can do is serve the same *shapes* over real HTTP, on a real origin, and
// drive the real extension against them in Chromium.
//
// The reconstructions below are exactly that: reconstructions. They are honest
// about the technique each challenge tests and they are not the real markup, so
// a pass here means "the tool handles this shape", not "the tool passes that
// challenge".
//
// To close that gap, drop the real page in:
//
//     e2e/challenges/pages/<id>.html
//
// Save it from the browser (Ctrl+S, "Webpage, HTML Only") or copy the DOM from
// DevTools. Any file that exists there is served instead of the reconstruction,
// and the same assertions run against the real thing. That is the only step
// this environment cannot do on its own.

const BOOKS = [
  ["Gut", "Giulia Enders", 4, "$10.49"],
  ["The Brain That Changes Itself", "Norman Doidge", 4, "$11.03"],
  ["Medical Medium Liver Rescue", "Anthony William", 4, "$23.76"],
  ["Wreck This Journal", "Keri Smith", 4, "$9.59"],
  ["12 Rules for Life", "Jordan B. Peterson", 4, "$20.99"],
  ["12 Rules for Life", "Jordan B. Peterson", 4, "$10.26"],
  ["Gut and Psychology Syndrome", "Dr Natasha Campbell-McBride", 4, "$19.48"],
  ["Medical Medium Thyroid Healing", "Anthony William", 4, "$17.26"],
  ["Steal Like an Artist", "Austin Kleon", 4, "$8.81"],
  ["Sitting Still Like A Frog", "Eline Snel", 4, "$10.4"],
];

const shell = (title, body) =>
  `<!doctype html><html><head><title>${title}</title></head><body>
  <nav><a href="/">Home</a><a href="/challenges">Challenges</a><a href="/docs">Docs</a></nav>
  ${body}
  <footer>&copy; TryScrapeMe <a href="/about">About</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></footer>
  </body></html>`;

const PRICE_TOTAL = BOOKS.reduce((n, b) => n + Number(b[3].slice(1)), 0);

/**
 * Each challenge names the technique it tests, the routes it needs, the
 * pipeline a user would build, and what the answer has to look like.
 */
export const CHALLENGES = [
  {
    id: "parse",
    title: "Parsing HTML structures",
    technique: "CSS selectors / XPath over a plain table",
    routes: {
      "/": shell(
        "Parse",
        `<table class="table"><thead><tr><th>name</th><th>author</th><th>stars</th><th>price</th></tr></thead>
         <tbody>${BOOKS.map(
           ([n, a, s, p]) =>
             `<tr><td>${n}</td><td>${a}</td><td>${s}</td><td>${p}</td></tr>`,
         ).join("")}</tbody></table>`,
      ),
    },
    start: "/",
    // Detect Table should find all four columns, including `stars`, which reads
    // 4 in every row (K-10).
    detect: {
      rows: 10,
      columns: ["name", "author", "stars", "price"],
    },
    pipeline: [
      {
        type: "EXTRACT",
        config: {
          fields: [
            { name: "name", selector: "td:nth-of-type(1)" },
            {
              name: "price",
              selector: "td:nth-of-type(4)",
              transform: ["number"],
            },
          ],
        },
      },
    ],
    check(rows) {
      if (rows.length !== 10) return `wanted 10 rows, got ${rows.length}`;
      const total = rows.reduce((n, r) => n + Number(r.price ?? 0), 0);
      if (Math.abs(total - PRICE_TOTAL) > 0.005) {
        return `price total ${total.toFixed(2)}, wanted ${PRICE_TOTAL.toFixed(2)}`;
      }
      return null;
    },
  },

  {
    id: "pagination",
    title: "Pagination",
    technique: "follow next-page links until they run out",
    routes: (() => {
      const PAGES = 5;
      const r = {};
      for (let p = 1; p <= PAGES; p++) {
        const items = Array.from({ length: 4 }, (_, i) => {
          const n = (p - 1) * 4 + i + 1;
          return `<tr><td class="t">Item ${n}</td></tr>`;
        }).join("");
        const next =
          p < PAGES
            ? `<a class="next" href="/page/${p + 1}">Next</a>`
            : `<span class="next disabled">Next</span>`;
        r[p === 1 ? "/" : `/page/${p}`] = shell(
          `Page ${p}`,
          `<table><tbody>${items}</tbody></table>${next}`,
        );
      }
      return r;
    })(),
    start: "/",
    pipeline: [
      {
        type: "LOOP",
        config: {
          type: "paginate",
          selector: "a.next",
          max: 20,
          settleMs: 200,
        },
        children: [
          {
            type: "EXTRACT",
            config: { fields: [{ name: "t", selector: ".t" }] },
          },
        ],
      },
    ],
    check(rows) {
      if (rows.length !== 20)
        return `wanted 20 rows across 5 pages, got ${rows.length}`;
      if (rows[0].t !== "Item 1" || rows[19].t !== "Item 20") {
        return `first/last wrong: ${rows[0].t} .. ${rows[19].t}`;
      }
      return null;
    },
  },

  {
    id: "iframe",
    title: "Iframes",
    technique: "content embedded in a nested document",
    routes: {
      "/": shell(
        "Iframe",
        `<h1>Quotes</h1><iframe id="data" src="/inner" width="600" height="200"></iframe>`,
      ),
      "/inner": `<!doctype html><html><body>${[
        ["Quote one", "Author A"],
        ["Quote two", "Author B"],
        ["Quote three", "Author C"],
      ]
        .map(
          ([q, a]) =>
            `<div class="quote"><span class="text">${q}</span><small class="author">${a}</small></div>`,
        )
        .join("")}</body></html>`,
    },
    start: "/",
    pipeline: [
      {
        type: "EXTRACT",
        config: {
          // frameUrl is what the picker records when you click inside a frame
          // (K-03); `<origin>` is substituted with the test server's origin.
          frameUrl: "<origin>/inner",
          inFrame: true,
          fields: [
            { name: "text", selector: ".text" },
            { name: "author", selector: ".author" },
          ],
        },
      },
    ],
    check(rows) {
      if (rows.length !== 3) return `wanted 3 quotes, got ${rows.length}`;
      if (rows[0].text !== "Quote one")
        return `first quote wrong: ${rows[0].text}`;
      return null;
    },
  },

  {
    id: "obfuscated-classes",
    title: "Class names that change every request",
    technique: "XPath, because every CSS selector is dead on arrival",
    routes: {
      get "/"() {
        const r = () => Math.random().toString(36).slice(2, 8);
        return shell(
          "Obfuscated",
          `<table><tbody>
            ${BOOKS.slice(0, 4)
              .map(
                ([n, , , p]) =>
                  `<tr><td class="${r()}">${n}</td><td class="${r()}">${p}</td></tr>`,
              )
              .join("")}
            <tr><td class="${r()}">Total</td><td class="${r()}">$55.87</td></tr>
          </tbody></table>`,
        );
      },
    },
    start: "/",
    pipeline: [
      {
        type: "EXTRACT",
        config: {
          fields: [
            { name: "total", selector: '//tr[td[contains(., "Total")]]/td[2]' },
          ],
        },
      },
    ],
    check(rows) {
      if (rows[0]?.total !== "$55.87") return `got ${JSON.stringify(rows[0])}`;
      return null;
    },
  },

  {
    id: "base64",
    title: "Base64-encoded content",
    technique: "decode what the page is hiding",
    routes: {
      "/": shell(
        "Base64",
        `<div id="payload" data-secret="${Buffer.from("The hidden answer").toString("base64")}"></div>`,
      ),
    },
    start: "/",
    pipeline: [
      {
        type: "EXTRACT",
        config: {
          fields: [
            {
              name: "secret",
              selector: "#payload",
              type: "attribute",
              attribute: "data-secret",
              transform: ["base64"],
            },
          ],
        },
      },
    ],
    check(rows) {
      if (rows[0]?.secret !== "The hidden answer")
        return `got ${JSON.stringify(rows[0])}`;
      return null;
    },
  },

  {
    id: "ajax",
    title: "Data loaded by AJAX",
    technique: "the sniffer sees the call the page makes",
    routes: {
      "/": shell(
        "AJAX",
        `<div id="out">loading…</div>
         <script>fetch('/api/items').then(r=>r.json()).then(d=>{
           document.getElementById('out').textContent = d.length + ' items';
         });</script>`,
      ),
    },
    apiRoutes: {
      "/api/items": JSON.stringify(
        BOOKS.slice(0, 3).map(([name, author]) => ({ name, author })),
      ),
    },
    start: "/",
    // The sniffer hooks fetch when the run starts and says so: traffic from
    // before that point is not captured. So the run has to load the page
    // itself, which is also how a user builds it.
    pipeline: [
      { type: "API_SNIFFER", config: {} },
      {
        type: "NAVIGATE",
        config: { url: "<origin>/", wait: true, timeoutMs: 10000 },
      },
      { type: "WAIT", config: { mode: "fixed", ms: 1500 } },
    ],
    checkCaptures(networks) {
      const hit = networks.find((n) => String(n.url).includes("/api/items"));
      if (!hit) return `no capture for /api/items (saw ${networks.length})`;
      if (!String(hit.responseBody).includes("Giulia Enders")) {
        return "the capture has no response body";
      }
      return null;
    },
  },

  {
    id: "login",
    title: "Login form",
    technique: "fill, submit, then scrape what comes back",
    routes: {
      "/": shell(
        "Login",
        `<form id="f" method="get" action="/secret">
           <input name="user" id="user"><input name="pass" id="pass" type="password">
           <button id="go" type="submit">Sign in</button>
         </form>`,
      ),
      "/secret": shell(
        "Secret",
        `<ul>${BOOKS.slice(0, 3)
          .map(([n]) => `<li class="s">${n}</li>`)
          .join("")}</ul>`,
      ),
    },
    start: "/",
    pipeline: [
      {
        type: "FILL",
        config: {
          mode: "multi",
          fields: [
            { selector: "#user", value: "demo" },
            { selector: "#pass", value: "hunter2" },
          ],
        },
      },
      { type: "CLICK", config: { selector: "#go" } },
      { type: "WAIT", config: { mode: "fixed", ms: 600 } },
      { type: "EXTRACT", config: { fields: [{ name: "s", selector: ".s" }] } },
    ],
    check(rows) {
      if (rows.length !== 3)
        return `wanted 3 rows behind the form, got ${rows.length}`;
      return null;
    },
  },

  {
    id: "shadow-dom",
    title: "Web components",
    technique: "a boundary CSS cannot cross",
    routes: {
      "/": shell(
        "Components",
        `<div id="grid"></div>
         <script>
           class ShopCard extends HTMLElement {
             connectedCallback() {
               this.attachShadow({ mode: 'open' }).innerHTML =
                 '<h3 class="title">' + this.dataset.t + '</h3>' +
                 '<span class="price">' + this.dataset.p + '</span>';
             }
           }
           customElements.define('shop-card', ShopCard);
           document.getElementById('grid').innerHTML = ${JSON.stringify(
             BOOKS.slice(0, 4).map(([n, , , p]) => [n, p]),
           )}.map(function (b) {
             return '<shop-card data-t="' + b[0] + '" data-p="' + b[1] + '"></shop-card>';
           }).join('');
         </script>`,
      ),
    },
    start: "/",
    pipeline: [
      {
        type: "EXTRACT",
        config: {
          fields: [
            { name: "title", selector: "shop-card >>> .title" },
            { name: "price", selector: "shop-card >>> .price" },
          ],
        },
      },
    ],
    check(rows) {
      if (rows.length !== 4) return `wanted 4 cards, got ${rows.length}`;
      if (rows[0].title !== "Gut") return `first title wrong: ${rows[0].title}`;
      return null;
    },
  },
];
