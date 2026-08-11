/**
 * results.js — high-level General Election orchestration: joins the raw
 * CSV loaders (meta.js, shapes.js) with the pure algorithm modules
 * (supplementaryVote.js, proportional.js, localRepresentative.js, status.js)
 * into the per-seat-type functions the rest of the site actually calls.
 *
 * This is the main entry point Phase 2 agents should use for General
 * Election data — they should not need to touch supplementaryVote.js /
 * proportional.js / meta.js / shapes.js directly, though those remain
 * exported from data.js for anything that needs finer-grained access.
 *
 * Status-gating convention used throughout this module (documented once
 * here rather than repeated on every function): a row's raw vote columns
 * are only summed into a result once that row is Declared, per Section 2's
 * table ("Declared" -> "full result"). A row's Turnout is only exposed once
 * that SAME row has reached at least "Counting" (Section 2: "Counting" ->
 * "turnout" becomes visible; "Verifying" -> only "received, unverified", no
 * turnout yet) — `turnoutIfKnown()` below is that gate, used everywhere a
 * single row's own Turnout is surfaced (a precinct, a reporting sector, a
 * Sub_Constituency row), returning `null` rather than `0` so the UI can
 * distinguish "not yet counted" from "counted, zero turnout". The CSVs
 * don't blank out vote/turnout columns based on wall-clock time (they're
 * fixed values; only the timestamps gate what's "supposed" to be visible
 * yet), so this module is what actually enforces the gate.
 * Electorate and percentDeclared, by contrast, are computed across ALL rows
 * regardless of status — Electorate is demographic, not a "result" (Section
 * 2 never gates it), and percentDeclared's whole point is to keep
 * not-yet-declared rows in its denominator.
 *
 * Declaration-certainty gate for the three Supplementary Vote seat types
 * (Alma Vale, Home Districts, General Direct): `buildSupplementaryVoteSeatSummary()`
 * / `buildSubRowSummaries()` / `getAlmaValeSupplementaryVoteForShapeIds()`
 * below attach a `certainty` field (from `resolveSupplementaryVoteCertainty()`
 * in supplementaryVote.js) alongside the always-present `winnerSpectrum`/
 * `winnerParty` "currently leading" figures. Those figures come from
 * `leadingSpectrum()` (supplementaryVote.js), NOT `computeSupplementaryVote()`'s
 * own `winner` directly — `winner` always forces a specific elimination +
 * round2 hypothetical even off a single early batch, so `leadingSpectrum()`
 * only trusts that forced figure once it's certain which two spectrums even
 * make the runoff (`certainty.participantsCertain`, or an outright round1
 * majority already certain), and shows round1's own plain plurality leader
 * before that — see its doc comment for why. `certainty.resultCertain` is
 * the separate, stricter gate the UI should use before presenting a winner
 * as SETTLED — it goes true once the outstanding undeclared ballots
 * (`computeUndecidedVotes()` below, worst-cased per Section 1's rule) can no
 * longer change the outcome, which is frequently true well before every row
 * backing the seat is literally Declared (e.g. 99.8% declared with a
 * comfortable margin). This does NOT apply to
 * General Proportional (a different method, HareQuotaLRM) or to the
 * derived Local Representative seat (its own margin-safe rule lives in
 * localRepresentative.js instead, since it's FPTP-over-Districts, not SV).
 */

import { toNumber, computeStatus, statusAtLeast, summarizeStatus, STATUS } from './status.js';
import { fetchCSV } from './csv.js';
import {
  loadElectionMeta,
  loadPartyParticipation,
  findSeatType,
  seatTypeResultsUrl,
  findParticipation,
  flattenLists,
  findParty,
} from './meta.js';
import { getShapeJoinIndex, orderConstituencies } from './shapes.js';
import { sumSupplementaryVoteRows, computeSupplementaryVote, resolveWinningParty, resolveSupplementaryVoteCertainty, leadingSpectrum } from './supplementaryVote.js';
import { computeProportionalAllocation, computeGuaranteedMinimumAllocation } from './proportional.js';
import {
  deriveLocalRepresentative,
  buildSpectrumDisplayLabels,
  tallyFirstPreferenceSpectrumVotes,
  relabelSpectrumVotes,
  pluralityWinner,
} from './localRepresentative.js';

const DECLARED_ONLY = (row, now) => computeStatus(row, now) === STATUS.DECLARED;

/**
 * A single row's own Turnout, gated per Section 2: only visible once that
 * row has reached "Counting" (or "Declared"). Returns `null` — not `0` —
 * below that, so callers/UI can tell "not yet counted" apart from a
 * genuine zero-turnout row.
 * @param {Object} row raw CSV row (has `Turnout` and the 3 timestamp cols)
 * @param {Date} now
 */
function turnoutIfKnown(row, now) {
  return statusAtLeast(row, STATUS.COUNTING, now) ? toNumber(row.Turnout) : null;
}

/**
 * Sum of `turnoutIfKnown()` across several raw rows that together make up
 * one displayed unit (e.g. a Sub_Constituency's underlying rows) — a
 * partial sum from whichever rows have reached Counting/Declared so far
 * (Section 2: "Parent levels aggregate from whichever children have
 * reached each status"), or `null` if none of them have yet.
 * @param {Array<Object>} rows
 * @param {Date} now
 */
function sumKnownTurnout(rows, now) {
  const known = rows.map((r) => turnoutIfKnown(r, now)).filter((v) => v != null);
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
}

