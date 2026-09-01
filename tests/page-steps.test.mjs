// Regression tests for audit findings B-10, B-23, B-24, B-25 and B-31 — the
// step handlers that run in the page, tested against a real DOM.
//
// B-10: _typeInto did `el.value += ch` and dispatched a plain Event. React
// installs its own `value` accessor on the node and caches the last value it
// saw in _valueTracker, so that assignment updates the cache too, React's
// change detection sees no change, no onChange runs, and the next render writes
// the old state back — the field ends up empty and the step reports success.
// FILL also had no idea what to do with a checkbox, a radio, a <select> or a
// contenteditable, and silently did nothing on all four.
//
// B-23: SELECT assigned el.value directly. On a select with no matching option
// that sets the value to "" — it silently *clears* the control — and only a
// change event was fired, never input.
//
// B-24: the code value was "Key" + upper for any single character, giving Key1
// for a digit (Digit1) and Key- for a hyphen (Minus). Sites keyed on
// event.code ignored the event entirely.
//
// B-25: text-contains compared raw textContent, and text-equals only trimmed —
// neither survives the indentation real markup puts inside an element.
//
// B-31: percent scrolling used document.body.scrollHeight, which is the
// viewport height whenever the html element is the scroll container.
import test from "node:test";
import assert from "node:assert/strict";
import { loadInjector } from "./helpers/content-harness.mjs";

/**
 * Make an input behave the way React's controlled inputs do.
 *
 * React defines its own `value` accessor on the node and keeps the last value
 * it saw in _valueTracker; on every input event it compares the two, and only
 * runs onChange when they differ. Anything it did not notice gets overwritten
 * on the next render. That is the exact mechanism FILL used to lose to.
 */
function reactify(window, node) {
  const desc = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  );
  let tracked = desc.get.call(node);
  let state = "";

  Object.defineProperty(node, "value", {
    configurable: true,
    get() {
      return desc.get.call(this);
    },
    set(v) {
      tracked = String(v);
      desc.set.call(this, v);
    },
  });
  node._valueTracker = {
    getValue: () => tracked,
    setValue: (v) => {
      tracked = String(v);
    },
  };

  // React's change detection.
  node.addEventListener("input", () => {
    const next = desc.get.call(node);
    if (next === tracked) return; // it never saw a change
    tracked = next;
    state = next;
  });
  // React's re-render, writing component state back over the DOM.
  node.addEventListener("input", () => desc.set.call(node, state));

  return { state: () => state };
}

// ── B-10: FILL ───────────────────────────────────────────────────────────────

test("FILL fills a plain input", async () => {
  const h = await loadInjector(`<input id="q">`);
  await h.api._stepFill({ selector: "#q", text: "hello", delayMs: 0 });
  assert.equal(h.document.getElementById("q").value, "hello");
  h.close();
});

test("FILL fills a React-controlled input, which used to end up empty", async () => {
  const h = await loadInjector(`<input id="q">`);
  const react = reactify(h.window, h.document.getElementById("q"));

  await h.api._stepFill({ selector: "#q", text: "shoes", delayMs: 0 });

  assert.equal(h.document.getElementById("q").value, "shoes", "the DOM value");
  assert.equal(react.state(), "shoes", "and the component state behind it");
  h.close();
});

test("FILL reports failure instead of claiming success on a field it cannot set", async () => {
  const h = await loadInjector(`<input id="q">`);
  const el = h.document.getElementById("q");
  // A field the page insists on owning: every input event snaps it back. This
  // is the case _setNativeValue cannot win, and the one that must be reported
  // rather than returning { typed: true } over an empty box.
  el.addEventListener("input", () => {
    const desc = Object.getOwnPropertyDescriptor(
      h.window.HTMLInputElement.prototype,
      "value",
    );
    desc.set.call(el, "");
  });

  await assert.rejects(
    () => h.api._stepFill({ selector: "#q", text: "x", delayMs: 0 }),
    /did not stick/,
  );
  h.close();
});

