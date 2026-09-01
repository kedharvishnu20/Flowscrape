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

const src = await readFile(new URL("../mcp/server.mjs", import.meta.url), "utf8");

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
  assert.equal(resolveArgValue(["--root", "--transport=stdio"], "--root"), null);
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
  assert.match(src, /process\.env\.HOST \?\? "127\.0\.0\.1"/);
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
