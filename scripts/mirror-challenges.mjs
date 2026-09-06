// Fetches the real tryscrapeme.com challenge pages and saves them under
// e2e/challenges/pages/, so `npm run challenges` can serve the real markup
// instead of a reconstruction — see the note at the top of
// e2e/challenges/index.mjs for why that gap matters.
//
//     node scripts/mirror-challenges.mjs
//
// If outbound traffic here goes through an HTTP(S) proxy, run it with
// NODE_USE_ENV_PROXY=1 so Node's fetch actually uses it — undici (the fetch
// implementation Node ships) does not read HTTPS_PROXY on its own.
//
// Run this by hand, from a machine with real network access, whenever the
// site's markup changes enough to be worth re-capturing. It is not part of
// `npm test` or `npm run challenges` — the test suite must run offline, and
// this script is the only thing here allowed to touch the network.
//
// Politeness: one request at a time, a pause between each, and every page is
// fetched exactly once. tryscrapeme.com is someone's free practice site, not
// a load target.
//
// The site rejects requests whose User-Agent looks automated ("403 Invalid
// User Agent"), so this sends a plain desktop Chrome string — the same
// courtesy any browser gives it, not a bypass of anything the site is
// actually trying to stop.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = join(HERE, "..", "e2e", "challenges", "pages");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const BASE = "https://tryscrapeme.com";
const DELAY_MS = 1500;

/**
 * What to fetch, and where it lands. `id` matches a challenge id in
 * e2e/challenges/index.mjs; `file` is relative to e2e/challenges/pages/.
 *
 * Two challenge ids are deliberately absent — mirroring them would either
 * fake a technique the extension cannot perform, or mirror a page that does
 * not exist. Both are explained in the console output below and in
 * e2e/challenges/index.mjs:
 *
 *   - "base64": the real challenge decodes base64 *images* and asks for the
 *     MD5 hash of whichever one is visually "Night Tiger" — there is no
 *     selector or transform that identifies an image by its pixels, and the
 *     base64 transform decodes to UTF-8 text (by design), so it cannot even
 *     round-trip JPEG bytes. Mirroring the page would only test "can we grab
 *     a data: URL's text", which is not what the challenge tests.
 *   - "shadow-dom": tryscrapeme.com has no web-components/shadow-DOM
 *     challenge. The fixture stays a reconstruction because there is nothing
 *     real to mirror it against.
 */
const TARGETS = [
  {
    id: "parse",
    url: `${BASE}/web-scraping-practice/beginner/parse`,
    file: "parse.html",
  },
  {
    id: "pagination",
    url: `${BASE}/web-scraping-practice/beginner/pagination`,
    file: "pagination.html",
    // Mirrored for the record even though the fixture marks this a known
    // extension gap (see realPageGap in index.mjs) — the real page uses
    // numbered ?pageno= links with no "next" affordance at all, which the
    // LOOP paginate step cannot drive.
  },
  {
    id: "iframe",
    url: `${BASE}/web-scraping-practice/beginner/iframe`,
    file: "iframe.html",
    subresources: [
      {
        url: `${BASE}/web-scraping-practice/beginner/iframe-data`,
        file: "iframe/inner.html",
      },
    ],
  },
  {
    id: "ajax",
    url: `${BASE}/web-scraping-practice/beginner/ajax`,
    file: "ajax.html",
    subresources: [
      {
        url: `${BASE}/web-scraping-practice/beginner/ajax/api`,
        file: "ajax/api.json",
        json: true,
      },
    ],
  },
  {
    id: "login",
    url: `${BASE}/web-scraping-practice/beginner/simulate-login`,
    file: "login.html",
  },
  {
    id: "obfuscated-classes",
    url: `${BASE}/web-scraping-practice/beginner/random`,
    file: "obfuscated-classes.html",
  },
];

/**
 * Third-party hosts a challenge page references that are not part of the
 * challenge itself (payments SDK, analytics) — dropped entirely rather than
 * rewritten, so the offline suite never has a reason to reach them.
 */
const THIRD_PARTY_SCRIPT_HOSTS = ["cdn.paddle.com", "www.googletagmanager.com"];

/**
 * Make a mirrored page work from whatever origin the test server happens to
 * be on, the same way `withOrigin` in challenges.mjs makes a pipeline work
 * from it: nothing in a saved file can know the test's port ahead of time
 * (it's assigned fresh per run), so instead of a substitutable `<origin>`
 * token this strips the host entirely and leaves root-relative paths, which
 * resolve against whatever origin actually served the page.
 */
function rewriteForLocalOrigin(html) {
  let out = html;
  for (const host of THIRD_PARTY_SCRIPT_HOSTS) {
    out = out.replace(
      new RegExp(
        `<script[^>]*\\ssrc="https?://${host}[^"]*"[^>]*>\\s*</script>`,
        "g",
      ),
      "",
    );
  }
  // Covers plain hrefs/srcs and the backslash-escaped form JS string
  // literals use (the ajax challenge's inline fetch call is written that
  // way in the real page).
  out = out.replaceAll("https://tryscrapeme.com", "");
  out = out.replaceAll("http://tryscrapeme.com", "");
  out = out.replaceAll("https:\\/\\/tryscrapeme.com", "");
  out = out.replaceAll("http:\\/\\/tryscrapeme.com", "");
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOne(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}`);
  }
  return res.text();
}

async function saveOne(url, file, { json = false } = {}) {
  console.log(`fetching ${url}`);
  const body = await fetchOne(url);
  const out = json ? body : rewriteForLocalOrigin(body);
  const dest = join(PAGES_DIR, file);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, out, "utf8");
  console.log(`  saved ${dest} (${out.length} bytes)`);
}

for (const target of TARGETS) {
  await saveOne(target.url, target.file);
  await sleep(DELAY_MS);
  for (const sub of target.subresources ?? []) {
    await saveOne(sub.url, sub.file, { json: sub.json });
    await sleep(DELAY_MS);
  }
}

console.log(
  "\nDone. base64 and shadow-dom were left as reconstructions — see the " +
    "comment above TARGETS for why.",
);
