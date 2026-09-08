# FlowScrape v3 MCP

This folder contains a standalone Model Context Protocol server for the FlowScrape workspace.

## What it exposes

- Workspace file tools: list, read, write, and text search
- Pipeline tooling: compile, validate, serialize, and emit Python or Node scripts
- Pipeline storage: save, load, and list reusable pipeline files
- Safety checks: PII scan and robots.txt check
- Row formatting: render CSV, JSON, JSONL, TSV, XML, or Markdown
- PDF scraping: extract text from local or URL PDFs

PDF tool inputs:

- source: local workspace path or HTTP/HTTPS PDF URL
- fileBase64: uploaded PDF bytes encoded as base64 (or data URL)
- fileName: optional label for uploaded payloads

## Install

From this folder:

```bash
npm install
```

## Run

Local stdio mode:

```bash
npm start -- --root /path/to/flowscrape
```

Both `--root /path` and `--root=/path` work. Omit it to root the server at the
repository folder.

HTTP mode for broader MCP clients:

```bash
npm run start:http -- --root /path/to/flowscrape --port 3000
```

HTTP mode binds `127.0.0.1` by default and the SDK applies DNS-rebinding
protection for loopback hosts. `--host` overrides the bind address; anything
beyond loopback has **no authentication** and loses that protection, so the
server warns when you do it.

Workspace writes (`repo_write_file`, `pipeline_save`) are refused over HTTP
unless you pass `--allow-write`. Over stdio the client is a process you started,
so they are allowed.

If your MCP client accepts a command directly, point it at `node server.mjs` inside this folder.

If your client supports MCP over HTTP, connect it to `http://localhost:3000/mcp` after starting HTTP mode.

## Notes

- The server is rooted at the repository folder by default.
- File tools refuse paths that escape the workspace root.
- The generated scripts come from the repo's `script-gen/` modules, and cover
  11 of the 21 step types — see the Script export section of the root README.
- Step validation and row formatting are shared with the extension
  (`utils/step-types.js`, `exporters/row-formatters.js`), so `pipeline_validate`
  and `rows_to_text` agree with what the extension does.
- Saved pipelines live in `pipelines/`, which is created on first save. Listing
  an absent folder returns an empty list rather than an error.
