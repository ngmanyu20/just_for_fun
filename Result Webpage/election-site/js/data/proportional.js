/**
 * proportional.js — General Proportional's two-stage Hare quota + largest
 * remainder method (FEATURE_SPEC.md Section 4), plus a separate provisional
 * method used before all 10 reporting sectors are Declared.
 *
 * Pure functions, no fetch/DOM — importable straight into Node for tests.
 * See test/proportional.test.mjs for an automated check against the spec's
 * worked example (45 seats, Valid Votes = 159,833, quota = 3,551.84,
 * gate = 23,975 -> NRD 10, LRP 9, GRF 19, Right 7).
 *
 * `computeProportionalAllocation()` — the exact/final method (national
 * basis — runs once on the sum across all reporting sectors, not per
 * sector). Only valid once every sector is Declared, i.e. `partyVotes` is
 * the true final national total:
 *  1. Lists: parties in the same spectrum may run pooled ("list") or solo.
 *     A spectrum with one participating party is automatically a list of one.
 *  2. Valid Votes = sum of every party's votes. Total Votes = Valid Votes + Spoil.
 *     Percent = votes / Valid Votes (Spoil's percent uses Total Votes instead).
 *  3. 15% gate: a list needs >= 0.15 * Valid Votes to qualify for any seats.
 *     Below-gate lists get 0 seats and drop out of the quota math entirely.
 *  4. Stage 1 (seats per list): national quota = (sum of qualifying lists'
 *     votes) / totalSeats -- below-gate lists' votes are excluded from the
 *     denominator as well as from the seat round, so all totalSeats seats
 *     always land on qualifying lists. floor(list votes / quota) seats
 *     each, then remaining seats go one at a time to the largest fractional
 *     remainders among qualifying lists.
 *  5. Stage 2 (seats within a list): for a list with 2+ member parties,
 *     re-run Hare quota + largest remainder *within* the list using
 *     list-internal quota = list votes / seats the list won. A single-party
 *     list skips this — its seats go entirely to its one party.
 *
 * `computeGuaranteedMinimumAllocation()` — the provisional method, used
 * while sectors are still outstanding. See its own doc comment below.
 */

import { toNumber } from './status.js';

/**
 * @typedef {{id:string, parties:string[]}} ListConfig
 */

/**
 * Award `seatsToAward` seats using floor(quota) + largest-remainder, given
 * an array of `{id, votes}` candidates and a quota. Shared by Stage 1
 * (lists) and Stage 2 (parties within a list) — the method is identical,
 * only the inputs differ.
 *
 * Tie-break for the largest-remainder step (spec is silent on ties): sort
 * by remainder desc, then by raw votes desc, then by id asc — deterministic
 * and reproducible rather than insertion-order-dependent.
 *
 * @param {Array<{id:string, votes:number}>} candidates
 * @param {number} quota
 * @param {number} seatsToAward
 * @returns {Map<string, number>} id -> seats
 */
function hareLargestRemainder(candidates, quota, seatsToAward) {
  const seats = new Map();
  if (quota <= 0 || candidates.length === 0 || seatsToAward <= 0) {
    for (const c of candidates) seats.set(c.id, 0);
    return seats;
  }

  const entries = candidates.map((c) => {
    const raw = c.votes / quota;
    const floorSeats = Math.floor(raw);
    return { id: c.id, votes: c.votes, raw, floorSeats, remainder: raw - floorSeats };
  });

  let allocated = 0;
  for (const e of entries) {
    seats.set(e.id, e.floorSeats);
    allocated += e.floorSeats;
  }

  let remaining = seatsToAward - allocated;
  // Guard against a pathological over-allocation from rounding — never
  // award a negative number of leftover seats.
  if (remaining < 0) remaining = 0;

  const byRemainder = [...entries].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    if (b.votes !== a.votes) return b.votes - a.votes;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  for (let i = 0; i < remaining && i < byRemainder.length; i++) {
    const id = byRemainder[i].id;
    seats.set(id, (seats.get(id) || 0) + 1);
  }

  return seats;
}

/**
 * Run the full two-stage General Proportional allocation.
 *
 * @param {Object} input
 * @param {Record<string, number>} input.partyVotes party abbreviation -> vote total
 *   (already summed nationally across every Declared reporting sector).
 * @param {number} [input.spoil=0] spoiled/invalid ballots, national total.
 * @param {number} [input.electorate=0] national electorate total (for Turnout display only).
 * @param {ListConfig[]} input.lists list/coalition config, from election_meta.json's
 *   `GeneralProportional.lists[]`.
 * @param {number} input.totalSeats e.g. 45.
 * @param {number} [input.thresholdPct=15] gate, as a percent of Valid Votes.
 * @returns {{
 *   validVotes:number, totalVotes:number, spoil:number, spoilPercent:number,
 *   electorate:number, turnout:number, quota:number, gateVotes:number, thresholdPct:number,
 *   lists: Array<{
 *     id:string, votes:number, percent:number, qualified:boolean, seats:number,
 *     parties: Array<{abbreviation:string, votes:number, percent:number, seats:number}>
 *   }>
 * }}
 */
