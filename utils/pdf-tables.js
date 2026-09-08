// === pdf-tables.js ===
/**
 * @module pdf-tables
 * @description Getting a table back out of a PDF.
 *
 *   A PDF has no notion of a table. It has strings, and coordinates to draw
 *   them at; the grid is something a reader's eye assembles. So the whole job
 *   is reassembling it from positions — which is why `PDF_EXTRACTION` returned
 *   one long blob of text before this, with the columns run together.
 *
 *   Three decisions, each with a way of being wrong that looks like success:
 *
 *   - **Rows come from y, with a tolerance.** Cells on one line are rarely at
 *     exactly the same y — a superscript, a different font size, a rounding
 *     difference of a hundredth of a point. Demanding equality puts every cell
 *     on its own row, and the result still looks like a table.
 *   - **Columns come from clustering x, not from counting cells.** A row with
 *     an empty cell has fewer cells than its neighbours. Matching by position
 *     puts the values under the right headings and leaves the gap empty;
 *     matching by index shifts everything after the gap one column left, and
 *     nothing about the output says so.
 *   - **A row drawn as one string is split on runs of spaces.** Some writers
 *     lay a whole row out with padding rather than positioning each cell.
 *     There are no positions to cluster there, and two or more spaces is what
 *     the padding looks like.
 *
 * @dependencies none
 */

/**
 * How far apart two cells' y positions can be and still be one row.
 *
 * In PDF units, which are points — so this is about a tenth of a line at
 * ordinary body sizes. Large enough for a superscript or a font-size change,
 * small enough that two real rows never merge.
 */
export const ROW_TOLERANCE = 3;

/**
 * How far apart two cells' x positions can be and still be one column.
 *
 * Wider than the row tolerance on purpose: a right-aligned number column
 * varies by the width of a digit, and a centred one by half a cell.
 */
export const COLUMN_TOLERANCE = 12;

/**
 * Group positioned text runs into rows, in reading order.
 *
 * **Which way is up is not knowable from the numbers.** PDF's default user
 * space has y growing upward, so descending y looks like reading order — and
 * that is what this did first. But a page can install a transformation matrix
 * that flips the axis, and Chrome's own print-to-PDF does exactly that: its
 * tables come out with the last row at the highest y, so the header ended up
 * at the bottom and every column was named after a data value.
 *
 * So y decides only which cells share a row; the *order* of the rows comes
 * from the order the writer emitted them, which is reading order in every
 * writer worth reading and is what the plain-text reader has always relied on.
 *
 * @param {Array<{x: number, y: number, text: string}>} items - in document order
 * @param {{rowTolerance?: number}} [opts]
 * @returns {Array<Array<{x: number, y: number, text: string}>>}
 */
export function groupIntoRows(items, opts = {}) {
  const tolerance = Number(opts.rowTolerance) || ROW_TOLERANCE;
  const indexed = (items ?? []).map((item, at) => ({ ...item, at }));
  // Sorted by y only to find the groups: a run's neighbours in y are its row,
  // whichever direction y happens to run in.
  const byY = [...indexed].sort((a, b) => a.y - b.y || a.at - b.at);

  const rows = [];
  for (const item of byY) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - item.y) <= tolerance) row.push(item);
    else rows.push([item]);
  }

  for (const row of rows) row.sort((a, b) => a.x - b.x || a.at - b.at);
  // Reading order: the row whose first cell was drawn first comes first.
  rows.sort(
    (a, b) => Math.min(...a.map((c) => c.at)) - Math.min(...b.map((c) => c.at)),
  );
  return rows;
}

/**
 * The x positions the page's columns sit at.
 *
 * Clustered rather than taken from any one row: the header row alone would
 * miss a column that only later rows use, and the widest row alone would
 * include a wrapped line's continuation as a column of its own.
 *
 * @param {Array<Array<{x: number}>>} rows
 * @param {{columnTolerance?: number}} [opts]
 * @returns {number[]} column x positions, left to right
 */
