// === row-formatters.js ===
/**
 * @module row-formatters
 * @description Turn result rows into text, in one place.
 *
 *   There were three independent implementations of this: _doExport in the
 *   service worker, the "Download Data" button in the side panel, and
 *   exporters/text-exporters.js — which was the only correct one and was never
 *   imported by anything. They disagreed in ways that lost data:
 *
 *     - The first two quoted every CSV field unconditionally and used
 *       `String(row[h] || "")`, so a legitimate 0 or false became an empty
 *       cell.
 *     - The service worker took the union of every row's keys; text-exporters
 *       and the MCP server used Object.keys(rows[0]), so a column absent from
 *       the first row vanished from the output entirely.
 *
 *   Formatting is pure: it returns a string and knows nothing about how the
 *   result is delivered. Callers handle downloads, file pickers or MCP
 *   responses themselves.
 *
 * @dependencies none
 */

"use strict";

/** @typedef {'csv'|'json'|'jsonl'|'tsv'|'xml'|'markdown'} RowFormat */

/** Formats offered to the user, in the order the UI lists them. */
export const ROW_FORMATS = Object.freeze([
  "csv",
  "json",
  "jsonl",
  "tsv",
  "xml",
  "markdown",
]);

const META = Object.freeze({
  csv: { ext: "csv", mime: "text/csv", label: "CSV" },
  json: { ext: "json", mime: "application/json", label: "JSON" },
  jsonl: { ext: "jsonl", mime: "application/x-ndjson", label: "JSONL" },
  tsv: { ext: "tsv", mime: "text/tab-separated-values", label: "TSV" },
  xml: { ext: "xml", mime: "application/xml", label: "XML" },
  markdown: { ext: "md", mime: "text/markdown", label: "Markdown" },
});

/**
 * File extension, MIME type and display label for a format.
 * @param {RowFormat} format
 */
export function formatMeta(format) {
  const meta = META[format];
  if (!meta) throw new Error(`Unsupported export format: ${format}`);
  return meta;
}

/**
 * Column names, as the union of every row's keys in first-seen order.
 *
 * Object.keys(rows[0]) silently drops any column the first row happens not to
 * have — which for scraped data is the common case, not an edge case.
 *
 * @param {object[]} rows
 * @returns {string[]}
 */
export function collectHeaders(rows) {
  const headers = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row ?? {})) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  return headers;
}

/**
 * Stringify one cell. Null and undefined become empty; every other value keeps
 * its text, including 0 and false.
 */
function cell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** RFC 4180: quote only when needed, and double any embedded quote. */
function csvEscape(value) {
  const text = cell(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCSV(rows, headers) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row?.[h])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function toTSV(rows, headers) {
  const clean = (v) => cell(v).replace(/[\t\r\n]/g, " ");
  const lines = [headers.map(clean).join("\t")];
  for (const row of rows) {
    lines.push(headers.map((h) => clean(row?.[h])).join("\t"));
  }
  return lines.join("\n") + "\n";
}

const XML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};
const xmlEscape = (v) => cell(v).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/** XML element names cannot start with a digit or contain arbitrary characters. */
function xmlTag(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9_.-]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

function toXML(rows, headers) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<rows>"];
  for (const row of rows) {
    lines.push("  <row>");
    for (const header of headers) {
      const tag = xmlTag(header);
      lines.push(`    <${tag}>${xmlEscape(row?.[header])}</${tag}>`);
    }
    lines.push("  </row>");
  }
  lines.push("</rows>");
  return lines.join("\n") + "\n";
}

function toMarkdown(rows, headers) {
  // A pipe inside a cell would otherwise start a new column.
  const md = (v) => cell(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const lines = [
    `| ${headers.map(md).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${headers.map((h) => md(row?.[h])).join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Render rows as text in the requested format.
 *
 * @param {object[]} rows
 * @param {RowFormat} format
 * @returns {string}
 */
export function formatRows(rows, format) {
  const safeRows = Array.isArray(rows) ? rows : [];

  if (format === "json") return JSON.stringify(safeRows, null, 2);
  if (format === "jsonl") {
    return (
      safeRows.map((row) => JSON.stringify(row)).join("\n") +
      (safeRows.length ? "\n" : "")
    );
  }

  formatMeta(format); // rejects an unknown format before doing any work
  if (safeRows.length === 0) return "";

  const headers = collectHeaders(safeRows);
  switch (format) {
    case "csv":
      return toCSV(safeRows, headers);
    case "tsv":
      return toTSV(safeRows, headers);
    case "xml":
      return toXML(safeRows, headers);
    case "markdown":
      return toMarkdown(safeRows, headers);
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}

/**
 * Default filename for a format.
 * @param {RowFormat} format
 * @param {string} [stem='export']
 */
export function defaultFilename(format, stem = "export") {
  return `${stem}.${formatMeta(format).ext}`;
}

// === END row-formatters.js ===
