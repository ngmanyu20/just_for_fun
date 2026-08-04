/**
 * Automated test of computeProportionalAllocation() against the exact
 * worked example in FEATURE_SPEC.md Section 4:
 *
 *   45 seats, Valid Votes = 159,833, quota = 3,551.84, gate = 23,975
 *   NRD 36,894 (23.08%) -> Left list 68,036 -> Stage1 19 -> Stage2 NRD 10
 *   LRP 31,142 (19.48%) -> Left list 68,036 -> Stage1 19 -> Stage2 LRP  9
 *   GRF 67,288 (42.10%) -> MR   list 67,288 -> Stage1 19 -> Stage2 GRF 19
 *   Right 24,509 (15.33%) -> Right list 24,509 -> Stage1  7 -> Stage2 Right 7
 *   Spoil 3,234 (1.98% of Total Votes 163,067)
 *
 * Run with: node election-site/js/data/test/proportional.test.mjs
 * Plain Node, no test framework/build step — consistent with the "vanilla
 * ES modules, no build step" constraint for the whole data layer.
 */

import { computeProportionalAllocation, computeGuaranteedMinimumAllocation } from '../proportional.js';

let failures = 0;
function assertEqual(actual, expected, label) {
  // Allow tiny floating point slack for percentages/quota, exact match for seats.
  const ok =
    typeof expected === 'number' && !Number.isInteger(expected)
      ? Math.abs(actual - expected) < 0.01
      : actual === expected;
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
  } else {
    console.log(`ok   ${label}: ${actual}`);
  }
}

const input = {
  partyVotes: {
    NRD: 36894,
    LRP: 31142,
    GRF: 67288,
    Right: 24509,
  },
  spoil: 3234,
  electorate: 0, // not exercised by this test
  totalSeats: 45,
  thresholdPct: 15,
  lists: [
    { id: 'Left', parties: ['NRD', 'LRP'] },
    { id: 'MR', parties: ['GRF'] },
    { id: 'Right', parties: ['Right'] },
  ],
};

const result = computeProportionalAllocation(input);

console.log('\n--- Section-level figures ---');
assertEqual(result.validVotes, 159833, 'Valid Votes');
assertEqual(result.totalVotes, 163067, 'Total Votes');
assertEqual(Math.round(result.quota * 100) / 100, 3551.84, 'Quota (national)');
assertEqual(Math.round(result.gateVotes), 23975, 'Gate votes (rounded)');
assertEqual(Math.round(result.spoilPercent * 100) / 100, 1.98, 'Spoil % of Total Votes');

console.log('\n--- Party % of Valid Votes ---');
const byAbbrev = {};
for (const list of result.lists) for (const p of list.parties) byAbbrev[p.abbreviation] = p;
assertEqual(Math.round(byAbbrev.NRD.percent * 100) / 100, 23.08, 'NRD % of Valid');
assertEqual(Math.round(byAbbrev.LRP.percent * 100) / 100, 19.48, 'LRP % of Valid');
assertEqual(Math.round(byAbbrev.GRF.percent * 100) / 100, 42.1, 'GRF % of Valid');
assertEqual(Math.round(byAbbrev.Right.percent * 100) / 100, 15.33, 'Right % of Valid');

console.log('\n--- Stage 1: seats per list ---');
const byListId = Object.fromEntries(result.lists.map((l) => [l.id, l]));
assertEqual(byListId.Left.seats, 19, 'Left list seats');
assertEqual(byListId.MR.seats, 19, 'MR list seats');
assertEqual(byListId.Right.seats, 7, 'Right list seats');
assertEqual(
  result.lists.reduce((s, l) => s + l.seats, 0),
  45,
  'Total seats allocated across lists'
);

console.log('\n--- Stage 2: seats per party ---');
assertEqual(byAbbrev.NRD.seats, 10, 'NRD seats');
assertEqual(byAbbrev.LRP.seats, 9, 'LRP seats');
assertEqual(byAbbrev.GRF.seats, 19, 'GRF seats');
assertEqual(byAbbrev.Right.seats, 7, 'Right seats');
assertEqual(
  Object.values(byAbbrev).reduce((s, p) => s + p.seats, 0),
  45,
  'Total seats allocated across parties'
);

