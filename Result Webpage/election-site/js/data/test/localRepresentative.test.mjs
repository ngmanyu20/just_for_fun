/**
 * Tests for localRepresentative.js's derivation rule (FEATURE_SPEC.md
 * Section 4), using a small synthetic fixture (data/results/df_results_alma_vale.csv
 * is currently empty per Section 7's simulation checklist, so this can't
 * be cross-checked against real numbers yet -- the fixture below stands in
 * for it and exercises the spectrum-first tally + NRD/LRP pooling, the
 * (District, District_Ward) plurality step, and the overall-winner step
 * end to end).
 *
 * Run with: node election-site/js/data/test/localRepresentative.test.mjs
 */
import { deriveLocalRepresentative, marginSafeResult } from '../localRepresentative.js';

let failures = 0;
function check(cond, label, extra) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${label}${extra !== undefined ? ' -- ' + JSON.stringify(extra) : ''}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const NOW = new Date('2026-08-03T12:00:00Z');
const PAST = '2026-08-01T00:00:00Z';

// ConstA fields NRD for Left, ConstB fields LRP for Left -- both must be
// pooled under the "LRP" display label for this derivation (module doc:
// NRD and LRP are the same "Left" force under two local brandings, per
// df_party_participation.csv's GeneralDirect/Local Representative row).
const participationRows = [
  { Seat_Type: 'AlmaVale', Constituency: 'ConstA', Sub_Constituency: 'ConstA', Left_Party: 'NRD', MR_Party: 'GRF', Right_Party: 'GCCA' },
  { Seat_Type: 'AlmaVale', Constituency: 'ConstB', Sub_Constituency: 'ConstB', Left_Party: 'LRP', MR_Party: 'GRF', Right_Party: 'GCCA' },
  { Seat_Type: 'GeneralDirect', Constituency: 'Local Representative', Sub_Constituency: 'Local Representative', Left_Party: 'LRP', MR_Party: 'GRF', Right_Party: 'GCCA' },
];

// P1 and P2 share District name "Alpha" but DIFFERENT District_Ward values
// -- they must be counted as two SEPARATE districts (1,779-unit rule), not
// pooled together just because they share a District name. P3+P4 share
// BOTH District AND District_Ward ("Beta (Ward 1)") -- they SHOULD pool.
const polygonById = new Map([
  ['P1', { Shape_ID: 'P1', District: 'Alpha', District_Ward: 'Ward 1', Constituency: 'ConstA' }],
  ['P2', { Shape_ID: 'P2', District: 'Alpha', District_Ward: 'Ward 2', Constituency: 'ConstB' }],
  ['P3', { Shape_ID: 'P3', District: 'Beta', District_Ward: 'Ward 1', Constituency: 'ConstA' }],
  ['P4', { Shape_ID: 'P4', District: 'Beta', District_Ward: 'Ward 1', Constituency: 'ConstA' }],
]);

function row(shapeId, { LL = 0, LR = 0, LM = 0, RL = 0, RR = 0, RM = 0, ML = 0, MR = 0, MM = 0, declared = true } = {}) {
  return {
    Shape_ID: shapeId,
    Electorate: '1000',
    Turnout: '800',
    Left_Left: String(LL), Left_Right: String(LR), Left_MR: String(LM),
    Right_Left: String(RL), Right_Right: String(RR), Right_MR: String(RM),
    MR_Left: String(ML), MR_Right: String(MR), MR_MR: String(MM),
    Spoil: '0',
    received_at: PAST, verified_at: PAST, declared_at: declared ? PAST : '2099-01-01T00:00:00Z',
  };
}

// "Alpha (Ward 1)": P1 (ConstA, Left=NRD) gets LL=100 (-> pooled as "LRP"),
// RR=250 (Right/GCCA) -> GCCA wins this ward (250 > 100) despite Left
// having a real local candidate there.
// "Alpha (Ward 2)": P2 (ConstB, Left=LRP) gets LL=100 (-> "LRP", only
// contestant) -> LRP wins this ward. Same District NAME as Ward 1's
// district, but a DIFFERENT (District, Ward) unit -- must not be merged.
// "Beta (Ward 1)": P3 gets RR=100 (Right/GCCA), P4 gets MM=150 (MR/GRF)
// -> pooled together (same District AND Ward) -> GRF wins (150 > 100).
const almaValeRows = [
  row('P1', { LL: 100, RR: 250 }),
  row('P2', { LL: 100 }),
  row('P3', { RR: 100 }),
  row('P4', { MM: 150 }),
];