/**
 * The maximum number of ballots that could still land any way at all for a
 * Supplementary Vote seat -- the "undecided" pool `resolveSupplementaryVoteCertainty()`
 * (supplementaryVote.js) worst-cases every declaration against. Per row:
 *   - Declared: contributes 0 -- already counted into round1/round2.
 *   - Counting (verified, not yet declared): contributes that row's own
 *     Turnout -- the ballot count is known, but not yet allocated to a
 *     candidate, so all of it is still "pending to count."
 *   - Verifying / Not received: contributes Electorate -- turnout itself is
 *     unknown, so the row's full electorate is the conservative upper bound
 *     on how many ballots from it could still surface.
 * @param {Array<Object>} rows raw result rows for one seat (or Sub_Constituency)
 * @param {Date} now
 * @returns {number}
 */
function computeUndecidedVotes(rows, now) {
  let undecided = 0;
  for (const row of rows) {
    const status = computeStatus(row, now);
    if (status === STATUS.DECLARED) continue;
    undecided += status === STATUS.COUNTING ? toNumber(row.Turnout) : toNumber(row.Electorate);
  }
  return undecided;
}

/**
 * Load a seat type's backing results CSV via its `results_file` manifest
 * entry (never a hardcoded path — Section 4's "JSON is the manifest" rule).
 * @param {Object} electionMeta
 * @param {string} seatTypeId
 * @returns {Promise<{seatType:Object, rows:Array<Object>}>}
 */
async function loadSeatTypeRows(electionMeta, seatTypeId) {
  const seatType = findSeatType(electionMeta, seatTypeId);
  if (!seatType) throw new Error(`data layer: unknown seat type "${seatTypeId}"`);
  const rows = await fetchCSV(seatTypeResultsUrl(seatType));
  return { seatType, rows };
}

// ---------------------------------------------------------------------
// Alma Vale (40 seats, Shape_ID-keyed, one row per precinct)
// ---------------------------------------------------------------------

/**
 * All 40 Alma Vale seats with their current count (Section 4).
 * @param {Date} [now]
 * @returns {Promise<Array<AlmaValeSeatSummary>>}
 */
export async function getAlmaValeSeats(now = new Date()) {
  const electionMeta = await loadElectionMeta();
  const [participationRows, shapeIndex, { rows: resultRows }] = await Promise.all([
    loadPartyParticipation(),
    getShapeJoinIndex(),
    loadSeatTypeRows(electionMeta, 'AlmaVale'),
  ]);

  const constituencies = orderConstituencies(shapeIndex.constituencies);
  const seats = [];
  for (const constituencyRow of constituencies) {
    const constituencyName = constituencyRow.Constituency;
    const precinctRows = resultRows.filter((r) => {
      const precinct = shapeIndex.polygonById.get(r.Shape_ID);
      return precinct && precinct.Constituency === constituencyName;
    });
    seats.push(buildSupplementaryVoteSeatSummary({
      seatTypeId: 'AlmaVale',
      constituency: constituencyName,
      subConstituency: constituencyName,
      rows: precinctRows,
      participationRows,
      now,
      constituencyMeta: constituencyRow,
    }));
  }
  return seats;
}

/**
 * Precinct-level detail for one Alma Vale seat (for the map + precinct
 * breakdown view, Section 4).
 * @param {string} constituencyName
 * @param {Date} [now]
 */
export async function getAlmaValeSeatDetail(constituencyName, now = new Date()) {
  const electionMeta = await loadElectionMeta();
  const [participationRows, shapeIndex, { rows: resultRows }] = await Promise.all([
    loadPartyParticipation(),
    getShapeJoinIndex(),
    loadSeatTypeRows(electionMeta, 'AlmaVale'),
  ]);

  const precinctRows = resultRows.filter((r) => {
    const precinct = shapeIndex.polygonById.get(r.Shape_ID);
    return precinct && precinct.Constituency === constituencyName;
  });

  const summary = buildSupplementaryVoteSeatSummary({
    seatTypeId: 'AlmaVale',
    constituency: constituencyName,
    subConstituency: constituencyName,
    rows: precinctRows,
    participationRows,
    now,
  });

  const precincts = precinctRows.map((row) => {
    const status = computeStatus(row, now);
    return {
      shapeId: row.Shape_ID,
      status,
      electorate: toNumber(row.Electorate),
      turnout: turnoutIfKnown(row, now),
      // Spoil, like the vote breakdown, only becomes visible once Declared
      // (Section 2) -- bundled alongside `result` rather than a separate
      // gate, since both come from the same Declared-only computation.
      // `totals` (the raw 9 transfer-column sums, same shape
      // `sumSupplementaryVoteRows` always returns) is kept alongside
      // `result` so callers can re-run `computeHypotheticalRunoff()` for
      // this one precinct with a different forced elimination -- `result`
      // alone only carries the ACTUAL elimination's outcome.
      ...(status === STATUS.DECLARED
        ? (() => {
            const totals = sumSupplementaryVoteRows([row]);
            return { result: computeSupplementaryVote(totals), totals, spoil: toNumber(row.Spoil) };
          })()
        : {}),
    };
  });

  return { ...summary, precincts };
}

