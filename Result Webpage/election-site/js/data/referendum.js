/**
 * referendum.js — Referendum page orchestration (FEATURE_SPEC.md Section 5).
 *
 * Display layers are fixed: Authority (top) -> County (second) -> Precinct
 * (bottom) -- same 3-layer drill depth as the General Election, but no
 * toggle. Only geographically-scoped seat types (currently just AlmaVale)
 * need to reach that Authority/County map; GeneralDirect is a functional
 * constituency (Section 4) and renders as its own flat table instead, on
 * both the General Election and Referendum pages alike.
 *
 * `referendum_meta.json`'s `seat_types[]` lists which seat types feed a
 * given referendum question and where their result file lives — resolved
 * here the same "JSON is the manifest, never hardcode the path" way as
 * election_meta.json's seat types in results.js.
 */

import { fetchCSV } from './csv.js';
import { dataPath } from './config.js';
import { loadReferendumMeta } from './meta.js';
import { getShapeJoinIndex } from './shapes.js';
import { toNumber, computeStatus, statusAtLeast, summarizeStatus, STATUS } from './status.js';

/**
 * Resolve one of referendum_meta.json's `seat_types[]` entries by id.
 * @param {Object} referendumMeta
 * @param {string} seatTypeId
 * @returns {{id:string, results_file:string}|null}
 */
function findReferendumSeatType(referendumMeta, seatTypeId) {
  if (!referendumMeta || !Array.isArray(referendumMeta.seat_types)) return null;
  return referendumMeta.seat_types.find((st) => st.id === seatTypeId) || null;
}

async function loadReferendumSeatTypeRows(referendumMeta, seatTypeId) {
  const seatType = findReferendumSeatType(referendumMeta, seatTypeId);
  if (!seatType) throw new Error(`data layer: referendum seat type "${seatTypeId}" not found for this referendum`);
  const rows = await fetchCSV(dataPath(seatType.results_file));
  return { seatType, rows };
}

/**
 * Turnout, like Yes/No votes, is gated per Section 2's table — a row only
 * exposes its own Turnout once it's reached "Counting" (not just
 * "Verifying"). Unlike Yes/No (only visible once "Declared", so those stay
 * gated by `statusPredicate`), Turnout uses the looser Counting threshold
 * directly here. Returns `null` (not `0`) when none of `rows` have reached
 * it yet, so a single-row caller (one precinct, one Sub_Constituency) can
 * tell "not yet counted" apart from a genuine zero-turnout row; a multi-row
 * caller (a whole seat/authority/national total) gets a partial "turnout so
 * far" sum from whichever rows qualify (Section 2: "Parent levels aggregate
 * from whichever children have reached each status").
 */
function summarizeYesNo(rows, { now, statusPredicate }) {
  let yes = 0;
  let no = 0;
  let electorate = 0;
  let turnoutSum = 0;
  let turnoutKnownCount = 0;
  for (const row of rows) {
    electorate += toNumber(row.Electorate);
    if (statusAtLeast(row, STATUS.COUNTING, now)) {
      turnoutSum += toNumber(row.Turnout);
      turnoutKnownCount++;
    }
    if (!statusPredicate(row, now)) continue;
    yes += toNumber(row.Yes_Votes);
    no += toNumber(row.No_Votes);
  }
  const validVotes = yes + no;
  return {
    yes,
    no,
    validVotes,
    yesPercent: validVotes > 0 ? (yes / validVotes) * 100 : 0,
    noPercent: validVotes > 0 ? (no / validVotes) * 100 : 0,
    electorate,
    turnout: turnoutKnownCount > 0 ? turnoutSum : null,
  };
}

const DECLARED_ONLY = (row, now) => computeStatus(row, now) === STATUS.DECLARED;

// ---------------------------------------------------------------------
// AlmaVale (geographic, Shape_ID-keyed) -- renders on the Authority/County/
// Precinct choropleth.
// ---------------------------------------------------------------------

/**
 * Precinct-level referendum rows for AlmaVale, plus a national Yes/No
 * summary (Declared precincts only) and full status breakdown.
 * @param {Date} [now]
 */
export async function getAlmaValeReferendumResults(now = new Date()) {
  const referendumMeta = await loadReferendumMeta();
  const { rows } = await loadReferendumSeatTypeRows(referendumMeta, 'AlmaVale');
  return {
    referendumId: referendumMeta.referendum_id,
    question: referendumMeta.question,
    national: summarizeYesNo(rows, { now, statusPredicate: DECLARED_ONLY }),
    statusSummary: summarizeStatus(rows, { now }),
    precinctRows: rows,
  };
}