test("FILL respects maxlength rather than treating truncation as failure", async () => {
  const h = await loadInjector(`<input id="q" maxlength="3">`);
  // jsdom does not enforce maxlength on assignment the way typing does, and
  // the fix deliberately writes through the prototype setter, so enforce it
  // there — patching the instance would just be bypassed.
  const proto = h.window.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  Object.defineProperty(proto, "value", {
    configurable: true,
    get: desc.get,
    set(v) {
      const max = this.maxLength;
      desc.set.call(this, max >= 0 ? String(v).slice(0, max) : v);
    },
  });

  const r = await h.api._stepFill({
    selector: "#q",
    text: "abcdef",
    delayMs: 0,
  });
  assert.equal(r.typed, "abc");
  assert.equal(h.document.getElementById("q").value, "abc");
  h.close();
});

test("FILL appends when asked, and replaces when not", async () => {
  const h = await loadInjector(`<input id="q" value="ab">`);
  await h.api._stepFill({
    selector: "#q",
    text: "cd",
    delayMs: 0,
    append: true,
  });
  assert.equal(h.document.getElementById("q").value, "abcd");

  await h.api._stepFill({ selector: "#q", text: "zz", delayMs: 0 });
  assert.equal(h.document.getElementById("q").value, "zz");
  h.close();
});

test("FILL ticks a checkbox and clears it", async () => {
  const h = await loadInjector(`<input type="checkbox" id="c">`);
  const el = h.document.getElementById("c");
  let changes = 0;
  el.addEventListener("change", () => changes++);

  await h.api._stepFill({ selector: "#c", text: "true", delayMs: 0 });
  assert.equal(
    el.checked,
    true,
    "a checkbox used to be typed into and ignored",
  );
  assert.equal(changes, 1);

  await h.api._stepFill({ selector: "#c", text: "false", delayMs: 0 });
  assert.equal(el.checked, false);
  h.close();
});

test("FILL does not re-fire change when the box is already in the wanted state", async () => {
  const h = await loadInjector(`<input type="checkbox" id="c" checked>`);
  const el = h.document.getElementById("c");
  let changes = 0;
  el.addEventListener("change", () => changes++);
  await h.api._stepFill({ selector: "#c", text: "yes", delayMs: 0 });
  assert.equal(el.checked, true);
  assert.equal(changes, 0);
  h.close();
});

test("FILL on a select picks the option", async () => {
  const h = await loadInjector(
    `<select id="s"><option value="s">Small</option><option value="l">Large</option></select>`,
  );
  await h.api._stepFill({ selector: "#s", text: "Large", delayMs: 0 });
  assert.equal(h.document.getElementById("s").value, "l");
  h.close();
});

test("FILL writes into a contenteditable", async () => {
  const h = await loadInjector(`<div id="e" contenteditable="true"></div>`);
  await h.api._stepFill({ selector: "#e", text: "note", delayMs: 0 });
  assert.equal(h.document.getElementById("e").textContent, "note");
  h.close();
});

test("FILL refuses a target it cannot fill instead of typing into a div", async () => {
  const h = await loadInjector(`<div id="d"></div>`);
  await assert.rejects(
    () => h.api._stepFill({ selector: "#d", text: "x", delayMs: 0 }),
    /not an input, textarea, select or contenteditable/,
  );
  h.close();
});

test("FILL refuses a file input and points at the right step", async () => {
  const h = await loadInjector(`<input type="file" id="f">`);
  await assert.rejects(
    () => h.api._stepFill({ selector: "#f", text: "/etc/passwd", delayMs: 0 }),
    /Upload from Storage/,
  );
  h.close();
});

test("a missing single-mode target fails instead of typing into the scope root", async () => {
  const h = await loadInjector(`<form id="f"><input id="q"></form>`);
  await assert.rejects(
    () => h.api._stepFill({ selector: "#nope", text: "x", delayMs: 0 }),
    /Fill target not found: #nope/,
  );
  h.close();
});

