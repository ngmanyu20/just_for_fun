/**
 * election-seat.js — individual seat detail page (election-seat.html).
 * FEATURE_SPEC.md Section 4's third site-structure hop: "individual seat
 * detail (constituency map, precinct breakdown, status)". URL shape:
 * `election-seat.html?type=<AlmaVale|HomeDistricts|GeneralDirect>&constituency=<name>`.
 *
 * Judgment calls (flagged):
 *  - Map mounting is Alma Vale-only. FEATURE_SPEC.md Section 1's
 *    Constituency->County/District->Precinct geography, and the
 *    `lockToConstituency` contract in BUILD_NOTES.md, both key off the 40
 *    real constituencies in df_constituency.csv. Home Districts'
 *    `Constituency` values (Tong, Diamond & Rainbow SE, ...) were checked
 *    against that 40-row set and have zero overlap -- confirmed by diff --
 *    so there's no valid `lockToConstituency` target for it, unlike Alma
 *    Vale where the seat *is* one of the 40. General Direct never gets a
 *    map per Section 4 (functional constituency, explicit). So only
 *    AlmaVale seats mount `mountElectionMap`; HomeDistricts/GeneralDirect
 *    render a table-only detail view.
 *  - Home Districts/General Direct have no precinct-level rows and no
 *    `getHomeDistrictsSeatDetail`/`getGeneralDirectSeatDetail` export (see
 *    the longer note in election-common.js on renderConstituencySeatRows)
 *    -- their "precinct breakdown" section instead shows the aggregate
 *    sub-row status breakdown available on the seat summary.
 *  - Round 1 / Round 2 bar charts are required by spec for Alma Vale
 *    specifically; this page also renders them for Home Districts/General
 *    Direct seats since they share the identical Supplementary Vote
 *    schema/method and the data is already computed on the seat summary
 *    (`round1`/`round2`/`totals`) -- showing them keeps all three
 *    Supplementary Vote seat types visually consistent rather than
 *    special-casing Alma Vale's page shape.
 */

import * as Data from '../data.js';
import {
  formatNumber,
  formatPercent,
  formatTurnout,
  statusBadge,
  isResultCertain,
  dominantStatus,
  partyPill,
  renderError,
  el,
  SEAT_TYPE_PAGE,
  SEAT_TYPE_LABEL,
  mapToggleControls,
  mountElectionMapDefensively,
} from './election-common.js';
import { renderRound1Chart, renderRound2Chart } from './election-charts.js';
import { renderNav, renderBreadcrumbs } from '../nav.js';

const content = document.getElementById('content');
let mapHandle = null;

async function main() {
  const params = new URLSearchParams(location.search);
  const seatTypeId = params.get('type');
  const constituency = params.get('constituency');

  if (!seatTypeId || !constituency) {
    throw new Error('This page needs ?type=&constituency= in the URL.');
  }
  if (seatTypeId === 'GeneralDirect' && constituency === 'Local Representative') {
    location.replace('election-local-representative.html');
    return;
  }

  renderNav(document.getElementById('nav'), SEAT_TYPE_PAGE[seatTypeId] || 'index.html');

  const electionMeta = await Data.loadElectionMeta();

  if (seatTypeId === 'AlmaVale') {
    await renderAlmaValeDetail(constituency, electionMeta);
  } else if (seatTypeId === 'HomeDistricts' || seatTypeId === 'GeneralDirect') {
    await renderConstituencyGroupedDetail(seatTypeId, constituency, electionMeta);
  } else {
    throw new Error(`Unknown seat type "${seatTypeId}".`);
  }
}

// ---------------------------------------------------------------------
// Alma Vale: map + precinct breakdown + round 1 / round 2 charts.
// ---------------------------------------------------------------------

