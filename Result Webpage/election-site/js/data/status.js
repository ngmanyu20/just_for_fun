/**
 * status.js — time-gating (FEATURE_SPEC.md Section 2).
 *
 * Pure functions, no fetch/DOM — importable straight into Node for tests.
 *
 * Every precinct/seat result row carries `received_at`, `verified_at`,
 * `declared_at`. Status is derived by comparing each against real
 * wall-clock time:
 *
 *   Not received  -> received_at null or future
 *   Verifying     -> received_at <= now
 *   Counting      -> verified_at <= now
 *   Declared      -> declared_at <= now
 *
 * A precinct's General Election and Referendum rows share the same three
 * timestamps (one physical ballot box, reported once) — callers just pass
 * whichever row they have; this module doesn't care which file it came from.
 */

export const STATUS = Object.freeze({
  NOT_RECEIVED: 'Not received',
  VERIFYING: 'Verifying',
  COUNTING: 'Counting',
  DECLARED: 'Declared',
});

/** Ordering used by `statusAtLeast` / sorting — index = rank. */
const STATUS_RANK = {
  [STATUS.NOT_RECEIVED]: 0,
  [STATUS.VERIFYING]: 1,
  [STATUS.COUNTING]: 2,
  [STATUS.DECLARED]: 3,
};

/**
 * Parse a timestamp cell defensively. Blank/missing/unparseable values all
 * become `null` (never throws) — this is what makes the status pipeline
 * safe against the sparse/empty result files noted in Section 7: a row
 * with `received_at=''` simply resolves to `Not received`, not a crash.
 * @param {*} value Raw CSV cell value.
 * @returns {Date|null}
 */
export function parseTimestamp(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Convert a raw CSV numeric cell to a number, defensively. Blank/missing/
 * non-numeric values become 0 (votes/electorate/turnout are always summed,
 * and "no data yet" should contribute nothing rather than NaN-poisoning a
 * sum) — never throws, never returns NaN.
 * @param {*} value
 * @returns {number}
 */
export function toNumber(value) {
  if (value == null) return 0;
  const s = String(value).trim();
  if (s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute the display status of a single row against wall-clock time.
 * @param {{received_at?: *, verified_at?: *, declared_at?: *}} row
 * @param {Date} [now] Defaults to `new Date()` — pass an explicit value in tests.
 * @returns {string} one of STATUS.*
 */
export function computeStatus(row, now = new Date()) {
  if (!row) return STATUS.NOT_RECEIVED;
  const declaredAt = parseTimestamp(row.declared_at);
  if (declaredAt && declaredAt <= now) return STATUS.DECLARED;
  const verifiedAt = parseTimestamp(row.verified_at);
  if (verifiedAt && verifiedAt <= now) return STATUS.COUNTING;
  const receivedAt = parseTimestamp(row.received_at);
  if (receivedAt && receivedAt <= now) return STATUS.VERIFYING;
  return STATUS.NOT_RECEIVED;
}

/**
 * True if `row`'s status is at or beyond `minStatus` (STATUS.* ordering).
 * @param {Object} row
 * @param {string} minStatus one of STATUS.*
 * @param {Date} [now]
 * @returns {boolean}
 */
export function statusAtLeast(row, minStatus, now = new Date()) {
  return STATUS_RANK[computeStatus(row, now)] >= STATUS_RANK[minStatus];
}

/**
 * Electorate-weighted "% declared" for a set of rows (FEATURE_SPEC.md
 * Section 2): sum of Electorate for Declared rows / total Electorate for
 * the set — NOT a plain count of declared rows. Rows with a blank/zero
 * Electorate contribute 0 to both sums (so they neither inflate nor
 * deflate the percentage) and never divide-by-zero: an empty/all-zero
 * input returns 0.
 * @param {Array<Object>} rows Raw CSV row objects (must have `received_at` /
 *   `verified_at` / `declared_at` and an electorate field).
 * @param {Object} [opts]
 * @param {string} [opts.electorateField='Electorate']
 * @param {Date} [opts.now]
 * @returns {number} 0-100
 */
export function percentDeclared(rows, opts = {}) {
  const electorateField = opts.electorateField || 'Electorate';
  const now = opts.now || new Date();
  let total = 0;
  let declared = 0;
  for (const row of rows) {
    const e = toNumber(row[electorateField]);
    total += e;
    if (computeStatus(row, now) === STATUS.DECLARED) declared += e;
  }
  return total > 0 ? (declared / total) * 100 : 0;
}

/**
 * Full status breakdown for a set of rows: electorate-weighted percentage
 * in each status bucket, plus row counts. Useful for progress UI ("12,401
 * / 20,850 precincts declared, covering 61.2% of electorate") without
 * repeatedly re-deriving per-row status.
 * @param {Array<Object>} rows
 * @param {Object} [opts]
 * @param {string} [opts.electorateField='Electorate']
 * @param {Date} [opts.now]
 * @returns {{
 *   totalRows:number, totalElectorate:number,
 *   byStatus: Object<string,{count:number, electorate:number, percentOfElectorate:number}>,
 *   percentDeclared:number
 * }}
 */
export function summarizeStatus(rows, opts = {}) {
  const electorateField = opts.electorateField || 'Electorate';
  const now = opts.now || new Date();
  const byStatus = {
    [STATUS.NOT_RECEIVED]: { count: 0, electorate: 0, percentOfElectorate: 0 },
    [STATUS.VERIFYING]: { count: 0, electorate: 0, percentOfElectorate: 0 },
    [STATUS.COUNTING]: { count: 0, electorate: 0, percentOfElectorate: 0 },
    [STATUS.DECLARED]: { count: 0, electorate: 0, percentOfElectorate: 0 },
  };
  let totalElectorate = 0;
  for (const row of rows) {
    const e = toNumber(row[electorateField]);
    const s = computeStatus(row, now);
    byStatus[s].count += 1;
    byStatus[s].electorate += e;
    totalElectorate += e;
  }
  for (const s of Object.keys(byStatus)) {
    byStatus[s].percentOfElectorate = totalElectorate > 0 ? (byStatus[s].electorate / totalElectorate) * 100 : 0;
  }
  return {
    totalRows: rows.length,
    totalElectorate,
    byStatus,
    percentDeclared: byStatus[STATUS.DECLARED].percentOfElectorate,
  };
}
