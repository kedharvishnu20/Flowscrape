// === pdf-text.js ===
/**
 * @module pdf-text
 * @description Text extraction from a PDF, with no dependencies.
 *
 *   PDF_EXTRACTION had a full config UI — source, max pages, storeAs — and
 *   never parsed anything. It logged "use MCP tool pdf_extract_text" and stored
 *   `{status: "pending"}`, which is an instruction the user cannot act on:
 *   there is no bridge from the extension to the MCP server (audit B-28, G-05).
 *
 *   The MCP server uses pdfjs. The extension has no bundler and no npm
 *   dependencies, so this is a direct reader instead. It handles what the
 *   overwhelming majority of text PDFs are made of:
 *
 *     * uncompressed and FlateDecode content streams (via DecompressionStream,
 *       which service workers have)
 *     * literal `(string)` and hex `<hex>` operands of Tj, TJ, ' and "
 *     * PDF string escapes, including octal
 *     * per-font /ToUnicode CMaps, for bfchar and bfrange
 *
 *   What it does not do, and reports rather than guessing at:
 *
 *     * encrypted PDFs
 *     * scanned pages, which contain images and no text at all
 *     * CID text whose font ships no ToUnicode map — the bytes are glyph
 *       indices, and without the map there is nothing to map them to
 *
 *   A page it cannot read comes back with an explicit note, never with the
 *   mojibake that guessing would produce.
 *
 * @dependencies none
 */

"use strict";

/**
 * @typedef {Object} PdfPage
 * @property {number} page
 * @property {string} text
 * @property {number} chars
 * @property {string} [note] why this page has no text
 */

/**
 * @typedef {Object} PdfText
 * @property {PdfPage[]} pages
 * @property {string}    text        every page joined with a blank line
 * @property {number}    pageCount   content streams found
 * @property {boolean}   truncated   whether maxPages cut it short
 * @property {string[]}  warnings
 */

/** Bytes → a string with one char per byte, so offsets survive regex scanning. */
function _latin1(bytes) {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** The inverse, for handing a slice back to the inflater. */
function _bytesOf(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Inflate a zlib or raw-deflate stream.
 *
 * PDF writers are inconsistent about the zlib header, so try both.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array|null>} null when neither format decodes
 */
async function _inflate(bytes) {
  for (const format of ["deflate", "deflate-raw"]) {
    try {
      const stream = new Blob([bytes])
        .stream()
        .pipeThrough(new DecompressionStream(format));
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      // Try the other framing.
    }
  }
  return null;
}

/**
 * Pull every stream object out of the file, decoded where possible.
 *
 * @param {string} raw - the file as latin1
 * @returns {Promise<Array<{ dict: string, data: string }>>}
 */
async function _readStreams(raw) {
  const streams = [];
  // `stream` is followed by CRLF or LF, then the bytes, then `endstream`.
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end === -1) break;

    // The dictionary is whatever precedes this stream back to the object head.
    const objStart = raw.lastIndexOf(" obj", m.index);
    const dict = objStart === -1 ? "" : raw.slice(objStart, m.index);

    // The EOL that separates the data from `endstream` is not part of the
    // stream. Feeding it to the inflater makes every compressed stream fail.
    let data = raw.slice(start, end).replace(/\r?\n$/, "");
    if (/\/Filter\s*(\[[^\]]*\])?\s*\/?[^>]*FlateDecode/.test(dict)) {
      const inflated = await _inflate(_bytesOf(data));
      if (!inflated) {
        re.lastIndex = end;
        continue; // compressed with something we cannot read
      }
      data = _latin1(inflated);
    }
    streams.push({ dict, data });
    re.lastIndex = end;
  }
  return streams;
}

/** Decode a PDF literal string body, resolving escapes. */
function _decodeLiteral(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      let oct = next;
      while (oct.length < 3 && body[i + 1] >= "0" && body[i + 1] <= "7") {
        oct += body[++i];
      }
      out += String.fromCharCode(parseInt(oct, 8));
      continue;
    }
    const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
    if (next === "\n") continue; // a line continuation
    out += simple[next] ?? next;
  }
  return out;
}

/** Decode a `<...>` hex string. */
function _decodeHex(body) {
  const hex = body.replace(/[^0-9A-Fa-f]/g, "");
  const padded = hex.length % 2 ? `${hex}0` : hex;
  let out = "";
  for (let i = 0; i < padded.length; i += 2) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Parse the /ToUnicode CMaps in a document into one code → text map per CMap.
 *
 * Keys are the raw byte sequences as they appear in the content stream, so a
 * two-byte CID and a one-byte code are both handled.
 *
 * @param {Array<{ dict: string, data: string }>} streams
 * @returns {Map<string, string>}
 */
function _readToUnicode(streams) {
  const map = new Map();

  for (const { data } of streams) {
    if (!data.includes("beginbfchar") && !data.includes("beginbfrange")) {
      continue;
    }

    for (const block of data.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
      const pairs = block.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) ?? [];
      for (const pair of pairs) {
        const [src, dst] = pair
          .match(/<([0-9A-Fa-f]+)>/g)
          .map((h) => h.slice(1, -1));
        map.set(_decodeHex(src), _utf16beToString(dst));
      }
    }

    for (const block of data.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
      const rows =
        block.match(
          /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g,
        ) ?? [];
      for (const row of rows) {
        const [lo, hi, dst] = row
          .match(/<([0-9A-Fa-f]+)>/g)
          .map((h) => h.slice(1, -1));
        const width = lo.length / 2;
        const start = parseInt(lo, 16);
        const end = parseInt(hi, 16);
        const base = parseInt(dst, 16);
        // A runaway range would build a huge map for nothing.
        if (end - start > 65535) continue;
        for (let code = start; code <= end; code++) {
          let key = "";
          for (let b = width - 1; b >= 0; b--) {
            key += String.fromCharCode((code >> (b * 8)) & 0xff);
          }
          map.set(key, String.fromCodePoint(base + (code - start)));
        }
      }
    }
  }
  return map;
}

