// Regression tests for audit findings B-17 and B-18, plus three further RFC
// 9309 defects the fix exposed.
//
// B-17: `_pathMatches` returned true for an empty pattern, so `Disallow:` — the
// canonical way to say "everything is allowed" — became a rule matching every
// path, and the gate reported the whole site as disallowed. The inline comment
// claimed the opposite of what the code did.
//
// B-18: the escape class omitted `$`, so it reached the regex unescaped. The
// `endsWith('\\$')` branch below could never fire, a trailing `$` anchored only
// by accident, and a `$` anywhere else became an anchor that matched nothing.
//
// Also fixed here, all found while writing these:
//   * a user-agent line following a rule line merged two groups into one, so a
//     `Disallow: /` written for one bot applied to the group before it;
//   * an Allow and a Disallow of equal length were resolved by file order
//     rather than in Allow's favour (RFC 9309 §2.2.2);
//   * only 404 counted as "no robots.txt"; a 401 or 403 — ordinary on sites
//     behind a login or a WAF — came back as a fetch error.
import test from "node:test";
import assert from "node:assert/strict";
import { parseRobots, isAllowedByRules } from "../ethics/robots-parser.js";

const allowed = (txt, path, ua) => isAllowedByRules(parseRobots(txt), path, ua);

// ── B-17: the empty Disallow ─────────────────────────────────────────────────

test("`Disallow:` with no path allows everything", () => {
  const txt = "User-agent: *\nDisallow:";
  assert.equal(allowed(txt, "/"), true);
  assert.equal(allowed(txt, "/anything/at/all"), true, "this reported blocked");
});

test("an empty Allow: is ignored rather than matching everything", () => {
  const txt = "User-agent: *\nAllow:\nDisallow: /private";
  assert.equal(allowed(txt, "/private/x"), false, "the real rule still applies");
  assert.equal(allowed(txt, "/public"), true);
});

test("an empty rule cannot outrank a real one", () => {
  // Length 0 used to match every path and could win when nothing else did.
  const parsed = parseRobots("User-agent: *\nDisallow:\nDisallow: /admin");
  assert.equal(parsed.agentRules.get("*").length, 1, "the empty rule is dropped");
  assert.equal(isAllowedByRules(parsed, "/admin/panel"), false);
  assert.equal(isAllowedByRules(parsed, "/home"), true);
});

// ── B-18: the $ anchor ───────────────────────────────────────────────────────

test("a trailing $ anchors the end of the path", () => {
  const txt = "User-agent: *\nDisallow: /*.pdf$";
  assert.equal(allowed(txt, "/docs/a.pdf"), false);
  assert.equal(allowed(txt, "/docs/a.pdf?x=1"), true, "$ means end of path");
});

test("a $ in the middle of a pattern is a literal, not an anchor", () => {
  const txt = "User-agent: *\nDisallow: /a$b/";
  assert.equal(allowed(txt, "/a$b/c"), false, "the literal path is blocked");
  assert.equal(allowed(txt, "/ab/c"), true);
});

test("regex metacharacters in a path are literals", () => {
  const txt = "User-agent: *\nDisallow: /p(1)+x[2].y";
  assert.equal(allowed(txt, "/p(1)+x[2].y"), false);
  assert.equal(allowed(txt, "/p1xx2ZyZ"), true, "not interpreted as a pattern");
});

test("* is still a wildcard", () => {
  const txt = "User-agent: *\nDisallow: /a/*/c";
  assert.equal(allowed(txt, "/a/b/c"), false);
  assert.equal(allowed(txt, "/a/b/d"), true);
});

// ── grouping ─────────────────────────────────────────────────────────────────

test("a user-agent line after a rule line starts a new group", () => {
  // No blank line between the groups — legal, and common.
  const txt = [
    "User-agent: *",
    "Disallow: /admin",
    "User-agent: BadBot",
    "Disallow: /",
  ].join("\n");

  assert.equal(allowed(txt, "/products"), true, "BadBot's rule leaked into *");
  assert.equal(allowed(txt, "/admin"), false, "* keeps its own rule");
  assert.equal(allowed(txt, "/products", "BadBot"), false);
});