test("multi-mode fills every field and reports the ones it could not find", async () => {
  const h = await loadInjector(
    `<input id="a"><input id="b"><button id="go"></button>`,
  );
  const r = await h.api._stepFill({
    mode: "multi",
    delayMs: 0,
    fields: [
      { selector: "#a", value: "one" },
      { selector: "#b", value: "two" },
    ],
    submitSelector: "#go",
  });
  assert.equal(r.filled, 2);
  assert.equal(h.document.getElementById("a").value, "one");
  assert.equal(h.document.getElementById("b").value, "two");

  await assert.rejects(
    () =>
      h.api._stepFill({
        mode: "multi",
        delayMs: 0,
        fields: [
          { selector: "#a", value: "x" },
          { selector: "#gone", value: "y" },
        ],
      }),
    /#gone/,
    "a half-filled form used to be reported as a complete success",
  );
  h.close();
});

test("multi-mode does not click submit when the button is missing", async () => {
  const h = await loadInjector(`<input id="a">`);
  await assert.rejects(
    () =>
      h.api._stepFill({
        mode: "multi",
        delayMs: 0,
        fields: [{ selector: "#a", value: "x" }],
        submitSelector: "#nobutton",
      }),
    /Submit target not found/,
  );
  h.close();
});

// ── B-23: SELECT ─────────────────────────────────────────────────────────────

test("SELECT matches by value, by label, and case-insensitively", async () => {
  const h = await loadInjector(
    `<select id="s"><option value="sm">Small</option><option value="lg">Large</option></select>`,
  );
  const el = h.document.getElementById("s");

  await h.api._stepSelect({ selector: "#s", value: "lg" });
  assert.equal(el.value, "lg");

  await h.api._stepSelect({ selector: "#s", value: "Small" });
  assert.equal(el.value, "sm", "the label is what the user sees and types");

  await h.api._stepSelect({ selector: "#s", value: "  LARGE " });
  assert.equal(el.value, "lg");
  h.close();
});

test("SELECT fails loudly instead of silently clearing the control", async () => {
  const h = await loadInjector(
    `<select id="s"><option value="a">A</option></select>`,
  );
  await assert.rejects(
    () => h.api._stepSelect({ selector: "#s", value: "zzz" }),
    /no option matching "zzz".*Available: a/s,
  );
  assert.equal(h.document.getElementById("s").value, "a", "left untouched");
  h.close();
});

test("SELECT fires input as well as change", async () => {
  const h = await loadInjector(
    `<select id="s"><option value="a">A</option><option value="b">B</option></select>`,
  );
  const seen = [];
  const el = h.document.getElementById("s");
  el.addEventListener("input", () => seen.push("input"));
  el.addEventListener("change", () => seen.push("change"));
  await h.api._stepSelect({ selector: "#s", value: "b" });
  assert.deepEqual(seen, ["input", "change"], "frameworks listen for input");
  h.close();
});

test("SELECT refuses a disabled option and a non-select target", async () => {
  const h = await loadInjector(
    `<select id="s"><option value="a">A</option><option value="b" disabled>B</option></select><input id="i">`,
  );
  await assert.rejects(
    () => h.api._stepSelect({ selector: "#s", value: "b" }),
    /disabled/,
  );
  await assert.rejects(
    () => h.api._stepSelect({ selector: "#i", value: "a" }),
    /not a <select>/,
  );
  h.close();
});

// ── B-24: KEYBOARD ───────────────────────────────────────────────────────────

async function pressAndRead(h, key) {
  const seen = [];
  h.document.body.addEventListener("keydown", (e) =>
    seen.push({
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
    }),
  );
  await h.api._stepKeyboard({ key });
  return seen[0];
}

