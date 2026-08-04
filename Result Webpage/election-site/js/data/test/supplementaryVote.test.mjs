/**
 * Tests for supplementaryVote.js's counting logic, including a
 * cross-check against real rows from data/results/df_results_13d.csv
 * (Home Districts) so the majority/elimination/NIL logic is exercised
 * against actual (not just hand-built) data.
 *
 * Run with: node election-site/js/data/test/supplementaryVote.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from '../csv.js';
import { computeSupplementaryVote, computeSupplementaryVoteFromRows, sumSupplementaryVoteRows, resolveSupplementaryVoteCertainty } from '../supplementaryVote.js';

let failures = 0;
function check(cond, label, extra) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${label}${extra ? ' -- ' + JSON.stringify(extra) : ''}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.resolve(__dirname, '../../../../data');

// --- 1. Outright majority case (hand-built) ---
{
  const totals = {
    Left_Left: 6000, Left_Right: 0, Left_MR: 0,
    Right_Left: 0, Right_Right: 1000, Right_MR: 0,
    MR_Left: 0, MR_Right: 0, MR_MR: 500,
  };
  // Left = 6000 of 7500 total = 80% > 50% -> outright winner, no round 2.
  const r = computeSupplementaryVote(totals);
  check(r.majorityWinner === 'Left', 'outright majority winner is Left');
  check(r.winner === 'Left', 'outright majority: winner field set');
  check(r.round2 === null, 'outright majority: no round 2 run');
}

// --- 2. No majority -> elimination + transfer + NIL (hand-built) ---
{
  // Left=1000, Right=900, MR=200 (lowest, eliminated).
  // MR's ballots: MR_Left=120 (-> Left), MR_Right=50 (-> Right), MR_MR=30 (NIL, exhausted).
  const totals = {
    Left_Left: 1000, Left_Right: 0, Left_MR: 0,
    Right_Left: 0, Right_Right: 900, Right_MR: 0,
    MR_Left: 120, MR_Right: 50, MR_MR: 30,
  };
  const r = computeSupplementaryVote(totals);
  check(r.eliminated === 'MR', 'lowest spectrum (MR) eliminated', r);
  check(r.round2.Left === 1120, 'round2 Left = 1000 + 120 transferred', r.round2);
  check(r.round2.Right === 950, 'round2 Right = 900 + 50 transferred', r.round2);
  check(r.nil === 30, 'self-referential MR_MR counted as NIL/exhausted', r);
  check(r.winner === 'Left', 'round 2 winner is Left (1120 > 950)', r);
}

// --- 3. Tie in round 2 is surfaced, not guessed ---
{
  const totals = {
    Left_Left: 500, Left_Right: 0, Left_MR: 0,
    Right_Left: 0, Right_Right: 500, Right_MR: 0,
    MR_Left: 0, MR_Right: 0, MR_MR: 0,
  };
  const r = computeSupplementaryVote(totals);
  check(r.tie === true, 'tied round 2 flagged as tie, not silently resolved');
  check(r.winner === null, 'tied round 2 has null winner');
}

// --- 4. All-blank/zero row never throws, resolves to a defined (non-crashing) shape ---
{
  const r = computeSupplementaryVote({});
  check(r.totalValid === 0, 'all-blank totals -> totalValid 0, no NaN');
  check(Number.isFinite(r.round1.Left) && Number.isFinite(r.round1.Right) && Number.isFinite(r.round1.MR), 'round1 values all finite for blank input');
}

// --- 5. Real data: Home Districts (df_results_13d.csv), MR doesn't participate there
//        (Section 3: MR_* columns blank throughout) -> MR must always compute as
//        eliminated with 0 votes and never crash the transfer math. ---
{
  const csvText = readFileSync(path.join(dataRoot, 'results', 'df_results_13d.csv'), 'utf-8');
  const rows = parseCSV(csvText);
  check(rows.length > 0, 'df_results_13d.csv loaded and parsed');

  // Aggregate by Constituency (Home Districts basis rule, Section 4) and run the count.
  const byConstituency = new Map();
  for (const row of rows) {
    const key = row.Constituency;
    if (!byConstituency.has(key)) byConstituency.set(key, []);
    byConstituency.get(key).push(row);
  }
  check(byConstituency.size === 5, '5 Home Districts constituencies grouped from 12 rows', [...byConstituency.keys()]);

  let anyMRParticipates = false;
  for (const [constituency, seatRows] of byConstituency) {
    const { totals, ...result } = computeSupplementaryVoteFromRows(seatRows, { include: () => true });
    if (result.round1.MR !== 0) anyMRParticipates = true;
    check(Number.isFinite(result.totalValid), `Home Districts "${constituency}": totalValid is finite`, result);
    check(result.winner === 'Left' || result.winner === 'Right' || result.winner === null, `Home Districts "${constituency}": winner is Left/Right/tie (MR never wins, doesn't contest)`, result);
  }
  check(!anyMRParticipates, 'MR contributes 0 votes across all Home Districts seats (confirms Section 3 note)');
}

// --- 6. Real data: General Direct's "Local Representative" row is entirely
//        blank by design (Section 4) -- must resolve to a safe zero-result,
//        not crash, when fed through the same aggregation path. ---
{
  const csvText = readFileSync(path.join(dataRoot, 'results', 'df_results_general_direct.csv'), 'utf-8');
  const rows = parseCSV(csvText);
  const blankRow = rows.find((r) => r.Constituency === '' && r.Sub_Constituency === '');
  check(!!blankRow, 'blank Local Representative placeholder row found in df_results_general_direct.csv');
  const totals = sumSupplementaryVoteRows([blankRow]);
  check(totals.Electorate === 0 && totals.Turnout === 0, 'blank row sums to 0 electorate/turnout, not NaN');
  const result = computeSupplementaryVote(totals);
  check(result.totalValid === 0 && result.winner === null, 'blank row -> no winner, no crash (Local Representative is derived separately, not from this row)');
}

// --- 7. resolveSupplementaryVoteCertainty: round-1 majority certain once
//        the leader's margin over BOTH other spectrums beats undecided. ---
{
  const r = computeSupplementaryVote({
    Left_Left: 1000, Right_Right: 700, MR_MR: 250, // Left leads by 1000-950=50
  });
  check(resolveSupplementaryVoteCertainty(r, 49).resultCertain === true, 'round1 majority certain when margin(50) > undecided(49)');
  check(resolveSupplementaryVoteCertainty(r, 49).winner === 'Left', 'round1 majority certain winner is Left');
  check(resolveSupplementaryVoteCertainty(r, 50).resultCertain === false, 'round1 majority NOT certain when margin(50) == undecided(50)');
}

// --- 8. resolveSupplementaryVoteCertainty: runoff guaranteed only once the
//        leader's best case (all undecided) still can't clear a majority --
//        the naive "gap(1st,2nd) > undecided" check is deliberately NOT
//        used here since it can be true while a majority is still reachable. ---
{
  // Left=100 (leader), Right=85 (2nd), MR=16 (3rd), undecided=5.
  // gap(1st,2nd) = 15 > 5, and Left(100) < Right+MR(101) -- the naive rule
  // from the original request would call this "runoff guaranteed", but the
  // leader's best case is 100+5=105 vs total 206, half=103 -- majority IS
  // still reachable, so this must NOT be declared runoff-certain.
  const r = computeSupplementaryVote({ Left_Left: 100, Right_Right: 85, MR_MR: 16 });
  const c = resolveSupplementaryVoteCertainty(r, 5);
  check(c.runoffCertain === false, 'runoff NOT certain when leader could still reach majority with all undecided votes (corrected rule)');
  check(c.resultCertain === false, 'result not certain either in that same ambiguous case');
}
{
  // Left=45 (leader), Right=40 (2nd), MR=15 (3rd), undecided=3.
  // Leader's best case: 45+3=48 vs final total 103, half=51.5 -> can't reach
  // majority even in the best case, so runoff is genuinely guaranteed.
  const r = computeSupplementaryVote({ Left_Left: 45, Right_Right: 40, MR_MR: 15 });
  const c = resolveSupplementaryVoteCertainty(r, 3);
  check(c.runoffCertain === true, 'runoff certain when even the leader\'s best case cannot reach a majority');
  check(c.participantsCertain === true, 'runoff participants certain when gap(2nd,3rd)=25 > undecided=3');
  check(JSON.stringify(c.participants) === JSON.stringify(['Left', 'Right']), 'runoff participants are the top two spectrums', c.participants);
}

// --- 9. resolveSupplementaryVoteCertainty: runoff participants uncertain
//        when #2/#3 are within reach of each other. ---
{
  const r = computeSupplementaryVote({ Left_Left: 45, Right_Right: 30, MR_MR: 25 });
  const c = resolveSupplementaryVoteCertainty(r, 10); // gap(Right,MR)=5, not > 10
  check(c.participantsCertain === false, 'runoff participants uncertain when #2/#3 gap does not exceed undecided');
  check(c.resultCertain === false, 'result not certain while participants are still uncertain');
}

// --- 10. resolveSupplementaryVoteCertainty: runoff winner only certain once
//         round 2's own gap exceeds undecided (rule mirrors the round-1
//         2-candidate case exactly). Round1 (Left=45,Right=40,MR=15) keeps
//         runoffCertain true for undecided<=10 and participantsCertain true
//         for undecided<25 regardless of how MR's 15 ballots split on
//         transfer -- that split is chosen independently below to control
//         round2's own gap without disturbing round1. ---
{
  const r = computeSupplementaryVote({
    Left_Left: 45, Right_Right: 40, MR_Left: 8, MR_Right: 7, MR_MR: 0,
  });
  check(r.eliminated === 'MR', 'MR eliminated (lowest round1)', r);
  check(r.round2.Left === 53 && r.round2.Right === 47, 'round2 tally sanity check (gap=6)', r.round2);
  const certainWinner = resolveSupplementaryVoteCertainty(r, 4); // round1 runoffCertain (u<=10) + participants (u<25); round2 gap=6 > 4
  check(certainWinner.runoffCertain === true && certainWinner.participantsCertain === true, 'runoff + participants still certain at undecided=4', certainWinner);
  check(certainWinner.resultCertain === true && certainWinner.winner === 'Left', 'runoff winner certain once round2 gap(6) exceeds undecided(4)', certainWinner);
  const pendingWinner = resolveSupplementaryVoteCertainty(r, 8); // round1 runoffCertain still holds at u=8<=10; round2 gap=6, not > 8
  check(pendingWinner.runoffCertain === true && pendingWinner.participantsCertain === true, 'runoff + participants still certain at undecided=8', pendingWinner);
  check(pendingWinner.stage === 'runoff-pending', 'runoff winner still pending when round2 gap(6) does not exceed undecided(8)', pendingWinner);
  check(pendingWinner.resultCertain === false, 'pending runoff has no certain result yet', pendingWinner);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
