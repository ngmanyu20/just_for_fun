/**
 * localRepresentative.js — derivation rule for the one-off `Local
 * Representative` seat within General Direct (FEATURE_SPEC.md Section 4).
 *
 * `Local Representative`'s row in df_results_general_direct.csv is
 * entirely blank by design (no ballot data of its own). Its result is
 * derived instead:
 *   1. Take precinct-level votes from df_results_alma_vale.csv, join each
 *      precinct to its District via df_polygon.csv.
 *   2. Sum votes per party within each District; whichever party has the
 *      plurality (highest vote) wins that District.
 *   3. The party that wins the most Districts overall is awarded the seat.
 *
 * `seatWinner` is only ever set once that's mathematically certain, not as
 * soon as a party is simply ahead: there's no second round for this seat
 * (added per user direction), so a leader is only declared once the
 * remaining undeclared Districts are fewer than its lead over the
 * runner-up — the trailing party couldn't catch up even by winning every
 * single one of them. See `marginSafeResult()` below. Before that point
 * `currentLeader` still reports who's ahead right now, for a "leading, not
 * yet decided" display, but `seatWinner` stays `null`.
 *
 * Two interpretive judgment calls, both clarified directly by the user
 * after reviewing the live data (not spelled out in FEATURE_SPEC.md):
 *
 * **What counts as "a District"**: `df_districts.csv` has 1,779 rows, each
 * its own polygon with its own `District_Ward` label, `Population`, and
 * `Constituency` — many rows share a `District` *name* (e.g. 87 rows are
 * all named "Alington City", spread across 2 constituencies), but each row
 * is its own independently-contested electoral unit for this rule's
 * "one vote per District" count — 1,779 total, not the ~38 distinct
 * District names. `df_polygon.csv` precincts carry a matching
 * `District_Ward` column, so the join to `df_districts.csv` is unneeded
 * for the tally itself — a precinct's own `(District, District_Ward)` pair
 * already identifies which of the 1,779 units it belongs to.
 *
 * **Which parties get pooled**: Alma Vale's ballot columns are
 * spectrum-labeled (`Left_Left`, `Right_Right`, ...), not party-labeled,
 * and Section 3 establishes that Left is fielded by either NRD or LRP
 * depending on constituency (`df_party_participation.csv`'s AlmaVale
 * rows), while MR and Right only ever field one party each (GRF, GCCA —
 * see `election_meta.json`'s `spectrums[].parties`). Since a constituency
 * only ever fields ONE party per spectrum (`SupplementaryVote` seats field
 * exactly one party per spectrum, Section 3), a spectrum's first-preference
 * total is unambiguous without ever looking up which specific party it
 * is — so this module tallies by SPECTRUM first (Left/MR/Right, straight
 * from each row's own round1 sums) and only maps the winning spectrum to a
 * display party label at the very end. That label mapping comes from
 * `df_party_participation.csv`'s own `GeneralDirect` / `Local
 * Representative` row (`Left_Party=LRP, MR_Party=GRF, Right_Party=GCCA`) —
 * that row exists specifically to supply it, even though the seat's own
 * vote columns are blank. The practical effect: every Left-spectrum vote
 * nationwide (whether cast in an NRD-fielding constituency or an
 * LRP-fielding one) is pooled into one combined "LRP" total for this
 * seat's purposes — NRD and LRP are genuinely separate, independently
 * competing parties everywhere else (General Proportional runs them
 * against each other, Section 4's worked example), but for the Local
 * Representative derivation specifically they're the same "Left" force
 * under two different local brandings, per the participation row's label
 * choice.
 *
 * Uses first-preference totals only (no Supplementary Vote transfer
 * round) — the derivation is a plurality count of first preferences, not
 * a re-run of the SV method.
 *
 * Pure function, no fetch/DOM — importable straight into Node for tests.
 */

import { toNumber, computeStatus, STATUS } from './status.js';

const SPECTRUMS = ['Left', 'Right', 'MR'];

/**
 * Build the "{spectrum} -> display party label" map for the Local
 * Representative derivation, from `df_party_participation.csv`'s own
 * `GeneralDirect` / `Local Representative` row. MR and Right only ever
 * field one party each, so their label is just that party unchanged; Left
 * is the only spectrum with more than one competing party nationally (NRD
 * and LRP, see module doc), so both get folded under this row's single
 * "LRP" label. Falls back to the raw spectrum id if the row is missing
 * (defensive — should never happen against real data).
 * @param {Array<Object>} participationRows
 * @returns {Map<string,string>} spectrum -> display party label
 */