/**
 * The full Supplementary Vote computation (round1 + round2 if triggered,
 * Spoil, Turnout, Electorate — Declared-only, matching the seat-level
 * convention) restricted to an arbitrary subset of Alma Vale precincts
 * within one Constituency. Used by the map's County/District tooltips,
 * which need the SAME two-round method the Constituency itself gets
 * (round1 sums are additive across precincts, but round2 is NOT — a
 * sub-area can only be correctly re-run from its own raw aggregated
 * totals, not by summing each precinct's already-computed round2, since
 * elimination could differ per precinct). Also carries its own `certainty`
 * (`resolveSupplementaryVoteCertainty()`, same as the seat-level summary
 * above) computed from THIS SUBSET's own undecided pool — a unit's round2
 * figures can be certain even while the whole Constituency's aren't, or
 * vice versa, so the tooltip must gate on this unit's own certainty, not
 * the parent seat's.
 * @param {string} constituencyName
 * @param {Iterable<string>} shapeIds precinct Shape_IDs to include
 * @param {Date} [now]
 */
export async function getAlmaValeSupplementaryVoteForShapeIds(constituencyName, shapeIds, now = new Date()) {
  const electionMeta = await loadElectionMeta();
  const [participationRows, { rows: resultRows }] = await Promise.all([
    loadPartyParticipation(),
    loadSeatTypeRows(electionMeta, 'AlmaVale'),
  ]);
  const idSet = shapeIds instanceof Set ? shapeIds : new Set(shapeIds);
  const rows = resultRows.filter((r) => idSet.has(r.Shape_ID));

  const totals = sumSupplementaryVoteRows(rows, { include: (row) => DECLARED_ONLY(row, now) });
  const svResult = computeSupplementaryVote(totals);
  const statusSummary = summarizeStatus(rows, { now });
  const undecided = computeUndecidedVotes(rows, now);
  const certainty = resolveSupplementaryVoteCertainty(svResult, undecided);
  const winner = leadingSpectrum(svResult, certainty); // overrides svResult's own forced-elimination `winner`, see module doc comment
  const participation = findParticipation(participationRows, 'AlmaVale', constituencyName);
  const winnerParty = resolveWinningParty(winner, participation);

  return { ...svResult, winner, totals, winnerParty, statusSummary, certainty };
}

/**
 * FPTP (first-preference-only, no Supplementary Vote transfer round)
 * SPECTRUM vote tally + plurality winner (relabeled to a display party
 * label) for an arbitrary subset of Alma Vale precincts, Declared-only.
 * This is the SAME counting rule FEATURE_SPEC.md Section 4 mandates for
 * the Local Representative derivation ("sum votes per party ... whichever
 * party has the plurality wins that District") — reused here for the
 * map's District-level "who wins this District" tooltip/color, which must
 * agree with that rule rather than re-running the (different)
 * Supplementary Vote method Alma Vale SEATS use. See localRepresentative.js
 * for the shared tally/relabel/plurality helpers and why NRD+LRP's votes
 * are pooled under one "LRP" label for this rule specifically.
 * @param {Iterable<string>} shapeIds precinct Shape_IDs to include
 * @param {Date} [now]
 * @returns {Promise<{votesByParty: Record<string,number>, spectrumVotes: {Left:number,Right:number,MR:number}, winnerParty: string|null, winnerSpectrum: string|null, statusSummary: Object}>}
 */
export async function getAlmaValeFirstPreferenceWinnerForShapeIds(shapeIds, now = new Date()) {
  const electionMeta = await loadElectionMeta();
  const [participationRows, { rows: resultRows }] = await Promise.all([
    loadPartyParticipation(),
    loadSeatTypeRows(electionMeta, 'AlmaVale'),
  ]);
  const idSet = shapeIds instanceof Set ? shapeIds : new Set(shapeIds);
  const rows = resultRows.filter((r) => idSet.has(r.Shape_ID));
  const declaredRows = rows.filter((r) => DECLARED_ONLY(r, now));

  const spectrumDisplayLabels = buildSpectrumDisplayLabels(participationRows);
  const spectrumVotes = tallyFirstPreferenceSpectrumVotes(declaredRows);
  const votesByParty = relabelSpectrumVotes(spectrumVotes, spectrumDisplayLabels);
  const winnerParty = pluralityWinner(votesByParty);
  const winnerSpectrum = winnerParty ? findParty(electionMeta, winnerParty)?.spectrum || null : null;
  const statusSummary = summarizeStatus(rows, { now });

  // Pre-relabel spectrum tally (Left/Right/MR), kept alongside the
  // display-party-relabeled `votesByParty` above -- FEATURE_SPEC.md's
  // spectrum-colored displays elsewhere on the site (map fill, vote-share
  // bars, the results list's Left/MR/Right columns) all key off the
  // spectrum directly, not the pooled display-party label `votesByParty`
  // uses (see the module doc's NRD/LRP pooling note).
  const spectrumVotesObj = { Left: spectrumVotes.get('Left') || 0, Right: spectrumVotes.get('Right') || 0, MR: spectrumVotes.get('MR') || 0 };

  return { votesByParty: Object.fromEntries(votesByParty), spectrumVotes: spectrumVotesObj, winnerParty, winnerSpectrum, statusSummary };
}

// ---------------------------------------------------------------------
// Home Districts (5 seats) / General Direct (10 seats, incl. derived
// Local Representative) -- Constituency + Sub_Constituency keyed, basis =
// Constituency, sub-rows summed (Section 4).
// ---------------------------------------------------------------------

/**
 * Home Districts' 5 seats.
 * @param {Date} [now]
 */
export async function getHomeDistrictsSeats(now = new Date()) {
  return getConstituencyGroupedSeats('HomeDistricts', now);
}

