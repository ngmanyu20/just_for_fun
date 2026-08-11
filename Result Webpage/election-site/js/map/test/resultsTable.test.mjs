/**
 * Tests for resultsTable.js's pure tooltip-table logic (winner-first
 * ordering, round1/round2/Spoil-NIL math, the C/D confirmed-winner tick
 * columns, the aggregate status label). No fetch/DOM involved.
 * Run with: node election-site/js/map/test/resultsTable.test.mjs
 */
import { aggregateStatusLabel, resultsTableHtml, statusLinesHtml, roundStatusLabel, winnerStatusLabel } from '../resultsTable.js';

let failures = 0;
function check(cond, label, extra) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${label}${extra ? ' -- ' + JSON.stringify(extra) : ''}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const PARTICIPATION_ALL = {
  Left_Participate: 'yes', Left_Party: 'NRD',
  MR_Participate: 'yes', MR_Party: 'GRF',
  Right_Participate: 'yes', Right_Party: 'GCCA',
};

// ---------------------------------------------------------------------
// aggregateStatusLabel
// ---------------------------------------------------------------------
check(aggregateStatusLabel(0) === 'Not received', 'aggregateStatusLabel(0) -> Not received');
check(aggregateStatusLabel(100) === 'Declared', 'aggregateStatusLabel(100) -> Declared');
check(aggregateStatusLabel(50) === 'In progress', 'aggregateStatusLabel(50) -> In progress');
check(aggregateStatusLabel(0.01) === 'In progress', 'aggregateStatusLabel(0.01) -> In progress (not Not received)');
check(aggregateStatusLabel(99.99) === 'In progress', 'aggregateStatusLabel(99.99) -> In progress (not Declared)');

// ---------------------------------------------------------------------
// resultsTableHtml -- no round2 (outright majority)
// ---------------------------------------------------------------------
{
  const html = resultsTableHtml({
    round1: { Left: 600, MR: 300, Right: 100 },
    round2: null,
    eliminated: null,
    nil: null,
    spoil: 20,
    participation: PARTICIPATION_ALL,
    confirmedWinnerSpectrum: 'Left',
  });
  check(html.includes('<th>1st Vote</th>'), 'majority case: has 1st Vote column');
  check(html.includes('<th>2nd Vote</th>'), 'majority case: has 2nd Vote column');
  check(!html.includes('<th>D</th>'), 'majority case: no D column when confirmedUnitWinnerSpectrum omitted');
  // All rows' 2nd Vote/Pct should be em-dash since no round2 was needed.
  const dashCount = (html.match(/—/g) || []).length;
  check(dashCount >= 4, '2nd Vote/Pct show em-dash for every row (party rows + spoil row) when no round2', { dashCount });
  check(html.indexOf('NRD') < html.indexOf('GRF') && html.indexOf('NRD') < html.indexOf('GCCA'), 'winner (NRD/Left) row appears first');
  check(/<\/span>NRD<\/td><td>600<\/td><td>60\.0%<\/td>/.test(html), '1st Vote/Pct computed correctly for the winner', { html });
}

