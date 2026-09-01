// Regression tests for audit findings C-06, G-02 and F-06.
//
// C-06: startHttpServer called app.listen(HTTP_PORT) with no host, so the
// socket bound every interface — reachable from the local network with no
// authentication — while repo_write_file was a registered tool. The SDK's
// createMcpExpressApp applies DNS-rebinding protection for loopback hosts, but
// it was called with no options, so the middleware and the socket disagreed
// about what was being protected.
//
// G-02: mcp/README.md documents `--root "path"` and `--port 3000`, but the
// parser accepted only `--root=path`. Following the README silently ignored
// --root and rooted the server at the repository directory.
//
// F-06: pipeline_list called readdir on pipelines/, which does not exist in a
// fresh clone, so the tool threw ENOENT instead of reporting an empty library.
//
// server.mjs starts a transport on import, so the CLI parser is extracted and
// the rest asserted at source level.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const src = await readFile(
  new URL("../mcp/server.mjs", import.meta.url),
  "utf8",
);

const resolveArgValue = new Function(
  `${src.match(/function resolveArgValue\([\s\S]*?\n\}/)[0]}; return resolveArgValue;`,
)();

test("CLI flags accept both --name=value and --name value", () => {
  assert.equal(resolveArgValue(["--root=/tmp/ws"], "--root"), "/tmp/ws");
  assert.equal(
    resolveArgValue(["--root", "/tmp/ws"], "--root"),
    "/tmp/ws",
    "the space form is what mcp/README.md documents",
  );
  assert.equal(resolveArgValue(["--port", "3000"], "--port"), "3000");
});

test("a flag with no value does not swallow the next flag", () => {
  assert.equal(
    resolveArgValue(["--root", "--transport=stdio"], "--root"),
    null,
  );
  assert.equal(resolveArgValue([], "--root"), null);
  assert.equal(resolveArgValue(["--other=1"], "--root"), null);
});

test("a path containing spaces survives the = form", () => {
  assert.equal(
    resolveArgValue(["--root=/my space/project"], "--root"),
    "/my space/project",
  );
});

test("the HTTP socket binds the host the middleware protects", () => {
  assert.match(
    src,
    /app\.listen\(HTTP_PORT, HTTP_HOST,/,
    "listen with no host binds every interface regardless of the middleware",
  );
  assert.match(
    src,
    /createMcpExpressApp\(\{ host: HTTP_HOST \}\)/,
    "the app must know which host it is protecting",
  );
});

test("the default bind address is loopback", () => {
  assert.match(src, /process\.env\.HOST \s*\?\?\s*\n?\s*"127\.0\.0\.1"/);
});

test("binding beyond loopback warns that there is no authentication", () => {
  assert.match(src, /if \(!LOOPBACK_HOSTS\.has\(HTTP_HOST\)\)/);
  assert.match(src, /This server has no authentication/);
});

test("workspace writes are refused over HTTP unless enabled", () => {
  assert.match(
    src,
    /TRANSPORT_MODE === "stdio" \|\| process\.argv\.slice\(2\)\.includes\("--allow-write"\)/,
    "stdio means a process the user started; HTTP means anyone who reaches the port",
  );
  assert.match(src, /assertWritesAllowed\("repo_write_file"\)/);
  assert.match(src, /assertWritesAllowed\("pipeline_save"\)/);
});

test("the write refusal explains how to enable it", () => {
  const fn = src.match(/function assertWritesAllowed\([\s\S]*?\n\}/)[0];
  assert.match(fn, /--allow-write/);
});

test("listing pipelines in a fresh clone returns empty, not ENOENT", () => {
  const fn = src.match(/async function listPipelineFiles\([\s\S]*?\n\}\n/)[0];
  assert.match(fn, /if \(err\.code === "ENOENT"\) return entries;/);
});

// ── Later findings: G-06, G-07, G-08, and B-14/B-16 on the MCP side ──────────

test("repo_search_text says a glob is not a directory", () => {
  const tool = src.match(
    /server\.tool\(\s*\n\s*"repo_search_text"[\s\S]*?\n\);/,
  )[0];
  assert.match(tool, /if \(\/\[\*\?\[\\\]\]\/\.test\(include\)\)/);
  assert.match(tool, /include is a directory, not a glob/);
  assert.match(tool, /filePattern for a file-name regular expression/);
});

test("repo_search_text can filter file names, which is what a glob was for", () => {
  const tool = src.match(
    /server\.tool\(\s*\n\s*"repo_search_text"[\s\S]*?\n\);/,
  )[0];
  assert.match(tool, /filePattern: z\s*\n?\s*\.string\(\)/);
  assert.match(tool, /nameFilter = new RegExp\(filePattern\)/);
  assert.match(tool, /!nameFilter\.test\(toWorkspaceRelative\(file\)\)/);
  assert.match(
    tool,
    /not a valid regular expression/,
    "a bad pattern is named",
  );
});

test("the search regex is built per file, not shared across the loop", () => {
  const tool = src.match(
    /server\.tool\(\s*\n\s*"repo_search_text"[\s\S]*?\n\);/,
  )[0];
  const loop = tool.match(/for \(const file of files\) \{[\s\S]*?\n {4}\}/)[0];
  assert.match(loop, /const needle = regex/, "constructed inside the loop");
});

test("pipeline_report no longer emits two scripts to measure their length", () => {
  const tool = src.match(
    /server\.tool\(\s*\n\s*"pipeline_report"[\s\S]*?\n\);/,
  )[0];
  assert.ok(!/pythonBytes/.test(tool), "a byte count nobody can act on");
  assert.ok(
    !/emitPython\(/.test(tool),
    "and two full code generations per call",
  );
  assert.match(tool, /unexportable: compiled\.ast \? findUnexportableSteps/);
  assert.match(tool, /unresolvedTemplates/);
});

test("both MCP emit tools redact credentials, like the extension does", () => {
  for (const name of ["pipeline_emit_python", "pipeline_emit_node"]) {
    const tool = src.match(
      new RegExp(`server\\.tool\\(\\s*\\n\\s*"${name}"[\\s\\S]*?\\n\\);`),
    )[0];
    assert.match(
      tool,
      /const templates = findUnresolvedTemplates\(ast\);/,
      name,
    );
    assert.match(tool, /const secrets = redactSecrets\(ast\);/, name);
    assert.ok(
      tool.indexOf("findUnresolvedTemplates") < tool.indexOf("redactSecrets"),
      `${name}: the scan must read the original values`,
    );
    assert.ok(
      tool.indexOf("redactSecrets") < tool.indexOf("code:"),
      `${name}: redaction must happen before the code is emitted`,
    );
  }
});