/**
 * AlmaVale referendum results for one Authority (top layer), aggregating
 * over every precinct reachable via Authority -> County -> Precinct.
 * @param {string} authorityName
 * @param {Date} [now]
 */
export async function getAlmaValeReferendumForAuthority(authorityName, now = new Date()) {
  const [referendumMeta, shapeIndex] = await Promise.all([loadReferendumMeta(), getShapeJoinIndex()]);
  const { rows } = await loadReferendumSeatTypeRows(referendumMeta, 'AlmaVale');
  const rowsByShapeId = new Map(rows.map((r) => [r.Shape_ID, r]));

  const counties = shapeIndex.countiesByZone.get(authorityName) || [];
  const precinctRows = [];
  for (const county of counties) {
    for (const precinct of shapeIndex.polygonsByCounty.get(county.County) || []) {
      const resultRow = rowsByShapeId.get(precinct.Shape_ID);
      if (resultRow) precinctRows.push(resultRow);
    }
  }

  return {
    authority: authorityName,
    counties: counties.map((c) => c.County),
    summary: summarizeYesNo(precinctRows, { now, statusPredicate: DECLARED_ONLY }),
    statusSummary: summarizeStatus(precinctRows, { now }),
    precinctRows,
  };
}

/**
 * AlmaVale referendum results for one County (second layer).
 * @param {string} countyCode
 * @param {Date} [now]
 */
export async function getAlmaValeReferendumForCounty(countyCode, now = new Date()) {
  const [referendumMeta, shapeIndex] = await Promise.all([loadReferendumMeta(), getShapeJoinIndex()]);
  const { rows } = await loadReferendumSeatTypeRows(referendumMeta, 'AlmaVale');
  const rowsByShapeId = new Map(rows.map((r) => [r.Shape_ID, r]));

  const precincts = shapeIndex.polygonsByCounty.get(countyCode) || [];
  const precinctRows = precincts.map((p) => rowsByShapeId.get(p.Shape_ID)).filter(Boolean);

  return {
    county: countyCode,
    summary: summarizeYesNo(precinctRows, { now, statusPredicate: DECLARED_ONLY }),
    statusSummary: summarizeStatus(precinctRows, { now }),
    precinctRows,
  };
}

// ---------------------------------------------------------------------
// GeneralDirect (functional constituency, never on a map -- Section 5) --
// flat table, same Constituency-basis sub-row aggregation as the General
// Election side (Section 4).
// ---------------------------------------------------------------------

/**
 * GeneralDirect's referendum results as a flat table, one row per
 * Constituency (sub-rows summed), Local Representative excluded from the
 * per-Constituency grouping since its row is entirely blank by design
 * (Section 4) and it has no referendum ballot data of its own either.
 * @param {Date} [now]
 */
export async function getGeneralDirectReferendumResults(now = new Date()) {
  const referendumMeta = await loadReferendumMeta();
  const { rows } = await loadReferendumSeatTypeRows(referendumMeta, 'GeneralDirect');

  const rowsByConstituency = new Map();
  for (const row of rows) {
    if (!row.Constituency) continue; // blank placeholder row(s), if any -- see Section 4
    if (!rowsByConstituency.has(row.Constituency)) rowsByConstituency.set(row.Constituency, []);
    rowsByConstituency.get(row.Constituency).push(row);
  }

  const seats = [...rowsByConstituency.entries()].map(([constituency, seatRows]) => ({
    constituency,
    subRowCount: seatRows.length,
    summary: summarizeYesNo(seatRows, { now, statusPredicate: DECLARED_ONLY }),
    statusSummary: summarizeStatus(seatRows, { now }),
    // Named Sub_Constituency child rows (mirrors the General Election side's
    // results.js#buildSubRowSummaries -- Section 4's collapsible-row rule
    // applies identically here, just with a Yes/No summary instead of a
    // Supplementary Vote result since referendum rows carry no party data).
    subRows: seatRows.length > 1 ? seatRows.map((row) => ({
      subConstituency: row.Sub_Constituency,
      summary: summarizeYesNo([row], { now, statusPredicate: DECLARED_ONLY }),
      statusSummary: summarizeStatus([row], { now }),
    })) : undefined,
  }));

  return {
    referendumId: referendumMeta.referendum_id,
    question: referendumMeta.question,
    seats,
  };
}