test("a digit reports Digit1, not Key1", async () => {
  const h = await loadInjector();
  assert.equal((await pressAndRead(h, "1")).code, "Digit1");
  h.close();
});

test("symbols report their real codes", async () => {
  const h = await loadInjector();
  assert.equal((await pressAndRead(h, "-")).code, "Minus");
  h.close();
});

test("letters and named keys are unchanged", async () => {
  const h = await loadInjector();
  assert.equal((await pressAndRead(h, "a")).code, "KeyA");
  h.close();

  const h2 = await loadInjector();
  assert.equal((await pressAndRead(h2, "Enter")).code, "Enter");
  h2.close();
});

test("a combo carries its modifiers and the main key", async () => {
  const h = await loadInjector();
  const ev = await pressAndRead(h, "Ctrl+Shift+K");
  assert.equal(ev.key, "K");
  assert.equal(ev.code, "KeyK");
  assert.equal(ev.ctrlKey, true);
  assert.equal(ev.shiftKey, true);
  h.close();
});

test("an unknown symbol reports an empty code rather than an invented one", async () => {
  const h = await loadInjector();
  assert.equal((await pressAndRead(h, "€")).code, "");
  h.close();
});

// ── B-25: IF_ELSE text conditions ────────────────────────────────────────────

test("text-equals matches text as it is rendered, not as it is indented", async () => {
  const h = await loadInjector(
    `<button id="b">\n      Add to cart\n    </button>`,
  );
  const r = await h.api._stepIfElse({
    condition: "text-equals",
    selector: "#b",
    value: "Add to cart",
  });
  assert.equal(r.conditionMet, true);
  h.close();
});

test("text-contains normalises both sides", async () => {
  const h = await loadInjector(`<div id="d">Price:\n  $12.00</div>`);
  assert.equal(
    (
      await h.api._stepIfElse({
        condition: "text-contains",
        selector: "#d",
        value: "Price: $12",
      })
    ).conditionMet,
    true,
  );
  h.close();
});

test("a genuinely different string still does not match", async () => {
  const h = await loadInjector(`<div id="d">In stock</div>`);
  assert.equal(
    (
      await h.api._stepIfElse({
        condition: "text-equals",
        selector: "#d",
        value: "Out of stock",
      })
    ).conditionMet,
    false,
  );
  h.close();
});

test("exists and attribute conditions still work", async () => {
  const h = await loadInjector(`<div id="d" data-state=" ready "></div>`);
  const c = (condition, extra) =>
    h.api
      ._stepIfElse({ condition, selector: "#d", ...extra })
      .then((r) => r.conditionMet);

  assert.equal(await c("exists"), true);
  assert.equal(await c("not-exists"), false);
  assert.equal(
    await c("attr-equals", { attr: "data-state", value: "ready" }),
    true,
  );
  assert.equal(
    await c("attr-contains", { attr: "data-state", value: "read" }),
    true,
  );
  h.close();
});

// ── B-31: SCROLL ─────────────────────────────────────────────────────────────

test("percent scrolling measures the document, not the body box", async () => {
  const h = await loadInjector(`<div id="tall"></div>`);
  Object.defineProperty(h.window.document.documentElement, "scrollHeight", {
    configurable: true,
    get: () => 10000,
  });
  Object.defineProperty(h.window.document.body, "scrollHeight", {
    configurable: true,
    get: () => 800, // body is only as tall as the viewport, the common case
  });

  let target = null;
  h.window.scrollTo = (opts) => (target = opts.top);
  await h.api._stepScroll({ mode: "percent", amount: 50 });
  assert.equal(target, 5000, "body.scrollHeight would have given 400");
  h.close();
});

test("pixel scrolling is unchanged", async () => {
  const h = await loadInjector();
  let by = null;
  h.window.scrollBy = (opts) => (by = opts.top);
  await h.api._stepScroll({ mode: "pixel", amount: 250 });
  assert.equal(by, 250);
  h.close();
});
