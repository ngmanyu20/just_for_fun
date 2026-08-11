/**
 * resultsTable.js — pure HTML-building logic for the election map's
 * tooltip results table, factored out of electionMap.js so this
 * genuinely non-trivial logic (winner-first row ordering, round1/round2/
 * Spoil-NIL math, the C/D confirmed-winner tick columns) is unit-testable
 * under plain Node without needing D3/DOM (see test/resultsTable.test.mjs).
 *
 * No fetch/DOM dependency — only string/number logic plus the two mapCore
 * color-lookup helpers (which just build `var(--...)` CSS strings, not DOM
 * calls).
 */

import { spectrumColorVar, formatPercent } from './mapCore.js';

/**
 * Aggregate-level status label for a tooltip's "Status:" line
 * (Constituency and County/District levels — a single precinct already has
 * one definite status of its own and doesn't use this). Deliberately
 * coarser than the 4-value per-row status: an aggregate of many rows in a
 * mix of states isn't well described by any one of them, so anything
 * strictly between 0% and 100% declared reads as "In progress" rather than
 * borrowing whichever status happens to be most common among its rows.
 * @param {number} percentDeclared
 * @returns {'Not received'|'In progress'|'Declared'}
 */
export function aggregateStatusLabel(percentDeclared) {
  if (percentDeclared >= 100) return 'Declared';
  if (percentDeclared <= 0) return 'Not received';
  return 'In progress';
}

/**
 * Shared results table, reused by all three tooltip levels
 * (constituency/second/precinct): Party | 1st Vote | Pct | 2nd Vote | Pct |
 * C | [D]. One row per spectrum that actually fields a candidate here
 * (FEATURE_SPEC.md Section 3, via df_party_participation.csv), plus a
 * trailing Spoil/NIL row, sorted winner-first then by descending
 * current-round vote count. Returns '' once there are no valid votes to
 * show yet, rather than a misleading all-zero table (Section 2: vote
 * breakdown stays hidden until something's counted).
 *
 * @param {Object} params
 * @param {{Left:number, MR:number, Right:number}} params.round1
 * @param {{[spectrum:string]:number}|null} params.round2 only the 2 surviving spectrums' keys, or null if no round2 was needed
 * @param {string|null} params.eliminated which spectrum was eliminated (set only if round2 happened)
 * @param {number|null} params.nil NIL/exhausted votes from round2 (set only if round2 happened)
 * @param {number} params.spoil 1st-round spoiled ballots
 * @param {Object|null} params.participation this unit's owning constituency's df_party_participation.csv row
 * @param {string|null} params.confirmedWinnerSpectrum spectrum to tick "C" for (the overall Constituency seat's confirmed winner) — null if not yet confirmed
 * @param {string|null} [params.confirmedUnitWinnerSpectrum] spectrum to tick "D" for (THIS unit's own confirmed winner) — omit entirely (undefined) to hide the D column, pass null if applicable-but-not-yet-confirmed
 * @param {boolean} [params.roundTwoCertain=true] Whether it's mathematically
 *   certain this unit's round1/round2 split is settled -- results.js's
 *   `resolveSupplementaryVoteCertainty()`: `certainty.stage === 'round1-majority'`
 *   when `round2` is null, or `certainty.participantsCertain` when it isn't.
 *   Defaults to `true` (unchanged legacy behavior) for callers with nothing
 *   left to be uncertain about (a single already-Declared precinct row has
 *   0 undecided ballots, so it's trivially certain). When `false`, the 2nd
 *   Vote/Pct columns show "Pending" instead of `round2`'s numbers (or the
 *   em-dash a null `round2` would otherwise show) — outstanding undeclared
 *   ballots could still change which two spectrums even make the runoff, so
 *   showing that data as if settled would misrepresent it (the list tables'
 *   Final column shows "Undecided" for the same underlying gate — see
 *   election-alma-vale.js/election-general-direct.js — "Pending" is this
 *   tooltip's own wording for it; see resolveSupplementaryVoteCertainty's
 *   doc comment in supplementaryVote.js for why the gate itself can't be
 *   simplified to "gap(1st,2nd) > undecided").
 * @param {'1st'|'2nd'} [params.view] When given, renders `singleRoundTableHtml`'s
 *   single-round table (one Vote/Pct pair, driven by electionMap.js's
 *   shared 1st/2nd Pref toggle) instead of this function's own legacy
 *   dual-column (1st AND 2nd side by side) table. Omit for the legacy shape.
 * @returns {string} HTML, or '' if there's nothing to show yet
 */
