// Regression test for audit finding I-04.
//
// The same version was written out separately in manifest.json,
// utils/strings.js, mcp/server.mjs (twice) and pipeline-compiler.js's AST
// stamp, while mcp/package.json had none at all and the git history called the
// same code both v3 and v4. Nothing kept any of them in step.
//
// utils/version.js is the one definition now, mirroring manifest.json — which
// is the copy Chrome actually reads, so it stays canonical. This test is what
// makes that true rather than aspirational: it fails the moment they drift.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { VERSION } from "../utils/version.js";
import { S } from "../utils/strings.js";
import { compilePipeline } from "../script-gen/pipeline-compiler.js";

const json = async (p) =>
  JSON.parse(await readFile(new URL(p, import.meta.url), "utf8"));

test("the manifest and utils/version.js agree", async () => {
  const manifest = await json("../manifest.json");
  assert.equal(
    manifest.version,
    VERSION,
    "manifest.json is what Chrome reads; version.js mirrors it",
  );
});

test("every package manifest carries the same version", async () => {
  assert.equal((await json("../package.json")).version, VERSION);
  assert.equal(
    (await json("../mcp/package.json")).version,
    VERSION,
    "the MCP package had no version at all",
  );
});

test("the UI strings read the shared constant", () => {
  assert.equal(S.VERSION, VERSION);
  assert.equal(S.APP_NAME, `FlowScrape v${VERSION.split(".")[0]}`);
});

test("a compiled pipeline is stamped with it", () => {
  const { ast } = compilePipeline({ name: "t", targetOrigin: "", steps: [] });
  assert.equal(ast.version, VERSION, "the stamp was a hardcoded literal");
});

test("a pipeline that declares its own version keeps it", () => {
  const { ast } = compilePipeline({
    name: "t",
    version: "2.4.0",
    targetOrigin: "",
    steps: [],
  });
  assert.equal(ast.version, "2.4.0", "an imported pipeline is not restamped");
});

test("the MCP server identifies itself with it", async () => {
  const src = await readFile(
    new URL("../mcp/server.mjs", import.meta.url),
    "utf8",
  );
  assert.match(src, /import \{ VERSION \} from "\.\.\/utils\/version\.js";/);

  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !/version: "\d+\.\d+\.\d+"/.test(code),
    "no literal version string is left in the server",
  );
});

test("no source file still hardcodes the version", async () => {
  // Docs and changelogs legitimately name versions; source should not.
  const files = [
    "../utils/strings.js",
    "../script-gen/pipeline-compiler.js",
    "../background/service-worker.js",
  ];
  for (const f of files) {
    const src = await readFile(new URL(f, import.meta.url), "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !new RegExp(`["']${VERSION.replace(/\./g, "\\.")}["']`).test(code),
      `${f} still has the version written out`,
    );
  }
});
