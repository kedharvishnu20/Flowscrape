# Examples

Pipeline JSON you can load with **📂 Upload Pipeline** in the side panel.

| File                                               | What it shows                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`loop-select-click.json`](loop-select-click.json) | Looping over matched elements, using `{{item.href}}` inside the body, and exporting |

Import validates every step against
[`utils/step-types.js`](../utils/step-types.js) and fills in that registry's
defaults, so a file here only needs the keys it wants to override.

## A note on selectors inside a loop

Steps inside a `LOOP` in `elements` mode are scoped to the current item, so a
child selector is relative to it — `.product-link`, not `.product-card
.product-link`.

`loop-select-click.json` used to write that selector as
`"{{item.tag}}.product-link"`. `item.tag` is the matched element's own tag name,
so it rendered to something like `div.product-link` and then looked for that
_inside_ the item — which is exactly the object-in-a-selector pattern
[`docs/JinjaTemplateGuide.md`](../docs/JinjaTemplateGuide.md) warns against
(audit F-10).