export function resultsTableHtml({
  round1,
  round2,
  eliminated,
  nil,
  spoil,
  participation,
  confirmedWinnerSpectrum,
  confirmedUnitWinnerSpectrum,
  roundTwoCertain = true,
  view,
}) {
  if (view === '1st' || view === '2nd') {
    return singleRoundTableHtml({ round1, round2, eliminated, nil, spoil, participation, confirmedWinnerSpectrum, confirmedUnitWinnerSpectrum, roundTwoCertain, view });
  }

  const totalValid1 = (round1.Left || 0) + (round1.MR || 0) + (round1.Right || 0);
  if (totalValid1 <= 0 && !spoil) return '';

  const showD = confirmedUnitWinnerSpectrum !== undefined;
  const round2Valid = round2 ? Object.values(round2).reduce((a, b) => a + b, 0) : 0;
  const currentWinner =
    confirmedWinnerSpectrum || (round2 ? (round2Valid > 0 ? Object.keys(round2).sort((a, b) => round2[b] - round2[a])[0] : null) : null);

  const participatingSpectrums = ['Left', 'MR', 'Right'].filter(
    (spectrumId) => participation && participation[`${spectrumId}_Participate`] === 'yes'
  );

  // Current-round vote (round2 if it happened, else round1) — the basis
  // for "winner first, then by descending vote" ordering, and also what
  // decides an unconfirmed-but-currently-leading spectrum above.
  const currentVote = (s) => (round2 ? (s === eliminated ? 0 : round2[s] || 0) : round1[s] || 0);
  const leader = currentWinner || [...participatingSpectrums].sort((a, b) => currentVote(b) - currentVote(a))[0] || null;

  const ordered = [...participatingSpectrums].sort((a, b) => {
    if (a === leader && b !== leader) return -1;
    if (b === leader && a !== leader) return 1;
    return currentVote(b) - currentVote(a);
  });

  const rows = ordered
    .map((spectrumId) => {
      const partyAbbrev = (participation && participation[`${spectrumId}_Party`]) || spectrumId;
      const v1 = round1[spectrumId] || 0;
      const pct1 = totalValid1 > 0 ? (v1 / totalValid1) * 100 : 0;
      let v2Cell;
      let pct2Cell;
      if (!roundTwoCertain) {
        v2Cell = 'Pending';
        pct2Cell = 'Pending';
      } else if (!round2) {
        v2Cell = '—';
        pct2Cell = '—';
      } else if (spectrumId === eliminated) {
        v2Cell = '0';
        pct2Cell = formatPercent(0);
      } else {
        const v2 = round2[spectrumId] || 0;
        v2Cell = v2.toLocaleString();
        pct2Cell = formatPercent(round2Valid > 0 ? (v2 / round2Valid) * 100 : 0);
      }
      const cTick = confirmedWinnerSpectrum === spectrumId ? '✓' : '';
      const dCell = showD ? `<td>${confirmedUnitWinnerSpectrum === spectrumId ? '✓' : ''}</td>` : '';
      const pendingClass = !roundTwoCertain ? ' class="map-tooltip__cell--pending"' : '';
      return `<tr><td><span class="map-tooltip__dot" style="background:${spectrumColorVar(spectrumId)}"></span>${partyAbbrev}</td><td>${v1.toLocaleString()}</td><td>${formatPercent(pct1)}</td><td${pendingClass}>${v2Cell}</td><td${pendingClass}>${pct2Cell}</td><td>${cTick}</td>${dCell}</tr>`;
    })
    .join('');
  if (!rows) return '';

  // Spoil/NIL row: 1st-round Spoil, plus (if round2 happened) Spoil + NIL together.
  const spoilTotalValid1 = totalValid1 + spoil;
  const spoilPct1 = spoilTotalValid1 > 0 ? (spoil / spoilTotalValid1) * 100 : 0;
  let spoilV2Cell;
  let spoilPct2Cell;
  if (!roundTwoCertain) {
    spoilV2Cell = 'Pending';
    spoilPct2Cell = 'Pending';
  } else if (!round2) {
    spoilV2Cell = '—';
    spoilPct2Cell = '—';
  } else {
    const combined = spoil + (nil || 0);
    spoilV2Cell = combined.toLocaleString();
    const denom = round2Valid + combined;
    spoilPct2Cell = formatPercent(denom > 0 ? (combined / denom) * 100 : 0);
  }
  const spoilPendingClass = !roundTwoCertain ? ' class="map-tooltip__cell--pending"' : '';
  const spoilRow = `<tr class="map-tooltip__spoil-row"><td>Spoil / NIL</td><td>${spoil.toLocaleString()}</td><td>${formatPercent(spoilPct1)}</td><td${spoilPendingClass}>${spoilV2Cell}</td><td${spoilPendingClass}>${spoilPct2Cell}</td><td></td>${showD ? '<td></td>' : ''}</tr>`;

  const headerCells = `<th>Party</th><th>1st Vote</th><th>Pct</th><th>2nd Vote</th><th>Pct</th><th>C</th>${showD ? '<th>D</th>' : ''}`;
  return `<table class="map-tooltip__table"><thead><tr>${headerCells}</tr></thead><tbody>${rows}${spoilRow}</tbody></table>`;
}