// ---------------------------------------------------------------------
// resultsTableHtml -- round2 triggered, come-from-behind winner
// ---------------------------------------------------------------------
{
  // Left eliminated (lowest round1); MR was 2nd in round1 but wins round2
  // after transfers overtake Right -- winner should still sort FIRST even
  // though it wasn't the round1 leader.
  const html = resultsTableHtml({
    round1: { Left: 100, MR: 300, Right: 400 },
    round2: { MR: 450, Right: 350 },
    eliminated: 'Left',
    nil: 30,
    spoil: 15,
    participation: PARTICIPATION_ALL,
    confirmedWinnerSpectrum: 'GRF' === 'GRF' ? 'MR' : null, // MR is the confirmed winner
    confirmedUnitWinnerSpectrum: 'MR',
  });
  check(html.includes('<th>D</th>'), 'round2 case: D column present when confirmedUnitWinnerSpectrum passed');
  // Winner (MR/GRF) must appear before Right (round1 leader) despite trailing round1.
  const grfIdx = html.indexOf('GRF');
  const gccaIdx = html.indexOf('GCCA');
  check(grfIdx !== -1 && gccaIdx !== -1 && grfIdx < gccaIdx, 'come-from-behind winner (GRF/MR) sorts before round1 leader (GCCA/Right)');
  // Eliminated party (Left/NRD) 2nd Vote should be 0, and it should sort last (0 current votes).
  const nrdIdx = html.indexOf('NRD');
  check(nrdIdx > grfIdx && nrdIdx > gccaIdx, 'eliminated party (NRD/Left) sorts last');
  check(/<\/span>NRD<\/td><td>100<\/td><td>[\d.]+%<\/td><td>0<\/td>/.test(html), 'eliminated party shows 0 in 2nd Vote column', { html });
  // Both C and D ticks should land on MR/GRF's row.
  const grfRowMatch = html.match(/<tr><td>[^]*?GRF<\/td>[^]*?<\/tr>/);
  check(!!grfRowMatch && grfRowMatch[0].includes('✓'), 'winner row has at least one tick (C and/or D)', { row: grfRowMatch && grfRowMatch[0] });
  // Spoil/NIL row: combined = spoil(15) + nil(30) = 45, denom = round2Valid(450+350=800) + 45 = 845
  const expectedSpoilPct2 = ((15 + 30) / (800 + 45)) * 100;
  check(html.includes(`>${(15 + 30).toLocaleString()}<`), 'Spoil/NIL row 2nd-round combined value present', { expected: 15 + 30 });
  check(html.includes(`${expectedSpoilPct2.toFixed(1)}%`), 'Spoil/NIL row 2nd-round pct computed correctly', { expectedSpoilPct2 });
}

// ---------------------------------------------------------------------
// resultsTableHtml with view: '2nd' (dispatches to singleRoundTableHtml) --
// a settled runoff must DROP the eliminated spectrum's row entirely, not
// show it at "0" (the legacy dual-column shape above still shows the
// eliminated row at 0, on purpose -- see its own test above -- since it
// displays 1st AND 2nd side by side; the single-round map/list views only
// ever show ONE round at a time, so an eliminated party's row has nothing
// left to justify its presence there once the runoff is real and settled).
// ---------------------------------------------------------------------
{
  // Same come-from-behind scenario as the legacy-shape test above, but
  // requesting the single-round '2nd' view a real map tooltip/list uses.
  const html = resultsTableHtml({
    round1: { Left: 100, MR: 300, Right: 400 },
    round2: { MR: 450, Right: 350 },
    eliminated: 'Left',
    nil: 30,
    spoil: 15,
    participation: PARTICIPATION_ALL,
    confirmedWinnerSpectrum: 'MR',
    view: '2nd',
  });
  check(!html.includes('>NRD<'), 'settled 2nd Round view: eliminated party (NRD/Left) row is dropped entirely, not shown at 0', { html });
  check(html.includes('>GRF<') && html.includes('>GCCA<'), 'settled 2nd Round view: both runoff survivors still shown');
  const grfIdx = html.indexOf('GRF');
  const gccaIdx = html.indexOf('GCCA');
  check(grfIdx !== -1 && gccaIdx !== -1 && grfIdx < gccaIdx, 'settled 2nd Round view: come-from-behind winner (GRF/MR) still sorts first');
}
{
  // Outright round1 majority (no elimination ever happened) -- every
  // participating spectrum keeps its row, none are "eliminated".
  const html = resultsTableHtml({
    round1: { Left: 600, MR: 300, Right: 100 },
    round2: null,
    eliminated: null,
    nil: null,
    spoil: 20,
    participation: PARTICIPATION_ALL,
    confirmedWinnerSpectrum: 'Left',
    view: '2nd',
  });
  check(html.includes('>NRD<') && html.includes('>GRF<') && html.includes('>GCCA<'), 'outright-majority 2nd Round view: no elimination happened, all 3 parties still shown', { html });
}
{
  // Pending (round2 exists off the current tally, but the runoff pairing
  // isn't certain yet) -- nothing is safe to drop, so all 3 stay, each
  // showing "Pending".
  const html = resultsTableHtml({
    round1: { Left: 100, MR: 300, Right: 400 },
    round2: { MR: 450, Right: 350 },
    eliminated: 'Left',
    nil: 30,
    spoil: 15,
    participation: PARTICIPATION_ALL,
    confirmedWinnerSpectrum: null,
    roundTwoCertain: false,
    view: '2nd',
  });
  check(html.includes('>NRD<') && html.includes('>GRF<') && html.includes('>GCCA<'), 'pending 2nd Round view: nothing dropped while the runoff pairing is still uncertain', { html });
}