export function buildSpectrumDisplayLabels(participationRows) {
  const row = (participationRows || []).find(
    (r) => r.Seat_Type === 'GeneralDirect' && r.Constituency === 'Local Representative'
  );
  const labels = new Map();
  for (const spectrum of SPECTRUMS) {
    const label = row && row[`${spectrum}_Party`] ? String(row[`${spectrum}_Party`]).trim() : spectrum;
    labels.set(spectrum, label);
  }
  return labels;
}

/**
 * One Alma Vale row's first-preference totals per spectrum, straight from
 * its own round1 ballot columns (Left_Left/Left_Right/Left_MR, etc). Shared
 * by `tallyFirstPreferenceSpectrumVotes` (pools by spectrum) and
 * `tallyFirstPreferencePartyVotes` (attributes to the actual party per row)
 * below, so the two never drift out of sync on how a row's raw columns turn
 * into spectrum totals.
 * @param {Object} row raw df_results_alma_vale.csv row
 * @returns {{Left:number, Right:number, MR:number}}
 */
function round1BySpectrum(row) {
  return {
    Left: toNumber(row.Left_Left) + toNumber(row.Left_Right) + toNumber(row.Left_MR),
    Right: toNumber(row.Right_Left) + toNumber(row.Right_Right) + toNumber(row.Right_MR),
    MR: toNumber(row.MR_Left) + toNumber(row.MR_Right) + toNumber(row.MR_MR),
  };
}

/**
 * FPTP (first-preference-only, no Supplementary Vote transfer round)
 * SPECTRUM vote tally for a set of Alma Vale rows — the method
 * FEATURE_SPEC.md Section 4 mandates for the Local Representative
 * derivation ("sum votes per party ... whichever party has the plurality
 * wins"), factored out so the map's District-level "who wins this
 * District" tooltip/color can reuse the exact same counting rule instead
 * of re-running the Supplementary Vote method (which is what Alma Vale
 * SEATS use, not what District-level FPTP counting uses).
 * @param {Array<Object>} rows raw df_results_alma_vale.csv rows (caller filters to Declared-only first)
 * @returns {Map<string,number>} spectrum -> first-preference votes
 */
export function tallyFirstPreferenceSpectrumVotes(rows) {
  const votesBySpectrum = new Map();
  for (const row of rows) {
    const round1 = round1BySpectrum(row);
    for (const spectrum of SPECTRUMS) {
      const votes = round1[spectrum];
      if (votes === 0) continue;
      votesBySpectrum.set(spectrum, (votesBySpectrum.get(spectrum) || 0) + votes);
    }
  }
  return votesBySpectrum;
}

/**
 * Per-PARTY (not spectrum-pooled) first-preference vote tally for a set of
 * Alma Vale rows — same underlying round1 columns as
 * `tallyFirstPreferenceSpectrumVotes`, but each row's Left votes are
 * credited to whichever specific party actually fields Left in that row's
 * own constituency (NRD or LRP — see module doc's "Which parties get
 * pooled" section), not pooled into one combined label. General
 * Proportional runs NRD and LRP as genuinely separate competing lists
 * (Section 4's worked example), so its own use of Alma Vale data (the
 * derived `Local Representative` sector on the General Proportional page)
 * needs this instead of the seat derivation's pooled version.
 * @param {Array<Object>} rows raw df_results_alma_vale.csv rows (caller filters to Declared-only first)
 * @param {(row:Object) => ({Left:string, MR:string, Right:string}|null)} partiesForRow resolves a row to its constituency's Left/MR/Right party abbreviations, or `null` if unresolvable (skipped defensively)
 * @returns {Map<string,number>} party abbreviation -> first-preference votes
 */
export function tallyFirstPreferencePartyVotes(rows, partiesForRow) {
  const votesByParty = new Map();
  for (const row of rows) {
    const parties = partiesForRow(row);
    if (!parties) continue;
    const round1 = round1BySpectrum(row);
    for (const spectrum of SPECTRUMS) {
      const party = parties[spectrum];
      const votes = round1[spectrum];
      if (!party || votes === 0) continue;
      votesByParty.set(party, (votesByParty.get(party) || 0) + votes);
    }
  }
  return votesByParty;
}

