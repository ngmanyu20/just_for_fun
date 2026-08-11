/**
 * supplementaryVote.js — Supplementary Vote method (FEATURE_SPEC.md Section 4),
 * used by Alma Vale (40), Home Districts (5) and General Direct (10).
 *
 * Pure functions, no fetch/DOM — importable straight into Node for tests.
 *
 * Ballot schema (per precinct/seat row), 9 first-preference x second-preference
 * columns over the 3 spectrums:
 *
 *   Left_Left, Left_Right, Left_MR, Right_Left, Right_Right, Right_MR,
 *   MR_Left, MR_Right, MR_MR
 *
 * Self-referential columns (Left_Left, Right_Right, MR_MR) mean *no second
 * preference* — that ballot becomes NIL (exhausted) if its first-preference
 * spectrum is eliminated.
 *
 * Method: a spectrum wins outright with >50% of first-preference votes.
 * Otherwise eliminate the lowest spectrum and redistribute its votes via the
 * second-preference columns; winner is whoever leads the remaining two
 * spectrums after redistribution.
 */

import { toNumber } from './status.js';

export const SPECTRUMS = Object.freeze(['Left', 'Right', 'MR']);

/** The 9 transfer column names, in the canonical spec order. */
export const TRANSFER_COLUMNS = Object.freeze([
  'Left_Left', 'Left_Right', 'Left_MR',
  'Right_Left', 'Right_Right', 'Right_MR',
  'MR_Left', 'MR_Right', 'MR_MR',
]);

/**
 * Sum the 9 transfer columns (+ Electorate/Turnout/Spoil) across a set of
 * raw rows, restricted to rows whose status is at least `minStatus`
 * (default: Declared — see the module doc in results.js for why vote
 * totals are Declared-only while turnout/electorate figures are not).
 * Blank/missing cells contribute 0 (never NaN, never throws) via
 * `toNumber`, so an entirely-blank row (e.g. before any data lands) is a
 * safe, silent no-op contribution.
 *
 * @param {Array<Object>} rows Raw CSV rows sharing the transfer-column schema.
 * @param {Object} [opts]
 * @param {(row:Object)=>boolean} [opts.include] Predicate; defaults to "always true"
 *   (status filtering, if wanted, is the caller's job — see results.js).
 * @returns {{Electorate:number, Turnout:number, Spoil:number} & Record<string,number>}
 */
export function sumSupplementaryVoteRows(rows, opts = {}) {
  const include = opts.include || (() => true);
  const totals = { Electorate: 0, Turnout: 0, Spoil: 0 };
  for (const col of TRANSFER_COLUMNS) totals[col] = 0;
  for (const row of rows) {
    if (!include(row)) continue;
    totals.Electorate += toNumber(row.Electorate);
    totals.Turnout += toNumber(row.Turnout);
    totals.Spoil += toNumber(row.Spoil);
    for (const col of TRANSFER_COLUMNS) totals[col] += toNumber(row[col]);
  }
  return totals;
}

/**
 * Run the Supplementary Vote count on a single aggregated set of 9 transfer
 * totals (already summed across whatever precincts/sub-rows make up one
 * seat — see `sumSupplementaryVoteRows`).
 *
 * @param {Record<string,number>} totals Object with the 9 TRANSFER_COLUMNS keys
 *   (any missing key is treated as 0).
 * @returns {{
 *   round1: {Left:number, Right:number, MR:number},
 *   totalValid: number,
 *   majorityWinner: string|null,
 *   eliminated: string|null,
 *   transfers: {toRemaining0:number, toRemaining1:number, nil:number}|null,
 *   round2: {[spectrum:string]:number}|null,
 *   nil: number|null,
 *   winner: string|null,
 *   tie: boolean
 * }}
 */
