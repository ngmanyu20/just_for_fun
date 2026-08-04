/**
 * csv.js — minimal, dependency-free CSV parser + fetch helpers.
 *
 * This is the ONLY place in the data layer that turns raw CSV text into
 * JS objects. It is a hand-written RFC4180-ish state machine (not a naive
 * `split(',')`) because several columns in this dataset — `geometry` and
 * `centroid` in particular — are quoted fields containing embedded commas,
 * e.g. `"POLYGON ((2883.27 1328.07, 2878.63 1333.14, ...))"`.
 *
 * Handles:
 *  - quoted fields with embedded commas and newlines
 *  - escaped quotes inside quoted fields (`""` -> `"`)
 *  - CRLF and LF line endings
 *  - a UTF-8 BOM at the start of the file
 *  - a header-only or completely empty file (returns [])
 *
 * Deliberately does NOT try to guess types — every value comes back as a
 * string (or `''` for a missing/empty field). Numeric/date coercion is the
 * caller's job (see status.js's `toNumber` / `parseTimestamp`), because
 * "blank" is a meaningful value here (it signals `Not received`), and
 * silently coercing blank -> 0 at parse time would hide that distinction
 * from callers that need to tell "zero votes" apart from "no data yet".
 */

/**
 * Parse a full CSV document into an array of row objects keyed by the
 * header row. Never throws on malformed/short rows — a row with fewer
 * fields than the header just gets '' for the missing trailing columns,
 * and an all-blank row (e.g. the General Direct "Local Representative"
 * placeholder row, Section 4) round-trips as an object of empty strings
 * rather than being dropped, so callers can detect "row exists but has no
 * data" vs "row is missing entirely".
 *
 * @param {string} text Raw CSV file contents.
 * @returns {Array<Object<string,string>>}
 */
export function parseCSV(text) {
  if (text == null) return [];
  // Strip a leading UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.length === 0) return [];

  const rows = tokenizeCSV(text);
  if (rows.length === 0) return [];

  const header = rows[0];
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const raw = rows[r];
    // Skip fully-empty trailing lines (e.g. trailing newline at EOF
    // produces one bogus row of a single '' field).
    if (raw.length === 1 && raw[0] === '' && r === rows.length - 1) continue;
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = raw[c] !== undefined ? raw[c] : '';
    }
    records.push(obj);
  }
  return records;
}

/**
 * Character-scan tokenizer: turns raw CSV text into an array of rows,
 * each an array of string fields. Internal to this module — callers
 * should use `parseCSV`.
 * @param {string} text
 * @returns {Array<Array<string>>}
 */
function tokenizeCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const len = text.length;

  for (let i = 0; i < len; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // consume the escaped quote's second character
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') {
      // Peek for \n to consume CRLF as one line break.
      if (text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }

  // Flush the final field/row (files not ending in a newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// ---------------------------------------------------------------------
// Fetch helpers — browser-only (use `fetch`). Kept separate from the
// pure `parseCSV` above so the parser itself stays unit-testable under
// plain Node with no DOM/fetch shim required.
// ---------------------------------------------------------------------

const _textCache = new Map(); // url -> Promise<string>
const _jsonCache = new Map(); // url -> Promise<any>
const _csvCache = new Map(); // url -> Promise<Array<Object>>

/**
 * Fetch a URL as text, memoized per URL for the lifetime of the page.
 * @param {string} url
 * @returns {Promise<string>}
 */
export function fetchText(url) {
  if (!_textCache.has(url)) {
    _textCache.set(
      url,
      fetch(url).then((res) => {
        if (!res.ok) {
          throw new Error(`data layer: failed to fetch ${url} (${res.status} ${res.statusText})`);
        }
        return res.text();
      })
    );
  }
  return _textCache.get(url);
}

/**
 * Fetch and parse a CSV file, memoized per URL.
 * @param {string} url
 * @returns {Promise<Array<Object<string,string>>>}
 */
export function fetchCSV(url) {
  if (!_csvCache.has(url)) {
    _csvCache.set(url, fetchText(url).then(parseCSV));
  }
  return _csvCache.get(url);
}

/**
 * Fetch and parse a JSON file, memoized per URL.
 * @param {string} url
 * @returns {Promise<any>}
 */
export function fetchJSON(url) {
  if (!_jsonCache.has(url)) {
    _jsonCache.set(
      url,
      fetch(url).then((res) => {
        if (!res.ok) {
          throw new Error(`data layer: failed to fetch ${url} (${res.status} ${res.statusText})`);
        }
        return res.json();
      })
    );
  }
  return _jsonCache.get(url);
}

/** Clears all fetch caches. Exposed for tests / hot-reload scenarios only. */
export function _clearFetchCaches() {
  _textCache.clear();
  _jsonCache.clear();
  _csvCache.clear();
}