export function computeProportionalAllocation(input) {
  const partyVotes = input.partyVotes || {};
  const spoil = toNumber(input.spoil);
  const electorate = toNumber(input.electorate);
  const lists = input.lists || [];
  const totalSeats = toNumber(input.totalSeats);
  const thresholdPct = input.thresholdPct != null ? toNumber(input.thresholdPct) : 15;

  const validVotes = Object.values(partyVotes).reduce((sum, v) => sum + toNumber(v), 0);
  const totalVotes = validVotes + spoil;
  const gateVotes = (thresholdPct / 100) * validVotes;

  const listVotes = lists.map((list) => {
    const votes = list.parties.reduce((sum, p) => sum + toNumber(partyVotes[p]), 0);
    return { id: list.id, votes, parties: list.parties };
  });

  const qualifying = listVotes.filter((l) => l.votes >= gateVotes);
  // Quota is based on qualifying lists' votes only, not all Valid Votes --
  // a below-gate list gets zero seats *and* its votes are removed from the
  // quota's denominator, so the floor+largest-remainder round below always
  // has exactly `totalSeats` worth of quotas to hand out among the lists
  // still in the running, and always allocates all `totalSeats` seats no
  // matter how large a gated-out list's vote share is.
  const qualifyingVotes = qualifying.reduce((sum, l) => sum + l.votes, 0);
  const quota = totalSeats > 0 ? qualifyingVotes / totalSeats : 0;

  // Stage 1 — seats per list, largest remainder among qualifying lists only.
  const stage1Seats = hareLargestRemainder(
    qualifying.map((l) => ({ id: l.id, votes: l.votes })),
    quota,
    totalSeats
  );

  const resultLists = listVotes.map((list) => {
    const qualified = qualifying.some((q) => q.id === list.id);
    const seats = qualified ? stage1Seats.get(list.id) || 0 : 0;
    const percent = validVotes > 0 ? (list.votes / validVotes) * 100 : 0;

    let partySeatsMap;
    if (!qualified || list.parties.length <= 1 || seats === 0) {
      // Single-party list (or an unqualified/zero-seat list): no internal
      // largest-remainder round needed — either all seats go to the one
      // party, or there are no seats to distribute.
      partySeatsMap = new Map(list.parties.map((p) => [p, seats]));
    } else {
      const listInternalQuota = list.votes / seats;
      partySeatsMap = hareLargestRemainder(
        list.parties.map((p) => ({ id: p, votes: toNumber(partyVotes[p]) })),
        listInternalQuota,
        seats
      );
    }

    const parties = list.parties.map((abbrev) => {
      const votes = toNumber(partyVotes[abbrev]);
      return {
        abbreviation: abbrev,
        votes,
        percent: validVotes > 0 ? (votes / validVotes) * 100 : 0,
        seats: partySeatsMap.get(abbrev) || 0,
      };
    });

    return { id: list.id, votes: list.votes, percent, qualified, seats, parties };
  });

  return {
    validVotes,
    totalVotes,
    spoil,
    spoilPercent: totalVotes > 0 ? (spoil / totalVotes) * 100 : 0,
    electorate,
    turnout: electorate > 0 ? (totalVotes / electorate) * 100 : 0,
    quota,
    gateVotes,
    thresholdPct,
    lists: resultLists,
  };
}