export function computeSupplementaryVote(totals) {
  const t = totals || {};
  const col = (name) => toNumber(t[name]);

  const round1 = {
    Left: col('Left_Left') + col('Left_Right') + col('Left_MR'),
    Right: col('Right_Left') + col('Right_Right') + col('Right_MR'),
    MR: col('MR_Left') + col('MR_Right') + col('MR_MR'),
  };
  const totalValid = round1.Left + round1.Right + round1.MR;

  // Outright majority (> 50% of first-preference valid votes).
  if (totalValid > 0) {
    for (const s of SPECTRUMS) {
      if (round1[s] > totalValid / 2) {
        return {
          round1,
          totalValid,
          majorityWinner: s,
          eliminated: null,
          transfers: null,
          round2: null,
          nil: null,
          winner: s,
          tie: false,
        };
      }
    }
  }

  // No majority (or no votes at all) — eliminate the lowest spectrum and
  // redistribute via its second-preference columns. Deterministic
  // tie-break for "lowest": first in SPECTRUMS order (Left, Right, MR).
  let eliminated = SPECTRUMS[0];
  for (const s of SPECTRUMS) {
    if (round1[s] < round1[eliminated]) eliminated = s;
  }
  const remaining = SPECTRUMS.filter((s) => s !== eliminated);
  const [a, b] = remaining;

  const transferToA = col(`${eliminated}_${a}`);
  const transferToB = col(`${eliminated}_${b}`);
  const nil = col(`${eliminated}_${eliminated}`); // self-referential = exhausted

  const round2 = {
    [a]: round1[a] + transferToA,
    [b]: round1[b] + transferToB,
  };

  let winner = null;
  let tie = false;
  if (round2[a] > round2[b]) winner = a;
  else if (round2[b] > round2[a]) winner = b;
  else tie = true; // spec is silent on ties; surfaced explicitly rather than guessed

  return {
    round1,
    totalValid,
    majorityWinner: null,
    eliminated,
    transfers: { toRemaining0: transferToA, toRemaining1: transferToB, nil },
    round2,
    nil,
    winner,
    tie,
  };
}

/**
 * Hypothetical 2nd-round (runoff) tally for a FORCED elimination choice,
 * rather than `computeSupplementaryVote()`'s own "eliminate whichever
 * spectrum actually has the fewest 1st-preference votes" rule. Same
 * transfer-column math (`{eliminated}_{target}` columns), just letting the
 * caller pick which of the 3 spectrums is eliminated -- there are only 3
 * possible eliminations in a 3-spectrum contest (one of which is always the
 * REAL one `computeSupplementaryVote` would pick), used for the results
 * page's "what if X had been eliminated instead" explorer.
 * @param {Record<string,number>} totals same 9-column shape sumSupplementaryVoteRows returns
 * @param {string} eliminated 'Left'|'Right'|'MR'
 * @returns {{round1:{Left:number,Right:number,MR:number}, eliminated:string, round2:Record<string,number>, nil:number, winner:string|null, tie:boolean}}
 */
export function computeHypotheticalRunoff(totals, eliminated) {
  const t = totals || {};
  const col = (name) => toNumber(t[name]);

  const round1 = {
    Left: col('Left_Left') + col('Left_Right') + col('Left_MR'),
    Right: col('Right_Left') + col('Right_Right') + col('Right_MR'),
    MR: col('MR_Left') + col('MR_Right') + col('MR_MR'),
  };

  const remaining = SPECTRUMS.filter((s) => s !== eliminated);
  const [a, b] = remaining;
  const transferToA = col(`${eliminated}_${a}`);
  const transferToB = col(`${eliminated}_${b}`);
  const nil = col(`${eliminated}_${eliminated}`);
  const round2 = { [a]: round1[a] + transferToA, [b]: round1[b] + transferToB };

  let winner = null;
  let tie = false;
  if (round2[a] > round2[b]) winner = a;
  else if (round2[b] > round2[a]) winner = b;
  else tie = true;

  return { round1, eliminated, round2, nil, winner, tie };
}

/**
 * Convenience: sum rows then run the count in one call.
 * @param {Array<Object>} rows
 * @param {Object} [opts] see `sumSupplementaryVoteRows`
 * @returns {ReturnType<typeof computeSupplementaryVote> & {totals: Record<string,number>}}
 */