/**
 * General Direct's 10 seats, including the derived `Local Representative`
 * seat (Section 4).
 * @param {Date} [now]
 */
export async function getGeneralDirectSeats(now = new Date()) {
  const seats = await getConstituencyGroupedSeats('GeneralDirect', now, {
    // Local Representative's row(s) in df_results_general_direct.csv are
    // entirely blank by design -- exclude blank Constituency rows from the
    // normal per-Constituency grouping so they don't form a bogus "" seat.
    excludeBlankConstituency: true,
    // Local Representative IS still one of the 10 roster entries in
    // df_party_participation.csv (Section 4: "its seat identity lives only
    // in df_party_participation.csv"), so the roster-driven loop above
    // would otherwise emit a second, blank/placeholder "Local
    // Representative" seat (0 matching rows -> Not received) alongside the
    // properly-derived one appended below. Skip it here; the derived
    // version is the only one that should reach the caller.
    excludeConstituencies: ['Local Representative'],
  });

  const local = await getLocalRepresentativeSeat(now);
  if (local) seats.push(local);
  return seats;
}

/**
 * Shared implementation for Home Districts / General Direct: group a
 * Constituency/Sub_Constituency-keyed results file by Constituency (the
 * seat), sum sub-rows, run Supplementary Vote per seat. The seat roster
 * itself comes from df_party_participation.csv (Section 4's authoritative
 * list of which Constituency values are real seats for this seat type),
 * not from the results file's row set, so a seat with zero data rows still
 * appears (as Not received) rather than silently disappearing.
 * @param {string} seatTypeId 'HomeDistricts' | 'GeneralDirect'
 * @param {Date} now
 * @param {{excludeBlankConstituency?:boolean}} [opts]
 */
async function getConstituencyGroupedSeats(seatTypeId, now, opts = {}) {
  const electionMeta = await loadElectionMeta();
  const [participationRows, { rows: resultRows }] = await Promise.all([
    loadPartyParticipation(),
    loadSeatTypeRows(electionMeta, seatTypeId),
  ]);

  const exclude = new Set(opts.excludeConstituencies || []);
  const roster = participationRows.filter((r) => r.Seat_Type === seatTypeId && !exclude.has(r.Constituency));
  const rowsByConstituency = new Map();
  for (const row of resultRows) {
    if (opts.excludeBlankConstituency && !row.Constituency) continue;
    if (!rowsByConstituency.has(row.Constituency)) rowsByConstituency.set(row.Constituency, []);
    rowsByConstituency.get(row.Constituency).push(row);
  }

  return roster.map((seatRoster) => {
    const constituencyName = seatRoster.Constituency;
    const rows = rowsByConstituency.get(constituencyName) || [];
    return buildSupplementaryVoteSeatSummary({
      seatTypeId,
      constituency: constituencyName,
      subConstituency: constituencyName, // the roster's own seat identity; sub-rows are reporting granularity only
      rows,
      participationRows,
      now,
      subRowCount: rows.length,
      // Named Sub_Constituency child rows (FEATURE_SPEC.md Section 4's
      // collapsible-row UI) -- each sub-row gets its own SV
      // count/status/vote breakdown, resolved against the SAME seat-level
      // participation row (df_party_participation.csv has no per-sub-row
      // entries -- participation is a property of the seat, Constituency ==
      // Sub_Constituency there -- see meta.js's findParticipation default).
      includeSubRows: rows.length > 1,
    });
  });
}

/**
 * Derive and shape the `Local Representative` seat (Section 4) into the
 * same summary shape as the other General Direct seats, sourced from Alma
 * Vale votes rather than its own (intentionally blank) results row.
 *
 * `deriveLocalRepresentative()` already gates `seatWinner` behind the
 * margin-safe rule (localRepresentative.js's `marginSafeResult` — no second
 * round for this seat, so a leader is only credited once the remaining
 * undeclared Districts can no longer catch up), so `winnerParty` below is
 * `null` until that's certain even if a party is currently ahead. `isFinal`
 * is surfaced separately so callers (the sub-page, the General Direct list,
 * the overview) don't have to reach into `derivation` themselves to know
 * whether it's safe to display `winnerParty` as decided.
 * @param {Date} now
 */
async function getLocalRepresentativeSeat(now) {
  const electionMeta = await loadElectionMeta();
  const [participationRows, shapeIndex, { rows: almaValeRows }] = await Promise.all([
    loadPartyParticipation(),
    getShapeJoinIndex(),
    loadSeatTypeRows(electionMeta, 'AlmaVale'),
  ]);

  const derived = deriveLocalRepresentative({
    almaValeRows,
    polygonById: shapeIndex.polygonById,
    participationRows,
    now,
  });

  const partyMeta = findParty(electionMeta, derived.seatWinner);

  // For the General Direct list page's shared vote table (which every
  // other seat feeds via seat.electorate/turnout/round1/round2/totals),
  // Local Representative is treated as its own mini-election where each
  // of the 1,779 District units nationwide is "one voter": Electorate =
  // that total, Turnout = 100% by design (every district's plurality
  // counts once it's Declared -- see districtsConsidered/undeclared in
  // `derived` for the real declared/undeclared split), Vote (raw count)
  // matches Electorate so the standard Vote/Electorate turnout-% formula
  // comes out to exactly 100%, and each spectrum's "1st preference" cell
  // is the number of Districts that spectrum's pooled display party (see
  // buildSpectrumDisplayLabels) actually won -- NOT a real ballot count.
  // No 2nd round or Spoil concept applies (FPTP, no SV transfer).
  const spectrumDisplayLabels = buildSpectrumDisplayLabels(participationRows);
  const round1 = {};
  for (const spectrum of ['Left', 'MR', 'Right']) {
    const label = spectrumDisplayLabels.get(spectrum);
    round1[spectrum] = derived.districtsWonByParty[label] || 0;
  }

  return {
    seatTypeId: 'GeneralDirect',
    constituency: 'Local Representative',
    subConstituency: 'Local Representative',
    isDerived: true,
    derivation: derived,
    winnerParty: derived.seatWinner,
    winnerPartyName: partyMeta ? partyMeta.name : null,
    winnerSpectrum: partyMeta ? partyMeta.spectrum : null,
    isFinal: derived.isFinal,
    electorate: derived.totalDistrictsNationwide,
    turnout: derived.totalDistrictsNationwide,
    round1,
    round2: null,
    totals: { Spoil: 0 },
    percentDeclared: null,
  };
}

