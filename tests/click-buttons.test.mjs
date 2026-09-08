import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadInjector } from "./helpers/content-harness.mjs";

import { STEP_TYPES } from "../utils/step-types.js";
import { emitNode } from "../script-gen/node-emitter.js";
import { emitPython } from "../script-gen/python-emitter.js";

/**
 * Run a CLICK inside a real DOM and report every mouse event the target saw.
 *
 * @param {object} config - the CLICK step's config
 * @returns {Promise<{events: object[], result: object}>}
 */
async function clickInPage(config) {
  const h = await loadInjector(`<button id="t">Target</button>`);
  const events = [];
  const target = h.document.getElementById("t");
  for (const name of [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
    "auxclick",
    "contextmenu",
  ]) {
    target.addEventListener(name, (e) => {
      events.push({
        type: e.type,
        button: e.button,
        buttons: e.buttons,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      });
    });
  }

  const result = await h.api._stepClick({
    selector: "#t",
    retries: 1,
    ...config,
  });
  h.close();
  return { events, result };
}

/** Only the events a page would distinguish a button by. */
const kinds = (events) => events.map((e) => e.type);

// ── The step's shape ─────────────────────────────────────────────────────────

test("CLICK carries a button and a set of held keys", () => {
  const def = STEP_TYPES.CLICK.def;
  assert.equal(def.button, "left", "the default must not change behaviour");
  assert.deepEqual(def.modifiers, []);
});

// ── What the page actually receives ──────────────────────────────────────────

test("a left click is still a click, and still uses the element's own click()", async () => {
  const { events, result } = await clickInPage({});
  assert.equal(result.clicked, 1);
  assert.ok(kinds(events).includes("click"));
  assert.ok(
    !kinds(events).includes("auxclick") &&
      !kinds(events).includes("contextmenu"),
  );
});

test("the right button fires contextmenu and no click at all", async () => {
  const { events, result } = await clickInPage({ button: "right" });
  assert.equal(result.clicked, 1);
  const seen = kinds(events);
  assert.ok(seen.includes("contextmenu"), `saw ${seen.join(", ")}`);
  assert.ok(
    !seen.includes("click"),
    "a right click that also fires `click` triggers the left-click handler too",
  );
  assert.equal(
    events.find((e) => e.type === "mousedown").button,
    2,
    "button 2 is the right one; a handler reading it must see the truth",
  );
});

test("the middle button fires auxclick, which is what a page listens for", async () => {
  const { events } = await clickInPage({ button: "middle" });
  const seen = kinds(events);
  assert.ok(seen.includes("auxclick"), `saw ${seen.join(", ")}`);
  assert.ok(
    !seen.includes("click"),
    "browsers do not fire click for a non-primary button",
  );
  assert.equal(events.find((e) => e.type === "mousedown").buttons, 4);
});

test("held keys reach the handler, which is the whole point of ctrl-click", async () => {
  const { events } = await clickInPage({ modifiers: ["ctrl", "shift"] });
  const click = events.find((e) => e.type === "click");
  assert.equal(click.ctrlKey, true);
  assert.equal(click.shiftKey, true);
  assert.equal(click.altKey, false);
  assert.equal(click.metaKey, false);
});

test("'cmd' and 'control' are accepted as the names people actually use", async () => {
  const { events } = await clickInPage({ modifiers: ["cmd", "control"] });
  const click = events.find((e) => e.type === "click");
  assert.equal(click.metaKey, true);
  assert.equal(click.ctrlKey, true);
});

test("the button is released by the time the click lands", async () => {
  // A modifier, so the synthetic path runs at all: a plain left click goes
  // through the element's own click(), which fires one `click` and nothing to
  // read `buttons` from.
  const { events } = await clickInPage({ modifiers: ["shift"] });
  const down = events.find((e) => e.type === "mousedown");
  const click = events.find((e) => e.type === "click");
  assert.equal(down.buttons, 1);
  assert.equal(
    click.buttons,
    0,
    "a handler telling a drag from a click reads `buttons`; leaving it set lies to it",
  );
});

// ── What the exported script asks for ────────────────────────────────────────

const pipeline = (config) => ({
  name: "buttons",
  steps: [{ id: "c", type: "CLICK", config: { selector: ".x", ...config } }],
});

test("a plain click exports with no options, as it always did", () => {
  assert.match(emitNode(pipeline({})), /page\.click\('\.x'\);/);
  assert.match(emitPython(pipeline({})), /page\.click\("\.x"\)/);
});

test("the Node script names the button and spells the modifiers Playwright's way", () => {
  assert.match(
    emitNode(pipeline({ button: "right" })),
    /page\.click\('\.x', \{ button: 'right' \}\)/,
  );
  assert.match(
    emitNode(pipeline({ modifiers: ["ctrl", "shift"] })),
    /modifiers: \['Control', 'Shift'\]/,
  );
  assert.match(
    emitNode(pipeline({ modifiers: ["cmd"] })),
    /modifiers: \['Meta'\]/,
  );
});

test("the Python script asks for the same thing", () => {
  assert.match(
    emitPython(pipeline({ button: "middle" })),
    /page\.click\("\.x", button="middle"\)/,
  );
  assert.match(
    emitPython(pipeline({ modifiers: ["alt"] })),
    /modifiers=\["Alt"\]/,
  );
});

test("the side panel offers both, or the config is unreachable", async () => {
  const src = readFileSync(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /data-key="button"/);
  assert.match(src, /data-member=/);
  // The limit has to be on screen, not only in a commit message: a user who
  // picks "Middle" expecting a new tab has been misled by the control itself.
  assert.match(src, /will not make Chrome open a tab/i);
});