export function computeSupplementaryVoteFromRows(rows, opts = {}) {
  const totals = sumSupplementaryVoteRows(rows, opts);
  const result = computeSupplementaryVote(totals);
  return { ...result, totals };
}

/**
 * The plain 1st-preference plurality leader -- most round1 votes, no
 * elimination/transfer math at all. A tie at the top returns null rather
 * than guessing (same policy `computeSupplementaryVote` uses for a genuine
 * round2 tie).
 * @param {{Left:number, MR:number, Right:number}} round1
 * @returns {string|null}
 */
export function round1PluralityLeader(round1) {
  const r = round1 || {};
  const ranked = SPECTRUMS.map((s) => [s, toNumber(r[s])]).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] <= 0) return null;
  if (ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
}

/**
 * The spectrum to present everywhere as "currently leading" this seat/unit
 * -- map fill colors, "Leading: X" list labels, the constituency-level "who
 * wins" figure precincts defer to once certain. `computeSupplementaryVote()`'s
 * own `winner` always forces a SPECIFIC elimination + round2 hypothetical,
 * even off a single early batch where it isn't remotely certain that's the
 * real runoff pairing -- from an early count, round1's actual plurality
 * leader can legitimately differ from whichever spectrum a forced early
 * elimination happens to leave ahead in a hypothetical round2, and showing
 * the latter as "leading" overstates what's actually known. So: show
 * round1's own plain plurality leader for as long as it isn't even certain
 * which two spectrums make the runoff (`certainty.participantsCertain`,
 * unless round1 already produced a certain outright majority, `certainty.
 * stage === 'round1-majority'`); once the runoff's participants ARE
 * certain, the forced elimination is no longer a guess, so `svResult.
 * winner` (the round2 leader between that certain pair) becomes the right
 * "currently leading" figure to show, even though who ultimately wins that
 * runoff may still be open.
 * @param {ReturnType<typeof computeSupplementaryVote>} svResult
 * @param {ReturnType<typeof resolveSupplementaryVoteCertainty>|null} certainty
 * @returns {string|null}
 */
export function leadingSpectrum(svResult, certainty) {
  const runoffPairingSettled = !!(certainty && (certainty.stage === 'round1-majority' || certainty.participantsCertain));
  return runoffPairingSettled ? svResult.winner : round1PluralityLeader(svResult.round1);
}

/**
 * Mathematical-certainty declaration rule for a Supplementary Vote seat
 * still mid-count. `computeSupplementaryVote()` above always returns
 * *some* `winner` (whichever spectrum currently leads the Declared-only
 * totals), even from a single stray precinct -- that's correct as the
 * "currently leading" figure, but it is NOT safe to present as a settled
 * result: outstanding undeclared ballots could still flip it. This
 * function is the gate that decides when a result stops being "leading"
 * and becomes "certain," using worst-case reasoning against `undecided`
 * (the maximum number of ballots that could still land any way at all --
 * see `results.js`'s `computeUndecidedVotes()` for how that pool itself is
 * measured from each precinct's own status).
 *
 * Three certainty questions, each a simple margin-vs-undecided check
 * (worst case: every remaining undecided ballot breaks against the
 * side being tested):
 *
 *  1. Outright round-1 majority: the leader's current lead over BOTH other
 *     spectrums combined exceeds `undecided` -- so even if every
 *     outstanding ballot went to the other two, the leader still finishes
 *     with over half the final total. `leadVotes - (others) > undecided`.
 *
 *  2. No one can reach a majority (a runoff is unavoidable): even the
 *     leader's best case (every outstanding ballot goes to the leader)
 *     tops out at or below half the final total. Equivalent to
 *     `(others) - leadVotes >= undecided`. NOTE this is the rigorous
 *     complement of #1 (not simply "the gap between 1st and 2nd exceeds
 *     undecided" -- that weaker check can be true while the leader could
 *     still mathematically reach a majority, i.e. it would produce false
 *     "runoff guaranteed" calls; see supplementaryVote.test.mjs).
 *
 *  3. Which two spectrums make the runoff: the current #3 spectrum can
 *     only be caught by #2 catching up, so if #2's lead over #3 exceeds
 *     `undecided`, #3 can never pass #2 and is safely eliminated --
 *     #1/#2 are the certain pair. (#1 can never drop below #2 by the same
 *     logic, since #1 already leads #2.)
 *
 * Once the runoff pair is certain, the same margin check runs a second
 * time on round 2's two-way tally to decide whether the runoff's own
 * winner is certain yet.
 *
 * @param {{round1: Record<string,number>, round2: Record<string,number>|null}} svResult
 *   result of `computeSupplementaryVote()` for the SAME totals `undecided` was measured against.
 * @param {number} undecided see `results.js`'s `computeUndecidedVotes()`.
 * @returns {{
 *   undecided: number,
 *   stage: 'round1-majority'|'runoff-winner'|'runoff-pending'|'uncertain',
 *   resultCertain: boolean,
 *   winner: string|null,
 *   runoffCertain: boolean,
 *   participantsCertain: boolean,
 *   participants: [string,string]|null,
 *   eliminated: string|null,
 * }}
 */
