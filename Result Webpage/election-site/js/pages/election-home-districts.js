/**
 * election-home-districts.js — Home Districts seat-type page (5 seats,
 * Constituency basis, Supplementary Vote, sub-rows collapsible).
 *
 * Judgment call: FEATURE_SPEC.md Section 1's presentation-order rule
 * ("group by Region, sort by Constituency_Code") is written for real
 * constituencies (df_constituency.csv). Home Districts' `Constituency`
 * values (Tong, Diamond & Rainbow SE, Dragon & Outland, Shek East and
 * Central, Shek West) have zero overlap with that 40-row set -- confirmed
 * by diffing the two -- so there's no Region/Constituency_Code to group or
 * sort by here. This page keeps the roster order `getHomeDistrictsSeats()`
 * already returns (which itself follows df_party_participation.csv's row
 * order), rather than forcing `orderConstituencies()`/
 * `groupConstituenciesByRegion()` onto data those functions weren't built
 * for.
 *
 * This page's table is a dedicated layout (Electorate/Turnout/Turnout %/
 * Left Vote/Right Vote/Spoil Vote/L Pct/R Pct/Results, plus a Total row)
 * rather than the shared `renderConstituencySeatRows()` used by General
 * Direct -- Home Districts
 * never fields an MR candidate (df_party_participation.csv: MR_Participate
 * is "no" for every Home Districts row), so a plain two-party vote count is
 * meaningful here in a way it isn't for the other Supplementary Vote seat
 * types. Constituency names are plain text, not links -- this page doesn't
 * route to the per-seat detail sub-page.
 */

import * as Data from '../data.js';
import { formatNumber, formatPercent, formatTurnout, statusBadge, dominantStatus, isResultCertain, partyPill, renderError, el } from './election-common.js';
import { renderNav, renderBreadcrumbs } from '../nav.js';

const content = document.getElementById('content');

const COLUMNS = ['Electorate', 'Turnout', 'Turnout', 'Left Vote', 'Right Vote', 'Spoil Vote', 'L Pct', 'R Pct', 'Results'];

async function main() {
  renderNav(document.getElementById('nav'), 'election-home-districts.html');
  renderBreadcrumbs(document.getElementById('breadcrumbs'), [
    { label: 'General Election', href: 'index.html' },
    { label: 'Home Districts' },
  ]);

  const [seats, electionMeta] = await Promise.all([Data.getHomeDistrictsSeats(), Data.loadElectionMeta()]);
  document.title = 'Home Districts — Results';

  const frag = document.createDocumentFragment();
  frag.appendChild(
    el('div', { className: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Home Districts' }),
        el('div', { className: 'page-header__meta', text: `${seats.length} seats` }),
      ]),
    ])
  );

  const table = document.createElement('table');
  table.className = 'data-table seat-table hd-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Constituency</th>${COLUMNS.map((c) => `<th>${c}</th>`).join('')}</tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  renderSeatRows(tbody, seats, electionMeta);
  renderTotalRow(tbody, seats, electionMeta);
  table.appendChild(tbody);
  frag.appendChild(table);

  content.replaceChildren(frag);
}

function renderSeatRows(tbody, seats, electionMeta) {
  let rowIndex = 0;
  for (const seat of seats) {
    rowIndex++;
    const rowId = `seat-row-${rowIndex}`;
    const expandable = seat.subRowCount > 1 && Array.isArray(seat.subRows) && seat.subRows.length > 0;

    const tr = document.createElement('tr');
    tr.className = 'seat-row';

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
    nameWrap.appendChild(document.createTextNode(seat.constituency));
    nameTd.appendChild(nameWrap);
    tr.appendChild(nameTd);

    appendDataCells(tr, seat, electionMeta);
    tbody.appendChild(tr);

    if (expandable) {
      const detailTr = document.createElement('tr');
      detailTr.id = rowId;
      detailTr.className = 'subrow-detail hidden';
      const td = document.createElement('td');
      td.colSpan = COLUMNS.length + 1;
      const inner = el('div', { className: 'subrow-detail__inner' });
      inner.appendChild(subRowTable(seat.subRows, electionMeta));
      td.appendChild(inner);
      detailTr.appendChild(td);
      tbody.appendChild(detailTr);
    }
  }
}

