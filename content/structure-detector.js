// === structure-detector.js ===
/**
 * @module structure-detector
 * @description Find the repeating record sets on a page, and their columns.
 *
 *   Building a scrape normally means knowing CSS selectors before you start:
 *   name a field, pick it, repeat, and hope the selectors line up. This inverts
 *   that. It reads the page, works out which groups of elements are records —
 *   products, rows, results, reviews — and what columns each has, with sample
 *   values. The user then picks a table instead of picking elements.
 *
 *   A classic script, not a module: content scripts cannot `import`, so it is
 *   injected alongside injector.js and communicates through a global, the same
 *   way smart-extractor.js does.
 *
 *   Three things it does that a naive version gets wrong, each because real
 *   pages do it constantly:
 *
 *     * Records are grouped by *shape overlap*, not an exact fingerprint. A
 *       sponsored row carries an extra badge and a sold-out row has no rating;
 *       exact matching splits one list into three and the user silently scrapes
 *       a subset without ever being told.
 *     * A value split across children is read from the parent. A price written
 *       `<span>$</span><span>10</span>` is one column, not two.
 *     * A column whose text is already covered by an ancestor column is
 *       dropped, so a list does not come back as itself plus each of its items.
 *
 *   What it cannot do: pages that render records with no shared structure, and
 *   single-record pages (a product detail page has nothing repeating to find).
 *   Both come back as "no tables found" rather than as a bad guess.
 *
 * @dependencies none
 */

"use strict";