/**
 * Relabel a spectrum -> votes tally to display-party-label -> votes, per
 * `buildSpectrumDisplayLabels` — this is where NRD-sourced and
 * LRP-sourced Left votes actually get pooled together (both spectrums'
 * votes land under the same "LRP" label).
 * @param {Map<string,number>} votesBySpectrum
 * @param {Map<string,string>} spectrumDisplayLabels
 * @returns {Map<string,number>} display party label -> votes
 */
export function relabelSpectrumVotes(votesBySpectrum, spectrumDisplayLabels) {
  const votesByLabel = new Map();
  for (const [spectrum, votes] of votesBySpectrum) {
    const label = spectrumDisplayLabels.get(spectrum) || spectrum;
    votesByLabel.set(label, (votesByLabel.get(label) || 0) + votes);
  }
  return votesByLabel;
}

/**
 * Plurality winner from a label -> votes tally. Ties broken by
 * first-encountered (Map iteration/insertion order) — spec is silent on
 * ties; deterministic given fixed input order, not claimed to be "correct"
 * tie-breaking.
 * @param {Map<string,number>} votesByLabel
 * @returns {string|null}
 */
export function pluralityWinner(votesByLabel) {
  let winner = null;
  let best = -Infinity;
  for (const [label, votes] of votesByLabel) {
    if (votes > best) {
      best = votes;
      winner = label;
    }
  }
  return winner;
}

/**
 * Decide whether the current District leader's win is already
 * mathematically certain, given how many (District, District_Ward) units
 * are still undeclared. There's no second round for this seat (FPTP
 * plurality-of-Districts, Section 4) — so the trailing party's best
 * possible outcome is winning every single remaining undeclared District
 * outright, and the leader's win is certain exactly once even that best
 * case can't catch up: `districtsRemaining < margin`, where `margin` is
 * the leader's current lead over the runner-up (the party best-placed to
 * catch up — no other trailing party can ever do better than the
 * runner-up against the same pool of remaining Districts). Once every
 * District has actually been counted (`districtsRemaining === 0`) the
 * tally itself already *is* final regardless of the margin — including a
 * genuine tie, broken the same arbitrary-but-deterministic way
 * `pluralityWinner` breaks any tie — since there's nothing left to change it.
 * @param {Map<string,number>} districtsWonByParty display label -> Districts won so far (fully-declared units only)
 * @param {number} districtsRemaining count of (District, District_Ward) units not yet fully Declared
 * @returns {{currentLeader: string|null, margin: number, isFinal: boolean, winner: string|null}}
 */
export function marginSafeResult(districtsWonByParty, districtsRemaining) {
  const entries = [...districtsWonByParty.entries()].sort((a, b) => b[1] - a[1]);
  const currentLeader = entries.length ? entries[0][0] : null;
  const leaderCount = entries.length ? entries[0][1] : 0;
  const runnerUpCount = entries.length > 1 ? entries[1][1] : 0;
  const margin = leaderCount - runnerUpCount;
  const remaining = Math.max(0, districtsRemaining);
  const isFinal = currentLeader != null && (remaining === 0 || remaining < margin);
  return { currentLeader, margin, isFinal, winner: isFinal ? currentLeader : null };
}

/**
 * Total (District, District_Ward) unit count per District *name* ("council"
 * in the UI — the ~38 broader groupings, e.g. "Alington City", each made up
 * of many independently-contested District units — see module doc). Counts
 * straight from `polygonById` (every precinct nationwide carries its own
 * `District`/`District_Ward`, regardless of Alma Vale/Declared status), so
 * this reflects the TRUE total even for councils with zero Declared
 * precincts right now — needed to show "N undeclared" per council rather
 * than just omitting them.
 * @param {Map<string,Object>} polygonById
 * @returns {Map<string,number>} council (District name) -> total district-ward units
 */
export function buildCouncilTotals(polygonById) {
  const wardsByCouncil = new Map();
  for (const p of polygonById.values()) {
    if (!p.District || !p.District_Ward) continue;
    if (!wardsByCouncil.has(p.District)) wardsByCouncil.set(p.District, new Set());
    wardsByCouncil.get(p.District).add(p.District_Ward);
  }
  const totals = new Map();
  for (const [council, wards] of wardsByCouncil) totals.set(council, wards.size);
  return totals;
}

/**
 * Council (District name) -> Region, for grouping the UI's council table
 * by Region (Capital/Highland/Lowland). Every precinct nationwide carries
 * its own `Region` (df_polygon.csv), and — unlike `Constituency`, which 12
 * District names genuinely straddle (Section 1) — a District name never
 * spans more than one Region in the live data (verified: 0 of 37 District
 * names have precincts in more than one Region), so the first precinct
 * seen for a council is always representative.
 * @param {Map<string,Object>} polygonById
 * @returns {Map<string,string>} council (District name) -> Region
 */
