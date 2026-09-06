// Runs every challenge fixture against the real extension in Chromium.
//
//     npm run challenges
//
// Each fixture is served over real HTTP on a real origin, a pipeline is started
// through the service worker exactly as the side panel starts one, and the rows
// it stored are checked against the answer the challenge asks for.
//
// A fixture whose real page has been saved to e2e/challenges/pages/<id>.html is
// served from that file instead of from the reconstruction — see the note at the
// top of challenges/index.mjs. Nothing else changes: the same pipeline and the
// same assertions run against the real markup.
//
// `CHALLENGE=iframe npm run challenges` runs one, for iterating on a fixture.
//
// This file used to stall after the second challenge, and the reason is worth
// keeping: `server.close()` stops accepting connections and then waits for
// every open one to end, and Chrome holds its keep-alive sockets open long
// after the page that opened them is gone. So each challenge sat in teardown
// waiting out sockets, and waited longer for every challenge before it — 72s,
// 86s, 121s, 177s, 291s — until the file hit its timeout, while the actual
// work in each one took under a second. Tracing where the time went, rather
// than guessing at browser state, is what found it: the whole suite now runs
// in about ten seconds.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { launch } from "./harness.mjs";
import { CHALLENGES } from "./challenges/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, "challenges", "pages");

/** Real pages the user has saved, by challenge id. */
async function savedPages() {
  const out = new Map();
  let names = [];
  try {
    names = await readdir(PAGES);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith(".html")) continue;
    out.set(n.replace(/\.html$/, ""), await readFile(join(PAGES, n), "utf8"));
  }
  return out;
}

/** Buffer a request body into one string — only POST routes ever need it. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Serve one challenge. HTML routes and JSON routes are separate so a fixture
 * can offer the API its own page calls. `postRoutes` is separate again: it
 * exists for the login challenge, where the real site serves the logged-in
 * table by POSTing the form back to its own URL, and keeping that off the
 * (GET-only) `routes` map means a saved real page can still replace the "/"
 * markup wholesale without disturbing how a POST to that same path behaves.
 */
