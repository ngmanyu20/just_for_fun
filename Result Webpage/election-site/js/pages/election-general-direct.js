/**
 * election-general-direct.js — General Direct seat-type page (10 seats,
 * Constituency basis, Supplementary Vote, table only -- never wired into
 * any map, FEATURE_SPEC.md Section 4: "a functional constituency, not a
 * geographic one"). Unlike the other seat-type list pages, this table shows
 * the actual 1st-preference/Final vote counts per spectrum (plus Spoil)
 * rather than just status/leading-party. Includes the derived
 * `Local Representative` seat, which routes to its own sub-page
 * (election-local-representative.html) instead of the normal
 * precinct/sub-row detail view.
 */

import * as Data from '../data.js';
import { formatNumber, formatPercent, formatTurnout, isResultCertain, dominantStatus, statusBadge, partyPill, seatDetailHref, renderError, el } from './election-common.js';
import { renderNav, renderBreadcrumbs } from '../nav.js';

const content = document.getElementById('content');

async function main() {
  renderNav(document.getElementById('nav'), 'election-general-direct.html');
  renderBreadcrumbs(document.getElementById('breadcrumbs'), [
    { label: 'General Election', href: 'index.html' },
    { label: 'General Direct' },
  ]);

  const [seats, electionMeta] = await Promise.all([Data.getGeneralDirectSeats(), Data.loadElectionMeta()]);
  document.title = 'General Direct — Results';

  const spectrumColumns = (electionMeta.spectrums || []).map((s) => ({ id: s.id, label: s.id }));

  const frag = document.createDocumentFragment();
  frag.appendChild(
    el('div', { className: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'General Direct' }),
        el('div', { className: 'page-header__meta', text: '10 seats' }),
      ]),
    ])
  );
  frag.appendChild(voteTable(seats, electionMeta, spectrumColumns));

  content.replaceChildren(frag);
}

function voteTable(seats, electionMeta, spectrumColumns) {
  const wrap = el('div', { className: 'scroll-table-wrap scroll-table-wrap--full-height' });
  const table = document.createElement('table');
  table.className = 'data-table seat-table gd-vote-table';
  table.appendChild(voteTableHead(spectrumColumns, 'Constituency'));
  const tbody = document.createElement('tbody');
  renderSeatRows(tbody, seats, electionMeta, spectrumColumns);
  renderTotalRow(tbody, seats, spectrumColumns);
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function voteTableHead(spectrumColumns, firstColumnLabel) {
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  const headers = [
    firstColumnLabel,
    'Electorate',
    'Vote',
    'Turnout',
    ...spectrumColumns.map((s) => `${s.label} Final`),
    ...spectrumColumns.map((s) => `${s.label} 1st`),
    'Spoil',
    'Status',
  ];
  for (const text of headers) tr.appendChild(el('th', { text }));
  thead.appendChild(tr);
  return thead;
}

function renderSeatRows(tbody, seats, electionMeta, spectrumColumns) {
  let rowIndex = 0;
  for (const seat of seats) {
    rowIndex++;
    const rowId = `seat-row-${rowIndex}`;
    const expandable = !seat.isDerived && seat.subRowCount > 1;

    const tr = document.createElement('tr');
    tr.className = 'seat-row';
    tr.appendChild(nameCell(seat, rowId, expandable));
    appendTurnoutCells(tr, seat);
    appendVoteCells(tr, seat, spectrumColumns);
    tr.appendChild(statusOrResultCell(seat, electionMeta));
    tbody.appendChild(tr);

    if (expandable) tbody.appendChild(subRowDetailRow(rowId, seat, electionMeta, spectrumColumns));
  }
}

function nameCell(seat, rowId, expandable) {
  const nameTd = document.createElement('td');
  const nameWrap = el('span', { className: 'seat-row__name' });
  if (expandable) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'expand-toggle';
    btn.textContent = '▸';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', rowId);
    btn.addEventListener('click', () => {
      const detailRow = document.getElementById(rowId);
      const isHidden = detailRow.classList.toggle('hidden');
      btn.textContent = isHidden ? '▸' : '▾';
      btn.setAttribute('aria-expanded', String(!isHidden));
    });
    nameWrap.appendChild(btn);
  } else {
    nameWrap.appendChild(el('span', { attrs: { style: 'display:inline-block;width:1.4rem' } }));
  }
  if (seat.isDerived) {
    // Local Representative is the one General Direct row that routes to a
    // real sub-page (its own district-breakdown view) -- the other rows
    // are plain functional-constituency sectors with nothing extra to
    // drill into beyond what this table already shows, so they're just
    // text, not a link.
    const a = document.createElement('a');
    a.href = seatDetailHref('GeneralDirect', seat.constituency);
    a.textContent = seat.constituency;
    nameWrap.appendChild(a);
    nameWrap.appendChild(el('span', { className: 'page-header__meta', text: '(derived)' }));
  } else {
    nameWrap.appendChild(el('span', { text: seat.constituency, attrs: { style: 'font-weight:600' } }));
  }
  nameTd.appendChild(nameWrap);
  return nameTd;
}