/**
 * `Local Representative`'s reporting-sector row for General Proportional
 * (Section 4): its row in df_results_general_proportional.csv is blank by
 * design, same reason as its General Direct row (no ballot data of its
 * own). Sourced from the exact same District-level derivation as the
 * General Direct seat (`deriveLocalRepresentative` -- one "vote" per
 * (District, District_Ward) unit, credited to whichever party wins that
 * unit's plurality, only once ALL of its precincts are Declared), not a
 * raw ballot-count tally: Electorate/Turnout are both pinned to
 * `totalDistrictsNationwide` (every District counts as "one voter", same
 * convention `getLocalRepresentativeSeat` uses for the General Direct
 * table), and Spoil is always 0 (FPTP plurality count, no spoiled-ballot
 * concept at the District level). The only difference from that seat
 * derivation: this passes `partiesForRow` so NRD and LRP are kept as
 * separate parties instead of pooled into one combined display label --
 * General Proportional runs them as genuinely separate competing lists.
 *
 * Shaped to match the other 9 sectors in `getGeneralProportionalResult`'s
 * `sectors` array (same statusSummary/electorate/turnout/partyVotes/spoil
 * fields), except `subRowCount` is pinned to 1 -- with ~1,779 underlying
 * Districts (let alone ~20,850 precincts), an expandable per-unit
 * breakdown on this table would be unusable; that granularity already
 * exists on the Alma Vale / Local Representative sub-pages.
 * @param {Object} electionMeta
 * @param {Array<string>} partyAbbreviations General Proportional's own party columns (NRD/LRP/GRF/GCCA)
 * @param {Date} now
 */
async function buildLocalRepresentativeProportionalSector(electionMeta, partyAbbreviations, now) {
  const [participationRows, shapeIndex, { rows: almaValeRows }] = await Promise.all([
    loadPartyParticipation(),
    getShapeJoinIndex(),
    loadSeatTypeRows(electionMeta, 'AlmaVale'),
  ]);

  const partiesByConstituency = new Map(
    participationRows
      .filter((r) => r.Seat_Type === 'AlmaVale')
      .map((r) => [r.Constituency, { Left: r.Left_Party, MR: r.MR_Party, Right: r.Right_Party }])
  );
  const partiesForRow = (row) => {
    const precinct = shapeIndex.polygonById.get(row.Shape_ID);
    return (precinct && partiesByConstituency.get(precinct.Constituency)) || null;
  };

  const derived = deriveLocalRepresentative({ almaValeRows, polygonById: shapeIndex.polygonById, participationRows, now, partiesForRow });

  return {
    constituency: 'Local Representative',
    statusSummary: districtStatusSummary(derived),
    electorate: derived.totalDistrictsNationwide,
    turnout: derived.totalDistrictsNationwide,
    partyVotes: derived.districtsConsidered > 0
      ? Object.fromEntries(partyAbbreviations.map((p) => [p, derived.districtsWonByParty[p] || 0]))
      : null,
    spoil: 0,
    subRowCount: 1,
    subRows: undefined,
  };
}

/**
 * Synthesize a `summarizeStatus()`-shaped object for the derived Local
 * Representative sector, from `deriveLocalRepresentative()`'s own District
 * completion counts rather than re-deriving it from ~20,850 individual
 * precinct rows: each of the `totalDistrictsNationwide` Districts is
 * weighted 1 (matching that sector's Electorate = District count, not real
 * population), Declared once fully considered, Not received otherwise --
 * this derivation doesn't track a District's intermediate Verifying/
 * Counting state, only "fully Declared or not" (see its module doc), so
 * there is nothing to put in those two buckets.
 * @param {ReturnType<typeof deriveLocalRepresentative>} derived
 */
function districtStatusSummary(derived) {
  const total = derived.totalDistrictsNationwide;
  const declared = derived.districtsConsidered;
  const notReceived = total - declared;
  const percentDeclared = total > 0 ? (declared / total) * 100 : 0;
  return {
    totalRows: total,
    totalElectorate: total,
    byStatus: {
      [STATUS.NOT_RECEIVED]: { count: notReceived, electorate: notReceived, percentOfElectorate: 100 - percentDeclared },
      [STATUS.VERIFYING]: { count: 0, electorate: 0, percentOfElectorate: 0 },
      [STATUS.COUNTING]: { count: 0, electorate: 0, percentOfElectorate: 0 },
      [STATUS.DECLARED]: { count: declared, electorate: declared, percentOfElectorate: percentDeclared },
    },
    percentDeclared,
  };
}

