// === page-runtime.js ===
/**
 * @module page-runtime
 * @description The page-side rules both emitters ship into the browser.

 *   Two questions the extension answers with real DOM code, and that a
 *   generated script has to answer the same way or quietly disagree with the
 *   pipeline it came from: what does this element *say*, and is this Next
 *   control dead.
 *
 *   `content/injector.js` reads an element with a dozen small rules that only
 *   look fussy until you meet the pages that need them: an `<img>` answers with
 *   its `src`, a bare `<a>` with its `href`, an `<input type=checkbox>` with
 *   its value only when checked, a `<select>` with the option's text when it
 *   has no value. The emitted scripts used `innerText()` for all of it — which
 *   for a grid of images is the empty string, on every row.
 *
 *   So the rules live here once, as JavaScript source, and both emitters ship
 *   the same text into `locator.evaluate`. Playwright's Python API evaluates
 *   JavaScript too, so "both emitters" really is one implementation and not
 *   two that drift.
 *
 *   Kept as a string rather than a function because it has to cross into the
 *   page: the emitters write it into a generated file, and the browser is what
 *   compiles it.
 *
 * @dependencies none
 */

/**
 * Mirrors `_extractValue` in content/injector.js.
 *
 * `f` is the field: `{ type, attribute, countSelector }`. The emitters refuse
 * at generation time when `attribute` or `countSelector` is missing, so this
 * does not repeat those checks — by the time the page sees it, the field is
 * whole.
 */
export const EXTRACT_VALUE_JS = `(node, f) => {
  if (f.type === 'attribute') return node.getAttribute(f.attribute) ?? null;
  if (f.type === 'count') return String(node.querySelectorAll(f.countSelector).length);
  if (f.type === 'html') return node.innerHTML;
  const tag = node.tagName.toLowerCase();
  if (tag === 'input') {
    const t = (node.type || 'text').toLowerCase();
    if (t === 'checkbox' || t === 'radio') return node.checked ? (node.value ?? 'true') : '';
    if (t === 'file') {
      const files = Array.from(node.files || []);
      return files.length ? files.map(x => x.name).join(', ') : (node.value ?? '');
    }
    return node.value ?? node.getAttribute('value') ?? '';
  }
  if (tag === 'textarea') return node.value ?? '';
  if (tag === 'select') {
    const opts = Array.from(node.selectedOptions || []);
    if (node.multiple) return opts.map(o => o.value || o.textContent.trim()).filter(Boolean).join(', ');
    const o = opts[0];
    return o ? (o.value || o.textContent.trim()) : (node.value ?? '');
  }
  if (node.isContentEditable) return node.innerText?.trim() ?? node.textContent.trim();
  if (tag === 'img') return node.src || node.dataset?.src || node.getAttribute('src');
  if (tag === 'a' && !node.textContent.trim()) return node.href || node.getAttribute('href');
  if (tag === 'video' || tag === 'audio') return node.src || node.getAttribute('src') || node.querySelector('source')?.src;
  return (node.innerText || node.textContent || '').trim();
}`;

/**
 * Mirrors `_paginateDeadReason` and the anchor check in content/injector.js.
 *
 * The emitted scripts used to ask only `count() === 0 || !isEnabled()`, which
 * misses every way a real paginator says "last page": `aria-disabled`, a
 * `disabled` class on a `<span>`, an `<a>` with no `href`, a control the site
 * hides with CSS. The script kept clicking a dead control and re-scraped the
 * final page until the count ran out — the same bug the extension had, in the
 * one place a test of the extension could not see it.
 *
 * Also reports where the control leads and whether it would open a second tab,
 * so a `target="_blank"` paginator can be followed in the page the script is
 * actually reading.
 */
export const PAGINATE_STATE_JS = `(el) => {
  const dead = (() => {
    if (el.disabled === true) return 'the Next control is disabled';
    if (el.getAttribute('aria-disabled') === 'true') return 'the Next control is marked aria-disabled';
    if (/(^|[\\s_-])(disabled|inactive|is-disabled)([\\s_-]|$)/i.test(el.className || '')) return 'the Next control is styled as disabled';
    if (el.tagName === 'A' && !el.getAttribute('href')) return 'the Next link has no target';
    const st = el.ownerDocument.defaultView?.getComputedStyle?.(el);
    if (st && (st.display === 'none' || st.visibility === 'hidden')) return 'the Next control is hidden';
    return '';
  })();
  const a = el.tagName === 'A' ? el : (el.closest ? el.closest('a') : null);
  const target = String(a?.getAttribute('target') ?? '').trim().toLowerCase();
  const sameTab = target === '' || target === '_self' || target === '_top';
  return { dead, href: a?.href ?? '', newTab: Boolean(a) && !sameTab };
}`;

// === END page-runtime.js ===
