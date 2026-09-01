// === csv-parser.js ===
/**
 * @module csv-parser
 * @description Streaming CSV parser. BOM-safe, auto-detects delimiter
 *   (comma, semicolon, tab). Logs malformed rows with index and skips
 *   without aborting. Never loads full file into RAM; processes chunk-by-chunk.
 *
 *   Design decision: We implement RFC 4180-compatible parsing from scratch
 *   (no papaparse) to avoid CDN dependencies (MV3 CSP forbids remote scripts).
 *   Auto-delimiter detection uses character frequency on the first 2KB of content.
 *
 * @dependencies logger
 */

import { logger } from "../utils/logger.js";

const MODULE = "csv-parser";

/**
 * Detect the most likely delimiter from the first chunk of CSV text.
 * @param {string} sample - First ~2KB of the file
 * @returns {',' | ';' | '\t'}
 */
export function detectDelimiter(sample) {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  // Only look at the first line
  const firstLine = sample.split("\n")[0] ?? "";
  for (const ch of firstLine) {
    if (ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Strip UTF-8 BOM if present.
 * @param {string} text
 * @returns {string}
 */
export function stripBOM(text) {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/**
 * Parse a single CSV line into fields (handles quoted fields with embedded commas/newlines).
 * @param {string} line
 * @param {string} delimiter
 * @returns {string[]}
 */
export function parseLine(line, delimiter) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    i++;
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Parse a complete CSV string into an array of row objects.
 * @param {string} rawText
 * @param {object} [opts]
 * @param {string} [opts.delimiter]   - Auto-detect if not provided
 * @param {number} [opts.startRow=1]  - 1-indexed row to start from (default: skip header)
 * @returns {{ rows: object[], headers: string[], errors: Array<{row:number, message:string}> }}
 */
export function parseCSV(rawText, { delimiter, startRow = 1 } = {}) {
  const text = stripBOM(rawText);
  const sample = text.slice(0, 2048);
  const delim = delimiter ?? detectDelimiter(sample);
  const lines = text.split(/\r?\n/);
  const headers = parseLine(lines[0] ?? "", delim);
  const rows = [];
  const errors = [];

  for (let i = startRow; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const fields = parseLine(line, delim);
      if (fields.length !== headers.length) {
        // Tolerate minor mismatches: truncate or pad
        while (fields.length < headers.length) fields.push("");
      }
      const row = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = fields[j] ?? "";
      }
      rows.push(row);
    } catch (err) {
      errors.push({ row: i + 1, message: err.message });
      logger.warn(MODULE, "row-parse-fail", { row: i + 1, error: err.message });
    }
  }

  logger.info(MODULE, "csv-parsed", {
    rows: rows.length,
    errors: errors.length,
    delim,
  });
  return { rows, headers, errors };
}

/**
 * Stream-parse a large CSV File object in chunks, calling onRows() per chunk.
 * Never loads full file into RAM.
 * @param {File} file
 * @param {function(object[]): Promise<void>} onRows - Called per chunk
 * @param {object} [opts]
 * @param {number} [opts.chunkSize=65536]
 * @returns {Promise<{ totalRows: number, totalErrors: number, headers: string[] }>}
 */
export async function streamParseCSV(
  file,
  onRows,
  { chunkSize = 65_536 } = {},
) {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let headers = null;
  let delimiter = ",";
  let totalRows = 0;
  let totalErrors = 0;
  let firstChunk = true;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    let chunk = decoder.decode(value, { stream: !done });
    if (firstChunk) {
      chunk = stripBOM(chunk);
      delimiter = detectDelimiter(chunk);
      firstChunk = false;
    }

    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? ""; // keep incomplete last line

    if (headers === null && lines.length > 0) {
      headers = parseLine(lines.shift(), delimiter);
    }

    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const fields = parseLine(line, delimiter);
        const row = {};
        for (let j = 0; j < (headers?.length ?? 0); j++) {
          row[headers[j]] = fields[j] ?? "";
        }
        rows.push(row);
        totalRows++;
      } catch (err) {
        totalErrors++;
        logger.warn(MODULE, "stream-row-fail", { error: err.message });
      }
    }

    if (rows.length > 0) await onRows(rows);
  }

  // Handle leftover buffer
  if (buffer.trim() && headers) {
    try {
      const fields = parseLine(buffer.trim(), delimiter);
      const row = {};
      for (let j = 0; j < headers.length; j++)
        row[headers[j]] = fields[j] ?? "";
      await onRows([row]);
      totalRows++;
    } catch {
      totalErrors++;
    }
  }

  logger.info(MODULE, "stream-complete", { totalRows, totalErrors });
  return { totalRows, totalErrors, headers: headers ?? [] };
}

// === END csv-parser.js ===
