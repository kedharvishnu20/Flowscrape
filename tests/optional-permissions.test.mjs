// The two permissions this extension asks for only when asked to.
//
// COOKIES/SESSION and SET_HEADERS both need something the install does not
// grant. Making them *required* would undo C-07, which cut four permissions
// nobody used — most runs need neither of these. So both are optional, Chrome
// asks at the moment the feature is switched on, and the steps that use them
// refuse with a message rather than breaking.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  OPTIONAL_PERMISSIONS,
  permissionRefusal,
} from "../background/optional-permissions.js";

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);

test("neither permission is required at install", () => {
  for (const name of Object.keys(OPTIONAL_PERMISSIONS)) {
    assert.ok(
      !manifest.permissions.includes(name),
      `${name} is in permissions — installing would now ask for it`,
    );
    assert.ok(
      manifest.optional_permissions.includes(name),
      `${name} is not offered as an optional permission`,
    );
  }
});

test("the header permission is the host-scoped variant", () => {
  // declarativeNetRequest can act on every request the browser makes;
  // WithHostAccess can only act where host access was already granted, which is
  // all this needs and a materially smaller ask.
  assert.ok(
    manifest.optional_permissions.includes(
      "declarativeNetRequestWithHostAccess",
    ),
  );
  assert.ok(
    !manifest.optional_permissions.includes("declarativeNetRequest"),
    "the broader variant is being requested",
  );
});

test("a refusal says what is missing, what for, and what happens without it", () => {
  for (const name of Object.keys(OPTIONAL_PERMISSIONS)) {
    const said = permissionRefusal(name);
    assert.match(said, /Settings/, `${name}: does not say where to turn it on`);
    assert.match(
      said,
      new RegExp(OPTIONAL_PERMISSIONS[name].forWhat.split(" ")[0], "i"),
      `${name}: does not say what it is for`,
    );
    assert.ok(
      said.includes("Without it"),
      `${name}: does not say what happens without it`,
    );
  }
});

test("the grant is asked for in the panel, never in the worker", async () => {
  // chrome.permissions.request needs a user gesture. Called from a service
  // worker it is refused without ever prompting, which is indistinguishable
  // from the user declining — a bug that would look like the feature not
  // working and be very hard to read from the outside.
  const sw = await readFile(
    new URL("../background/service-worker.js", import.meta.url),
    "utf8",
  );
  // A call, not the word: the worker explains in a comment why it does not
  // do this, and that comment should not fail its own test.
  const calls = sw
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  assert.ok(
    !/chrome\.permissions\.request\(/.test(calls),
    "the worker asks for a permission it cannot be granted",
  );
  const panel = await readFile(
    new URL("../sidepanel/pipeline-builder.js", import.meta.url),
    "utf8",
  );
  assert.match(panel, /chrome\.permissions\.request/);
  assert.match(panel, /chrome\.permissions\.remove/, "no way to take it back");
});
