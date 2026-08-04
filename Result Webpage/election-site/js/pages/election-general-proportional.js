/**
 * election-general-proportional.js — General Proportional national results
 * page (45 seats, two-stage Hare quota + largest remainder,
 * FEATURE_SPEC.md Section 4). `Data.getGeneralProportionalResult()` already
 * runs the right algorithm for the current state of the count -- the exact
 * Stage 1/Stage 2 method (Valid/Total Votes, Turnout, the 15% gate, list
 * then within-list seats) once all 10 reporting sectors are Declared
 * (`result.isFinal`), otherwise the provisional guaranteed-minimum method
 * (proportional.js's `computeGuaranteedMinimumAllocation`) -- this page
 * only formats whichever result comes back into tables, plus shows each
 * sector's own status/party breakdown (Section 2's status pipeline applies
 * per-sector even though seats are allocated nationally on the sum).
 */

import * as Data from '../data.js';
import {
  formatNumber,
  formatPercent,
  formatTurnout,
  statusBadge,
  spectrumColor,
  renderError,
  el,
  dominantStatus,
  isFullyDeclared,
} from './election-common.js';
import { renderNav, renderBreadcrumbs } from '../nav.js';

const content = document.getElementById('content');

async function main() {
  renderNav(document.getElementById('nav'), 'election-general-proportional.html');
  renderBreadcrumbs(document.getElementById('breadcrumbs'), [
    { label: 'General Election', href: 'index.html' },
    { label: 'General Proportional' },
  ]);

  const [result, electionMeta] = await Promise.all([Data.getGeneralProportionalResult(), Data.loadElectionMeta()]);
  document.title = 'General Proportional — Results';

  const declaredSectors = result.sectors.filter((s) => isFullyDeclared(s.statusSummary)).length;
  const isFinal = result.isFinal;

  const frag = document.createDocumentFragment();
  frag.appendChild(
    el('div', { className: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'General Proportional' }),
        el('div', {
          className: 'page-header__meta',
          text: `${result.seatType.count} seats`,
        }),
      ]),
    ])
  );

  frag.appendChild(
    el('div', { className: 'stat-grid' }, [
      statTile('Total votes', formatNumber(result.totalVotes), `incl. ${formatNumber(result.spoil)} spoiled (${formatPercent(result.spoilPercent)} of total)`),
      statTile('Valid votes', formatNumber(result.validVotes)),
      statTile('Turnout', formatPercent(result.turnout), `of ${formatNumber(result.electorate)} electorate`),
      statTile('Quorum', formatNumber(Math.round(result.gateVotes))),
    ])
  );

  // Combined list + within-list result table (Left is expandable into its
  // two member parties; MR/Right are single-party lists with nothing to
  // expand).
  frag.appendChild(el('h2', { className: 'section-heading', text: 'Seats by list' }));
  frag.appendChild(listResultTable(result.lists, electionMeta, isFinal));

  // Reporting sectors, one row per sector with a column per contesting
  // party, each row expandable for that sector's electorate/turnout detail.
  const partyColumns = result.lists.flatMap((list) => list.parties.map((p) => p.abbreviation));
  frag.appendChild(el('h2', { className: 'section-heading', text: `Reporting sectors (${declaredSectors}/${result.sectors.length} declared)` }));
  frag.appendChild(sectorTable(result.sectors, partyColumns, result.lists));

  content.replaceChildren(frag);
}

function statTile(label, value, sub) {
  return el('div', { className: 'stat-tile' }, [
    el('div', { className: 'stat-tile__label', text: label }),
    el('div', { className: 'stat-tile__value', text: value }),
    sub ? el('div', { className: 'stat-tile__sub', text: sub }) : null,
  ]);
}

