// Parses every extension source file as an ES module.
//
// The extension has no build step, so nothing else would catch a syntax error
// before Chrome does — and a broken content script fails silently on the page
// rather than anywhere you would look.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKIP = new Set(["node_modules", ".git", "bin", "fonts"]);

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.m?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = await walk(ROOT);
const failures = [];

for (const file of files) {
  const source = await readFile(file, "utf8");
  const res = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    failures.push({ file: relative(ROOT, file), error: res.stderr.trim().split("\n")[0] });
  }
}

for (const f of failures) console.error(`FAIL ${f.file}\n     ${f.error}`);
console.log(
  `${files.length - failures.length}/${files.length} files parse as ES modules`,
);
process.exit(failures.length ? 1 : 0);
