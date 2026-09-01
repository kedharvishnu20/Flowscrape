// === text-exporters.js ===
/**
 * @module exporters/text-exporters
 * @description Write result rows to a file the user chooses.
 *
 *   Formatting lives in row-formatters.js; this module only handles delivery.
 *   It used to carry its own CSV, TSV, XML and Markdown implementations, which
 *   were the fourth copy in the repository and disagreed with the others —
 *   headers came from Object.keys(rows[0]), so a column missing from the first
 *   row was dropped.
 *
 *   NOT CURRENTLY REACHED. Nothing imports this module: the EXPORT step is
 *   handled by _doExport in the service worker, which downloads directly. This
 *   exists for a caller that wants the File System Access API's save dialog,
 *   which a service worker cannot show. See docs/ISSUE_AUDIT.md F-01.
 *
 * @dependencies row-formatters, stream-writer
 */

import { formatRows, formatMeta, defaultFilename } from './row-formatters.js';
import { createWriter } from './stream-writer.js';

/**
 * Write rows to a file in the given format.
 *
 * @param {object[]} rows
 * @param {import('./row-formatters.js').RowFormat} format
 * @param {string} [filename] - defaults to export.<ext>
 * @returns {Promise<void>}
 */
export async function exportRows(rows, format, filename) {
  if (!Array.isArray(rows) || rows.length === 0) return;

  const { mime } = formatMeta(format);
  const writer = await createWriter(filename ?? defaultFilename(format), mime);

  await writer.write(formatRows(rows, format));
  await writer.close();
}

/** @param {object[]} rows @param {string} [filename] */
export const exportCSV = (rows, filename = 'export.csv') => exportRows(rows, 'csv', filename);
/** @param {object[]} rows @param {string} [filename] */
export const exportJSON = (rows, filename = 'export.json') => exportRows(rows, 'json', filename);
/** @param {object[]} rows @param {string} [filename] */
export const exportJSONL = (rows, filename = 'export.jsonl') => exportRows(rows, 'jsonl', filename);
/** @param {object[]} rows @param {string} [filename] */
export const exportTSV = (rows, filename = 'export.tsv') => exportRows(rows, 'tsv', filename);
/** @param {object[]} rows @param {string} [filename] */
export const exportXML = (rows, filename = 'export.xml') => exportRows(rows, 'xml', filename);
/** @param {object[]} rows @param {string} [filename] */
export const exportMarkdown = (rows, filename = 'export.md') => exportRows(rows, 'markdown', filename);

// === END text-exporters.js ===