function listResultTable(lists, electionMeta, isFinal) {
  const table = document.createElement('table');
  table.className = 'data-table seat-table list-result-table';
  const thead = document.createElement('tr');
  thead.innerHTML = '<th>List</th><th>Votes</th><th>Valid Proportion</th><th>Qualified</th><th>Seats</th>';
  table.appendChild(el('thead', {}, [thead]));

  const tbody = document.createElement('tbody');
  let rowIndex = 0;
  for (const list of lists) {
    rowIndex++;
    const rowId = `list-row-${rowIndex}`;
    const expandable = list.parties.length > 1;

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
    nameWrap.appendChild(el('span', { className: 'legend-swatch', attrs: { style: `background:${listColor(list, electionMeta)};margin-right:0.4rem` } }));
    nameWrap.appendChild(document.createTextNode(`${list.id} (${list.parties.map((p) => p.abbreviation).join(', ')})`));
    nameTd.appendChild(nameWrap);
    tr.appendChild(nameTd);

    tr.appendChild(td(formatNumber(list.votes)));
    tr.appendChild(td(formatPercent(list.percent)));
    tr.appendChild(td(list.qualified ? 'Yes' : isFinal ? 'No — below gate' : 'Not yet — below gate'));
    const seatsTd = td(formatNumber(list.seats));
    seatsTd.style.fontWeight = '700';
    tr.appendChild(seatsTd);
    tbody.appendChild(tr);

    if (expandable) {
      const detailTr = document.createElement('tr');
      detailTr.id = rowId;
      detailTr.className = 'subrow-detail hidden';
      const detailTd = document.createElement('td');
      detailTd.colSpan = 5;
      const inner = el('div', { className: 'subrow-detail__inner' });
      inner.appendChild(partyWithinListTable(list));
      detailTd.appendChild(inner);
      detailTr.appendChild(detailTd);
      tbody.appendChild(detailTr);
    }
  }
  table.appendChild(tbody);
  return table;
}