console.log('\n--- Edge cases ---');

// A list under the gate must get zero seats and be excluded from quota math
// entirely (its votes must not distort other lists' remainders).
const gated = computeProportionalAllocation({
  partyVotes: { NRD: 36894, LRP: 31142, GRF: 67288, Right: 5000 }, // Right well under 15%
  spoil: 3234,
  totalSeats: 45,
  thresholdPct: 15,
  lists: [
    { id: 'Left', parties: ['NRD', 'LRP'] },
    { id: 'MR', parties: ['GRF'] },
    { id: 'Right', parties: ['Right'] },
  ],
});
const gatedRight = gated.lists.find((l) => l.id === 'Right');
assertEqual(gatedRight.qualified, false, 'Below-gate list marked unqualified');
assertEqual(gatedRight.seats, 0, 'Below-gate list gets 0 seats');
// NOTE: the spec's formula (Section 4, step 4) defines national quota as
// Valid Votes / 45 where Valid Votes includes every party's votes — even
// a list that then fails the gate and is excluded from the quota math.
// When a gated-out list holds a large enough share, the remaining
// qualifying lists' floor+remainder seats can sum to fewer than 45 (the
// gated-out list's votes inflate the quota's denominator without any
// list being left to claim the corresponding seats). The worked example
// in the spec never exercises this — all three of its lists qualify — so
// this is flagged as an open item in the data-layer report rather than
// silently "fixed" by, e.g., recomputing the quota over qualifying votes
// only. This test only asserts the two properties the spec *does* state
// unambiguously: gated lists get zero seats, and allocation never exceeds
// the seat count.
const gatedTotalSeats = gated.lists.reduce((s, l) => s + l.seats, 0);
if (gatedTotalSeats > 45) {
  failures++;
  console.error(`FAIL Gated-list total seats must not exceed 45: got ${gatedTotalSeats}`);
} else {
  console.log(`ok   Gated-list scenario allocates ${gatedTotalSeats}/45 seats (see NOTE above)`);
}

// Defensive: empty/all-blank input must not throw or divide by zero.
const empty = computeProportionalAllocation({
  partyVotes: {},
  spoil: 0,
  electorate: 0,
  totalSeats: 45,
  thresholdPct: 15,
  lists: [
    { id: 'Left', parties: ['NRD', 'LRP'] },
    { id: 'MR', parties: ['GRF'] },
    { id: 'Right', parties: ['Right'] },
  ],
});
assertEqual(empty.validVotes, 0, 'Empty input: Valid Votes is 0, not NaN');
assertEqual(
  empty.lists.reduce((s, l) => s + l.seats, 0),
  0,
  'Empty input: no seats allocated, no crash'
);

console.log('\n--- computeGuaranteedMinimumAllocation (provisional, pre-100%-declared) ---');

// Worked example from the provisional-rule discussion: 20% of the national
// electorate has declared (turnout 100% in those sectors, for round numbers),
// GRF holds 80% of the votes counted so far -> guaranteed seats should be
// floor(0.2 * 0.8 * 45) = floor(7.2) = 7, not floor(0.8 * 45) = 36.
{
  const electorate = 1000;
  const declaredElectorate = 200; // 20%
  const grfVotes = declaredElectorate * 0.8; // 160
  const otherVotes = declaredElectorate * 0.2; // 40, some other list, doesn't qualify
  const provisional = computeGuaranteedMinimumAllocation({
    partyVotes: { GRF: grfVotes, Other: otherVotes },
    spoil: 0,
    electorate,
    totalSeats: 45,
    thresholdPct: 15,
    lists: [
      { id: 'MR', parties: ['GRF'] },
      { id: 'Other', parties: ['Other'] },
    ],
  });
  const grf = provisional.lists.find((l) => l.id === 'MR');
  const other = provisional.lists.find((l) => l.id === 'Other');
  assertEqual(grf.qualified, true, 'Guaranteed-min: GRF clears the gate early (160 >= 15% * 1000)');
  assertEqual(grf.seats, 7, 'Guaranteed-min: GRF gets floor(0.2 * 0.8 * 45) = 7, not floor(0.8 * 45) = 36');
  assertEqual(other.qualified, false, 'Guaranteed-min: Other (40 votes, 4% of electorate) has not cleared the gate yet');
  assertEqual(other.seats, 0, 'Guaranteed-min: unqualified list gets 0 seats');
}