/**
 * Provisional General Proportional allocation, used while at least one of
 * the 10 reporting sectors is still outstanding (FEATURE_SPEC.md Section 4,
 * "Provisional seats before 100% declared").
 *
 * Running `computeProportionalAllocation()` itself on a partial
 * `partyVotes` total doesn't work: its largest-remainder step always hands
 * out every one of the 45 seats, even off a single reporting sector, and a
 * list's *share* of votes-counted-so-far can rise or fall as more sectors
 * report — even though its raw vote count never does — so seats computed
 * that way could visibly go backwards as the count progresses.
 *
 * Instead this awards each party its **guaranteed minimum**: the seats it
 * would keep no matter how every outstanding sector eventually breaks. Both
 * the qualifying gate and the seat quota are measured against the full
 * national `electorate` — a fixed number, known before a single sector
 * reports and unchanged by which ones have — rather than against votes
 * counted so far:
 *
 *   - Gate: a list needs raw votes >= thresholdPct% * electorate (not
 *     thresholdPct% of votes-so-far) to be credited as qualified.
 *   - Seats: floor(party's votes-so-far * totalSeats / electorate), summed
 *     per list from its member parties. No largest-remainder top-up runs
 *     here, so seats can (and usually will) sum to fewer than `totalSeats`
 *     — the rest is simply undetermined, not assigned to anyone.
 *
 * Why this is a genuine lower bound, not a guess: no voter can cast more
 * than one ballot, so final Valid Votes can never exceed `electorate` —
 * meaning the *true* final quota (Valid Votes / totalSeats) can only be <=
 * electorate / totalSeats, and the *true* final gate (thresholdPct% of
 * Valid Votes) can only be <= thresholdPct% * electorate. Using the
 * larger, electorate-based denominator/threshold here therefore always
 * matches-or-undershoots what the exact method would award, never
 * overshoots it — a party's provisional seats are never later revealed to
 * have been an overstatement once `computeProportionalAllocation()` takes
 * over at 100% declared.
 *
 * That same substitution is also what makes this monotonic over time: a
 * party's counted votes only ever grow as more sectors declare (sectors
 * never un-declare), `electorate` and `totalSeats` never change, and the
 * gate is a fixed threshold rather than a share of a shrinking/growing
 * pool — so both "is this list qualified" and "how many seats does it
 * have" can only hold steady or climb as the count goes on, never drop.
 *
 * `electorate` isn't the only number that's safe to substitute this way,
 * though — it's just the loosest one, always available even before a
 * single ballot is counted. Two tighter (still 100%-safe) bounds become
 * available earlier per Section 2's status pipeline, and callers may pass
 * whichever is currently known via `input.voteBound` instead of leaving
 * this to fall back on `electorate`:
 *   - Once a row reaches Counting, its Turnout (ballots cast) is visible
 *     and fixed — `Valid = Turnout - Spoil <= Turnout`, so Turnout is a
 *     strictly tighter safe substitute than that row's Electorate.
 *   - Once a row reaches Declared, its own Valid Votes contribution is
 *     exactly known — no substitution needed at all for that row.
 * A caller building `voteBound` by summing, per row, whichever of these
 * three is currently known (Electorate / Turnout / actual Valid Votes)
 * keeps every one of the properties above (safe lower bound, monotonic,
 * never overstates) while converging on the true final gate/quota faster
 * than a flat `electorate`-only bound would — see results.js's
 * `computeSafeVoteBound()`. Falls back to `electorate` when `voteBound` is
 * omitted, so existing callers/tests are unaffected.
 *
 * @param {Object} input same shape as `computeProportionalAllocation`'s, plus:
 * @param {number} [input.voteBound] Safe upper bound on final Valid Votes to
 *   gate/quota against, in place of `electorate` (see above) — must never
 *   be less than the true final Valid Votes. Defaults to `electorate` if
 *   omitted.
 * @returns {Object} same shape as `computeProportionalAllocation`'s return value.
 */
export function computeGuaranteedMinimumAllocation(input) {
  const partyVotes = input.partyVotes || {};
  const spoil = toNumber(input.spoil);
  const electorate = toNumber(input.electorate);
  const voteBound = input.voteBound != null ? toNumber(input.voteBound) : electorate;
  const lists = input.lists || [];
  const totalSeats = toNumber(input.totalSeats);
  const thresholdPct = input.thresholdPct != null ? toNumber(input.thresholdPct) : 15;

  const validVotes = Object.values(partyVotes).reduce((sum, v) => sum + toNumber(v), 0);
  const totalVotes = validVotes + spoil;
  const gateVotes = (thresholdPct / 100) * voteBound;
  const quota = totalSeats > 0 && voteBound > 0 ? voteBound / totalSeats : 0;

  const resultLists = lists.map((list) => {
    const votes = list.parties.reduce((sum, p) => sum + toNumber(partyVotes[p]), 0);
    const percent = validVotes > 0 ? (votes / validVotes) * 100 : 0;
    const qualified = voteBound > 0 && votes >= gateVotes;

    const parties = list.parties.map((abbrev) => {
      const pVotes = toNumber(partyVotes[abbrev]);
      return {
        abbreviation: abbrev,
        votes: pVotes,
        percent: validVotes > 0 ? (pVotes / validVotes) * 100 : 0,
        seats: qualified && quota > 0 ? Math.floor(pVotes / quota) : 0,
      };
    });

    const seats = parties.reduce((sum, p) => sum + p.seats, 0);
    return { id: list.id, votes, percent, qualified, seats, parties };
  });

  return {
    validVotes,
    totalVotes,
    spoil,
    spoilPercent: totalVotes > 0 ? (spoil / totalVotes) * 100 : 0,
    electorate,
    turnout: electorate > 0 ? (totalVotes / electorate) * 100 : 0,
    quota,
    gateVotes,
    thresholdPct,
    lists: resultLists,
  };
}
