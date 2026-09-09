// Two defects in the Settings accordion, both found by reading it rather than
// running it.
//
// 1. Three text inputs promised to save a key: #key-2captcha, #key-openai,
//    #key-gemini. Only 2captcha is ever read back — background/api-key-
//    manager.js reads the bare "2captcha" / "anticaptcha" / "capsolver" slots
//    for captcha solving, and the only consumers of a *model* key
//    (background/gateway-config.js, background/service-worker.js) read
//    `gateway:<provider>`, the slot the separate "AI Gateway" accordion
//    writes to. #key-openai and #key-gemini stored under the bare provider
//    name instead, which nothing reads — a key could be typed in, saved,
//    reported as verified, and never once reach a request. That accordion is
//    the wrong door with a working handle.
//
// 2. #bypass-robots and #authorize-captcha — the two switches that decide
//    whether a run ignores a site's stated wishes or answers a challenge on
//    its behalf — sat at the bottom of that same "API Keys" section, as if
//    consent were a species of credential.
//
// Both are markup/wiring defects, so these are source-reading tests in the
// style of tests/pii-gate.test.mjs and tests/import-gate.test.mjs: the
// assertions are about what exists and where it sits, not about runtime
// behavior a DOM harness would have to fake anyway.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const markup = readFileSync(
  new URL("../sidepanel/index.html", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);

// ── Defect 1: the dead key-openai / key-gemini inputs ───────────────────────

test("the dead OpenAI and Gemini key inputs are gone from the markup", () => {
  assert.ok(
    !/id="key-openai"/.test(markup),
    "key-openai should no longer exist — nothing ever read it",
  );
  assert.ok(
    !/id="key-gemini"/.test(markup),
    "key-gemini should no longer exist — nothing ever read it",
  );
  assert.ok(
    !/id="btn-save-key-openai"/.test(markup),
    "its Save button should be gone too",
  );
  assert.ok(
    !/id="btn-save-key-gemini"/.test(markup),
    "its Save button should be gone too",
  );
});

test("the 2captcha input survives — it is the one that is actually consumed", () => {
  assert.match(markup, /id="key-2captcha"/);
  assert.match(markup, /id="btn-save-key-2captcha"/);
});

test("no handler in pipeline-builder.js still wires the dead inputs", () => {
  assert.ok(
    !/_saveAndValidateKey\(\s*"openai"/.test(panel),
    "an openai save handler is still wired to the bare provider slot",
  );
  assert.ok(
    !/_saveAndValidateKey\(\s*"gemini"/.test(panel),
    "a gemini save handler is still wired to the bare provider slot",
  );
  // 2captcha's handler must remain — it is the genuine consumer.
  assert.match(panel, /_saveAndValidateKey\(\s*"2captcha"/);
});

test("the captcha-keys section points at the AI Gateway for model keys", () => {
  const section = markup.match(
    /<span>Captcha Solver<\/span>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/,
  )?.[0];
  assert.ok(section, "the renamed captcha-keys section should exist");
  assert.match(
    section,
    /AI Gateway/,
    "it should point readers at where model keys actually go",
  );
});

test("the misleading 'API Keys & Services' title is gone", () => {
  assert.ok(
    !/API Keys (&amp;|&) Services/.test(markup),
    "the accordion title should no longer claim to hold keys that do nothing",
  );
});

// ── Defect 2: ethics toggles moved out from under key inputs ────────────────

test("bypass-robots and authorize-captcha keep their element IDs", () => {
  // pipeline-builder.js and the e2e suite reference these by ID; only their
  // markup location was supposed to change.
  assert.match(markup, /id="bypass-robots"/);
  assert.match(markup, /id="authorize-captcha"/);
  assert.match(panel, /getElementById\("bypass-robots"\)/);
  assert.match(panel, /getElementById\("authorize-captcha"\)/);
});

test("the ethics toggles are no longer inside the captcha-keys section", () => {
  const section = markup.match(
    /<span>Captcha Solver<\/span>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/,
  )?.[0];
  assert.ok(section, "the captcha-keys section should exist");
  assert.ok(
    !/id="bypass-robots"/.test(section),
    "bypass-robots should have moved out of the keys section",
  );
  assert.ok(
    !/id="authorize-captcha"/.test(section),
    "authorize-captcha should have moved out of the keys section",
  );
});

test("the ethics toggles have their own top-level accordion section", () => {
  const section = markup.match(
    /<span>Ethics &amp; consent<\/span>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/,
  )?.[0];
  assert.ok(section, "an 'Ethics & consent' accordion section should exist");
  assert.match(section, /id="bypass-robots"/);
  assert.match(section, /id="authorize-captcha"/);
});

test("the ethics section sits first in the Settings view, before Schedules", () => {
  const configStart = markup.indexOf('<div id="view-config" class="view">');
  assert.ok(configStart !== -1, "the config view markup should be found");
  const configView = markup.slice(configStart);
  const ethicsAt = configView.indexOf("Ethics &amp; consent");
  const schedulesAt = configView.indexOf(">Schedules<");
  assert.ok(ethicsAt !== -1, "the ethics section should be present");
  assert.ok(schedulesAt !== -1, "the schedules section should be present");
  assert.ok(
    ethicsAt < schedulesAt,
    "ethics & consent should be the first section in Settings",
  );
});

test("the ethics section explains what each toggle does", () => {
  const section = markup.match(
    /<span>Ethics &amp; consent<\/span>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/,
  )?.[0];
  assert.match(section, /robots\.txt/i);
  assert.match(section, /per-run/i);
  assert.match(
    section,
    /per-domain attestation/i,
    "should mention the step-level attestation captcha authorisation also needs",
  );
});
