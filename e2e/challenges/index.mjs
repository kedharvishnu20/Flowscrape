// The tryscrapeme.com challenges, as local fixtures.
//
// Real markup for six of the eight ids is saved under e2e/challenges/pages/
// (and, where a challenge needs one, a sub-resource beside it — an iframe's
// inner document, an AJAX endpoint's JSON) — see scripts/mirror-challenges.mjs
// for how it got there and docs/ISSUE_AUDIT.md K-16 for what testing against
// it found. challenges.mjs serves the saved file instead of the reconstruction
// below whenever one exists, so what runs by default *is* the real markup.
//
// The reconstructions still matter: this sandbox usually has no outbound
// network, so they are what runs here, and they still test the same
// technique on a shape close to the real one. Where the real data was known
// (parse, iframe, login, the randomized-class page) the reconstruction below
// uses the exact real values, so the two modes assert the same thing.
//
// Two ids have no saved page and never will:
//   - "base64": the real challenge decodes base64 *images* and asks for the
//     MD5 hash of whichever one is visually "Night Tiger". Nothing in the
//     pipeline identifies an image by its pixels, and the base64 transform
//     decodes to UTF-8 text by design — it cannot round-trip JPEG bytes.
//     Mirroring the page would only test "can we read a data: URL", which
//     is a different, weaker claim than the real challenge makes.
//   - "shadow-dom": tryscrapeme.com has no web-components/shadow-DOM
//     challenge to mirror. It stays a reconstruction because there is
//     nothing real to test it against.
//
// To refresh the saved pages: npm run mirror-challenges (needs real network).

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

// The iframe challenge's real inner document — captured from
// /web-scraping-practice/beginner/iframe-data, so the reconstruction and the
// saved real page (which overrides it via savedRoutes) agree on the answer.
const IFRAME_BOOKS = [
  ["The Checklist Manifesto", "Atul Gawande", 4, 9.04],
  ["Do No Harm", "Henry Marsh", 4, 8],
  ["The Anatomy Coloring Book", "Wynn Kapit", 4, 24.25],
  ["The Plant Paradox", "Steven R. Gundry", 3.5, 16.53],
  ["Wreck This Journal Everywhere", "Keri Smith", 4, 5.83],
  ["How to Change Your Mind", "Michael Pollan", 4.5, 10.28],
  ["Raising an Emotionally Intelligent Child", "John Gottman", 4, 11.21],
  ["Allen Carr's Easy Way to Stop Smoking", "Allen Carr", 4.5, 9.53],
  ["The Mindful Way through Depression", "J. Mark G. Williams", 4, 17.54],
  ["Call The Midwife", "Jennifer Worth", 4, 7.9],
];

// The randomized-class challenge's real cards — captured from
// /web-scraping-practice/beginner/random. The real page regenerates its class
// names every request; the point of the XPath below is that it does not care.
const RANDOM_BOOKS = [
  ["The How Not To Die Cookbook", "Michael Greger", 24.08],
  ["Pilates Anatomy", "Rael Isacowitz", 17.1],
  ["Quiet the Mind", "Matthew Johnstone", 7.71],
  ["Your Body, Your Yoga", "Bernie Clark", 20.3],
  [
    "Medical Interviews - a Comprehensive Guide to Ct, St and Registrar Interview Skills",
    "Olivier Picard",
    39.28,
  ],
  ["Radical Remission", "Kelly A. Turner", 13.3],
  ["The Immortal Life of Henrietta Lacks", "Rebecca Skloot", 13.82],
  ["The Crystal Bible Volume 2", "Judy Hall", 13.76],
  ["Start Where You Are", "Meera Lee Patel", 10.51],
  ["Birth Skills", "Juju Sundin", 26.59],
];

