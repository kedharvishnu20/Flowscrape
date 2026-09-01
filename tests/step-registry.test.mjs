// Regression tests for audit finding G-01.
//
// The step vocabulary was copy-pasted into four places — the side panel's
// STEP_REGISTRY, injector.js's _executeStep switch, both script emitters, and
// mcp/server.mjs's supportedStepTypes — and had drifted in all of them. The MCP
// list was missing 11 real types, so pipeline_validate reported FILL and
// AUTO_EXTRACT as "unsupported" for pipelines the UI had just built, while
// listing FORM_FILL, which is not a step type at all.
//
// utils/step-types.js is now the one definition. Everything that can import a
// module reads it; injector.js is a classic content script that cannot, so its
// switch is checked against the registry here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  STEP_TYPES,
  ALL_STEP_TYPES,
  USER_STEP_TYPES,
  PAGE_STEP_TYPES,
  isKnownStepType,
  defaultConfig,
} from "../utils/step-types.js";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

const injectorSrc = await read("content/injector.js");
const panelSrc = await read("sidepanel/pipeline-builder.js");
const mcpSrc = await read("mcp/server.mjs");

/** Step types injector's _executeStep actually dispatches. */
function injectorCases() {
  const fn = injectorSrc.match(/async function _executeStep\(step\) \{[\s\S]*?\n\}/)[0];
  return new Set([...fn.matchAll(/case "([A-Z_]+)":/g)].map((m) => m[1]));
}

test("the registry is well formed", () => {
  for (const [type, entry] of Object.entries(STEP_TYPES)) {
    assert.ok(entry.icon, `${type} has an icon`);
    assert.ok(["Action", "Flow", "Data"].includes(entry.cat), `${type} has a category`);
    assert.ok(entry.desc, `${type} has a description`);
    assert.ok(["page", "background"].includes(entry.runsIn), `${type} declares where it runs`);
    assert.equal(typeof entry.def, "object", `${type} has defaults`);
  }
});

test("injector handles every step type that runs in the page", () => {
  const handled = injectorCases();
  const missing = PAGE_STEP_TYPES.filter((t) => !handled.has(t));
  assert.deepEqual(missing, [], "these would throw 'Unknown step type' at runtime");
});

test("injector has no cases for types the registry does not know", () => {
  const handled = [...injectorCases()];
  const unknown = handled.filter((t) => !isKnownStepType(t));
  assert.deepEqual(
    unknown,
    [],
    "a handler with no registry entry is unreachable, or the registry is missing a type",
  );
});

test("the MCP server derives its supported types from the registry", () => {
  assert.match(
    mcpSrc,
    /const supportedStepTypes = new Set\(ALL_STEP_TYPES\)/,
    "hand-maintaining this list is what caused the drift",
  );
  assert.match(mcpSrc, /import \{ ALL_STEP_TYPES \} from "\.\.\/utils\/step-types\.js"/);
});

test("FORM_FILL is not advertised as a step type", () => {
  // It has ethics gates, emitter cases and an MCP entry, but no registry entry
  // and no injector case — see audit A-07. Nothing should claim it exists.
  assert.ok(!isKnownStepType("FORM_FILL"));
  assert.ok(!injectorCases().has("FORM_FILL"));
});

test("the side panel builds its palette from the registry", () => {
  assert.match(
    panelSrc,
    /import \{[\s\S]*?STEP_TYPES,[\s\S]*?USER_STEP_TYPES,[\s\S]*?defaultConfig,?[\s\S]*?\} from "\.\.\/utils\/step-types\.js"/,
  );
  assert.ok(
    !/const STEP_REGISTRY = \{\n\s+WEBSITE:/.test(panelSrc),
    "the inline copy is gone",
  );
});

test("internal dispatch types stay out of the palette", () => {
  for (const type of ["TYPE", "QUERY_COUNT", "QUERY_ELEMENTS"]) {
    assert.ok(isKnownStepType(type), `${type} is still recognised`);
    assert.ok(!USER_STEP_TYPES.includes(type), `${type} is not offered in the palette`);
  }
});

test("every palette type has a colour token in the panel stylesheet", async () => {
  // --step-FILL, --step-PDF_EXTRACTION and --step-AUTO_EXTRACT were missing
  // while stale --step-TYPE and --step-FORM_FILL remained (audit E-08), and the
  // palette uses var(--step-X) with no fallback.
  const html = await read("sidepanel/index.html");
  const defined = new Set(
    [...html.matchAll(/--step-([A-Z_]+)\s*:/g)].map((m) => m[1]),
  );
  const missing = USER_STEP_TYPES.filter((t) => !defined.has(t));
  assert.deepEqual(missing, [], "these render with no background in the palette");
});

test("defaultConfig hands out a fresh object every time", () => {
  const a = defaultConfig("EXTRACT");
  const b = defaultConfig("EXTRACT");
  a.fields.push({ name: "x" });
  assert.deepEqual(b.fields, [], "two steps must not share one defaults object");
});

test("defaultConfig rejects an unknown type", () => {
  assert.throws(() => defaultConfig("NOPE"), /Unknown step type/);
});

test("every registry type is reachable from some executor", () => {
  const handled = injectorCases();
  const swSrc = ALL_STEP_TYPES.filter(
    (t) => STEP_TYPES[t].runsIn === "background",
  );
  for (const type of ALL_STEP_TYPES) {
    const inPage = handled.has(type);
    const inBackground = swSrc.includes(type);
    assert.ok(inPage || inBackground, `${type} has no executor`);
  }
});
