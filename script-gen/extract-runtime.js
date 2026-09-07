// === extract-runtime.js ===
/**
 * @module extract-runtime
 * @description The one definition of "what does this element say", shared by
 *   both emitters.
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

// === END extract-runtime.js ===