function subRowTable(subRows, electionMeta) {
  const table = document.createElement('table');
  table.className = 'data-table subrow-table hd-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Sub_Constituency</th>${COLUMNS.map((c) => `<th>${c}</th>`).join('')}</tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const sub of subRows) {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = sub.subConstituency || '(unnamed)';
    tr.appendChild(nameTd);
    appendDataCells(tr, sub, electionMeta);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/**
 * The data columns shared by a seat row, its Sub_Constituency child rows,
 * and the Total row (all three shapes carry electorate/turnout/round1/
 * round2/eliminated/totals/statusSummary/winnerParty — see results.js's
 * buildSupplementaryVoteSeatSummary/buildSubRowSummaries, and
 * `totalsUnit()` below for the Total row's synthesized version).
 */
function appendDataCells(tr, unit, electionMeta) {
  const leftVote = currentVote(unit, 'Left');
  const rightVote = currentVote(unit, 'Right');
  const validVote = leftVote + rightVote;
  tr.appendChild(td(formatNumber(unit.electorate)));
  tr.appendChild(td(formatTurnout(unit.turnout)));
  tr.appendChild(td(formatPercent(unit.turnout != null && unit.electorate > 0 ? (unit.turnout / unit.electorate) * 100 : null)));
  tr.appendChild(td(formatNumber(leftVote)));
  tr.appendChild(td(formatNumber(rightVote)));
  tr.appendChild(td(formatNumber(unit.totals ? unit.totals.Spoil : 0)));
  tr.appendChild(td(formatPercent(validVote > 0 ? (leftVote / validVote) * 100 : null)));
  tr.appendChild(td(formatPercent(validVote > 0 ? (rightVote / validVote) * 100 : null)));
  tr.appendChild(statusResultCell(unit, electionMeta));
}

/**
 * Current-round vote count for a spectrum — round2 (if the seat went to a
 * second round) with the eliminated spectrum forced to 0, else round1.
 * Mirrors js/map/resultsTable.js's `currentVote`, kept local here since
 * this table has no other dependency on that (tooltip-specific) module.
 */
function currentVote(unit, spectrum) {
  if (unit.round2) return spectrum === unit.eliminated ? 0 : unit.round2[spectrum] || 0;
  return (unit.round1 && unit.round1[spectrum]) || 0;
}

/**
 * Combined Status/Result column: shows the status badge while a seat's
 * result isn't yet mathematically certain (results.js's
 * `certainty.resultCertain`, from `resolveSupplementaryVoteCertainty()` --
 * true once outstanding undeclared ballots can no longer change the
 * outcome, not necessarily only once literally every row is Declared),
 * switching to the winning party once it is (Section 2's "partial data is
 * never presented as a settled outcome" rule -- so this never shows a
 * "Leading: X" guess).
 */
function statusResultCell(unit, electionMeta) {
  const cell = document.createElement('td');
  if (isResultCertain(unit)) {
    if (unit.winnerParty) {
      cell.appendChild(partyPill(electionMeta, unit.winnerParty));
    } else {
      cell.appendChild(el('span', { className: 'party-pill party-pill--muted', text: '—' }));
    }
  } else {
    cell.appendChild(statusBadge(dominantStatus(unit)));
  }
  return cell;
}

/**
 * Total row across all top-level seats (not sub-rows): sums the same
 * figures each seat row already shows, so "Total" is literally the column
 * sum, not a re-derivation from raw CSV data. There's no single winner
 * across 5 separate seats, so the combined Status/Result cell is left
 * blank rather than guessing one.
 */
function renderTotalRow(tbody, seats, electionMeta) {
  let electorate = 0;
  let turnout = 0;
  let turnoutKnown = false;
  let leftVote = 0;
  let rightVote = 0;
  let spoil = 0;
  for (const seat of seats) {
    electorate += seat.electorate || 0;
    if (seat.turnout != null) {
      turnout += seat.turnout;
      turnoutKnown = true;
    }
    leftVote += currentVote(seat, 'Left');
    rightVote += currentVote(seat, 'Right');
    spoil += seat.totals ? seat.totals.Spoil : 0;
  }
  const validVote = leftVote + rightVote;

  const tr = document.createElement('tr');
  tr.className = 'seat-row seat-table__total-row';
  const nameTd = document.createElement('td');
  nameTd.appendChild(
    el('span', { className: 'seat-row__name' }, [
      el('span', { attrs: { style: 'display:inline-block;width:1.4rem' } }),
      document.createTextNode('Total'),
    ])
  );
  tr.appendChild(nameTd);
  tr.appendChild(td(formatNumber(electorate)));
  tr.appendChild(td(formatTurnout(turnoutKnown ? turnout : null)));
  tr.appendChild(td(formatPercent(turnoutKnown && electorate > 0 ? (turnout / electorate) * 100 : null)));
  tr.appendChild(td(formatNumber(leftVote)));
  tr.appendChild(td(formatNumber(rightVote)));
  tr.appendChild(td(formatNumber(spoil)));
  tr.appendChild(td(formatPercent(validVote > 0 ? (leftVote / validVote) * 100 : null)));
  tr.appendChild(td(formatPercent(validVote > 0 ? (rightVote / validVote) * 100 : null)));
  tr.appendChild(td('—'));
  tbody.appendChild(tr);
}

function td(text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

main().catch((err) => renderError(content, err));