// ---------------------------------------------------------------------
// resultsTableHtml -- participation filtering (a non-participating spectrum never gets a row)
// ---------------------------------------------------------------------
{
  const html = resultsTableHtml({
    round1: { Left: 500, MR: 0, Right: 400 },
    round2: null,
    eliminated: null,
    nil: null,
    spoil: 10,
    participation: { Left_Participate: 'yes', Left_Party: 'NRD', MR_Participate: 'no', MR_Party: '', Right_Participate: 'yes', Right_Party: 'GCCA' },
    confirmedWinnerSpectrum: 'Left',
  });
  check(!html.includes('>GRF<') && !html.includes('style="background:var(--spectrum-mr)"'), 'non-participating spectrum (MR) excluded entirely from rows', { html });
}

// ---------------------------------------------------------------------
// resultsTableHtml -- nothing to show yet
// ---------------------------------------------------------------------
{
  const html = resultsTableHtml({
    round1: { Left: 0, MR: 0, Right: 0 },
    round2: null,
    eliminated: null,
    nil: null,
    spoil: 0,
    participation: PARTICIPATION_ALL,
    confirmedWinnerSpectrum: null,
  });
  check(html === '', 'zero votes and zero spoil -> empty string (no misleading all-zero table)');
}

// ---------------------------------------------------------------------
// resultsTableHtml -- roundTwoCertain: false (results.js's
// resolveSupplementaryVoteCertainty says the round1/round2 split isn't
// mathematically settled yet) must show "Pending" instead of numbers,
// consistent with the seat-list tables' Final-column rule (which uses the
// wording "Undecided" for the same underlying gate -- "Pending" is this
// tooltip's own wording for it).
// ---------------------------------------------------------------------
{
  // round2 present (an elimination WAS run against the currently-declared
  // totals), but the caller reports the runoff pair isn't certain yet.
  const html = resultsTableHtml({
    round1: { Left: 100, MR: 300, Right: 400 },
    round2: { MR: 450, Right: 350 },
    eliminated: 'Left',
    nil: 30,
    spoil: 15,
    participation: PARTICIPATION_ALL,
    confirmedWinnerSpectrum: null,
    roundTwoCertain: false,
  });
  check(html.includes('<th>1st Vote</th>'), 'uncertain round2: still has 1st Vote column');
  check(!html.includes('<td>450</td>') && !html.includes('<td>350</td>'), 'uncertain round2: round2 numbers not shown', { html });
  const pendingCount = (html.match(/Pending/g) || []).length;
  check(pendingCount >= 8, 'uncertain round2: every party row + spoil row shows "Pending" in both 2nd Vote and Pct', { pendingCount });
  check(html.includes('map-tooltip__cell--pending'), 'uncertain round2: pending cells carry the muted-style class');
  // 1st Vote/Pct are still the raw current count -- uncertainty only gates round2.
  check(/<td>400<\/td><td>[\d.]+%<\/td>/.test(html), '1st Vote/Pct still shown even while round2 is uncertain', { html });
}
{
  // round2 is null (current data shows an outright round-1 majority), but
  // the caller reports that majority isn't certain yet either -- must still
  // read "Pending", not the old dash ("no round2 needed") which would
  // wrongly imply the majority itself is already settled.
  const html = resultsTableHtml({
    round1: { Left: 600, MR: 300, Right: 100 },
    round2: null,
    eliminated: null,
    nil: null,
    spoil: 20,
    participation: PARTICIPATION_ALL,
    confirmedWinnerSpectrum: null,
    roundTwoCertain: false,
  });
  check(!html.includes('—'), 'uncertain nominal-majority: no em-dash left over from the old "no round2" display', { html });
  const pendingCount = (html.match(/Pending/g) || []).length;
  check(pendingCount >= 8, 'uncertain nominal-majority: every row shows "Pending" instead of a dash', { pendingCount });
}
{
  // Omitting roundTwoCertain entirely must default to the old always-shown
  // behavior (legacy/precinct-level callers with 0 undecided ballots).
  const html = resultsTableHtml({
    round1: { Left: 100, MR: 300, Right: 400 },
    round2: { MR: 450, Right: 350 },
    eliminated: 'Left',
    nil: 30,
    spoil: 15,
    participation: PARTICIPATION_ALL,
    confirmedWinnerSpectrum: 'MR',
  });
  check(html.includes('<td>450</td>'), 'roundTwoCertain omitted defaults to true (round2 numbers shown)', { html });
  check(!html.includes('Pending'), 'roundTwoCertain omitted: no "Pending" text appears', { html });
}