/**
 * Single-round variant of `resultsTableHtml` (Party | {1st|2nd} Vote | Pct |
 * C | [D]) -- one Vote/Pct pair instead of both, driven by the shared 1st/
 * 2nd Pref toggle (election-alma-vale.js's `listPrefView`, mirrored onto
 * the map via `mountElectionMap`'s `setResultView`). '2nd' always means the
 * ACTUAL settled tally, same convention as everywhere else on the site this
 * toggle appears: a copy of `round1` when the unit was decided outright (no
 * runoff needed), the real `round2` once certain, or "Pending" while
 * neither is true yet.
 *
 * Once a real runoff HAS happened (`round2` truthy, settled, not pending),
 * the eliminated spectrum's row is dropped entirely rather than shown at
 * "0" -- it lost in round 1 and never received a single round2 vote, so
 * listing it alongside the two spectrums actually being decided between
 * reads as a live contender in the runoff when it structurally can't be one
 * anymore (user-reported: a settled 2-way runoff table showing a 3rd,
 * already-eliminated party's row right next to the two real contenders).
 * Doesn't apply to the outright-majority case (no elimination ever
 * happened, so every participating spectrum is still shown its real round1
 * number) or the `pending` case (which spectrum ends up eliminated isn't
 * locked in yet, so nothing is safe to drop).
 * @param {Object} params same shape as `resultsTableHtml`, plus `view: '1st'|'2nd'`
 * @returns {string}
 */