/** Big-endian UTF-16 hex → a JS string. */
function _utf16beToString(hex) {
  let out = "";
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const unit = parseInt(hex.slice(i, i + 4), 16);
    if (Number.isNaN(unit)) break;
    out += String.fromCharCode(unit);
  }
  return out;
}

/** Is this string mostly unprintable — i.e. glyph indices, not text? */
function _looksLikeGlyphIndices(s) {
  if (!s) return false;
  let bad = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 9 || (c > 13 && c < 32) || c === 0xfffd) bad++;
  }
  return bad / s.length > 0.3;
}

/**
 * Pull the text operands out of one content stream.
 *
 * @param {string} content
 * @param {Map<string, string>} toUnicode
 * @returns {{ text: string, undecodable: boolean }}
 */
function _textFromContent(content, toUnicode) {
  const parts = [];
  let undecodable = false;

  // Tj / TJ / ' / " operands, in document order. The TJ array holds strings
  // interleaved with kerning numbers, which are dropped.
  const re =
    /(\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>)|(TJ|Tj|'|")|(\bTd\b|\bTD\b|\bT\*\b|\bET\b)/g;
  let pending = "";
  let m;

  while ((m = re.exec(content)) !== null) {
    if (m[1]) {
      const token = m[1];
      const raw =
        token[0] === "("
          ? _decodeLiteral(token.slice(1, -1))
          : _decodeHex(token.slice(1, -1));

      let decoded = "";
      let mapped = true;
      // Try the CMap two bytes at a time, then one, before giving up on it.
      for (let i = 0; i < raw.length;) {
        const two = raw.slice(i, i + 2);
        const one = raw[i];
        if (toUnicode.has(two)) {
          decoded += toUnicode.get(two);
          i += 2;
        } else if (toUnicode.has(one)) {
          decoded += toUnicode.get(one);
          i += 1;
        } else {
          mapped = false;
          break;
        }
      }

      const text = mapped && decoded ? decoded : raw;
      if (!mapped && _looksLikeGlyphIndices(raw)) {
        undecodable = true;
        continue;
      }
      pending += text;
    } else if (m[2]) {
      if (pending) parts.push(pending);
      pending = "";
    } else if (m[3]) {
      // A positioning operator ends the run; treat it as whitespace.
      if (pending) parts.push(pending);
      pending = "";
      parts.push(" ");
    }
  }
  if (pending) parts.push(pending);

  return {
    text: parts.join("").replace(/\s+/g, " ").trim(),
    undecodable,
  };
}

/**
 * Extract text from a PDF.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{ maxPages?: number }} [options]
 * @returns {Promise<PdfText>}
 */
export async function extractPdfText(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const maxPages = Math.max(1, Number(options.maxPages) || 50);
  const warnings = [];

  const raw = _latin1(bytes);
  if (!raw.startsWith("%PDF-")) {
    throw new Error("Not a PDF: the file does not start with %PDF-.");
  }
  if (
    /\/Encrypt\b/.test(raw.slice(-4096)) ||
    /\/Encrypt\s+\d+\s+\d+\s+R/.test(raw)
  ) {
    throw new Error(
      "This PDF is encrypted. Text extraction needs the decrypted file.",
    );
  }

  const streams = await _readStreams(raw);
  const toUnicode = _readToUnicode(streams);

  // Content streams are the ones carrying text-showing operators. Mapping them
  // to page numbers properly means walking the page tree; in practice writers
  // emit them in page order, so they are numbered in the order they appear and
  // that is what "page" means here.
  const contents = streams.filter(
    (s) => /\bBT\b/.test(s.data) && /(Tj|TJ)\b/.test(s.data),
  );

  const pageCount = contents.length;
  const limit = Math.min(pageCount, maxPages);
  const pages = [];

  for (let i = 0; i < limit; i++) {
    const { text, undecodable } = _textFromContent(contents[i].data, toUnicode);
    const page = { page: i + 1, text, chars: text.length };
    if (!text && undecodable) {
      page.note =
        "Text is stored as glyph indices and the font ships no /ToUnicode map, so it cannot be decoded.";
    } else if (!text) {
      page.note = "No text on this page — it is probably a scanned image.";
    }
    pages.push(page);
  }

  if (pageCount === 0) {
    warnings.push(
      "No text content streams found. A scanned PDF holds images, not text.",
    );
  }
  if (pages.some((p) => p.note?.includes("glyph indices"))) {
    warnings.push(
      "Some pages use fonts with no /ToUnicode map and could not be decoded.",
    );
  }

  return {
    pages,
    text: pages
      .map((p) => p.text)
      .filter(Boolean)
      .join("\n\n"),
    pageCount,
    truncated: pageCount > limit,
    warnings,
  };
}

// === END pdf-text.js ===