/** True once every row backing a statusSummary (`summarizeStatus()`) is Declared — the same gate election-common.js's `isFullyDeclared()` applies at the page layer, replicated here so this data-layer module doesn't need to import from js/pages/. */
function isFullyDeclaredSummary(statusSummary) {
  if (!statusSummary || !statusSummary.totalRows) return false;
  return statusSummary.byStatus[STATUS.DECLARED].count === statusSummary.totalRows;
}

// ---------------------------------------------------------------------
// General Proportional (45 seats, national basis, two-stage Hare quota)
// ---------------------------------------------------------------------

/**
 * The national General Proportional allocation (Section 4), computed from
 * whichever of the 10 reporting sectors are currently Declared. Also
 * returns the electorate-weighted percent-declared across ALL 10 sectors,
 * so the UI can show "provisional, based on N/10 sectors (X% of
 * electorate) declared".
 *
 * Which allocation method runs depends on `isFinal` (all 10 sectors
 * Declared): the exact two-stage Hare quota + largest-remainder method
 * (`computeProportionalAllocation`) once true, otherwise the provisional
 * guaranteed-minimum method (`computeGuaranteedMinimumAllocation`) — see
 * proportional.js's doc comments on each for why the two can't just be one
 * function run on a partial total. `isFinal` is also returned so callers
 * (the overview page, this page's own banner) don't need to re-derive it
 * from `sectors`.
 * @param {Date} [now]
 */
/**
 * Safe upper bound on final national Valid Votes, given whichever of
 * Electorate/Turnout/Valid-Votes is currently known for each row (Section 2's
 * status pipeline) — the tightest bound `computeGuaranteedMinimumAllocation()`
 * can gate/quota against while it's still mathematically guaranteed to never
 * fall below the true final Valid Votes (see that function's doc comment for
 * why each per-row substitution is safe): a Declared row's own Valid Votes
 * contribution is exact and needs no substitute; a Counting row's Turnout is
 * visible and fixed, and `Valid <= Turnout`; anything earlier only has
 * Electorate, and `Turnout <= Electorate`. Summed across rows, this
 * tightens automatically as more of the count reaches Counting/Declared,
 * without ever needing every row to reach the same stage at once.
 * @param {Array<Object>} rows raw result rows
 * @param {Array<string>} partyAbbreviations
 * @param {Date} now
 */
function computeSafeVoteBound(rows, partyAbbreviations, now) {
  let bound = 0;
  for (const row of rows) {
    if (computeStatus(row, now) === STATUS.DECLARED) {
      for (const abbrev of partyAbbreviations) bound += toNumber(row[abbrev]);
    } else if (statusAtLeast(row, STATUS.COUNTING, now)) {
      bound += toNumber(row.Turnout);
    } else {
      bound += toNumber(row.Electorate);
    }
  }
  return bound;
}

export async function getGeneralProportionalResult(now = new Date()) {
  const electionMeta = await loadElectionMeta();
  const { seatType, rows: allRows } = await loadSeatTypeRows(electionMeta, 'GeneralProportional');

  const lists = seatType.lists || [];
  const partyToList = flattenLists(lists);
  const partyAbbreviations = [...partyToList.keys()];

  // Local Representative's row here is blank by design (same reason as its
  // General Direct row) -- excluded from the normal per-row tally below
  // and replaced with a sector derived from Alma Vale precinct data
  // instead (buildLocalRepresentativeProportionalSector).
  const rows = allRows.filter((row) => row.Constituency !== 'Local Representative');

  const partyVotes = Object.fromEntries(partyAbbreviations.map((p) => [p, 0]));
  let spoil = 0;
  let electorate = 0;
  let isFinal = allRows.length > 0;

  for (const row of rows) {
    electorate += toNumber(row.Electorate); // all sectors count toward electorate/percentDeclared regardless of status
    const declared = computeStatus(row, now) === STATUS.DECLARED;
    if (!declared) isFinal = false;
    if (!declared) continue; // vote totals: Declared sectors only
    for (const abbrev of partyAbbreviations) partyVotes[abbrev] += toNumber(row[abbrev]);
    spoil += toNumber(row.Spoil);
  }

  const localRepSector = await buildLocalRepresentativeProportionalSector(electionMeta, partyAbbreviations, now);
  electorate += localRepSector.electorate;
  if (!isFullyDeclaredSummary(localRepSector.statusSummary)) isFinal = false;
  if (localRepSector.partyVotes) {
    for (const abbrev of partyAbbreviations) partyVotes[abbrev] += localRepSector.partyVotes[abbrev] || 0;
    spoil += localRepSector.spoil || 0;
  }

  // Local Representative's own contribution to the safe vote bound is
  // always exactly its District count: whether a District is Declared
  // (its 1 "vote" is already exactly known) or not (its Electorate=1 is
  // the fallback), either way it contributes exactly 1 -- there's no
  // intermediate Turnout-known-but-undeclared tier tracked per District
  // (deriveLocalRepresentative only distinguishes "fully Declared" from
  // "not"), so `localRepSector.electorate` already IS its safe bound.
  const voteBound = computeSafeVoteBound(rows, partyAbbreviations, now) + localRepSector.electorate;

  const allocationInput = {
    partyVotes,
    spoil,
    electorate,
    voteBound,
    lists,
    totalSeats: seatType.count,
    thresholdPct: seatType.threshold_pct,
  };
  const allocation = isFinal
    ? computeProportionalAllocation(allocationInput)
    : computeGuaranteedMinimumAllocation(allocationInput);

  // Reporting sectors (Section 4), grouped by Constituency -- normally 1:1
  // with Sub_Constituency in the current data (one row per sector), but
  // grouped the same way Home Districts/General Direct group their
  // Sub_Constituency rows (see getConstituencyGroupedSeats below), so a
  // sector that DOES get split into multiple reporting rows shows as one
  // expandable sector with its own sub-division breakdown, rather than
  // several unrelated top-level rows. Iterates `allRows` (not the filtered
  // `rows`) to preserve Local Representative's original position among the
  // 10 sectors, substituting its derived sector in place of its blank row.
  const rowsBySector = new Map();
  for (const row of allRows) {
    if (!rowsBySector.has(row.Constituency)) rowsBySector.set(row.Constituency, []);
    rowsBySector.get(row.Constituency).push(row);
  }

  const sectors = [...rowsBySector.entries()].map(([constituency, sectorRows]) => {
    if (constituency === 'Local Representative') return localRepSector;
    const statusSummary = summarizeStatus(sectorRows, { now });
    return {
      constituency,
      statusSummary,
      electorate: statusSummary.totalElectorate,
      turnout: sumKnownTurnout(sectorRows, now),
      partyVotes: sumSectorPartyVotes(sectorRows, partyAbbreviations, now),
      spoil: sumSectorSpoil(sectorRows, now),
      subRowCount: sectorRows.length,
      subRows: sectorRows.length > 1
        ? sectorRows.map((row) => buildSectorRowSummary(row, partyAbbreviations, now))
        : undefined,
    };
  });

  return {
    ...allocation,
    isFinal,
    seatType,
    sectors,
  };
}