function singleRoundTableHtml({ round1, round2, eliminated, nil, spoil, participation, confirmedWinnerSpectrum, confirmedUnitWinnerSpectrum, roundTwoCertain, view }) {
  const totalValid1 = (round1.Left || 0) + (round1.MR || 0) + (round1.Right || 0);
  if (totalValid1 <= 0 && !spoil) return '';

  const showD = confirmedUnitWinnerSpectrum !== undefined;
  const participatingSpectrums = ['Left', 'MR', 'Right'].filter(
    (spectrumId) => participation && participation[`${spectrumId}_Participate`] === 'yes'
  );

  const pending = view === '2nd' && !roundTwoCertain;
  // '2nd', not pending: round2's numbers (0 for the eliminated spectrum) if
  // a runoff actually ran, else a copy of round1 (decided outright, no
  // runoff needed) -- same "actual settled tally" rule election-alma-vale.js's
  // `unitActualRunoff` uses for the summary list's own 2nd Pref column.
  const values =
    view === '1st'
      ? round1
      : pending
      ? null
      : round2
      ? Object.fromEntries(participatingSpectrums.map((id) => [id, id === eliminated ? 0 : round2[id] || 0]))
      : round1;

  // Once the runoff is genuinely SETTLED (not pending -- which spectrum ends
  // up eliminated isn't locked in yet while pending, so nothing is safe to
  // drop), only the two spectrums actually IN it get a row -- the eliminated
  // one is excluded outright, not shown at "0".
  const runoffSettled = view === '2nd' && !pending && !!round2;
  const visibleSpectrums = runoffSettled ? participatingSpectrums.filter((id) => id !== eliminated) : participatingSpectrums;

  const totalForPct = values ? Object.values(values).reduce((a, b) => a + b, 0) : 0;
  const currentVote = (id) => (values ? values[id] || 0 : round1[id] || 0);
  const leader = [...visibleSpectrums].sort((a, b) => currentVote(b) - currentVote(a))[0] || null;
  const ordered = [...visibleSpectrums].sort((a, b) => {
    if (a === leader && b !== leader) return -1;
    if (b === leader && a !== leader) return 1;
    return currentVote(b) - currentVote(a);
  });

  const rows = ordered
    .map((spectrumId) => {
      const partyAbbrev = (participation && participation[`${spectrumId}_Party`]) || spectrumId;
      let voteCell;
      let pctCell;
      if (pending) {
        voteCell = 'Pending';
        pctCell = 'Pending';
      } else {
        const v = values[spectrumId] || 0;
        voteCell = v.toLocaleString();
        pctCell = formatPercent(totalForPct > 0 ? (v / totalForPct) * 100 : 0);
      }
      const cTick = confirmedWinnerSpectrum === spectrumId ? '✓' : '';
      const dCell = showD ? `<td>${confirmedUnitWinnerSpectrum === spectrumId ? '✓' : ''}</td>` : '';
      const pendingClass = pending ? ' class="map-tooltip__cell--pending"' : '';
      return `<tr><td><span class="map-tooltip__dot" style="background:${spectrumColorVar(spectrumId)}"></span>${partyAbbrev}</td><td${pendingClass}>${voteCell}</td><td${pendingClass}>${pctCell}</td><td>${cTick}</td>${dCell}</tr>`;
    })
    .join('');
  if (!rows) return '';

  const hasRunoff = view === '2nd' && !!round2;
  let spoilVoteCell;
  let spoilPctCell;
  if (pending) {
    spoilVoteCell = 'Pending';
    spoilPctCell = 'Pending';
  } else {
    const spoilValue = hasRunoff ? spoil + (nil || 0) : spoil;
    const denom = totalForPct + spoilValue;
    spoilVoteCell = spoilValue.toLocaleString();
    spoilPctCell = formatPercent(denom > 0 ? (spoilValue / denom) * 100 : 0);
  }
  const spoilPendingClass = pending ? ' class="map-tooltip__cell--pending"' : '';
  const spoilLabel = hasRunoff ? 'Spoil / NIL' : 'Spoil';
  const spoilRow = `<tr class="map-tooltip__spoil-row"><td>${spoilLabel}</td><td${spoilPendingClass}>${spoilVoteCell}</td><td${spoilPendingClass}>${spoilPctCell}</td><td></td>${showD ? '<td></td>' : ''}</tr>`;

  const headerCells = `<th>Party</th><th>${view} Vote</th><th>Pct</th><th>C</th>${showD ? '<th>D</th>' : ''}`;
  return `<table class="map-tooltip__table"><thead><tr>${headerCells}</tr></thead><tbody>${rows}${spoilRow}</tbody></table>`;
}