// ---------------------------------------------------------------------
// roundStatusLabel / winnerStatusLabel
// ---------------------------------------------------------------------
check(roundStatusLabel({ stage: 'round1-majority', runoffCertain: false, participantsCertain: false }) === 'No Runoff Needed', 'roundStatusLabel: round1-majority -> No Runoff Needed');
check(roundStatusLabel({ stage: 'uncertain', runoffCertain: false, participantsCertain: false }) === 'Runoff Uncertain', 'roundStatusLabel: !runoffCertain -> Runoff Uncertain');
check(roundStatusLabel({ stage: 'uncertain', runoffCertain: true, participantsCertain: false }) === 'Runoff Needed', 'roundStatusLabel: runoffCertain but !participantsCertain -> Runoff Needed');
check(roundStatusLabel({ stage: 'runoff-pending', runoffCertain: true, participantsCertain: true }) === 'Runoff In Progress', 'roundStatusLabel: runoff-pending -> Runoff In Progress');
check(roundStatusLabel({ stage: 'runoff-winner', runoffCertain: true, participantsCertain: true }) === 'Runoff In Progress', 'roundStatusLabel: runoff-winner -> Runoff In Progress');
check(roundStatusLabel(null) === '', 'roundStatusLabel: null certainty -> empty string, no crash');
check(winnerStatusLabel({ resultCertain: true }) === 'Winner Decided', 'winnerStatusLabel: resultCertain -> Winner Decided');
check(winnerStatusLabel({ resultCertain: false }) === 'Winner Undecided', 'winnerStatusLabel: !resultCertain -> Winner Undecided');
check(winnerStatusLabel(undefined) === '', 'winnerStatusLabel: undefined certainty -> empty string, no crash');

// ---------------------------------------------------------------------
// statusLinesHtml
// ---------------------------------------------------------------------
{
  const html = statusLinesHtml('Declared', 100, 800, 1000);
  check(html.includes('Turnout: 80.0%'), 'statusLinesHtml computes turnout percent correctly', { html });
  check(html.includes('Status: Declared'), 'statusLinesHtml includes status label');
  check(html.includes('100.0% of votes in'), 'statusLinesHtml includes percentDeclared line');
}
{
  const html = statusLinesHtml('Not received', 0, null, 0);
  check(html.includes('Turnout: —'), 'statusLinesHtml shows em-dash turnout when electorate is 0 (nothing known yet)', { html });
}
{
  // "In progress" + a certainty object -> Status line grows to
  // "In progress, {Round Status}, {Winner Decided}" (Constituency/
  // County-District tooltips only, per election-site/js/map/electionMap.js).
  const html = statusLinesHtml('In progress', 62, 500, 900, { stage: 'uncertain', runoffCertain: true, participantsCertain: false, resultCertain: false });
  check(html.includes('Status: In progress, Runoff Needed, Winner Undecided'), 'statusLinesHtml appends Round Status + Winner Decided when In progress with a certainty object', { html });
}
{
  // No certainty object passed (e.g. the precinct-level tooltip, or a
  // referendum tooltip which has no SV certainty concept at all) -> plain
  // "In progress" unchanged, exactly like before this feature existed.
  const html = statusLinesHtml('In progress', 62, 500, 900);
  check(html.includes('Status: In progress<'), 'statusLinesHtml leaves "In progress" bare when no certainty object is given', { html });
}
{
  // Certainty given but status ISN'T "In progress" (e.g. Declared) -> no
  // detail appended even though a certainty object is present.
  const html = statusLinesHtml('Declared', 100, 800, 1000, { stage: 'round1-majority', runoffCertain: false, participantsCertain: false, resultCertain: true });
  check(html.includes('Status: Declared<'), 'statusLinesHtml only appends detail when statusLabel is exactly "In progress"', { html });
}

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
} else {
  console.log('\nALL TESTS PASSED');
}