/**
 * Per-party votes for a group of raw reporting-sector rows, Declared-only
 * per row (Section 2's "Declared" -> "full result" gate) -- `null` if none
 * of the rows have Declared yet, so the UI can render "—" rather than a
 * misleading 0 for a sector still being counted.
 * @param {Array<Object>} sectorRows
 * @param {Array<string>} partyAbbreviations
 * @param {Date} now
 */
function sumSectorPartyVotes(sectorRows, partyAbbreviations, now) {
  const declaredRows = sectorRows.filter((r) => computeStatus(r, now) === STATUS.DECLARED);
  if (!declaredRows.length) return null;
  return Object.fromEntries(
    partyAbbreviations.map((abbrev) => [abbrev, declaredRows.reduce((sum, r) => sum + toNumber(r[abbrev]), 0)])
  );
}

/**
 * Spoiled/invalid ballots for a group of raw reporting-sector rows,
 * Declared-only per row -- same gate as `sumSectorPartyVotes()` (Spoil is
 * part of the vote breakdown, Section 2), `null` below that.
 * @param {Array<Object>} sectorRows
 * @param {Date} now
 */
function sumSectorSpoil(sectorRows, now) {
  const declaredRows = sectorRows.filter((r) => computeStatus(r, now) === STATUS.DECLARED);
  if (!declaredRows.length) return null;
  return declaredRows.reduce((sum, r) => sum + toNumber(r.Spoil), 0);
}

/**
 * One raw reporting-sector row shaped for the sector table's sub-division
 * breakdown (only attached when a sector's Constituency actually splits
 * into more than one Sub_Constituency row -- see getGeneralProportionalResult).
 * @param {Object} row
 * @param {Array<string>} partyAbbreviations
 * @param {Date} now
 */
function buildSectorRowSummary(row, partyAbbreviations, now) {
  return {
    subConstituency: row.Sub_Constituency,
    status: computeStatus(row, now),
    electorate: toNumber(row.Electorate),
    turnout: turnoutIfKnown(row, now),
    partyVotes: sumSectorPartyVotes([row], partyAbbreviations, now),
    spoil: sumSectorSpoil([row], now),
  };
}

// ---------------------------------------------------------------------
// Overview (seats won per party, by seat type) -- Section 4's site
// structure: overview -> seat type -> individual seat detail.
// ---------------------------------------------------------------------

/**
 * Seats won per party, broken down by seat type, for the General Election
 * overview page.
 * @param {Date} [now]
 */
export async function getOverview(now = new Date()) {
  const [almaVale, homeDistricts, generalDirect, proportional] = await Promise.all([
    getAlmaValeSeats(now),
    getHomeDistrictsSeats(now),
    getGeneralDirectSeats(now),
    getGeneralProportionalResult(now),
  ]);

  const tally = {}; // party abbreviation -> {bySeatType: {...}, total}
  const bump = (seatTypeId, party, count = 1) => {
    if (!party) return;
    if (!tally[party]) tally[party] = { bySeatType: {}, total: 0 };
    tally[party].bySeatType[seatTypeId] = (tally[party].bySeatType[seatTypeId] || 0) + count;
    tally[party].total += count;
  };

  for (const seat of almaVale) bump('AlmaVale', seat.winnerParty);
  for (const seat of homeDistricts) bump('HomeDistricts', seat.winnerParty);
  for (const seat of generalDirect) bump('GeneralDirect', seat.winnerParty);
  for (const list of proportional.lists) {
    for (const party of list.parties) bump('GeneralProportional', party.abbreviation, party.seats);
  }

  return {
    tally,
    seatTypes: {
      AlmaVale: almaVale,
      HomeDistricts: homeDistricts,
      GeneralDirect: generalDirect,
      GeneralProportional: proportional,
    },
  };
}