/**
 * "Round Status" label for an "In progress" aggregate tooltip (Constituency
 * and County/District levels only — see `statusLinesHtml`'s `certainty`
 * param) — a finer breakdown of results.js's `certainty`
 * (`resolveSupplementaryVoteCertainty()`) than the single resultCertain
 * boolean the results table/winner tick already use, so someone reading
 * "In progress" can tell WHAT is still in progress:
 *  - "No Runoff Needed": `certainty.stage === 'round1-majority'` — an
 *    outright majority is already mathematically certain.
 *  - "Runoff Uncertain": `!certainty.runoffCertain` — it isn't yet certain
 *    whether a runoff will even be needed (a majority might still land).
 *  - "Runoff Needed": `certainty.runoffCertain && !certainty.participantsCertain`
 *    — no majority is possible for anyone, but which two spectrums make the
 *    runoff isn't locked in yet (the current #2/#3 gap is still within
 *    reach of the undecided pool).
 *  - "Runoff In Progress": `certainty.runoffCertain && certainty.participantsCertain`
 *    — both the runoff itself and its two participants are certain; round2
 *    is the live tally now (its own winner may or may not be certain yet —
 *    that's what the separate Winner Decided/Undecided label is for).
 * @param {Object|null|undefined} certainty
 * @returns {string}
 */
export function roundStatusLabel(certainty) {
  if (!certainty) return '';
  if (certainty.stage === 'round1-majority') return 'No Runoff Needed';
  if (!certainty.runoffCertain) return 'Runoff Uncertain';
  if (!certainty.participantsCertain) return 'Runoff Needed';
  return 'Runoff In Progress';
}

/**
 * "Winner Decided"/"Winner Undecided" label, straight off
 * `certainty.resultCertain` (see `roundStatusLabel` above for the sibling
 * Round Status label).
 * @param {Object|null|undefined} certainty
 * @returns {string}
 */
export function winnerStatusLabel(certainty) {
  if (!certainty) return '';
  return certainty.resultCertain ? 'Winner Decided' : 'Winner Undecided';
}

/**
 * The shared "Turnout: X%" / "Status: Y" / "Z% of votes in" trio under a
 * tooltip's results table. `turnout`/`electorate` should already be
 * Declared-only sums (matching the table above), so all figures in one
 * tooltip come from the same basis; the Turnout line reads "—" if
 * `electorate` is 0 (nothing known yet) rather than a misleading "0%".
 *
 * `certainty` (results.js's `resolveSupplementaryVoteCertainty()` output)
 * is optional — when given AND `statusLabel === 'In progress'`, the Status
 * line grows to "In progress, {Round Status}, {Winner Decided}" via
 * `roundStatusLabel`/`winnerStatusLabel` above, so an in-progress aggregate
 * (Constituency or County/District tooltip) says what's actually still
 * unresolved rather than just "In progress". Precinct tooltips (a single
 * row, never "In progress" — see `aggregateStatusLabel`'s doc comment)
 * simply omit it.
 * @param {string} statusLabel
 * @param {number} percentDeclared
 * @param {number|null} turnout
 * @param {number} electorate
 * @param {Object|null} [certainty]
 */
export function statusLinesHtml(statusLabel, percentDeclared, turnout, electorate, certainty) {
  const turnoutLine = electorate > 0 ? formatPercent((turnout / electorate) * 100) : '—';
  const detail =
    statusLabel === 'In progress' && certainty
      ? `, ${roundStatusLabel(certainty)}, ${winnerStatusLabel(certainty)}`
      : '';
  return `<div class="map-tooltip__status">Turnout: ${turnoutLine}</div><div class="map-tooltip__status">Status: ${statusLabel}${detail}</div><div class="map-tooltip__status">${formatPercent(percentDeclared)} of votes in</div>`;
}