export function buildCouncilRegions(polygonById) {
  const regions = new Map();
  for (const p of polygonById.values()) {
    if (!p.District || !p.Region || regions.has(p.District)) continue;
    regions.set(p.District, p.Region);
  }
  return regions;
}

/**
 * @param {Object} input
 * @param {Array<Object>} input.almaValeRows Raw df_results_alma_vale.csv rows.
 * @param {Map<string,Object>} input.polygonById Shape_ID -> precinct row (needs `.District`, `.District_Ward`).
 * @param {Array<Object>} input.participationRows df_party_participation.csv rows.
 * @param {Date} [input.now]
 * @param {string} [input.minStatus='Declared'] Only rows at/above this status
 *   contribute votes — consistent with this data layer's rule that vote
 *   totals (not turnout/electorate) are only trustworthy once Declared.
 * @param {(row:Object) => ({Left:string, MR:string, Right:string}|null)} [input.partiesForRow]
 *   When given, each district's plurality is decided PER-PARTY (via
 *   `tallyFirstPreferencePartyVotes`) instead of the default pooled-by-
 *   spectrum labeling (`buildSpectrumDisplayLabels` + `relabelSpectrumVotes`,
 *   which folds every Left vote nationwide into one combined display label
 *   — see module doc's "Which parties get pooled"). General Proportional's
 *   own use of this derivation (the `Local Representative` sector on the
 *   General Proportional page) needs NRD and LRP kept apart, since it runs
 *   them as genuinely separate competing lists; the General Direct seat
 *   (this function's original caller) omits this to keep its existing
 *   pooled behavior.
 * @returns {{
 *   seatWinner: string|null,
 *   currentLeader: string|null,
 *   margin: number,
 *   isFinal: boolean,
 *   districtsRemaining: number,
 *   districtsWonByParty: Record<string, number>,
 *   districtWinners: Record<string, string>,
 *   votesByDistrict: Record<string, Record<string, number>>,
 *   districtsConsidered: number,
 *   totalDistrictsNationwide: number,
 *   precinctsConsidered: number,
 *   precinctsSkippedUnmatched: number,
 *   councils: Record<string, {
 *     region: string|null,
 *     totalDistricts: number,
 *     declaredDistricts: number,
 *     undeclaredDistricts: number,
 *     seatsByParty: Record<string, number>,
 *     votesByParty: Record<string, number>
 *   }>
 * }}
 */