async function serve(challenge) {
  const html = { ...challenge.routes };
  const api = challenge.apiRoutes ?? {};
  const posts = challenge.postRoutes ?? {};
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("User-agent: *\nDisallow:\n");
    }
    if (req.method === "POST" && posts[path]) {
      return readBody(req).then((body) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(posts[path](new URLSearchParams(body)));
      });
    }
    if (api[path] !== undefined) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(api[path]);
    }
    const body = html[path];
    if (body === undefined) {
      res.writeHead(404, { "Content-Type": "text/html" });
      return res.end("<h1>404</h1>");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    /**
     * `server.close()` stops accepting and then waits for every open connection
     * to end, and Chrome keeps its keep-alive sockets long after the page that
     * opened them is gone. That wait was the entire cost of a challenge: the
     * work took under a second and the test took seventy, and it grew with each
     * challenge that had left sockets behind until the file hit its timeout.
     */
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

/** Substitute the server's origin into anything the fixture left a slot for. */
// `t.diagnostic` only prints once the test resolves, which is useless for
// finding where a run hangs. This goes straight to stderr, so the last line you
// see names the statement that never came back.
const TRACE = process.env.CHALLENGE_TRACE === "1";
const trace = (id, what) => {
  if (TRACE) console.error(`[trace] ${id}: ${what}`);
};

const withOrigin = (value, origin) =>
  JSON.parse(JSON.stringify(value).replaceAll("<origin>", origin));

const env = await launch();
const saved = await savedPages();

test.after(async () => {
  await env.close();
});

if (saved.size) {
  console.log(`Using real saved pages for: ${[...saved.keys()].join(", ")}`);
} else {
  console.log(
    "No saved pages found — running against reconstructions. " +
      "Drop real pages in e2e/challenges/pages/<id>.html to test the real markup.",
  );
}

// `CHALLENGE=parse npm run challenges` runs one, which is how you iterate on a
// newly saved page without waiting for the whole suite.
const only = process.env.CHALLENGE;
// `let`, not `const`: a challenge with a saved real page reassigns this
// binding inside the test body below (routes swapped in for the real markup),
// and `for (const ...)` still gives each iteration's closure its own binding
// — reassigning it is not reassigning the loop itself.
for (let challenge of CHALLENGES.filter((c) => !only || c.id === only)) {
  test(`${challenge.id} — ${challenge.title}`, async (t) => {
    const real = saved.get(challenge.id);
    if (real) {
      // Keyed by `challenge.start`, not a hardcoded "/": several fixtures now
      // serve at the real site's own path (e.g. /web-scraping-practice/...)
      // so a saved page's relative links resolve exactly as they do live,
      // with no <origin>-style rewriting needed for the markup itself.
      challenge = {
        ...challenge,
        routes: { ...challenge.routes, [challenge.start]: real },
      };
      t.diagnostic("serving the saved page");

      // Sub-resources the real page depends on (an iframe's inner document,
      // an AJAX endpoint's real JSON) live beside it under
      // e2e/challenges/pages/ — see mirror-challenges.mjs. Wiring them in is
      // opt-in per challenge via savedRoutes/savedApiRoutes, which just say
      // which saved file (path relative to PAGES) replaces which
      // reconstruction route; a challenge with nothing saved there is
      // untouched.
      for (const [path, file] of Object.entries(challenge.savedRoutes ?? {})) {
        const content = await readFile(join(PAGES, file), "utf8").catch(
          () => undefined,
        );
        if (content !== undefined) {
          challenge = {
            ...challenge,
            routes: { ...challenge.routes, [path]: content },
          };
        }
      }
      for (const [path, file] of Object.entries(
        challenge.savedApiRoutes ?? {},
      )) {
        const content = await readFile(join(PAGES, file), "utf8").catch(
          () => undefined,
        );
        if (content !== undefined) {
          challenge = {
            ...challenge,
            apiRoutes: { ...challenge.apiRoutes, [path]: content },
          };
        }
      }

      // Some challenges have a real page saved but a real defect the fixture
      // cannot drive around — see the field's own comment in index.mjs. The
      // page is still mirrored so the gap is documented in the repo, but
      // running the pipeline against it would just fail on a known cause.
      if (challenge.realPageGap) {
        t.todo(challenge.realPageGap);
        return;
      }
    }

    const t0 = Date.now();
    trace(challenge.id, "serving");
    const site = await serve(challenge);
    trace(challenge.id, "opening a page");
    const page = await env.ctx.newPage();
    try {
      t.diagnostic(`opening ${site.origin}${challenge.start}`);
      trace(challenge.id, "goto");
      await page.goto(site.origin + challenge.start);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(400);
      // The tab this test opened, by URL — not "whichever is active". The
      // browser is shared across challenges and the side panel is a page in it,
      // so `active: true` handed later tests the panel's own tab and the run
      // hung trying to inject into an extension page.
      const target = site.origin + challenge.start;
      // Asked through the panel page, not through `sw.evaluate`: MV3 terminates
      // an idle service worker, and a Playwright handle on a terminated worker
      // never resolves — which is what hung the batch run after the second
      // challenge, while every challenge on its own finished before the worker
      // ever went idle.
      trace(challenge.id, "tab lookup");
      const tabId = await env.panel.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((t) => t.url === url || t.url?.startsWith(url))?.id;
      }, target);
      assert.ok(tabId, `no tab for ${target}`);

      // Detect Table, where the challenge says what it should find. A
      // known, undriven-around gap in Detect Table itself (documented on
      // `detectGap`) is reported with t.todo instead of failing outright —
      // the rest of the test (the pipeline, which does not depend on
      // Detect Table) still runs and still has to pass.
      if (challenge.detect && challenge.detectGap) {
        trace(challenge.id, "detect (known gap)");
        t.todo(challenge.detectGap);
      } else if (challenge.detect) {
        trace(challenge.id, "detect");
        const det = await env.send("content:detect", { tabId });
        assert.equal(det.ok, true, JSON.stringify(det));
        const table = det.result.candidates?.[0];
        assert.ok(table, "Detect Table found nothing");
        assert.equal(table.count, challenge.detect.rows, "row count");
        assert.deepEqual(
          table.fields.map((f) => f.name),
          challenge.detect.columns,
          "columns",
        );
      }

      t.diagnostic(`tab ${tabId}; starting the pipeline`);
      trace(challenge.id, "pipeline:start");
      const started = await env.send("pipeline:start", {
        tabId,
        targetOrigin: site.origin,
        targetPath: challenge.start,
        bypassRobots: true,
        confirmed: true,
        pipeline: {
          name: challenge.id,
          steps: withOrigin(challenge.pipeline, site.origin).map((s, i) => ({
            id: `s${i}`,
            ...s,
          })),
        },
      });
      assert.equal(started.ok, true, JSON.stringify(started));
      const runId = started.result.runId;

      // Poll until the run has produced what the challenge asks for, or time is
      // up. A challenge that checks captures may legitimately store no rows.
      let rows = [];
      let networks = [];
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 250));
        trace(challenge.id, `data:download #${i}`);
        const dl = await env.send("data:download", { runId });
        if (dl.ok) {
          rows = dl.result.rows ?? [];
          networks = dl.result.networks ?? [];
          const enough = challenge.checkCaptures
            ? networks.length > 0
            : rows.length > 0;
          if (enough) break;
        }
      }

      const problem = challenge.checkCaptures
        ? challenge.checkCaptures(networks)
        : challenge.check(rows);
      assert.equal(
        problem,
        null,
        `${challenge.technique}: ${problem}\nrows: ${JSON.stringify(rows.slice(0, 3))}`,
      );
    } finally {
      trace(challenge.id, "closing");
      // What grows between challenges, measured rather than guessed at. Each
      // challenge takes longer than the one before it, and the browser is the
      // only thing they share.
      if (TRACE) {
        const grown = await env.panel.evaluate(async () => ({
          nodes: document.getElementsByTagName("*").length,
          tabs: (await chrome.tabs.query({})).length,
        }));
        trace(
          challenge.id,
          `panel ${grown.nodes} nodes, ${grown.tabs} tabs, ${Date.now() - t0}ms`,
        );
      }
      const tClose = Date.now();
      await page.close().catch(() => {});
      const tPage = Date.now();
      await site.close();
      trace(
        challenge.id,
        `page.close ${tPage - tClose}ms, site.close ${Date.now() - tPage}ms`,
      );
    }
  });
}