function partyWithinListTable(list) {
  const table = document.createElement('table');
  table.className = 'data-table subrow-table list-result-table';
  const thead = document.createElement('tr');
  thead.innerHTML = '<th>Party</th><th>Votes</th><th>Valid Proportion</th><th>Seats within list</th>';
  table.appendChild(el('thead', {}, [thead]));
  const tbody = document.createElement('tbody');
  for (const party of list.parties) {
    const tr = document.createElement('tr');
    tr.appendChild(td(party.abbreviation));
    tr.appendChild(td(formatNumber(party.votes)));
    tr.appendChild(td(formatPercent(party.percent)));
    const seatsTd = td(formatNumber(party.seats));
    seatsTd.style.fontWeight = '700';
    tr.appendChild(seatsTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function sectorTable(sectors, partyColumns, lists) {
  const table = document.createElement('table');
  table.className = 'data-table seat-table sector-table';
  const thead = document.createElement('tr');
  thead.innerHTML = `<th>Sector</th><th>Status</th><th>Electorate</th><th>Turnout</th><th>Turnout</th>${partyColumns.map((abbrev) => `<th>${abbrev}</th>`).join('')}<th>Spoil</th>${lists.map((list) => `<th>${list.id}</th>`).join('')}`;
  table.appendChild(el('thead', {}, [thead]));

  const tbody = document.createElement('tbody');
  let rowIndex = 0;
  for (const sector of sectors) {
    rowIndex++;
    const rowId = `sector-row-${rowIndex}`;
    // Only expandable when this sector's Constituency actually splits into
    // more than one Sub_Constituency reporting row (see
    // getGeneralProportionalResult) -- with the current data every sector
    // is exactly one row, so no toggle shows.
    const expandable = sector.subRowCount > 1;

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
    nameWrap.appendChild(document.createTextNode(sector.constituency || '(unnamed sector)'));
    nameTd.appendChild(nameWrap);
    tr.appendChild(nameTd);

    const statusTd = document.createElement('td');
    statusTd.appendChild(statusBadge(dominantStatus(sector)));
    tr.appendChild(statusTd);

    tr.appendChild(td(formatNumber(sector.electorate)));
    tr.appendChild(td(formatTurnout(sector.turnout)));
    tr.appendChild(td(formatPercent(turnoutPct(sector))));
    for (const abbrev of partyColumns) {
      tr.appendChild(td(sector.partyVotes ? formatNumber(sector.partyVotes[abbrev]) : '—'));
    }
    tr.appendChild(td(sector.spoil != null ? formatNumber(sector.spoil) : '—'));
    const sectorListPcts = listVotePcts(sector, lists);
    for (const pct of sectorListPcts) tr.appendChild(td(formatPercent(pct)));
    tbody.appendChild(tr);

    if (expandable) {
      const detailTr = document.createElement('tr');
      detailTr.id = rowId;
      detailTr.className = 'subrow-detail hidden';
      const detailTd = document.createElement('td');
      detailTd.colSpan = 6 + partyColumns.length + lists.length;
      const inner = el('div', { className: 'subrow-detail__inner' });
      inner.appendChild(sectorSubRowTable(sector.subRows, partyColumns, lists));
      detailTd.appendChild(inner);
      detailTr.appendChild(detailTd);
      tbody.appendChild(detailTr);
    }
  }
  table.appendChild(tbody);
  return table;
}

/**
 * Each list's (spectrum's) share of a sector's own valid votes -- e.g. the
 * Left list's % combines its member parties (NRD + LRP) into one figure,
 * same "list, not party" grouping as the national Seats-by-list table.
 * `null` per list while the sector's votes aren't visible yet (Section 2).
 * @param {{partyVotes: Record<string,number>|null}} sector
 * @param {Array<{id:string, parties:Array<{abbreviation:string}>}>} lists
 * @returns {Array<number|null>} one entry per list, same order as `lists`
 */
function listVotePcts(sector, lists) {
  if (!sector.partyVotes) return lists.map(() => null);
  const total = Object.values(sector.partyVotes).reduce((sum, v) => sum + v, 0);
  return lists.map((list) => {
    const listVotes = list.parties.reduce((sum, p) => sum + (sector.partyVotes[p.abbreviation] || 0), 0);
    return total > 0 ? (listVotes / total) * 100 : 0;
  });
}

function sectorSubRowTable(subRows, partyColumns, lists) {
  const table = document.createElement('table');
  table.className = 'data-table subrow-table sector-table';
  const thead = document.createElement('tr');
  thead.innerHTML = `<th>Sub_Constituency</th><th>Status</th><th>Electorate</th><th>Turnout</th><th>Turnout</th>${partyColumns.map((abbrev) => `<th>${abbrev}</th>`).join('')}<th>Spoil</th>${lists.map((list) => `<th>${list.id}</th>`).join('')}`;
  table.appendChild(el('thead', {}, [thead]));
  const tbody = document.createElement('tbody');
  for (const sub of subRows) {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = sub.subConstituency || '(unnamed)';
    tr.appendChild(nameTd);
    const statusTd = document.createElement('td');
    statusTd.appendChild(statusBadge(sub.status));
    tr.appendChild(statusTd);
    tr.appendChild(td(formatNumber(sub.electorate)));
    tr.appendChild(td(formatTurnout(sub.turnout)));
    tr.appendChild(td(formatPercent(turnoutPct(sub))));
    for (const abbrev of partyColumns) {
      tr.appendChild(td(sub.partyVotes ? formatNumber(sub.partyVotes[abbrev]) : '—'));
    }
    tr.appendChild(td(sub.spoil != null ? formatNumber(sub.spoil) : '—'));
    for (const pct of listVotePcts(sub, lists)) tr.appendChild(td(formatPercent(pct)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/** A sector/sub-row's own Turnout as a % of its Electorate, or `null` if Turnout isn't visible yet (Section 2's Counting gate). */
function turnoutPct(unit) {
  return unit.turnout != null && unit.electorate > 0 ? (unit.turnout / unit.electorate) * 100 : null;
}

function td(text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

function listColor(list, electionMeta) {
  // Same rule as election-charts.js's internal listColor(): resolve via
  // the first member party's spectrum, not by assuming list.id is itself a
  // spectrum id in general. Falls back to spectrumColor(list.id) when no
  // member party resolves -- General Proportional's `Right` list-party is a
  // literal column name with no `parties[]` entry of its own (FEATURE_SPEC.md
  // "Open items": implemented literally, not mapped to GCCA/RA), but its
  // list id ("Right") IS a real spectrum id here, so this still colors it
  // correctly instead of falling through to plain grey.
  for (const p of list.parties) {
    const abbrev = typeof p === 'string' ? p : p.abbreviation;
    const party = electionMeta.parties.find((x) => x.abbreviation === abbrev);
    if (party) return spectrumColor(party.spectrum);
  }
  return spectrumColor(list.id);
}

main().catch((err) => renderError(content, err));