export function columnPositions(rows, opts = {}) {
  const tolerance = Number(opts.columnTolerance) || COLUMN_TOLERANCE;
  const xs = rows
    .flat()
    .map((c) => c.x)
    .sort((a, b) => a - b);
  const clusters = [];

  for (const x of xs) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.at <= tolerance) {
      last.sum += x;
      last.n++;
      last.at = last.sum / last.n;
    } else {
      clusters.push({ sum: x, n: 1, at: x });
    }
  }
  return clusters.map((c) => c.at);
}

/**
 * Split a row that was drawn as one padded string.
 *
 * Only when there is nothing to cluster: a single cell holding two or more
 * consecutive spaces is a writer laying out columns with padding rather than
 * with positions.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitPadded(text) {
  return String(text ?? "")
    .split(/\s{2,}/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Turn one page's positioned runs into a grid of strings.
 *
 * @param {Array<{x: number, y: number, text: string}>} items
 * @param {{rowTolerance?: number, columnTolerance?: number}} [opts]
 * @returns {string[][]} rows of cells; short rows are padded with ""
 */
export function itemsToGrid(items, opts = {}) {
  const rows = groupIntoRows(items, opts);
  if (rows.length === 0) return [];

  // Nothing was positioned into columns — one run per line. The layout is in
  // the padding rather than in the coordinates, so read it from there.
  const positioned = rows.some((r) => r.length > 1);
  if (!positioned) {
    const split = rows.map((r) => splitPadded(r[0].text));
    // Still one cell each: this is prose, not a table. Said by returning it as
    // it is rather than by inventing a column boundary.
    return split;
  }

  const columns = columnPositions(rows, opts);
  const tolerance = Number(opts.columnTolerance) || COLUMN_TOLERANCE;

  return rows.map((row) => {
    const cells = new Array(columns.length).fill("");
    for (const cell of row) {
      // Nearest column, so a value that drifted stays under its heading rather
      // than opening a column of its own.
      let best = 0;
      let bestGap = Infinity;
      columns.forEach((at, i) => {
        const gap = Math.abs(at - cell.x);
        if (gap < bestGap) {
          bestGap = gap;
          best = i;
        }
      });
      if (bestGap > tolerance * 2) return;
      cells[best] = cells[best] ? `${cells[best]} ${cell.text}` : cell.text;
    }
    return cells;
  });
}

/**
 * Column names for a grid.
 *
 * @param {string[][]} grid
 * @param {boolean} hasHeader
 * @returns {{columns: string[], body: string[][]}}
 */
export function gridHeader(grid, hasHeader) {
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  if (!hasHeader || grid.length === 0) {
    return {
      columns: Array.from({ length: width }, (_, i) => `col${i + 1}`),
      body: grid,
    };
  }
  const head = grid[0];
  return {
    // A blank heading still needs a name, or the column has no key and its
    // values vanish from every row object.
    columns: Array.from(
      { length: width },
      (_, i) => (head[i] || "").trim() || `col${i + 1}`,
    ),
    body: grid.slice(1),
  };
}

/**
 * Every page's table, as row objects.
 *
 * @param {Array<{page: number, items: Array<{x:number,y:number,text:string}>}>} pages
 * @param {{hasHeader?: boolean, rowTolerance?: number, columnTolerance?: number, includePage?: boolean}} [opts]
 * @returns {{records: object[], perPage: Array<{page: number, columns: string[], rows: number}>}}
 */
export function tablesFromPages(pages, opts = {}) {
  const hasHeader = opts.hasHeader !== false;
  const records = [];
  const perPage = [];

  for (const page of pages ?? []) {
    const grid = itemsToGrid(page.items, opts);
    if (grid.length === 0) {
      perPage.push({ page: page.page, columns: [], rows: 0 });
      continue;
    }
    const { columns, body } = gridHeader(grid, hasHeader);
    for (const cells of body) {
      // A row of nothing but empty cells is a spacer the page drew, not a
      // record. Keeping it would put blank rows through the whole export.
      if (cells.every((c) => !c)) continue;
      const record = {};
      columns.forEach((name, i) => {
        record[name] = cells[i] ?? "";
      });
      if (opts.includePage !== false) record._page = page.page;
      records.push(record);
    }
    perPage.push({ page: page.page, columns, rows: body.length });
  }

  return { records, perPage };
}

// === END pdf-tables.js ===