// ---------------------------------------------------------------------
// Shared helper: aggregate rows + run Supplementary Vote + resolve the
// winning party, packaged into one summary object.
// ---------------------------------------------------------------------

function buildSupplementaryVoteSeatSummary({
  seatTypeId,
  constituency,
  subConstituency,
  rows,
  participationRows,
  now,
  constituencyMeta,
  subRowCount,
  includeSubRows,
}) {
  const declaredTotals = sumSupplementaryVoteRows(rows, { include: (row) => DECLARED_ONLY(row, now) });
  const svResult = computeSupplementaryVote(declaredTotals);

  const statusSummary = summarizeStatus(rows, { now });
  const undecided = computeUndecidedVotes(rows, now);
  const certainty = resolveSupplementaryVoteCertainty(svResult, undecided);
  const winnerSpectrum = leadingSpectrum(svResult, certainty); // overrides svResult's own forced-elimination `winner`, see module doc comment

  const participation = findParticipation(participationRows, seatTypeId, constituency, subConstituency);
  const winnerParty = resolveWinningParty(winnerSpectrum, participation);

  return {
    seatTypeId,
    constituency,
    subConstituency,
    region: constituencyMeta ? constituencyMeta.Region : undefined,
    constituencyCode: constituencyMeta ? constituencyMeta.Constituency_Code : undefined,
    subRowCount: subRowCount != null ? subRowCount : rows.length,
    electorate: statusSummary.totalElectorate,
    turnout: sumKnownTurnout(rows, now),
    percentDeclared: statusSummary.percentDeclared,
    statusSummary,
    round1: svResult.round1,
    round2: svResult.round2,
    eliminated: svResult.eliminated,
    nil: svResult.nil,
    winnerSpectrum,
    winnerParty,
    tie: svResult.tie,
    // Mathematical-certainty declaration gate (see resolveSupplementaryVoteCertainty
    // in supplementaryVote.js) -- `winnerSpectrum`/`winnerParty` above are the
    // CURRENTLY-leading figures, safe for a "Leading: X" display even from
    // partial data (via `leadingSpectrum()`, which itself only trusts a
    // forced round2 hypothetical once the runoff pairing is certain -- see
    // supplementaryVote.js's doc comment), while `certainty.resultCertain` is
    // what UI should gate an actual settled-result display on, since it
    // accounts for whether the remaining undeclared ballots could still
    // change the outcome. Whenever `certainty.resultCertain` is true,
    // `certainty.winner` always equals `winnerSpectrum` (both `leadingSpectrum()`
    // and `certainty` itself defer to the same `svResult.winner` once the
    // runoff pairing is certain -- proven for `certainty.winner`/`svResult.winner`
    // in supplementaryVote.test.mjs) -- certainty only ever narrows a
    // majority the raw current tally already shows.
    certainty,
    totals: declaredTotals,
    // Named Sub_Constituency child rows, only populated when there's more
    // than one (FEATURE_SPEC.md Section 4: "When a Constituency has more
    // than one row... the UI shows Constituency as a collapsible row
    // containing its Sub_Constituency rows"). Each child gets its own SV
    // count against the SAME seat-level participation row (participation is
    // a property of the seat, not of individual sub-rows -- see this
    // function's `participation` lookup above, reused unchanged below).
    subRows: includeSubRows ? buildSubRowSummaries(rows, participation, now) : undefined,
  };
}

/**
 * Per-Sub_Constituency child summaries for a multi-row Constituency seat
 * (Home Districts / General Direct -- Section 4's collapsible-row UI).
 * Rows are grouped by `Sub_Constituency` (defensively -- normally each
 * value is already unique per Constituency in the source CSVs) and each
 * group gets its own Supplementary Vote count/status breakdown, resolved
 * against the seat's own participation row (df_party_participation.csv has
 * no per-sub-row entries -- see the caller).
 * @param {Array<Object>} rows raw result rows for one Constituency
 * @param {Object|null} participation this seat's df_party_participation.csv row
 * @param {Date} now
 * @returns {Array<Object>} one entry per distinct Sub_Constituency, in row order
 */
function buildSubRowSummaries(rows, participation, now) {
  const bySub = new Map();
  for (const row of rows) {
    const key = row.Sub_Constituency || '';
    if (!bySub.has(key)) bySub.set(key, []);
    bySub.get(key).push(row);
  }
  return [...bySub.entries()].map(([subConstituency, subRows]) => {
    const totals = sumSupplementaryVoteRows(subRows, { include: (row) => DECLARED_ONLY(row, now) });
    const svResult = computeSupplementaryVote(totals);
    const statusSummary = summarizeStatus(subRows, { now });
    const undecided = computeUndecidedVotes(subRows, now);
    const certainty = resolveSupplementaryVoteCertainty(svResult, undecided);
    const winnerSpectrum = leadingSpectrum(svResult, certainty); // overrides svResult's own forced-elimination `winner`, see module doc comment
    const winnerParty = resolveWinningParty(winnerSpectrum, participation);
    return {
      subConstituency,
      electorate: statusSummary.totalElectorate,
      turnout: sumKnownTurnout(subRows, now),
      percentDeclared: statusSummary.percentDeclared,
      statusSummary,
      round1: svResult.round1,
      round2: svResult.round2,
      eliminated: svResult.eliminated,
      nil: svResult.nil,
      winnerSpectrum,
      winnerParty,
      tie: svResult.tie,
      certainty,
      totals,
    };
  });
}