async function renderAlmaValeDetail(constituency, electionMeta) {
  renderBreadcrumbs(document.getElementById('breadcrumbs'), [
    { label: 'General Election', href: 'index.html' },
    { label: 'Alma Vale', href: 'election-alma-vale.html' },
    { label: constituency },
  ]);
  document.title = `${constituency} — Alma Vale — Results`;

  const detail = await Data.getAlmaValeSeatDetail(constituency);

  const frag = document.createDocumentFragment();
  frag.appendChild(seatHeader(constituency, 'Alma Vale', detail, electionMeta));

  const grid = el('div', { className: 'seat-detail-grid seat-detail-grid--with-map' });

  const mapCol = document.createElement('div');
  mapCol.appendChild(sectionTitle('Constituency map'));
  mapCol.appendChild(mapToggleControls((mode) => {
    if (mapHandle && mapHandle.setMode) mapHandle.setMode(mode);
  }));
  const mapMount = document.createElement('div');
  mapMount.id = 'map-mount';
  mapMount.textContent = 'Loading map…';
  mapCol.appendChild(mapMount);
  grid.appendChild(mapCol);

  const precinctCol = document.createElement('div');
  precinctCol.appendChild(sectionTitle(`Precincts (${formatNumber(detail.precincts.length)})`));
  precinctCol.appendChild(precinctTable(detail.precincts));
  grid.appendChild(precinctCol);

  frag.appendChild(grid);

  frag.appendChild(el('h2', { className: 'section-heading', text: 'Round 1 — all 9 first/second-preference columns' }));
  const round1Card = el('div', { className: 'chart-card' });
  frag.appendChild(round1Card);

  let round2Card = null;
  if (detail.round2) {
    frag.appendChild(el('h2', { className: 'section-heading', text: `Round 2 — after eliminating ${spectrumName(detail.eliminated, electionMeta)}` }));
    round2Card = el('div', { className: 'chart-card' });
    frag.appendChild(round2Card);
  } else {
    frag.appendChild(el('h2', { className: 'section-heading', text: 'Round 2' }));
    frag.appendChild(
      el('p', {
        className: 'empty-msg',
        text: detail.statusSummary.percentDeclared > 0
          ? 'Not triggered — a spectrum won outright with more than 50% of first-preference votes.'
          : 'Not yet known — no declared results for this seat yet.',
      })
    );
  }

  content.replaceChildren(frag);

  renderRound1Chart(round1Card, detail.totals, electionMeta);
  if (round2Card) renderRound2Chart(round2Card, detail, electionMeta);

  mountMap(mapMount, constituency);
}