export function resolveSupplementaryVoteCertainty(svResult, undecided) {
  const u = Math.max(0, toNumber(undecided));
  const round1 = (svResult && svResult.round1) || {};
  const round2 = svResult && svResult.round2;

  const ranked = SPECTRUMS.map((s) => [s, toNumber(round1[s])]).sort((a, b) => b[1] - a[1]);
  const [[first, firstVotes], [second, secondVotes], [third, thirdVotes]] = ranked;

  if (firstVotes - (secondVotes + thirdVotes) > u) {
    return {
      undecided: u,
      stage: 'round1-majority',
      resultCertain: true,
      winner: first,
      runoffCertain: false,
      participantsCertain: false,
      participants: null,
      eliminated: null,
    };
  }

  const runoffCertain = secondVotes + thirdVotes - firstVotes >= u;
  const participantsCertain = secondVotes - thirdVotes > u;
  const participants = participantsCertain ? [first, second] : null;
  const eliminated = participantsCertain ? third : null;

  if (!runoffCertain || !participantsCertain) {
    return {
      undecided: u,
      stage: 'uncertain',
      resultCertain: false,
      winner: null,
      runoffCertain,
      participantsCertain,
      participants,
      eliminated,
    };
  }

  const leaderVotes = toNumber(round2 && round2[first]);
  const trailerVotes = toNumber(round2 && round2[second]);
  const runoffWinnerCertain = Math.abs(leaderVotes - trailerVotes) > u;
  const runoffWinner = runoffWinnerCertain ? (leaderVotes >= trailerVotes ? first : second) : null;

  return {
    undecided: u,
    stage: runoffWinnerCertain ? 'runoff-winner' : 'runoff-pending',
    resultCertain: runoffWinnerCertain,
    winner: runoffWinner,
    runoffCertain: true,
    participantsCertain: true,
    participants,
    eliminated,
  };
}

/**
 * Resolve a winning spectrum to the specific party abbreviation fielded in
 * that spectrum for a given seat, via `df_party_participation.csv`
 * (FEATURE_SPEC.md Section 3 — SupplementaryVote seats field exactly one
 * party per spectrum, so this is a simple column lookup, not an election).
 * @param {string|null} spectrum 'Left'|'Right'|'MR'|null
 * @param {Object|null} participationRow row from df_party_participation.csv
 *   for this seat (Seat_Type + Constituency [+ Sub_Constituency]).
 * @returns {string|null} party abbreviation, or null if unresolvable.
 */
export function resolveWinningParty(spectrum, participationRow) {
  if (!spectrum || !participationRow) return null;
  const key = `${spectrum}_Party`;
  const abbrev = participationRow[key];
  return abbrev ? String(abbrev).trim() || null : null;
}