(() => {
  /** Fewer than this is not a pattern, it is a coincidence. */
  const MIN_RECORDS = 3;
  const MAX_CANDIDATES = 6;
  const MAX_FIELDS = 15;
  const MAX_SAMPLE_ROWS = 3;
  /** How much of two records' child makeup must match to call them the same. */
  const SHAPE_OVERLAP = 0.6;
  /** A column present in fewer records than this is incidental. */
  const MIN_COVERAGE = 0.5;

  const NOISE = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "PATH",
    "BR",
    "HR",
  ]);

  /**
   * Class names that are styling state rather than identity.
   *
   * Deliberately narrow. "row", "col", "item", "card" and "grid" read like
   * layout, and Bootstrap does use them that way — but they are also the most
   * common names a site gives an actual record, and excluding them makes the
   * detector fall back to a bare tag selector like `li`, which is worse in
   * every way. Bootstrap's real layout classes carry a digit (`col-md-6`) and
   * the digit rule already catches those.
   */
  const JUNK_CLASS =
    /^(is|has|js|ng|v|active|open|show|hide|visible|hidden|selected|disabled|sr|clearfix)([-_]|$)|\d/;

  const clean = (s) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim();

  /** The child tag names of an element, as a multiset. */
  const childBag = (el) =>
    [...el.children].filter((c) => !NOISE.has(c.tagName)).map((c) => c.tagName);

  /** How much two child-bags have in common, 0..1. */
  function overlap(a, b) {
    if (!a?.length && !b?.length) return 1;
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
  }

  /** The most useful class on an element, or null. */
  function identityClass(el) {
    return [...el.classList].find((c) => !JUNK_CLASS.test(c)) ?? null;
  }

  /**
   * A selector for `el` relative to `root`, preferring a class.
   * @returns {string} "" when nothing usable was found
   */
  function relSelector(el, root) {
    const parts = [];
    let node = el;
    while (node && node !== root && node.parentElement) {
      const cls = identityClass(node);
      if (cls) {
        const short = `.${CSS.escape(cls)}`;
        return parts.length ? `${short} ${parts.join(" > ")}` : short;
      }
      const tag = node.tagName.toLowerCase();
      const sameTag = [...node.parentElement.children].filter(
        (c) => c.tagName === node.tagName,
      );
      parts.unshift(
        sameTag.length > 1
          ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})`
          : tag,
      );
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  /** A page-level selector for the record container. */
  function containerSelector(el) {
    const cls = identityClass(el);
    if (cls) {
      const sel = `.${CSS.escape(cls)}`;
      if (document.querySelectorAll(sel).length >= MIN_RECORDS) return sel;
    }
    const parentCls = el.parentElement && identityClass(el.parentElement);
    const tag = el.tagName.toLowerCase();
    if (parentCls) return `.${CSS.escape(parentCls)} > ${tag}`;
    return tag;
  }

  /** A column name guessed from the selector that found it. */
  function nameFor(selector, kind) {
    const last =
      selector
        .split(/[\s>+~]+/)
        .filter(Boolean)
        .pop() ?? "";
    const token =
      last.match(/\.([A-Za-z][\w-]*)/)?.[1] ??
      last.replace(/[^A-Za-z]/g, "") ??
      "field";
    const base =
      token
        .replace(/^(s|p|c|js|is|ui|el)[-_]/i, "")
        .replace(/[-_]+/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .trim()
        .toLowerCase() || "field";
    if (kind === "href") return base.endsWith("url") ? base : `${base} url`;
    if (kind === "src") return base.endsWith("image") ? base : `${base} image`;
    return base;
  }

  /**
   * Make every column name unique within a table.
   *
   * An anchor carries both text and an href, so `.link` produces two columns.
   * Rows are plain objects, so two columns sharing a name means one silently
   * overwrites the other and a column vanishes without a word.
   *
   * @param {Array<{name: string}>} columns - named in place
   */
  function uniquifyNames(columns) {
    const taken = new Set();
    for (const col of columns) {
      let name = col.name;
      let n = 2;
      while (taken.has(name)) name = `${col.name} ${n++}`;
      taken.add(name);
      col.name = name;
    }
  }

  /** Group the page's elements into candidate record sets. */
  function findRecordSets() {
    const sets = [];
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
        const bags = sameTag.map(childBag);

        // The shape the most siblings agree on is the reference.
        let reference = null;
        let bestCount = 0;
        for (const bag of bags) {
          const n = bags.filter((b) => overlap(bag, b) >= SHAPE_OVERLAP).length;
          if (n > bestCount) {
            bestCount = n;
            reference = bag;
          }
        }
        if (!reference) continue;

        const members = sameTag.filter(
          (_, i) => overlap(bags[i], reference) >= SHAPE_OVERLAP,
        );
        if (members.length >= MIN_RECORDS) sets.push(members);
      }
    }
    return sets;
  }

  /** Work out the columns of one record set. */
  function columnsOf(members) {
    const found = new Map();

    for (const record of members) {
      const seen = new Set();
      for (const el of record.querySelectorAll("*")) {
        if (NOISE.has(el.tagName)) continue;

        const full = clean(el.textContent);
        const ownText = clean(
          [...el.childNodes]
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent)
            .join(" "),
        );

        const href = el.getAttribute?.("href");
        const src = el.getAttribute?.("src");

        // A sole child that carries all its parent's text is a wrapper
        // artefact — unless it has an attribute of its own. A product image
        // inside its link is exactly that shape, and dropping it loses the
        // column people most often want after the title.
        const parent = el.parentElement;
        if (
          !href &&
          !src &&
          parent &&
          parent !== record &&
          parent.children.length === 1 &&
          clean(parent.textContent) === full
        ) {
          continue;
        }

        // An element whose children are all leaves reads as one value — that is
        // how a price split across spans becomes a single column.
        const childrenAreLeaves =
          el.children.length > 0 &&
          [...el.children].every((c) => c.children.length === 0);
        const value = ownText || (childrenAreLeaves ? full : "");
        if (!value && !href && !src) continue;

        const selector = relSelector(el, record);
        if (!selector) continue;

        for (const [kind, sample] of [
          ["text", value],
          ["href", href],
          ["src", src],
        ]) {
          if (!sample) continue;
          const id = `${selector}|${kind}`;
          if (!found.has(id)) {
            found.set(id, { selector, kind, hits: 0, samples: [], depth: 0 });
            let d = 0;
            for (let n = el; n && n !== record; n = n.parentElement) d++;
            found.get(id).depth = d;
          }
          const col = found.get(id);
          // Once per record, so coverage is a share and not a tally.
          if (!seen.has(id)) {
            col.hits++;
            seen.add(id);
          }
          if (col.samples.length < MAX_SAMPLE_ROWS) col.samples.push(sample);
        }
      }
    }

    let columns = [...found.values()].filter(
      (c) => c.hits >= members.length * MIN_COVERAGE,
    );

    // Drop a text column whose value is already inside a shallower one. A list
    // and each of its items are not four columns, they are one.
    const texts = columns.filter((c) => c.kind === "text");
    columns = columns.filter((col) => {
      if (col.kind !== "text") return true;
      const mine = col.samples[0] ?? "";
      if (!mine) return false;
      return !texts.some(
        (other) =>
          other !== col &&
          other.depth < col.depth &&
          (other.samples[0] ?? "").includes(mine),
      );
    });

    const named = columns
      .sort((a, b) => b.hits - a.hits || a.depth - b.depth)
      .slice(0, MAX_FIELDS)
      .map((c) => ({
        name: nameFor(c.selector, c.kind),
        selector: c.selector,
        kind: c.kind,
        coverage: Math.round((c.hits / members.length) * 100),
        samples: c.samples,
      }));
    uniquifyNames(named);
    return named;
  }

  /**
   * Read the page's repeating structures.
   *
   * @returns {{ url: string, title: string, candidates: object[] }}
   */
  function detectStructure() {
    const candidates = [];

    for (const members of findRecordSets()) {
      const columns = columnsOf(members);
      if (columns.length < 2) continue;

      const selector = containerSelector(members[0]);
      // Only offer a container the page can actually find again.
      let matched = 0;
      try {
        matched = document.querySelectorAll(selector).length;
      } catch {
        continue;
      }
      if (matched < MIN_RECORDS) continue;

      candidates.push({
        selector,
        count: members.length,
        matched,
        fields: columns,
        // Rows the user reads to decide, rather than trusting the selectors.
        sampleRows: Array.from({
          length: Math.min(MAX_SAMPLE_ROWS, members.length),
        }).map((_, i) =>
          Object.fromEntries(
            columns.map((c) => [c.name, c.samples[i] ?? c.samples[0] ?? ""]),
          ),
        ),
        score: members.length * columns.length,
      });
    }

    // Two containers can describe the same list; keep the better one.
    const unique = new Map();
    for (const c of candidates.sort((a, b) => b.score - a.score)) {
      if (!unique.has(c.selector)) unique.set(c.selector, c);
    }

    return {
      url: location.href,
      title: document.title,
      candidates: [...unique.values()].slice(0, MAX_CANDIDATES),
    };
  }

  // The isolated world is shared with injector.js, which dispatches to this.
  globalThis.__fsDetectStructure = detectStructure;
})();

// === END structure-detector.js ===
