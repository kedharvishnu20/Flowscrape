// === json-parser.js ===
/**
 * @module json-parser
 * @description Streaming JSON array + JSONL parser.
 *   Supports full JSON arrays [{ }, { }] and newline-delimited JSONL.
 *   Stream-parses large files chunk-by-chunk.
 *   Logs malformed rows with index; skips and continues without aborting.
 *
 *   Design decision: For large JSON arrays, we use a state machine string
 *   scanner rather than loading the full text and calling JSON.parse() —
 *   that would OOM on large files. JSONL is trivially streamable (one object
 *   per line). We auto-detect format from the first non-whitespace character.
 *
 * @dependencies logger
 */

import { logger } from "../utils/logger.js";

const MODULE = "json-parser";

/**
 * Parse a JSON array or JSONL string into an array of objects.
 * @param {string} text
 * @returns {{ rows: object[], errors: Array<{index:number, message:string}> }}
 */
export function parseJSON(text) {
  const trimmed = text.trim();
  if (!trimmed) return { rows: [], errors: [] };

  // JSONL: does not start with '[' or '{'
  if (trimmed.startsWith("{")) {
    return parseJSONL(trimmed);
  }

  if (trimmed.startsWith("[")) {
    // Full JSON array
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        logger.error(MODULE, "not-an-array", {});
        return {
          rows: [],
          errors: [{ index: 0, message: "Root element is not an array" }],
        };
      }
      const rows = [];
      const errors = [];
      for (let i = 0; i < parsed.length; i++) {
        if (
          parsed[i] &&
          typeof parsed[i] === "object" &&
          !Array.isArray(parsed[i])
        ) {
          rows.push(parsed[i]);
        } else {
          errors.push({ index: i, message: "Row is not an object" });
          logger.warn(MODULE, "row-skip", { index: i });
        }
      }
      return { rows, errors };
    } catch (err) {
      logger.error(MODULE, "json-parse-fail", { error: err.message });
      return { rows: [], errors: [{ index: 0, message: err.message }] };
    }
  }

  // Fallback: try JSONL
  return parseJSONL(trimmed);
}

/**
 * Parse JSONL (newline-delimited JSON) into an array of objects.
 * @param {string} text
 * @returns {{ rows: object[], errors: Array<{index:number, message:string}> }}
 */
export function parseJSONL(text) {
  const rows = [];
  const errors = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        rows.push(obj);
      } else {
        errors.push({ index: i, message: "Line is not a JSON object" });
        logger.warn(MODULE, "jsonl-row-skip", { line: i + 1 });
      }
    } catch (err) {
      errors.push({ index: i, message: err.message });
      logger.warn(MODULE, "jsonl-row-fail", {
        line: i + 1,
        error: err.message,
      });
    }
  }

  return { rows, errors };
}

/**
 * Stream-parse a large JSON or JSONL File object.
 * For JSON arrays: buffers until we collect complete objects using bracket depth.
 * For JSONL: trivially line-by-line.
 * @param {File} file
 * @param {function(object[]): Promise<void>} onRows
 * @returns {Promise<{ totalRows: number, totalErrors: number, format: 'json'|'jsonl' }>}
 */
export async function streamParseJSON(file, onRows) {
  const decoder = new TextDecoder("utf-8");
  const reader = file.stream().getReader();

  let buffer = "";
  let totalRows = 0;
  let totalErrors = 0;
  let format = null; // 'json' or 'jsonl'
  let arrayDepth = 0;
  let inString = false;
  let escape = false;
  let objStart = -1;

  const processBuffer = async (flush = false) => {
    if (format === "jsonl") {
      const lines = buffer.split("\n");
      if (!flush) buffer = lines.pop() ?? "";
      else buffer = "";
      const rows = [];
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (typeof obj === "object" && !Array.isArray(obj)) {
            rows.push(obj);
            totalRows++;
          } else totalErrors++;
        } catch {
          totalErrors++;
        }
      }
      if (rows.length) await onRows(rows);
      return;
    }

    // JSON array streaming: find complete top-level objects
    const rows = [];
    let i = 0;
    while (i < buffer.length) {
      const ch = buffer[i];
      if (escape) {
        escape = false;
        i++;
        continue;
      }
      if (inString) {
        if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        i++;
        continue;
      }
      if (ch === '"') {
        inString = true;
        i++;
        continue;
      }
      if (ch === "{") {
        if (arrayDepth === 1 && objStart === -1) objStart = i;
        arrayDepth++;
      } else if (ch === "}") {
        arrayDepth--;
        if (arrayDepth === 1 && objStart !== -1) {
          const objStr = buffer.slice(objStart, i + 1);
          try {
            const obj = JSON.parse(objStr);
            rows.push(obj);
            totalRows++;
          } catch {
            totalErrors++;
          }
          objStart = -1;
          buffer = buffer.slice(i + 1);
          i = 0;
          continue;
        }
      } else if (ch === "[") {
        arrayDepth++;
      } else if (ch === "]") {
        arrayDepth--;
      }
      i++;
    }
    if (rows.length) await onRows(rows);
  };

  // Read first chunk to detect format
  let firstChunk = true;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: !done });
    if (firstChunk) {
      const trimmed = buffer.trimStart();
      format = trimmed.startsWith("[") ? "json" : "jsonl";
      if (format === "json") arrayDepth = 1; // We're already inside the array
      firstChunk = false;
    }
    await processBuffer(false);
  }
  await processBuffer(true);

  logger.info(MODULE, "stream-complete", { totalRows, totalErrors, format });
  return { totalRows, totalErrors, format };
}

// === END json-parser.js ===