function precinctTable(precincts) {
  const wrap = el('div', { className: 'scroll-table-wrap' });
  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Precinct</th><th>Status</th><th>Electorate</th><th>Turnout</th><th>Leading</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const p of precincts) {
    const tr = document.createElement('tr');
    tr.appendChild(td(p.shapeId));
    const statusTd = document.createElement('td');
    statusTd.appendChild(statusBadge(p.status));
    tr.appendChild(statusTd);
    tr.appendChild(td(formatNumber(p.electorate)));
    tr.appendChild(td(formatTurnout(p.turnout)));
    const leadTd = document.createElement('td');
    if (p.result && p.result.winner) {
      const dot = document.createElement('span');
      dot.className = 'legend-swatch';
      dot.style.background = `var(--spectrum-${p.result.winner.toLowerCase()})`;
      dot.style.marginRight = '0.4rem';
      leadTd.appendChild(dot);
      leadTd.appendChild(document.createTextNode(p.result.winner));
    } else {
      leadTd.textContent = '—';
    }
    tr.appendChild(leadTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// ---------------------------------------------------------------------
// Home Districts / General Direct: table-only detail, no map, no
// precinct-level rows (see the file-level judgment-call note above).
// ---------------------------------------------------------------------

async function renderConstituencyGroupedDetail(seatTypeId, constituency, electionMeta) {
  const seats = seatTypeId === 'HomeDistricts' ? await Data.getHomeDistrictsSeats() : await Data.getGeneralDirectSeats();
  const seat = seats.find((s) => s.constituency === constituency);
  if (!seat) throw new Error(`No "${constituency}" seat found under ${SEAT_TYPE_LABEL[seatTypeId]}.`);

  renderBreadcrumbs(document.getElementById('breadcrumbs'), [
    { label: 'General Election', href: 'index.html' },
    { label: SEAT_TYPE_LABEL[seatTypeId], href: SEAT_TYPE_PAGE[seatTypeId] },
    { label: constituency },
  ]);
  document.title = `${constituency} — ${SEAT_TYPE_LABEL[seatTypeId]} — Results`;

  const frag = document.createDocumentFragment();
  frag.appendChild(seatHeader(constituency, SEAT_TYPE_LABEL[seatTypeId], seat, electionMeta));

  if (seatTypeId === 'GeneralDirect') {
    frag.appendChild(
      el('div', {
        className: 'banner',
        text: 'General Direct is a functional constituency (FEATURE_SPEC.md Section 4) — this seat has no geographic footprint, so there is no map for it.',
      })
    );
  }

  frag.appendChild(sectionTitle('Reporting breakdown'));
  if (seat.subRowCount > 1 && Array.isArray(seat.subRows) && seat.subRows.length) {
    frag.appendChild(
      el('p', {
        className: 'page-header__meta',
        text: `This seat's total aggregates ${seat.subRowCount} Sub_Constituency reporting rows (reporting granularity, not separate seats — Section 4). Named breakdown below.`,
      })
    );
    frag.appendChild(subRowDetailTable(seat.subRows, electionMeta));
  } else {
    frag.appendChild(statusBreakdown(seat.statusSummary));
  }

  frag.appendChild(el('h2', { className: 'section-heading', text: 'Round 1 — all 9 first/second-preference columns' }));
  const round1Card = el('div', { className: 'chart-card' });
  frag.appendChild(round1Card);

  let round2Card = null;
  if (seat.round2) {
    frag.appendChild(el('h2', { className: 'section-heading', text: `Round 2 — after eliminating ${spectrumName(seat.eliminated, electionMeta)}` }));
    round2Card = el('div', { className: 'chart-card' });
    frag.appendChild(round2Card);
  } else {
    frag.appendChild(el('h2', { className: 'section-heading', text: 'Round 2' }));
    frag.appendChild(
      el('p', {
        className: 'empty-msg',
        text: seat.statusSummary.percentDeclared > 0
          ? 'Not triggered — a spectrum won outright with more than 50% of first-preference votes.'
          : 'Not yet known — no declared results for this seat yet.',
      })
    );
  }

  content.replaceChildren(frag);
  renderRound1Chart(round1Card, seat.totals, electionMeta);
  if (round2Card) renderRound2Chart(round2Card, seat, electionMeta);
}

/**
 * Named Sub_Constituency breakdown for a multi-row Home Districts/General
 * Direct seat detail page (Section 4) -- each sub-row carries its own
 * status/vote data via results.js's `subRows` (Phase 3 addition, resolved
 * against the same seat-level participation row as the parent seat).
 * @param {Array<Object>} subRows
 * @param {Object} electionMeta
 */
function subRowDetailTable(subRows, electionMeta) {
  const wrap = el('div', { className: 'scroll-table-wrap' });
  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Sub_Constituency</th><th>Status</th><th>Electorate</th><th>Turnout</th><th>% declared</th><th>Leading</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const sub of subRows) {
    const tr = document.createElement('tr');
    tr.appendChild(td(sub.subConstituency || '(unnamed)'));
    const statusTd = document.createElement('td');
    statusTd.appendChild(statusBadge(dominantStatus(sub)));
    tr.appendChild(statusTd);
    tr.appendChild(td(formatNumber(sub.electorate)));
    tr.appendChild(td(formatTurnout(sub.turnout)));
    tr.appendChild(td(formatPercent(sub.statusSummary.percentDeclared)));
    const leadTd = document.createElement('td');
    if (isResultCertain(sub) && sub.winnerParty) {
      leadTd.appendChild(partyPill(electionMeta, sub.winnerParty));
    } else if (sub.statusSummary.percentDeclared > 0 && sub.winnerParty) {
      leadTd.appendChild(el('span', { className: 'page-header__meta', text: `Leading: ${sub.winnerParty}` }));
    } else {
      leadTd.appendChild(el('span', { className: 'party-pill party-pill--muted', text: '—' }));
    }
    tr.appendChild(leadTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function statusBreakdown(statusSummary) {
  const chips = el('div', { className: 'subrow-status-chips' });
  for (const statusKey of [Data.STATUS.DECLARED, Data.STATUS.COUNTING, Data.STATUS.VERIFYING, Data.STATUS.NOT_RECEIVED]) {
    const bucket = statusSummary.byStatus[statusKey];
    if (!bucket || !bucket.count) continue;
    const chip = statusBadge(statusKey);
    chip.textContent = `${bucket.count} × ${statusKey} (${formatPercent(bucket.percentOfElectorate)} of electorate)`;
    chips.appendChild(chip);
  }
  return chips;
}

// ---------------------------------------------------------------------
// Shared header + map mounting
// ---------------------------------------------------------------------

function seatHeader(constituency, seatTypeLabel, seat, electionMeta) {
  const final = isResultCertain(seat);
  const resultNode = final
    ? partyPill(electionMeta, seat.winnerParty)
    : seat.winnerParty
    ? el('span', { className: 'page-header__meta', text: `Leading: ${seat.winnerParty}` })
    : el('span', { className: 'party-pill party-pill--muted', text: 'No result yet' });

  return el('div', { className: 'page-header' }, [
    el('div', {}, [
      el('h1', { text: constituency }),
      el('div', { className: 'page-header__meta', text: `${seatTypeLabel} seat · Supplementary Vote` }),
    ]),
    el('div', { attrs: { style: 'text-align:right' } }, [
      statusBadge(dominantStatus(seat)),
      el('div', { className: 'page-header__meta', attrs: { style: 'margin-top:0.4rem' }, text: `${formatPercent(seat.statusSummary.percentDeclared)} declared` }),
      el('div', { attrs: { style: 'margin-top:0.4rem' } }, [resultNode]),
    ]),
  ]);
}

function sectionTitle(text) {
  return el('h2', { className: 'section-heading', attrs: { style: 'margin-top:0' }, text });
}

function spectrumName(spectrumId, electionMeta) {
  const s = electionMeta.spectrums.find((x) => x.id === spectrumId);
  return s ? s.name : spectrumId;
}

function td(text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

async function mountMap(mount, constituency) {
  mapHandle = await mountElectionMapDefensively(mount, { lockToConstituency: constituency });
}

main().catch((err) => renderError(content, err));