// Monotonicity: as more sectors "declare" (simulated as strictly increasing
// per-party vote totals against a fixed electorate/totalSeats), a party's
// guaranteed-minimum seats must never decrease, even as its *share* of
// votes-counted-so-far swings around.
{
  const electorate = 100000;
  const totalSeats = 45;
  const lists = [
    { id: 'A', parties: ['A'] },
    { id: 'B', parties: ['B'] },
  ];
  // Sequence of cumulative vote totals as more (simulated) sectors report --
  // B's *share* dips sharply at step 3 even though its raw total only grows.
  const steps = [
    { A: 5000, B: 20000 }, // A: 5%, B: 20% of votes-so-far
    { A: 8000, B: 22000 },
    { A: 40000, B: 23000 }, // B's share of counted votes collapses here
    { A: 45000, B: 30000 },
    { A: 46000, B: 35000 }, // fully declared-equivalent (votes == electorate not required here)
  ];
  let prevSeatsA = -1;
  let prevSeatsB = -1;
  let monotonic = true;
  for (const step of steps) {
    const r = computeGuaranteedMinimumAllocation({ partyVotes: step, spoil: 0, electorate, totalSeats, thresholdPct: 15, lists });
    const seatsA = r.lists.find((l) => l.id === 'A').seats;
    const seatsB = r.lists.find((l) => l.id === 'B').seats;
    if (seatsA < prevSeatsA || seatsB < prevSeatsB) monotonic = false;
    prevSeatsA = seatsA;
    prevSeatsB = seatsB;
  }
  if (!monotonic) {
    failures++;
    console.error('FAIL Guaranteed-min seats must be monotonically non-decreasing as more votes are counted');
  } else {
    console.log('ok   Guaranteed-min seats never decrease across an incrementally-reporting sequence');
  }
}

// Never overstates: guaranteed-minimum seats computed on a *partial* count
// must never exceed what the exact Stage 1/2 method awards once that same
// partial total is treated as final (the exact method here stands in for
// "whatever the real final result eventually is", which can only add more
// votes on top of the partial one, never remove any already-counted ones).
{
  const electorate = 200000;
  const totalSeats = 45;
  const thresholdPct = 15;
  const lists = [
    { id: 'Left', parties: ['NRD', 'LRP'] },
    { id: 'MR', parties: ['GRF'] },
    { id: 'Right', parties: ['Right'] },
  ];
  const partialVotes = { NRD: 12000, LRP: 9000, GRF: 30000, Right: 8000 };
  const provisional = computeGuaranteedMinimumAllocation({ partyVotes: partialVotes, spoil: 0, electorate, totalSeats, thresholdPct, lists });
  const asIfFinal = computeProportionalAllocation({ partyVotes: partialVotes, spoil: 0, electorate, totalSeats, thresholdPct, lists });
  let neverOverstates = true;
  for (const list of provisional.lists) {
    const finalList = asIfFinal.lists.find((l) => l.id === list.id);
    if (list.seats > finalList.seats) neverOverstates = false;
  }
  if (!neverOverstates) {
    failures++;
    console.error('FAIL Guaranteed-min seats must never exceed the exact method\'s seats on the same vote total');
  } else {
    console.log('ok   Guaranteed-min seats never exceed the exact method\'s result on the same vote total');
  }
}

// Defensive: zero electorate (no data at all yet) must not throw or divide by zero.
{
  const empty = computeGuaranteedMinimumAllocation({
    partyVotes: {},
    spoil: 0,
    electorate: 0,
    totalSeats: 45,
    thresholdPct: 15,
    lists: [{ id: 'Left', parties: ['NRD', 'LRP'] }],
  });
  assertEqual(empty.validVotes, 0, 'Guaranteed-min empty input: Valid Votes is 0, not NaN');
  assertEqual(
    empty.lists.reduce((s, l) => s + l.seats, 0),
    0,
    'Guaranteed-min empty input: no seats allocated, no crash'
  );
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