export function deriveLocalRepresentative(input) {
  const { almaValeRows, polygonById, participationRows, partiesForRow } = input;
  const now = input.now || new Date();
  const minStatus = input.minStatus || STATUS.DECLARED;

  const spectrumDisplayLabels = partiesForRow ? null : buildSpectrumDisplayLabels(participationRows);

  // Pass 1: bucket EVERY matched precinct (any status) by (District,
  // District_Ward) -- each row of df_districts.csv is its own distinct
  // electoral District for this rule's "one vote per District" count
  // (1,779 total; see module doc for why a District *name* like "Alington
  // City" is a grouping of many independently-contested units, not itself
  // one voting unit). Keyed by the readable "District (District_Ward)"
  // string, which module doc / shapes.js confirms is unique across the
  // whole dataset. Tracking every precinct (not just Declared ones) here
  // lets pass 2 tell whether a unit is FULLY Declared, not just "has at
  // least one Declared precinct" -- a unit's apparent plurality can still
  // flip once its remaining precincts report, so a partially-declared unit
  // must not contribute votes or count as "won" until every one of its
  // precincts has reported (real data currently has 434 of the 1,779
  // units in exactly this partial state -- they must show as undeclared,
  // not as decided on incomplete data).
  const buckets = new Map();
  let precinctsSkippedUnmatched = 0;

  for (const row of almaValeRows || []) {
    const precinct = polygonById.get(row.Shape_ID);
    if (!precinct) {
      precinctsSkippedUnmatched++;
      continue; // defensive: unmatched Shape_ID never crashes the derivation
    }
    const key = `${precinct.District} (${precinct.District_Ward})`;
    if (!buckets.has(key)) buckets.set(key, { council: precinct.District, rows: [], totalPrecincts: 0, declaredPrecincts: 0 });
    const bucket = buckets.get(key);
    bucket.totalPrecincts++;
    const atMinStatus = minStatus === STATUS.DECLARED ? computeStatus(row, now) === STATUS.DECLARED : true;
    if (atMinStatus) {
      bucket.declaredPrecincts++;
      bucket.rows.push(row);
    }
  }

  // Pass 2: only FULLY Declared units (every one of their precincts
  // Declared) contribute votes, a winner, or count toward a council's
  // declared total -- partial and fully-undeclared units alike are
  // skipped entirely here (they still count toward `totalDistricts` via
  // `buildCouncilTotals` below, just not `declaredDistricts`).
  const votesByDistrictAndLabel = new Map(); // "District (Ward)" -> Map(display label -> votes)
  const districtWinners = new Map();
  const councilSeats = new Map(); // council -> Map(display label -> districts won)
  const councilVotes = new Map(); // council -> Map(display label -> votes)
  const councilDeclaredCount = new Map(); // council -> count of FULLY declared district-ward units
  let precinctsConsidered = 0;

  for (const [key, bucket] of buckets) {
    if (bucket.totalPrecincts === 0 || bucket.declaredPrecincts !== bucket.totalPrecincts) continue;
    precinctsConsidered += bucket.totalPrecincts;

    const labelVotes = partiesForRow
      ? tallyFirstPreferencePartyVotes(bucket.rows, partiesForRow)
      : relabelSpectrumVotes(tallyFirstPreferenceSpectrumVotes(bucket.rows), spectrumDisplayLabels);
    votesByDistrictAndLabel.set(key, labelVotes);
    const winner = pluralityWinner(labelVotes);
    if (winner) districtWinners.set(key, winner);

    const council = bucket.council;
    councilDeclaredCount.set(council, (councilDeclaredCount.get(council) || 0) + 1);
    if (!councilVotes.has(council)) councilVotes.set(council, new Map());
    const cv = councilVotes.get(council);
    for (const [label, votes] of labelVotes) cv.set(label, (cv.get(label) || 0) + votes);
    if (winner) {
      if (!councilSeats.has(council)) councilSeats.set(council, new Map());
      const cs = councilSeats.get(council);
      cs.set(winner, (cs.get(winner) || 0) + 1);
    }
  }

  const districtsWonByParty = new Map();
  for (const winner of districtWinners.values()) {
    districtsWonByParty.set(winner, (districtsWonByParty.get(winner) || 0) + 1);
  }

  const councilTotals = buildCouncilTotals(polygonById);
  const councilRegions = buildCouncilRegions(polygonById);
  const councils = new Map();
  let totalDistrictsNationwide = 0;
  for (const [council, totalDistricts] of councilTotals) {
    const declaredDistricts = councilDeclaredCount.get(council) || 0;
    totalDistrictsNationwide += totalDistricts;
    councils.set(council, {
      region: councilRegions.get(council) || null,
      totalDistricts,
      declaredDistricts,
      undeclaredDistricts: Math.max(0, totalDistricts - declaredDistricts),
      seatsByParty: Object.fromEntries(councilSeats.get(council) || new Map()),
      votesByParty: Object.fromEntries(councilVotes.get(council) || new Map()),
    });
  }

  // districtsConsidered = fully-Declared units (votesByDistrictAndLabel.size)
  // -- see the module doc on marginSafeResult() for why the seat is only
  // called once the leader's margin over the runner-up can't be caught by
  // however these remaining Districts go.
  const districtsRemaining = Math.max(0, totalDistrictsNationwide - votesByDistrictAndLabel.size);
  const { currentLeader, margin, isFinal, winner: seatWinner } = marginSafeResult(districtsWonByParty, districtsRemaining);

  return {
    seatWinner,
    currentLeader,
    margin,
    isFinal,
    districtsRemaining,
    districtsWonByParty: Object.fromEntries(districtsWonByParty),
    districtWinners: Object.fromEntries(districtWinners),
    councils: Object.fromEntries(councils),
    votesByDistrict: Object.fromEntries([...votesByDistrictAndLabel].map(([d, m]) => [d, Object.fromEntries(m)])),
    districtsConsidered: votesByDistrictAndLabel.size,
    // Total (District, District_Ward) units nationwide (1,779 in the live
    // data) -- every district counts as "one voter" for the General
    // Direct list page's Local Representative row (Electorate = this
    // total, Turnout = 100% by design, "votes" per spectrum = districts
    // that spectrum's pooled party won -- see election-general-direct.js).
    totalDistrictsNationwide,
    precinctsConsidered,
    precinctsSkippedUnmatched,
  };
}