/**
 * Single merged Status/Result column: while the seat's result isn't yet
 * mathematically certain (results.js's `certainty.resultCertain`, from
 * `resolveSupplementaryVoteCertainty()` -- true once outstanding
 * undeclared ballots can no longer change the outcome, which can happen
 * before every row is literally Declared), show its status badge (same as
 * the other seat-type pages); once certain, show the actual winning party
 * instead of a now-redundant status badge. The derived Local Representative
 * seat has no statusSummary of its own, so it uses its own gate instead:
 * `seat.isFinal` (localRepresentative.js's margin-safe rule -- no second
 * round for this seat, so its winner is only shown as decided once the
 * remaining undeclared Districts can no longer catch up). Before that, a
 * current leader (if any) is shown the same "Leading: X" way a not-yet-
 * final ordinary seat would be, via `seat.derivation.currentLeader`.
 * @param {Object} seat
 * @param {Object} electionMeta
 */
function statusOrResultCell(seat, electionMeta) {
  const td = document.createElement('td');
  if (seat.isDerived) {
    if (seat.isFinal && seat.winnerParty) {
      td.appendChild(partyPill(electionMeta, seat.winnerParty));
    } else if (seat.derivation && seat.derivation.currentLeader) {
      td.appendChild(el('span', { className: 'page-header__meta', text: `Leading: ${seat.derivation.currentLeader}` }));
    } else {
      td.appendChild(el('span', { className: 'party-pill party-pill--muted', text: '—' }));
    }
    return td;
  }
  if (isResultCertain(seat)) {
    td.appendChild(partyPill(electionMeta, seat.winnerParty));
  } else {
    td.appendChild(statusBadge(dominantStatus(seat)));
  }
  return td;
}

/**
 * Electorate / Vote (ballots cast) / Turnout % cells for one row. Turnout %
 * divides Vote by Electorate. The derived Local Representative seat is
 * treated as its own mini-election here too: results.js's
 * getLocalRepresentativeSeat sets its Electorate/Vote to the nationwide
 * total District count (1,779) and Turnout% to a clean 100% by design
 * (every District's plurality counts once Declared -- see the seat's own
 * sub-page for the real declared/undeclared split) -- no special-casing
 * needed here, the normal formula just works once those fields are
 * populated. A real (non-derived) seat's Vote can still be genuinely
 * unknown (not yet reached Counting -- results.js's
 * turnoutIfKnown/sumKnownTurnout), which stays "—" rather than a
 * fabricated 0.
 * @param {HTMLTableRowElement} tr
 * @param {Object} seat
 */
function appendTurnoutCells(tr, seat) {
  tr.appendChild(el('td', { text: formatNumber(seat.electorate) }));
  tr.appendChild(el('td', { text: formatTurnout(seat.turnout) }));
  const turnoutPct = seat.turnout != null && seat.electorate ? (seat.turnout / seat.electorate) * 100 : null;
  tr.appendChild(el('td', { text: turnoutPct != null ? formatPercent(turnoutPct) : '—' }));
}

/**
 * Final/1st-preference vote cells + Spoil for one row, Final columns
 * leading (Left/MR/Right Final, then Left/MR/Right 1st). 1st always shows
 * seat.round1[spectrum] unconditionally (a raw current count, not a
 * declaration). Final is different per seat kind:
 *  - The derived Local Representative seat (FPTP plurality-of-Districts,
 *    not Supplementary Vote -- see localRepresentative.js) never has a 2nd
 *    round, so its Final is always the round1 copy; its winner cell is
 *    already gated by its own margin-safe rule (`winnerSpectrum` is only
 *    set once `isFinal`, see results.js's getLocalRepresentativeSeat).
 *  - Every other (real Supplementary Vote) seat only shows Final numbers
 *    once results.js's `certainty.participantsCertain` is true -- otherwise
 *    which two spectrums even make a runoff could still change, so a
 *    round2-in-progress number (or a premature round1 copy) would be
 *    presenting a possibly-wrong pair as if it were settled. Until then,
 *    Final shows "Undecided". The winning spectrum's Final cell is bolded
 *    only once `certainty.resultCertain` is true.
 * @param {HTMLTableRowElement} tr
 * @param {Object} seat
 * @param {Array<{id:string, label:string}>} spectrumColumns
 */