// The table the real simulate-login challenge POSTs back once the credentials
// match — captured by actually submitting the real form (admin /
// tryscrapeme.com, the values the real inputs come pre-filled with).
const LOGIN_BOOKS = [
  ["You Can Heal Your Life", "Louise Hay", 4, 14.83],
  ["Gratitude", "Oliver Sacks", 4, 7.82],
  [
    "DBT (R) Skills Training Handouts and Worksheets, Second Edition",
    "Marsha M. Linehan",
    4.5,
    30.06,
  ],
  ["Man's Search for Meaning", "Viktor E. Frankl", 4.5, 11.97],
  ["Don't Shoot the Dog!", "Karen Pryor", 4.5, 8.11],
  ["The Mindful Self-Compassion Workbook", "Kristin Neff", 4.5, 19.04],
  ["Self Compassion", "Kristin Neff", 4, 12.79],
  ["Trail Guide to the Body", "R.  Andrew Biel", 4.5, 71.64],
  ["The Man Who Mistook His Wife for a Hat", "Oliver Sacks", 4, 8.37],
  ["Hands Of Light", "Barbara Ann Brennan", 4.5, 20.44],
  ["The Drama of the Gifted Child", "Alice Miller", 4, 10.84],
  ["Taking Charge of Your Fertility", "Toni Weschler", 4.5, 21.9],
  ["When Breath Becomes Air", "Paul Kalanithi", 4.5, 7.54],
  ["It Didn't Start with You", "Mark Wolynn", 3.5, 13.18],
  ["Trauma and Recovery", "Judith Herman", 4.5, 11.84],
  ["Love's Executioner", "Irvin D. Yalom", 4, 9.6],
  ["The Complete Ketogenic Diet for Beginners", "Amy Ramos", 4, 11.08],
  ["The Compassionate Mind", "Paul Gilbert", 4, 13.42],
  ["I Had a Black Dog", "Matthew Johnstone", 4.5, 6.8],
  ["The End of Alzheimer's", "Dale E. Bredesen", 4.5, 15.49],
];

const shell = (title, body) =>
  `<!doctype html><html><head><title>${title}</title></head><body>
  <nav><a href="/">Home</a><a href="/challenges">Challenges</a><a href="/docs">Docs</a></nav>
  ${body}
  <footer>&copy; TryScrapeMe <a href="/about">About</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></footer>
  </body></html>`;

// Same shape as the real iframe-data and simulate-login result tables:
// name / author / stars / price, so the reconstruction's own selectors below
// (td:nth-of-type(4) for price) work unchanged whether they land on this or
// on the real saved markup.
const bookTable = (rows) =>
  `<table><thead><tr><th>name</th><th>author</th><th>stars</th><th>price</th></tr></thead>
   <tbody>${rows.map(([n, a, s, p]) => `<tr><td>${n}</td><td>${a}</td><td>${s}</td><td>${p}</td></tr>`).join("")}</tbody></table>`;

const PRICE_TOTAL = BOOKS.reduce((n, b) => n + Number(b[3].slice(1)), 0);
const IFRAME_TOTAL = IFRAME_BOOKS.reduce((n, b) => n + b[3], 0);
const RANDOM_TOTAL = RANDOM_BOOKS.reduce((n, b) => n + b[2], 0);
const LOGIN_TOTAL = LOGIN_BOOKS.reduce((n, b) => n + b[3], 0);

/**
 * Each challenge names the technique it tests, the routes it needs, the
 * pipeline a user would build, and what the answer has to look like.
 *
 * `start` doubles as the route a saved real page is served at, so for a
 * challenge with one it is the real site's own path — its relative links
 * then resolve exactly as they do live, no rewriting needed at test time.
 */