test("several user-agents can still share one group", () => {
  const txt = "User-agent: a\nUser-agent: b\nDisallow: /x";
  assert.equal(allowed(txt, "/x", "a"), false);
  assert.equal(allowed(txt, "/x", "b"), false);
});

test("a blank line ends a group", () => {
  const txt = "User-agent: a\nDisallow: /x\n\nUser-agent: b\nDisallow: /y";
  assert.equal(allowed(txt, "/y", "a"), true);
  assert.equal(allowed(txt, "/x", "b"), true);
});

// ── precedence ───────────────────────────────────────────────────────────────

test("the longest matching rule wins", () => {
  const txt = "User-agent: *\nDisallow: /a\nAllow: /a/b/c";
  assert.equal(allowed(txt, "/a/b/c"), true);
  assert.equal(allowed(txt, "/a/b"), false);
});

test("Allow wins a tie, whichever order they appear in", () => {
  const dFirst = "User-agent: *\nDisallow: /x\nAllow: /x";
  const aFirst = "User-agent: *\nAllow: /x\nDisallow: /x";
  assert.equal(allowed(dFirst, "/x"), true, "file order used to decide this");
  assert.equal(allowed(aFirst, "/x"), true);
});

test("a specific user-agent group replaces the wildcard group", () => {
  const txt = "User-agent: *\nDisallow: /\n\nUser-agent: FlowScrape\nAllow: /\nDisallow: /admin";
  assert.equal(allowed(txt, "/products", "FlowScrape"), true);
  assert.equal(allowed(txt, "/admin", "FlowScrape"), false);
  assert.equal(allowed(txt, "/products", "OtherBot"), false);
});

test("no rules at all means allowed", () => {
  assert.equal(allowed("", "/x"), true);
  assert.equal(allowed("Sitemap: https://x.test/s.xml", "/x"), true);
});

// ── the rest of the format ───────────────────────────────────────────────────

test("comments, casing and stray whitespace are handled", () => {
  const txt = "  USER-AGENT:  *  # everyone\n  DisAllow:  /admin  # keep out\n";
  assert.equal(allowed(txt, "/admin"), false);
  assert.equal(allowed(txt, "/home"), true);
});

test("crawl-delay and sitemaps are read", () => {
  const p = parseRobots(
    "User-agent: *\nCrawl-delay: 2.5\nDisallow: /x\nSitemap: https://a.test/s.xml",
  );
  assert.equal(p.crawlDelay, 2.5);
  assert.deepEqual(p.sitemaps, ["https://a.test/s.xml"]);
});

test("a line with no colon is skipped, not treated as a rule", () => {
  assert.equal(allowed("User-agent: *\ngibberish\nDisallow: /x", "/y"), true);
});

// ── fetch outcomes ───────────────────────────────────────────────────────────

test("any 4xx on robots.txt means no restrictions", async () => {
  // 401 and 403 are ordinary on sites behind a login or a WAF. Only 404 counted
  // before, so those came back as a fetch error instead of an allow-all.
  const { fetchRobots } = await import("../ethics/robots-parser.js");
  const real = globalThis.fetch;

  for (const status of [401, 403, 404, 410]) {
    globalThis.fetch = async () => ({ ok: false, status, async text() { return ""; } });
    const r = await fetchRobots(`https://s${status}.test`);
    assert.ok(r, `status ${status} should parse as an empty ruleset`);
    assert.equal(isAllowedByRules(r, "/anything"), true);
  }

  globalThis.fetch = async () => ({ ok: false, status: 503, async text() { return ""; } });
  assert.equal(
    await fetchRobots("https://s503.test"),
    null,
    "a server error is still reported as a fetch failure, not as allow-all",
  );
  globalThis.fetch = real;
});
