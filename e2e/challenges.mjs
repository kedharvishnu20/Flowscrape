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
// KNOWN LIMITATION — run one at a time:
//
//     CHALLENGE=iframe npm run challenges
//
// Every challenge passes on its own. Running the whole file in one process
// stalls after the second one, and I have not found why: it is not the tab
// lookup (fixed, and it stalled anyway), not shared browser state (each test
// gets its own profile now, and it stalled anyway), and not the file timeout
// (raised to 900s, and it stalled anyway). node:test's per-test `timeout`
// option is not the tool for narrowing it either — it aborts the test's async
// context, which severs the panel bridge and turns every challenge into a
// timeout, which is a false lead I followed for a while.
//
// The fixtures and the assertions are the valuable part and they are correct;
// the batch runner is not finished. Saying so beats a suite that looks green
// because nobody ran it past the second case.
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

/**
 * Serve one challenge. HTML routes and JSON routes are separate so a fixture
 * can offer the API its own page calls.
 */
async function serve(challenge) {
  const html = { ...challenge.routes };
  const api = challenge.apiRoutes ?? {};
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("User-agent: *\nDisallow:\n");
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
    close: () => new Promise((r) => server.close(r)),
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
for (const challenge of CHALLENGES.filter((c) => !only || c.id === only)) {
  test(`${challenge.id} — ${challenge.title}`, async (t) => {
    const real = saved.get(challenge.id);
    if (real) {
      challenge = {
        ...challenge,
        routes: { ...challenge.routes, "/": real },
      };
      t.diagnostic("serving the saved page");
    }

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

      // Detect Table, where the challenge says what it should find.
      if (challenge.detect) {
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
      await page.close().catch(() => {});
      await site.close();
    }
  });
}
