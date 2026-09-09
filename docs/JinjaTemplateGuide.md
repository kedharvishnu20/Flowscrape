# Jinja-style Templates in Verquill v3

This document explains how to use template variables in pipeline step configuration values.

> Verquill supports `{{ ... }}` placeholders in string configs and resolves them through a simple object-lookup resolver (in `background/service-worker.js`).

## 1. Template resolver behavior

Implemented in `background/service-worker.js` as `_resolveStr()`:

- Input string is scanned for `{{...}}` chunks
- Inside, it evaluates dot-separated paths against a runtime context object
- Example path: `{{loop.index}}`, `{{item.href}}`, `{{extracted.name}}`
- Missing values resolve to empty string

Pseudo-code:

```js
return s.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
  const parts = expr.trim().split(".");
  let val = ctx;
  for (const p of parts) val = val?.[p];
  return val !== undefined && val !== null ? String(val) : "";
});
```

## 2. Available contexts

### `parent` context in step execution

- `loop` (only inside `LOOP` step execution):
  - `loop.index` (1-based loop counter)
  - `loop.index0` (0-based loop counter)
  - `loop.count` (number of iterations)
  - `loop.selector` (loop `selector` config)

- `item` (for `LOOP` with type `elements`):
  - `item.text`, `item.href`, `item.src`, `item.value` etc from `QUERY_ELEMENTS`

- `extracted` (updates after each `EXTRACT` step):
  - `extracted.<field>` values from last extracted row

## 3. Using templates in step fields

You can use templates in any string config value. Example pipeline steps:

- `NAVIGATE`:
  - `url: "https://example.com/page/{{loop.index}}"

- `CLICK`:
  - `selector: "#items > li:nth-child({{loop.index}}) a"

- `FILL`:
  - `text: "{{extracted.firstName}} {{extracted.lastName}}"

- `LOOP` + `EXTRACT` pattern:
  1. LOOP `type: elements`, `selector: ".product-link"
  2. INSIDE loop: EXTRACT `fields: [{name:'title', selector:'h1'}]`
  3. Fetch `{{item.href}}` in nested `NAVIGATE`

- `EXTRACT` post-processing in later steps:
  - `target: "{{extracted.price}}"`

## 4. Example (from UI)

### Step 1 (LOOP)

```json
{
  "type": "LOOP",
  "config": {
    "type": "elements",
    "selector": ".product-card",
    "max": 20
  },
  "children": [
    {
      "type": "CLICK",
      "config": { "selector": ".product-link", "all": false }
    },
    {
      "type": "EXTRACT",
      "config": { "fields": [{ "name": "price", "selector": ".price" }] }
    },
    { "type": "EXPORT", "config": { "format": "json" } }
  ]
}
```

### Step 2 (using template)

- In a later step, reference extracted value:
  - `url: "https://api.myapp.com/price?value={{extracted.price}}"`

## 5. Common tips

- Always use `.` to drill into nested context keys.
- If you need safe default, create a helper field manually in data source prior to templating (no built-in default fallback expression like Jinja `| default(...)`).
- Keep values trailing-friendly: unsupported expressions are silently blank.

## 6. Limitations

- Not real Jinja engine; only `{{var}}` field access is supported
- No loops/conditionals inside template expression
- Only string `step.config` fields are resolved; other data types pass through unchanged

## 7. Array indexing and list access (new)

The resolver now supports array access for loop item arrays.

- `{{loop.items[0].href}}` → first list element from `QUERY_ELEMENTS`
- `{{loop.items.1.text}}` → second list element text (supports numeric path style)
- `{{item.href}}` / `{{item.index}}` → current item in loop
- `{{loop.first}}` → true on first iteration
- `{{loop.last}}` → true on last iteration
- `{{loop.current}}` → same as current `item` object

Child steps inside a `LOOP` are now automatically scoped to the current loop item. That means a `CLICK` or `EXTRACT` child can use a descendant selector like `a.product-link` and it will resolve inside the current item, not the whole page.

If a child selector is just a number like `1`, `2`, or `3`, Verquill treats it as `:scope > *:nth-child(n)` inside the current loop item, so `1` means first child, `2` means second child, and so on.

Do not use object templates like `{{item}}` or `{{loop.current}}` directly as selector text. Use a descendant selector (for example `a.product-link`) or leave selector empty to target the current loop item root.

### Example: click from list element in a LOOP

1. LOOP step:

```json
{
  "type": "LOOP",
  "config": {
    "type": "elements",
    "selector": ".product-list > .product",
    "max": 10
  },
  "children": [
    {
      "type": "CLICK",
      "config": { "selector": "a.product-link" }
    },
    {
      "type": "EXTRACT",
      "config": { "fields": [{ "name": "price", "selector": ".price" }] }
    }
  ]
}
```

2. If you want a downstream click to specifically use `loop.items[2]` (the 3rd found element, not current loop item):

```json
{
  "type": "CLICK",
  "config": {
    "selector": "{{loop.items[2].tag}}.product-link" // (the syntax is illustrative; usually your page uses known tags/ids, maybe `li:nth-child` is more stable
  }
}
```

Or extracting text from list element by index:

- `{{loop.items[2].text}}` → text in third matched element

## 8. Multiple real-world examples (HTML + pipeline)

### Example 1: product list LOOP + per-item click + extract + export

HTML:

```html
<ul class="product-list">
  <li class="product">
    <a class="product-link" href="/p/1">Product 1</a
    ><span class="price">$10</span>
  </li>
  <li class="product">
    <a class="product-link" href="/p/2">Product 2</a
    ><span class="price">$20</span>
  </li>
  <li class="product">
    <a class="product-link" href="/p/3">Product 3</a
    ><span class="price">$30</span>
  </li>
</ul>
```

Pipeline:

```json
{
  "steps": [
    {
      "id": "loop_products",
      "type": "LOOP",
      "config": {
        "type": "elements",
        "selector": ".product-list > .product",
        "max": 10
      },
      "children": [
        {
          "id": "click_current",
          "type": "CLICK",
          "config": { "selector": "a.product-link", "all": false }
        },
        {
          "id": "extract_price",
          "type": "EXTRACT",
          "config": {
            "fields": [
              { "name": "product", "selector": "a.product-link" },
              { "name": "price", "selector": ".price" }
            ]
          }
        },
        {
          "id": "navigate_specific",
          "type": "NAVIGATE",
          "config": {
            "url": "https://example.com{{loop.items[2].href}}",
            "wait": true
          }
        }
      ]
    },
    {
      "id": "export_data",
      "type": "EXPORT",
      "config": { "format": "json" }
    }
  ]
}
```

### Example 2: explicit list indexing in loop (third item), then click

```json
{
  "steps": [
    {
      "id": "loop_items_indexed",
      "type": "LOOP",
      "config": {
        "type": "elements",
        "selector": ".product-list > .product",
        "max": 5
      },
      "children": [
        {
          "id": "click_third_item",
          "type": "CLICK",
          "config": {
            "selector": "a[href='{{loop.items[2].href}}']",
            "all": false
          }
        }
      ]
    }
  ]
}
```

## 9. Debugging

- Use a `WAIT` / `SCREENSHOT` step and `console.log` in steps outside `LOOP` to inspect `item`, `loop`, and `extracted` content
- Add an `EXTRACT` output to a monitor row and run small debug batch
- If your template returns empty, check path spelling and step order

---

This guide is intentionally minimal and fully matched with current code path. Copy and use the JSON-config style behavior directly in the UI pipeline builder.