const result = deriveLocalRepresentative({ almaValeRows, polygonById, participationRows, now: NOW });

check(result.precinctsConsidered === 4, 'all 4 Declared precincts considered', result.precinctsConsidered);
check(result.districtsConsidered === 3, '3 (District, Ward) units considered -- Alpha splits into 2, Beta stays 1', result.districtsConsidered);
check(
  result.votesByDistrict['Alpha (Ward 1)'].LRP === 100,
  'Alpha (Ward 1): NRD-sourced Left votes pooled under "LRP" label (100)',
  result.votesByDistrict['Alpha (Ward 1)']
);
check(
  result.votesByDistrict['Alpha (Ward 1)'].NRD === undefined,
  'Alpha (Ward 1): raw "NRD" label never appears -- fully pooled into LRP',
  result.votesByDistrict['Alpha (Ward 1)']
);
check(result.districtWinners['Alpha (Ward 1)'] === 'GCCA', 'Alpha (Ward 1) plurality winner is GCCA (250 > 100)', result.districtWinners);
check(
  result.votesByDistrict['Alpha (Ward 2)'].LRP === 100,
  'Alpha (Ward 2): LRP-sourced Left votes tallied (100)',
  result.votesByDistrict['Alpha (Ward 2)']
);
check(result.districtWinners['Alpha (Ward 2)'] === 'LRP', 'Alpha (Ward 2) plurality winner is LRP (only contestant)', result.districtWinners);
check(
  result.votesByDistrict['Beta (Ward 1)'].GCCA === 100 && result.votesByDistrict['Beta (Ward 1)'].GRF === 150,
  'Beta (Ward 1): P3+P4 pooled into one unit (same District AND Ward)',
  result.votesByDistrict['Beta (Ward 1)']
);
check(result.districtWinners['Beta (Ward 1)'] === 'GRF', 'Beta (Ward 1) plurality winner is GRF (150 > 100)', result.districtWinners);
check(
  result.seatWinner === 'GCCA',
  'overall seat winner: GCCA wins 1 district (Alpha Ward 1), LRP wins 1 (Alpha Ward 2), GRF wins 1 (Beta Ward 1) -- 3-way tie resolved deterministically by first-encountered',
  result
);

// --- Council-level (District name) rollup ---
check(Object.keys(result.councils).sort().join(',') === 'Alpha,Beta', '2 councils present (Alpha, Beta)', Object.keys(result.councils));
check(result.councils.Alpha.totalDistricts === 2, 'Alpha council has 2 total district units (Ward 1, Ward 2)', result.councils.Alpha);
check(result.councils.Alpha.declaredDistricts === 2, 'Alpha council: both units Declared', result.councils.Alpha);
check(result.councils.Alpha.undeclaredDistricts === 0, 'Alpha council: 0 undeclared', result.councils.Alpha);
check(
  result.councils.Alpha.seatsByParty.GCCA === 1 && result.councils.Alpha.seatsByParty.LRP === 1,
  'Alpha council seats: GCCA won Ward 1, LRP won Ward 2 -- 1 each',
  result.councils.Alpha.seatsByParty
);
check(
  result.councils.Alpha.votesByParty.LRP === 200 && result.councils.Alpha.votesByParty.GCCA === 250,
  'Alpha council votes: LRP totals 200 across both wards (100+100), GCCA totals 250 (Ward 1 only)',
  result.councils.Alpha.votesByParty
);
check(result.councils.Beta.totalDistricts === 1, 'Beta council has 1 total district unit (Ward 1)', result.councils.Beta);
check(
  result.councils.Beta.seatsByParty.GRF === 1 && result.councils.Beta.votesByParty.GCCA === 100 && result.councils.Beta.votesByParty.GRF === 150,
  'Beta council: GRF won its 1 seat, votes GCCA=100/GRF=150',
  result.councils.Beta
);

// --- Council totals reflect the FULL precinct universe, not just Declared/considered rows ---
{
  const polygonByIdWithUndeclaredCouncil = new Map([
    ...polygonById,
    ['P5', { Shape_ID: 'P5', District: 'Gamma', District_Ward: 'Ward 1', Constituency: 'ConstA' }],
  ]);
  const r = deriveLocalRepresentative({ almaValeRows, polygonById: polygonByIdWithUndeclaredCouncil, participationRows, now: NOW });
  check(r.councils.Gamma.totalDistricts === 1, 'a council with a precinct but no Alma Vale row still gets a total-districts count', r.councils.Gamma);
  check(r.councils.Gamma.declaredDistricts === 0 && r.councils.Gamma.undeclaredDistricts === 1, 'that council shows 0 declared / 1 undeclared', r.councils.Gamma);
}

