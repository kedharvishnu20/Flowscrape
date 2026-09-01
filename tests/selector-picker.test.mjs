// Regression tests for audit findings E-02 and E-03.
//
// E-02: the picker's promise resolved only from onClick. There was no Escape
// key, no cancel affordance and no timeout, so a user who changed their mind
// left `_pickerActive` true for the life of the page: every later pick returned
// null immediately, and the side panel sat awaiting a message that never came.
// Only reloading the page recovered it.
//
// E-03: the blocker overlay inherits pointer-events:none from the shadow host,
// so despite its comment claiming it "physically stops mouse events from
// reaching the page", the page kept firing its own hover styles under the
// crosshair — and could shift the element being picked.
import test from "node:test";
import assert from "node:assert/strict";
import { loadInjector } from "./helpers/content-harness.mjs";

const PAGE = `
  <div class="card"><a class="open" id="first">One</a></div>
  <div class="card"><a class="open" id="second">Two</a></div>
`;

/** Move the mouse over an element, then act. */
function hover(h, el) {
  const rect = el.getBoundingClientRect();
  h.document.dispatchEvent(
    new h.window.MouseEvent("mousemove", {
      bubbles: true,
      clientX: rect.left + 1,
      clientY: rect.top + 1,
    }),
  );
}

const settle = () => new Promise((r) => setTimeout(r, 20));

async function pickWith(h, action) {
  const promise = h.api._activateSelectorPicker({ bulk: false });
  await settle();
  action();
  await settle();
  return promise;
}

test("clicking an element returns a selector for it", async () => {
  const h = await loadInjector(PAGE);
  const target = h.document.getElementById("second");

  const selector = await pickWith(h, () => {
    hover(h, target);
    target.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(typeof selector, "string");
  assert.ok(selector.length > 0);
  assert.ok(
    h.document.querySelector(selector),
    `the selector should match something: ${selector}`,
  );
  h.close();
});

test("Escape cancels and resolves null", async () => {
  const h = await loadInjector(PAGE);

  const selector = await pickWith(h, () =>
    h.document.dispatchEvent(
      new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );

  assert.equal(
    selector,
    null,
    "the promise settles instead of hanging forever",
  );
  h.close();
});

test("right-click cancels too", async () => {
  const h = await loadInjector(PAGE);

  const selector = await pickWith(h, () =>
    h.document.dispatchEvent(
      new h.window.MouseEvent("contextmenu", { bubbles: true }),
    ),
  );

  assert.equal(selector, null);
  h.close();
});

test("a cancelled picker can be used again", async () => {
  // This is the deadlock: _pickerActive stayed true, so every later pick
  // returned null immediately and the picker button was dead until reload.
  const h = await loadInjector(PAGE);

  const first = await pickWith(h, () =>
    h.document.dispatchEvent(
      new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  assert.equal(first, null);

  const target = h.document.getElementById("first");
  const second = await pickWith(h, () => {
    hover(h, target);
    target.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(
    typeof second,
    "string",
    "the picker still works after a cancel",
  );
  h.close();
});

test("navigating away settles the promise", async () => {
  const h = await loadInjector(PAGE);

  const selector = await pickWith(h, () =>
    h.window.dispatchEvent(new h.window.Event("beforeunload")),
  );

  assert.equal(selector, null, "the caller is not left waiting on a dead page");
  h.close();
});

test("cancelling removes every listener it installed", async () => {
  const h = await loadInjector(PAGE);

  const installed = [];
  const removed = [];
  const realAdd = h.document.addEventListener.bind(h.document);
  const realRemove = h.document.removeEventListener.bind(h.document);
  h.document.addEventListener = (type, fn, capture) => {
    installed.push(type);
    return realAdd(type, fn, capture);
  };
  h.document.removeEventListener = (type, fn, capture) => {
    removed.push(type);
    return realRemove(type, fn, capture);
  };

  await pickWith(h, () =>
    h.document.dispatchEvent(
      new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );

  for (const type of installed) {
    assert.ok(removed.includes(type), `${type} listener was left behind`);
  }
  h.close();
});

test("the blocker overlay actually blocks", async () => {
  const src = await (
    await import("node:fs/promises")
  ).readFile(new URL("../content/injector.js", import.meta.url), "utf8");
  const fn = src.match(
    /async function _activateSelectorPicker\([\s\S]*?\n\}/,
  )[0];

  assert.match(
    fn,
    /"pointer-events:auto;"/,
    "the host sets pointer-events:none, so the overlay has to opt back in",
  );
});

test("the tooltip tells the user how to cancel", async () => {
  const src = await (
    await import("node:fs/promises")
  ).readFile(new URL("../content/injector.js", import.meta.url), "utf8");
  assert.match(src, /Esc to cancel/);
});
