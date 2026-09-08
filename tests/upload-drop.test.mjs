// UPLOAD_ACTIVITY onto a drop zone with no file input behind it.
//
// More and more upload widgets have none. They listen for `drop` and read
// `event.dataTransfer.files`, so there is nothing whose `.files` can be set —
// the step's whole mechanism does not apply, and it failed with "Upload input
// not found" on a page that was perfectly willing to take the file.
//
// The part that decides whether this is honest is knowing when it did not
// work. Dispatching a drop at an element with no handler does nothing at all:
// no error, no change, nothing on screen. A step that fired the events and
// reported success would be exactly the shape of failure this project keeps
// finding.
//
// There is a real signal. A page that accepts a drop **must** call
// preventDefault() on `dragover`, or the browser refuses the drop outright. So
// "did anything cancel these events" answers "did anything take the files",
// and it is checked rather than assumed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadInjector } from "./helpers/content-harness.mjs";
import { STEP_TYPES } from "../utils/step-types.js";

/** A one-byte PNG, as the storage library hands files over. */
const FILE = {
  name: "shot.png",
  dataUrl: "data:image/png;base64,QQ==",
};

/**
 * A page with a drop zone, and a switch for whether anything handles the drop.
 *
 * @param {{handles: boolean, cancelDrop?: boolean}} opts
 */
async function zonePage({ handles, cancelDrop = true }) {
  const h = await loadInjector(`<div id="zone">Drop files here</div>`);
  const seen = [];
  const zone = h.document.getElementById("zone");
  for (const type of ["dragenter", "dragover", "drop"]) {
    zone.addEventListener(type, (e) => {
      seen.push({
        type: e.type,
        files: Array.from(e.dataTransfer?.files ?? []).map((f) => f.name),
        kinds: Array.from(e.dataTransfer?.types ?? []),
      });
      // What a real dropzone does, and has to do: without preventDefault on
      // dragover the browser will not deliver the drop at all.
      if (!handles) return;
      if (type === "dragover" || (type === "drop" && cancelDrop)) {
        e.preventDefault();
      }
    });
  }
  return { h, seen };
}

// ── The step's shape ─────────────────────────────────────────────────────────

test("UPLOAD_ACTIVITY carries which kind of target it is aiming at", () => {
  const def = STEP_TYPES.UPLOAD_ACTIVITY.def;
  assert.equal(def.mode, "input", "the default must not change behaviour");
});

test("it is still not exportable, and for the same reason", () => {
  // The bytes come out of the extension's own storage library; a standalone
  // script has no such library to read them from.
  assert.equal(STEP_TYPES.UPLOAD_ACTIVITY.exportable, false);
});

// ── The drop itself ──────────────────────────────────────────────────────────

test("the zone receives the whole drag sequence, carrying the files", async () => {
  const { h, seen } = await zonePage({ handles: true });
  const out = await h.api._stepUploadActivity({
    selector: "#zone",
    mode: "drop",
    files: [FILE],
  });

  assert.deepEqual(
    seen.map((e) => e.type),
    ["dragenter", "dragover", "drop"],
    "a zone that tracks dragenter for its highlight ends up in the wrong state without them",
  );
  assert.deepEqual(seen[2].files, ["shot.png"]);
  assert.ok(
    seen[1].kinds.includes("Files"),
    'a dropzone checks dataTransfer.types for "Files" before it accepts',
  );
  assert.equal(out.accepted, true);
  assert.equal(out.uploaded, 1);
  h.close();
});

test("a zone nothing handles is reported as not accepted", async () => {
  const { h, seen } = await zonePage({ handles: false });
  const out = await h.api._stepUploadActivity({
    selector: "#zone",
    mode: "drop",
    files: [FILE],
  });
  assert.equal(seen.length, 3, "the events still went out");
  assert.equal(
    out.accepted,
    false,
    "nothing cancelled them, so nothing took the files",
  );
  assert.equal(
    out.uploaded,
    0,
    "reporting 1 uploaded here is the silent failure this mode could produce",
  );
  h.close();
});

test("cancelling dragover alone is enough to count as accepted", async () => {
  // Some widgets cancel dragover to allow the drop and then handle it without
  // cancelling. Requiring both would call those a failure.
  const { h } = await zonePage({ handles: true, cancelDrop: false });
  const out = await h.api._stepUploadActivity({
    selector: "#zone",
    mode: "drop",
    files: [FILE],
  });
  assert.equal(out.accepted, true);
  h.close();
});

test("a selector that matches nothing says so", async () => {
  const { h } = await zonePage({ handles: true });
  await assert.rejects(
    () =>
      h.api._stepUploadActivity({
        selector: "#nope",
        mode: "drop",
        files: [FILE],
      }),
    /no drop zone matched/i,
  );
  h.close();
});

test("a drop with no files is refused before anything is dispatched", async () => {
  const { h, seen } = await zonePage({ handles: true });
  await assert.rejects(
    () =>
      h.api._stepUploadActivity({ selector: "#zone", mode: "drop", files: [] }),
    /no files to upload/i,
  );
  assert.equal(seen.length, 0);
  h.close();
});

// ── The file-input mode is untouched ─────────────────────────────────────────

test("the file-input mode still sets the input's files", async () => {
  const h = await loadInjector(`<input id="f" type="file">`);
  const out = await h.api._stepUploadActivity({
    selector: "#f",
    files: [FILE],
  });
  assert.equal(out.mode, "input");
  assert.equal(out.uploaded, 1);
  assert.equal(h.document.getElementById("f").files[0].name, "shot.png");
  h.close();
});

// ── What the run does with the answer ────────────────────────────────────────

test("the worker fails the step when the page did not take the drop", () => {
  const src = readFileSync(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /accepted === false/,
    "a drop nobody handled has to reach the user as a failure",
  );
  assert.match(src, /did not accept the drop/i);
});

test("the side panel offers the mode, or it is unreachable", () => {
  const src = readFileSync(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /It is a drop zone with no file input/);
  assert.match(src, /data-key="mode"/);
});