// --- A District/Ward unit with SOME but not ALL precincts Declared must
//     NOT contribute votes, a winner, or count as declared -- its apparent
//     plurality could still flip once the rest of its precincts report.
//     This was a real bug: the old implementation counted a unit as
//     "declared" from its first Declared precinct alone. ---
{
  const polygonByIdWithPartialWard = new Map([
    ...polygonById,
    ['P6', { Shape_ID: 'P6', District: 'Delta', District_Ward: 'Ward 1', Constituency: 'ConstA' }],
    ['P7', { Shape_ID: 'P7', District: 'Delta', District_Ward: 'Ward 1', Constituency: 'ConstA' }],
  ]);
  const rowsWithPartialWard = [
    ...almaValeRows,
    row('P6', { LL: 500 }), // Declared
    row('P7', { RR: 10, declared: false }), // NOT Declared -- same (District, Ward) as P6
  ];
  const r = deriveLocalRepresentative({ almaValeRows: rowsWithPartialWard, polygonById: polygonByIdWithPartialWard, participationRows, now: NOW });
  check(r.votesByDistrict['Delta (Ward 1)'] === undefined, 'a partially-Declared unit (1 of 2 precincts) has no vote entry at all', r.votesByDistrict['Delta (Ward 1)']);
  check(r.districtWinners['Delta (Ward 1)'] === undefined, 'a partially-Declared unit has no winner -- not decided yet', r.districtWinners['Delta (Ward 1)']);
  check(r.councils.Delta.totalDistricts === 1, 'Delta council still shows 1 total district unit', r.councils.Delta);
  check(
    r.councils.Delta.declaredDistricts === 0 && r.councils.Delta.undeclaredDistricts === 1,
    'Delta council shows 0 declared / 1 undeclared -- the partial unit does NOT count as declared',
    r.councils.Delta
  );
  check(
    Object.keys(r.councils.Delta.votesByParty).length === 0,
    'Delta council shows no votes at all for its partial unit (not even the 500 LL votes P6 alone reported)',
    r.councils.Delta.votesByParty
  );
}

// --- Defensive: undeclared precincts must not contribute votes ---
{
  const rowsWithFuture = [row('P1', { LL: 999, declared: false })];
  const r = deriveLocalRepresentative({ almaValeRows: rowsWithFuture, polygonById, participationRows, now: NOW });
  check(r.precinctsConsidered === 0, 'undeclared precinct excluded from the derivation entirely', r.precinctsConsidered);
  check(r.seatWinner === null, 'no data considered -> no seat winner, no crash', r.seatWinner);
}

// --- Defensive: unmatched Shape_ID (not in polygonById) never crashes ---
{
  const rowsWithGhost = [row('GHOST_ID', { LL: 999 })];
  const r = deriveLocalRepresentative({ almaValeRows: rowsWithGhost, polygonById, participationRows, now: NOW });
  check(r.precinctsSkippedUnmatched === 1, 'unmatched Shape_ID counted as skipped, not crashed');
  check(r.precinctsConsidered === 0, 'unmatched Shape_ID contributes no votes');
}

// --- Defensive: entirely empty input never crashes ---
{
  const r = deriveLocalRepresentative({ almaValeRows: [], polygonById, participationRows, now: NOW });
  check(r.seatWinner === null && r.districtsConsidered === 0, 'empty input -> null winner, no crash', r);
}