export const CHALLENGES = [
  {
    id: "parse",
    title: "Parsing HTML structures",
    technique: "CSS selectors / XPath over a plain table",
    routes: {
      "/web-scraping-practice/beginner/parse": shell(
        "Parse",
        `<table class="table"><thead><tr><th>name</th><th>author</th><th>stars</th><th>price</th></tr></thead>
         <tbody>${BOOKS.map(
           ([n, a, s, p]) =>
             `<tr><td>${n}</td><td>${a}</td><td>${s}</td><td>${p}</td></tr>`,
         ).join("")}</tbody></table>`,
      ),
    },
    start: "/web-scraping-practice/beginner/parse",
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
        r[
          p === 1 ? "/web-scraping-practice/beginner/pagination" : `/page/${p}`
        ] = shell(`Page ${p}`, `<table><tbody>${items}</tbody></table>${next}`);
      }
      return r;
    })(),
    start: "/web-scraping-practice/beginner/pagination",
    // The real page (mirrored to pagination.html) has no "next" affordance at
    // all — five numbered ?pageno= links, always the same five, on every
    // page. The LOOP paginate step only knows how to click a repeating "next"
    // element; there is nothing here to click that advances past page 1 (K-16).
    // Real-page mode is marked todo rather than fixed: driving numbered
    // pagination is a real pagination-by-URL mode the step does not have,
    // which is feature work, not a small fix.
    // The real page's five numbered links, saved beside it (see
    // mirror-challenges.mjs). Each page holds different books, so serving page
    // 1 for all five would let a broken pagination mode look like a working
    // one.
    savedRoutes: {
      // Page 1 is the saved main page under the link's own URL, so clicking
      // "1" lands somewhere real rather than on a 404.
      "/pagination?pageno=1": "pagination.html",
      ...Object.fromEntries(
        [2, 3, 4, 5].map((n) => [
          `/pagination?pageno=${n}`,
          `pagination/page-${n}.html`,
        ]),
      ),
    },
    // Against the real markup the run drives the numbered links (K-20); the
    // reconstruction below still exercises the click-Next mode, so both are
    // covered.
    realPagePipeline: [
      {
        type: "LOOP",
        config: {
          type: "paginate-links",
          selector: ".pagination a, nav a[href*='pageno=']",
          max: 0,
          settleMs: 300,
        },
        children: [
          {
            type: "EXTRACT",
            config: { fields: [{ name: "t", selector: "td:nth-of-type(1)" }] },
          },
        ],
      },
    ],
    realPageCheck(rows) {
      // Ten books a page, five pages. Counting distinct titles would be the
      // obvious way to prove no page was scraped twice and would be wrong: the
      // site's own catalogue repeats three titles across its fifty books, so
      // 46 distinct is the correct answer, not evidence of a bug. Each page's
      // opening title is the honest marker instead.
      if (rows.length !== 50) {
        return `wanted 50 books across five pages, got ${rows.length}`;
      }
      const firsts = [
        "This is Going to Hurt",
        "Gut",
        "How Not To Die",
        "The Checklist Manifesto",
        "The Dialectical Behavior Therapy Skills Workbook",
      ];
      const missing = firsts.filter((t) => !rows.some((r) => r.t === t));
      if (missing.length) return `pages never visited: ${missing.join(", ")}`;
      return null;
    },
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
      "/web-scraping-practice/beginner/iframe": shell(
        "Iframe",
        `<iframe src="/web-scraping-practice/beginner/iframe-data" width="600" height="200"></iframe>`,
      ),
      "/web-scraping-practice/beginner/iframe-data": bookTable(IFRAME_BOOKS),
    },
    // Real inner document, saved by mirror-challenges.mjs — see the module
    // comment. Wired in only when the file exists (savedRoutes is a no-op on
    // an id nothing was saved for), overriding the IFRAME_BOOKS reconstruction
    // above with the actual real markup.
    savedRoutes: {
      "/web-scraping-practice/beginner/iframe-data": "iframe/inner.html",
    },
    start: "/web-scraping-practice/beginner/iframe",
    pipeline: [
      {
        type: "EXTRACT",
        config: {
          // frameUrl is what the picker records when you click inside a frame
          // (K-03); `<origin>` is substituted with the test server's origin.
          frameUrl: "<origin>/web-scraping-practice/beginner/iframe-data",
          inFrame: true,
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
      if (rows[0].name !== IFRAME_BOOKS[0][0]) {
        return `first row wrong: ${rows[0].name}`;
      }
      const total = rows.reduce((n, r) => n + Number(r.price ?? 0), 0);
      if (Math.abs(total - IFRAME_TOTAL) > 0.005) {
        return `price total ${total.toFixed(2)}, wanted ${IFRAME_TOTAL.toFixed(2)}`;
      }
      return null;
    },
  },

  {
    id: "obfuscated-classes",
    title: "Class names that change every request",
    technique: "XPath, because every CSS selector is dead on arrival",
    // The real page (mirrored to obfuscated-classes.html) is a grid of
    // <div class="<random>"><h2>title</h2><div>author</div>
    // <div class="<random>">price</div></div> cards, not a table with a
    // Total row — that reconstruction predated ever seeing the real markup
    // and tested the wrong shape (K-16). This one uses the real values and,
    // like the real page, regenerates the class names every request; the
    // XPath below is written to not need them.
    routes: {
      get "/web-scraping-practice/beginner/random"() {
        const r = () => Math.random().toString(36).slice(2, 8);
        return shell(
          "Random",
          RANDOM_BOOKS.map(
            ([n, a, p]) =>
              `<div class="${r()}"><h2>${n}</h2><div>${a}</div><div class="${r()}">${p}</div></div>`,
          ).join(""),
        );
      },
    },
    start: "/web-scraping-practice/beginner/random",
    pipeline: [
      {
        type: "EXTRACT",
        config: {
          // [not(@class)]: the real page has one other <h2> on it, in a help
          // popover, and it *does* carry a class — the popover's own
          // formatting. Matching on that turned up as an 11th "card" whose
          // price came from the following real card, shifting every row by
          // one (K-16). The card h2s carry no class of their own — filtering
          // on that, not the random card wrapper's class, is what survives
          // the class names changing every request.
          fields: [
            { name: "name", selector: "//h2[not(@class)]" },
            {
              name: "price",
              selector: "//h2[not(@class)]/following-sibling::div[2]",
              transform: ["number"],
            },
          ],
        },
      },
    ],
    check(rows) {
      if (rows.length !== 10) return `wanted 10 cards, got ${rows.length}`;
      if (rows[0].name !== RANDOM_BOOKS[0][0]) {
        return `first row wrong: ${rows[0].name}`;
      }
      const total = rows.reduce((n, r) => n + Number(r.price ?? 0), 0);
      if (Math.abs(total - RANDOM_TOTAL) > 0.005) {
        return `price total ${total.toFixed(2)}, wanted ${RANDOM_TOTAL.toFixed(2)}`;
      }
      return null;
    },
  },

  {
    id: "base64",
    title: "Base64-encoded content",
    technique: "decode what the page is hiding",
    // No saved page: the real challenge decodes base64 *images* and asks for
    // the MD5 hash of the one that is visually "Night Tiger" — see the
    // module comment for why that is not something this pipeline can do.
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
      "/web-scraping-practice/beginner/ajax": shell(
        "AJAX",
        `<div id="out">loading…</div>
         <script>fetch('/web-scraping-practice/beginner/ajax/api').then(r=>r.json()).then(d=>{
           document.getElementById('out').textContent = d.length + ' items';
         });</script>`,
      ),
    },
    apiRoutes: {
      "/web-scraping-practice/beginner/ajax/api": JSON.stringify(
        BOOKS.slice(0, 3).map(([name, author]) => ({ name, author })),
      ),
    },
    // Real response JSON, saved by mirror-challenges.mjs — a different shape
    // (id/format/isbn/... alongside name/author) from the reconstruction
    // above, which is exactly the point: the sniffer just has to see it.
    savedApiRoutes: {
      "/web-scraping-practice/beginner/ajax/api": "ajax/api.json",
    },
    start: "/web-scraping-practice/beginner/ajax",
    // The sniffer hooks fetch when the run starts and says so: traffic from
    // before that point is not captured. So the run has to load the page
    // itself, which is also how a user builds it.
    pipeline: [
      { type: "API_SNIFFER", config: {} },
      {
        type: "NAVIGATE",
        config: {
          url: "<origin>/web-scraping-practice/beginner/ajax",
          wait: true,
          timeoutMs: 10000,
        },
      },
      { type: "WAIT", config: { mode: "fixed", ms: 1500 } },
    ],
    checkCaptures(networks) {
      const hit = networks.find((n) => String(n.url).includes("/ajax/api"));
      if (!hit)
        return `no capture for the ajax endpoint (saw ${networks.length})`;
      // One of these is in the response depending on whether the real saved
      // JSON or the BOOKS-based reconstruction served it.
      const markers = ["Giulia Enders", "The Body Keeps the Score"];
      if (!markers.some((m) => String(hit.responseBody).includes(m))) {
        return "the capture has no response body";
      }
      return null;
    },
  },

  {
    id: "login",
    title: "Login form",
    technique: "fill, submit, then scrape what comes back",
    // The real challenge posts the form back to its own URL — no separate
    // "logged in" page — and only reveals the table once the credentials
    // match, so the GET route and the POST handler share one path.
    routes: {
      "/web-scraping-practice/beginner/simulate-login": shell(
        "Login",
        `<form method="post">
           <input type="text" name="username" value="admin">
           <input type="password" name="password" value="tryscrapeme.com">
           <button type="submit">Login</button>
         </form>`,
      ),
    },
    postRoutes: {
      "/web-scraping-practice/beginner/simulate-login": (params) =>
        params.get("username") === "admin" &&
        params.get("password") === "tryscrapeme.com"
          ? shell("Login", bookTable(LOGIN_BOOKS))
          : shell("Login", "<p>Invalid credentials</p>"),
    },
    start: "/web-scraping-practice/beginner/simulate-login",
    pipeline: [
      {
        type: "FILL",
        config: {
          mode: "multi",
          fields: [
            { selector: "input[name=username]", value: "admin" },
            { selector: "input[name=password]", value: "tryscrapeme.com" },
          ],
        },
      },
      { type: "CLICK", config: { selector: "button[type=submit]" } },
      { type: "WAIT", config: { mode: "fixed", ms: 600 } },
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
      if (rows.length !== 20)
        return `wanted 20 rows behind the form, got ${rows.length}`;
      const total = rows.reduce((n, r) => n + Number(r.price ?? 0), 0);
      if (Math.abs(total - LOGIN_TOTAL) > 0.005) {
        return `price total ${total.toFixed(2)}, wanted ${LOGIN_TOTAL.toFixed(2)}`;
      }
      return null;
    },
  },

  {
    id: "shadow-dom",
    title: "Web components",
    technique: "a boundary CSS cannot cross",
    // No saved page: tryscrapeme.com has no web-components challenge to
    // mirror this against — see the module comment.
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
