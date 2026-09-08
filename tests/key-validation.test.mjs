// Regression tests for audit findings F-03 and F-10.
//
// F-03: the key:get handler imported getApiKey and validateApiKey — importing
// api-key-manager.js twice to do it — used neither, and returned only
// listProviders(). So no key was ever validated: all six _validate* functions
// in api-key-manager.js were unreachable, and saving a typo produced the same
// "saved" message as saving a working key.
//
// F-10: examples/loop-select-click.json used "{{item.tag}}.product-link".
// item.tag is the matched element's own tag name, so it rendered to something
// like div.product-link and then looked for that *inside* the item — the
// object-in-a-selector pattern the template guide warns against.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isKnownStepType, STEP_TYPES } from "../utils/step-types.js";

const swSrc = await readFile(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);
const panelSrc = await readFile(
  new URL("../sidepanel/pipeline-builder.js", import.meta.url),
  "utf8",
);

const handler = swSrc.match(/_registerHandler\(MSG\.KEY_GET[\s\S]*?\n\}\);/)[0];

test("the handler can actually validate, and imports the module once", () => {
  assert.match(
    handler,
    /validateApiKey\(provider\)/,
    "it was imported and never called",
  );
  assert.equal(
    (handler.match(/await import\(/g) ?? []).length,
    1,
    "it imported api-key-manager.js twice",
  );
  assert.ok(!/getApiKey/.test(handler), "an unused import is gone");
});

test("validation is opt-in, because it costs a network call per provider", () => {
  assert.match(handler, /if \(!payload\?\.validate\) return \{ providers \};/);
});

test("a single provider can be checked without checking them all", () => {
  assert.match(
    handler,
    /const only = payload\.provider \? \[payload\.provider\] : providers;/,
  );
});

test("a provider with no key stored says so rather than throwing", () => {
  assert.match(handler, /if \(!providers\.includes\(provider\)\)/);
  assert.match(handler, /"No key stored"/);
});

test("a validator that throws does not take the whole response down", () => {
  assert.match(
    handler,
    /catch \(err\) \{\s*\n\s*results\[provider\] = \{ valid: null/,
  );
});

test("the handler still never returns a key value", () => {
  assert.ok(!/value/.test(handler.replace(/\/\/.*$/gm, "")), "no key material");
  assert.match(handler, /return \{ providers, validation: results \}/);
});

// ── the panel side ───────────────────────────────────────────────────────────

test("saving a key checks it, and says which of the three outcomes it got", () => {
  const fn = panelSrc.match(
    /async function _saveAndValidateKey\(provider, label, inputId\) \{[\s\S]*?\n\}/,
  )[0];
  assert.match(fn, /type: "key:get",/);
  assert.match(fn, /validate: true, provider/);
  assert.match(fn, /result\.valid === true/);
  assert.match(fn, /result\.valid === false/);
  assert.match(
    fn,
    /inconclusive/,
    "a provider with no validator is not a failure",
  );
  assert.match(fn, /saved and verified/);
  assert.match(fn, /was rejected/);
});

test("all three save buttons go through it", () => {
  for (const p of ["2captcha", "openai", "gemini"]) {
    assert.match(
      panelSrc,
      new RegExp(`_saveAndValidateKey\\("${p}"`),
      `${p} still has its own copy`,
    );
  }
  // The three near-identical handlers collapsed into one call each.
  assert.equal(
    (panelSrc.match(/_saveAndValidateKey\(/g) ?? []).length,
    4,
    "three call sites and the definition",
  );
});

test("a save that fails outright does not claim to have checked anything", () => {
  const fn = panelSrc.match(
    /async function _saveAndValidateKey\(provider, label, inputId\) \{[\s\S]*?\n\}/,
  )[0];
  assert.match(fn, /if \(!res\?\.ok\) \{[\s\S]*?return;/);
  assert.ok(
    fn.indexOf("if (!res?.ok)") < fn.indexOf('type: "key:get"'),
    "the check only runs after a successful save",
  );
});

// ── F-10: the example ────────────────────────────────────────────────────────

const example = JSON.parse(
  await readFile(
    new URL("../examples/loop-select-click.json", import.meta.url),
    "utf8",
  ),
);

test("the example no longer builds a selector out of an element's tag name", () => {
  const json = JSON.stringify(example);
  assert.ok(
    !json.includes("{{item.tag}}"),
    "it rendered to e.g. div.product-link",
  );
  assert.equal(example.steps[0].children[0].config.selector, ".product-link");
});

test("the example uses a template that does resolve", () => {
  const nav = example.steps[0].children.find((s) => s.type === "NAVIGATE");
  assert.equal(
    nav.config.url,
    "{{item.href}}",
    "the current item, not items[2]",
  );
});

test("every step in the example is a real step type", () => {
  const walk = (steps) => {
    for (const s of steps ?? []) {
      assert.ok(isKnownStepType(s.type), `${s.type} is not in the registry`);
      assert.ok(!STEP_TYPES[s.type].internal, `${s.type} is internal-only`);
      walk(s.children);
      walk(s.ifBranch);
      walk(s.elseBranch);
    }
  };
  walk(example.steps);
});

test("the example would survive its own importer", () => {
  // _normalizeImportedPipeline requires an object with a steps array.
  assert.ok(Array.isArray(example.steps));
  assert.equal(typeof example.name, "string");
  assert.equal(typeof example.targetOrigin, "string");
});

test("the examples folder explains itself", async () => {
  const readme = await readFile(
    new URL("../examples/README.md", import.meta.url),
    "utf8",
  );
  assert.match(readme, /loop-select-click\.json/);
  assert.match(readme, /scoped to the current item/);
});