// --- marginSafeResult(): the "no second round" safe-call rule ---
// (added per user direction -- a leader is only the declared `seatWinner`
// once the trailing party couldn't catch up even by sweeping every
// remaining undeclared District.)
{
  // Leader is ahead by 5 (50 vs 45), but 10 Districts remain -- the runner-up
  // could sweep all 10 and finish at 55 > 50, so this must NOT be called yet.
  const notYetSafe = marginSafeResult(new Map([['GRF', 50], ['LRP', 45]]), 10);
  check(notYetSafe.margin === 5, 'marginSafeResult: margin computed as leader - runner-up (5)', notYetSafe);
  check(notYetSafe.currentLeader === 'GRF', 'marginSafeResult: currentLeader reports who is ahead even when not yet safe', notYetSafe);
  check(notYetSafe.isFinal === false, 'marginSafeResult: not final -- 10 remaining >= margin of 5', notYetSafe);
  check(notYetSafe.winner === null, 'marginSafeResult: no seatWinner while not yet mathematically certain', notYetSafe);
}
{
  // Same leader, margin 5, but only 4 Districts remain -- even a full sweep
  // by the runner-up (45+4=49) can't reach the leader's 50. Safe to call.
  const safe = marginSafeResult(new Map([['GRF', 50], ['LRP', 45]]), 4);
  check(safe.isFinal === true, 'marginSafeResult: final -- 4 remaining < margin of 5', safe);
  check(safe.winner === 'GRF', 'marginSafeResult: leader declared seatWinner once safe', safe);
}
{
  // Exactly at the boundary (remaining === margin): the runner-up sweeping
  // every remaining District produces an exact TIE (49+... wait 45+5=50),
  // not a win -- must still not be called (no runoff to break a live tie).
  const boundary = marginSafeResult(new Map([['GRF', 50], ['LRP', 45]]), 5);
  check(boundary.isFinal === false, 'marginSafeResult: remaining === margin is a possible tie, not a safe call', boundary);
}
{
  // Every District has been counted (remaining === 0): the tally itself is
  // final regardless of margin, even a genuine tie -- nothing left to change it.
  const fullyCountedTie = marginSafeResult(new Map([['GRF', 10], ['LRP', 10]]), 0);
  check(fullyCountedTie.isFinal === true, 'marginSafeResult: remaining === 0 is always final, even on a tie', fullyCountedTie);
  check(fullyCountedTie.winner === 'GRF', 'marginSafeResult: a fully-counted tie still resolves via the deterministic first-encountered rule', fullyCountedTie);
}
{
  // No Districts decided at all yet.
  const nothing = marginSafeResult(new Map(), 1779);
  check(nothing.currentLeader === null && nothing.isFinal === false && nothing.winner === null, 'marginSafeResult: no data -> no leader, not final, no crash', nothing);
}

// --- deriveLocalRepresentative(): margin-safe seatWinner end to end ---
{
  // Alpha (Ward 1) and Alpha (Ward 2) both Declared and both go to GCCA;
  // Beta (Ward 1) is NOT Declared (P4 pending) -- 1 District remains
  // undeclared nationwide, GCCA leads 2-0, margin 2 > 1 remaining -> safe.
  const rowsGccaSweep = [
    row('P1', { RR: 250 }), // Alpha (Ward 1) -> GCCA
    row('P2', { RR: 100 }), // Alpha (Ward 2) -> GCCA
    row('P3', { RR: 100 }),
    row('P4', { MM: 150, declared: false }), // Beta (Ward 1) stays undeclared (partial unit)
  ];
  const r = deriveLocalRepresentative({ almaValeRows: rowsGccaSweep, polygonById, participationRows, now: NOW });
  check(r.districtsRemaining === 1, 'end-to-end: 1 District (Beta Ward 1) still undeclared', r.districtsRemaining);
  check(r.currentLeader === 'GCCA' && r.margin === 2, 'end-to-end: GCCA leads 2-0, margin 2', { leader: r.currentLeader, margin: r.margin });
  check(r.isFinal === true && r.seatWinner === 'GCCA', 'end-to-end: 1 remaining < margin of 2 -> safe to call GCCA', r);
}
{
  // Same shape, but Alpha (Ward 2) goes to LRP instead of GCCA -- GCCA leads
  // 1-1... no, leads 1 to LRP's 1 -- not decisive with 1 District left, since
  // that District could go to LRP and create a tie (1 remaining === margin 0
  // is not even ahead). Use a clearer near-tie: GCCA 1, LRP 0, Beta undeclared
  // -- 1 remaining >= margin of 1, so NOT yet safe (LRP could still tie or lose,
  // but the rule is conservative about anything the leader hasn't clinched).
  const rowsNotYetSafe = [
    row('P1', { RR: 250 }), // Alpha (Ward 1) -> GCCA
    row('P2', { LL: 100 }), // Alpha (Ward 2) -> LRP
    row('P3', { RR: 100 }),
    row('P4', { MM: 150, declared: false }), // Beta (Ward 1) undeclared
  ];
  const r = deriveLocalRepresentative({ almaValeRows: rowsNotYetSafe, polygonById, participationRows, now: NOW });
  check(r.districtsRemaining === 1, 'end-to-end (near-tie): 1 District still undeclared', r.districtsRemaining);
  check(r.margin === 0, 'end-to-end (near-tie): GCCA and LRP tied 1-1 so far, margin 0', r.margin);
  check(r.isFinal === false && r.seatWinner === null, 'end-to-end (near-tie): not safe to call with a live tie and a District outstanding', r);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