function appendVoteCells(tr, seat, spectrumColumns) {
  const certainty = seat.certainty;
  const finalSource = seatFinalSource(seat);
  const certainWinner = seat.isDerived ? seat.winnerSpectrum : certainty && certainty.resultCertain ? certainty.winner : null;

  for (const s of spectrumColumns) {
    const isWinnerCell = certainWinner && s.id === certainWinner;
    if (finalSource) {
      tr.appendChild(el('td', { className: isWinnerCell ? 'vote-cell--winner' : undefined, text: formatNumber(finalSource[s.id]) }));
    } else {
      tr.appendChild(el('td', { className: 'vote-cell--undecided', text: 'Undecided' }));
    }
  }
  for (const s of spectrumColumns) {
    tr.appendChild(el('td', { text: formatNumber(seat.round1 ? seat.round1[s.id] : undefined) }));
  }
  tr.appendChild(el('td', { text: formatNumber(seat.totals ? seat.totals.Spoil : undefined) }));
}

/**
 * Shared by appendVoteCells() and the Total row: the same "which numbers
 * count as Final" gate documented on appendVoteCells above, factored out so
 * the Total row sums exactly what each seat's own row displays rather than
 * re-deriving it.
 * @param {Object} seat
 */
function seatFinalSource(seat) {
  const certainty = seat.certainty;
  return seat.isDerived
    ? seat.round1
    : certainty && certainty.stage === 'round1-majority'
    ? seat.round1
    : certainty && certainty.participantsCertain
    ? seat.round2 || {}
    : null;
}

/**
 * Total row across all top-level seats (not sub-rows, and not counting the
 * derived Local Representative seat twice -- it's already one row in
 * `seats`). Sums the same figures each row already shows; a seat whose
 * Final is still "Undecided" (seatFinalSource() returns null) simply
 * contributes nothing to the Final columns, same as it shows no number of
 * its own yet. Status is dropped rather than combined -- there's no single
 * status across 10 separate constituencies.
 * @param {HTMLTableSectionElement} tbody
 * @param {Array<Object>} seats
 * @param {Array<{id:string, label:string}>} spectrumColumns
 */
function renderTotalRow(tbody, seats, spectrumColumns) {
  let electorate = 0;
  let vote = 0;
  let spoil = 0;
  const finalTotals = {};
  const round1Totals = {};
  for (const s of spectrumColumns) {
    finalTotals[s.id] = 0;
    round1Totals[s.id] = 0;
  }

  for (const seat of seats) {
    electorate += seat.electorate || 0;
    vote += seat.turnout || 0;
    spoil += seat.totals ? seat.totals.Spoil || 0 : 0;
    const finalSource = seatFinalSource(seat);
    for (const s of spectrumColumns) {
      if (finalSource) finalTotals[s.id] += finalSource[s.id] || 0;
      round1Totals[s.id] += (seat.round1 && seat.round1[s.id]) || 0;
    }
  }

  const tr = document.createElement('tr');
  tr.className = 'seat-row seat-table__total-row';
  tr.appendChild(
    el('td', {}, [
      el('span', { className: 'seat-row__name' }, [
        el('span', { attrs: { style: 'display:inline-block;width:1.4rem' } }),
        document.createTextNode('Total'),
      ]),
    ])
  );
  tr.appendChild(el('td', { text: formatNumber(electorate) }));
  tr.appendChild(el('td', { text: formatTurnout(vote) }));
  tr.appendChild(el('td', { text: electorate > 0 ? formatPercent((vote / electorate) * 100) : '—' }));
  for (const s of spectrumColumns) tr.appendChild(el('td', { text: formatNumber(finalTotals[s.id]) }));
  for (const s of spectrumColumns) tr.appendChild(el('td', { text: formatNumber(round1Totals[s.id]) }));
  tr.appendChild(el('td', { text: formatNumber(spoil) }));
  tr.appendChild(el('td', { text: '' }));
  tbody.appendChild(tr);
}

function subRowDetailRow(rowId, seat, electionMeta, spectrumColumns) {
  const detailTr = document.createElement('tr');
  detailTr.id = rowId;
  detailTr.className = 'subrow-detail hidden';
  const td = document.createElement('td');
  td.colSpan = 6 + spectrumColumns.length * 2;
  const inner = el('div', { className: 'subrow-detail__inner' });
  if (Array.isArray(seat.subRows) && seat.subRows.length) {
    inner.appendChild(subRowTable(seat.subRows, electionMeta, spectrumColumns));
  }
  td.appendChild(inner);
  detailTr.appendChild(td);
  return detailTr;
}

function subRowTable(subRows, electionMeta, spectrumColumns) {
  const table = document.createElement('table');
  table.className = 'data-table subrow-table gd-vote-table';
  table.appendChild(voteTableHead(spectrumColumns, 'Sub_Constituency'));
  const tbody = document.createElement('tbody');
  for (const sub of subRows) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', { text: sub.subConstituency || '(unnamed)' }));
    appendTurnoutCells(tr, sub);
    appendVoteCells(tr, sub, spectrumColumns);
    tr.appendChild(statusOrResultCell(sub, electionMeta));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

main().catch((err) => renderError(content, err));
