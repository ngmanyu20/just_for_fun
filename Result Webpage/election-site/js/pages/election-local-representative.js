/**
 * election-local-representative.js — sub-page for General Direct's derived
 * `Local Representative` seat (FEATURE_SPEC.md Section 4, "one-off,
 * confirmed"). Unlike every other seat, it has no ballot data of its own —
 * `Data.getGeneralDirectSeats()` includes it with `isDerived: true` and a
 * `derivation` object (from `deriveLocalRepresentative()`) instead of the
 * normal precinct/status pipeline. Per spec: "clicking it must route to a
 * different sub-page showing vote breakdown by party per District/council,
 * rather than the precinct-breakdown view used for directly-voted seats" —
 * this page is that sub-page.
 *
 * There's no second round for this seat (FPTP plurality of Districts), so
 * `seat.winnerParty`/`seat.isFinal` are gated by the margin-safe rule
 * (localRepresentative.js's `marginSafeResult`): the leader is only shown
 * as the decided winner once the Districts still undeclared are fewer than
 * its lead over the runner-up — i.e. even a full sweep of what's left
 * couldn't change the outcome. Before that, `derivation.currentLeader`
 * still reports who's ahead right now, shown as "Undecided" rather than
 * decided.
 */

import * as Data from '../data.js';
import { formatNumber, partyPill, el, renderError } from './election-common.js';
import { renderNav, renderBreadcrumbs } from '../nav.js';

const content = document.getElementById('content');

async function main() {
  renderNav(document.getElementById('nav'), 'election-general-direct.html');
  renderBreadcrumbs(document.getElementById('breadcrumbs'), [
    { label: 'General Election', href: 'index.html' },
    { label: 'General Direct', href: 'election-general-direct.html' },
    { label: 'Local Representative' },
  ]);
  document.title = 'Local Representative — General Direct — Results';

  const [seats, electionMeta] = await Promise.all([Data.getGeneralDirectSeats(), Data.loadElectionMeta()]);
  const seat = seats.find((s) => s.constituency === 'Local Representative');
  if (!seat || !seat.derivation) throw new Error('Local Representative seat data not found.');

  const d = seat.derivation;
  const councils = Object.keys(d.councils).sort();

  const frag = document.createDocumentFragment();
  frag.appendChild(
    el('div', { className: 'page-header' }, [
      el('div', {}, [el('h1', { text: 'Local Representative' })]),
      el('div', { attrs: { style: 'text-align:right' } }, [resultHeaderNode(seat, d, electionMeta)]),
    ])
  );

  frag.appendChild(el('h2', { className: 'section-heading', text: 'Districts won, by party' }));
  frag.appendChild(districtsWonTable(d.districtsWonByParty, electionMeta));

  frag.appendChild(el('h2', { className: 'section-heading', text: `Vote breakdown by council (${councils.length})` }));
  frag.appendChild(councilBreakdownTable(councils, d, electionMeta));

  content.replaceChildren(frag);
}

/**
 * Header result indicator: a full party pill once `seat.isFinal` (margin-safe
 * winner declared), otherwise plain muted text -- "Undecided" while there's
 * a current leader but the margin isn't safe yet, or "No result yet" when
 * no District has been decided at all -- with no leading-party pill shown
 * in either not-final case (a partial lead isn't a result).
 * @param {Object} seat
 * @param {Object} d `seat.derivation`
 * @param {Object} electionMeta
 */
function resultHeaderNode(seat, d, electionMeta) {
  if (seat.isFinal && seat.winnerParty) {
    return partyPill(electionMeta, seat.winnerParty);
  }
  if (d.currentLeader) {
    return el('span', { className: 'party-pill party-pill--muted', text: 'Undecided' });
  }
  return el('span', { className: 'party-pill party-pill--muted', text: 'No result yet' });
}

function districtsWonTable(districtsWonByParty, electionMeta) {
  const table = document.createElement('table');
  table.className = 'data-table district-table';
  table.appendChild(
    el('thead', {}, [
      (() => {
        const tr = document.createElement('tr');
        tr.innerHTML = '<th style="text-align:left">Party</th><th>Districts won</th>';
        return tr;
      })(),
    ])
  );
  const tbody = document.createElement('tbody');
  const entries = Object.entries(districtsWonByParty).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    const tr = document.createElement('tr');
    const tdEl = document.createElement('td');
    tdEl.colSpan = 2;
    tdEl.className = 'empty-msg';
    tdEl.textContent = 'No Districts decided yet.';
    tr.appendChild(tdEl);
    tbody.appendChild(tr);
  }
  for (const [party, count] of entries) {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.style.textAlign = 'left';
    nameTd.appendChild(partyPill(electionMeta, party));
    tr.appendChild(nameTd);
    const countTd = document.createElement('td');
    countTd.textContent = formatNumber(count);
    countTd.style.fontWeight = '700';
    tr.appendChild(countTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/**
 * One row per council (District *name*, e.g. "Alington City" — the ~37
 * broader groupings, not the 1,779 individual District/Ward units that
 * actually decide seats — see localRepresentative.js's module doc),
 * grouped into collapsible Region sections (Capital/Highland/Lowland,
 * alphabetical — Section 1's presentation-order convention). Each region
 * starts collapsed to just its header row; clicking the header's toggle
 * expands/collapses its council rows, same `expand-toggle` interaction
 * used elsewhere in this app (election-general-direct.js,
 * election-home-districts.js), just grouping several rows per click
 * instead of one sub-table. Columns: total District units in the council,
 * seats won per party (how many of the council's own District units each
 * party's FPTP plurality won), total first-preference votes per party
 * across the whole council, and how many of the council's District units
 * have no Declared result yet.
 */
function councilBreakdownTable(councils, d, electionMeta) {
  const allParties = new Set();
  for (const council of councils) {
    for (const party of Object.keys(d.councils[council].seatsByParty)) allParties.add(party);
    for (const party of Object.keys(d.councils[council].votesByParty)) allParties.add(party);
  }
  const parties = [...allParties].sort();
  const columnCount = 3 + parties.length * 2; // Council, Total districts, [N party seats], [N party votes], Undeclared

  const councilsByRegion = new Map();
  for (const council of councils) {
    const region = d.councils[council].region || 'Unknown';
    if (!councilsByRegion.has(region)) councilsByRegion.set(region, []);
    councilsByRegion.get(region).push(council);
  }
  const regions = [...councilsByRegion.keys()].sort();

  const wrap = el('div', { className: 'scroll-table-wrap scroll-table-wrap--full-height' });
  const table = document.createElement('table');
  table.className = 'data-table district-table';
  const thead = document.createElement('thead');
  const headTr = document.createElement('tr');
  headTr.innerHTML = `<th style="text-align:left">Council</th><th>Total districts</th>${parties
    .map((p) => `<th>${p} seats</th>`)
    .join('')}${parties.map((p) => `<th>${p} votes</th>`).join('')}<th>Undeclared</th>`;
  thead.appendChild(headTr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  let regionIndex = 0;
  for (const region of regions) {
    regionIndex++;
    const regionId = `lr-region-${regionIndex}`;
    const regionCouncils = councilsByRegion.get(region);
    const spectrumSeats = regionSpectrumSeats(regionCouncils, d, electionMeta);
    tbody.appendChild(regionHeaderRow(region, regionCouncils.length, regionId, tbody, columnCount, spectrumSeats));
    for (const council of regionCouncils) {
      tbody.appendChild(councilRow(council, d.councils[council], parties, regionId));
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/**
 * Sum a region's Districts-won-per-party (`seatsByParty`, across all its
 * councils) into per-SPECTRUM totals (Left/MR/Right) plus the region's
 * still-undeclared District count, for the region header's caption -- the
 * display labels in `seatsByParty` (LRP/GRF/GCCA) are looked up back to
 * their spectrum via `Data.findParty` rather than hardcoded, since which
 * specific label a spectrum uses is itself derived data
 * (localRepresentative.js's `buildSpectrumDisplayLabels`), not fixed.
 * @param {Array<string>} regionCouncils council names in this region
 * @param {Object} d `seat.derivation`
 * @param {Object} electionMeta
 */
function regionSpectrumSeats(regionCouncils, d, electionMeta) {
  const totals = { total: 0, Left: 0, MR: 0, Right: 0, undeclared: 0 };
  for (const council of regionCouncils) {
    totals.undeclared += d.councils[council].undeclaredDistricts;
    for (const [party, count] of Object.entries(d.councils[council].seatsByParty)) {
      totals.total += count;
      const spectrum = Data.findParty(electionMeta, party)?.spectrum;
      if (spectrum && totals[spectrum] != null) totals[spectrum] += count;
    }
  }
  return totals;
}

function regionHeaderRow(region, councilCount, regionId, tbody, columnCount, spectrumSeats) {
  const tr = document.createElement('tr');
  tr.className = 'region-header-row';
  const td = document.createElement('td');
  td.colSpan = columnCount;
  td.style.textAlign = 'left';

  const wrap = el('span', { className: 'seat-row__name' });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'expand-toggle';
  btn.textContent = '▸';
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', regionId);
  btn.addEventListener('click', () => {
    const rows = tbody.querySelectorAll(`tr[data-region-group="${regionId}"]`);
    const currentlyHidden = rows.length > 0 && rows[0].classList.contains('hidden');
    rows.forEach((row) => row.classList.toggle('hidden', !currentlyHidden));
    btn.textContent = currentlyHidden ? '▾' : '▸';
    btn.setAttribute('aria-expanded', String(currentlyHidden));
  });
  wrap.appendChild(btn);
  wrap.appendChild(el('strong', { text: `${region} (${councilCount})` }));
  td.appendChild(wrap);
  td.appendChild(
    el('div', {
      className: 'page-header__meta',
      text: `Total Seats: ${formatNumber(spectrumSeats.total)}, Left Seats: ${formatNumber(spectrumSeats.Left)}, Middle Right Seats: ${formatNumber(spectrumSeats.MR)}, Right Seats: ${formatNumber(spectrumSeats.Right)}, Undecided: ${formatNumber(spectrumSeats.undeclared)}`,
    })
  );
  tr.appendChild(td);
  return tr;
}

function councilRow(council, c, parties, regionId) {
  const tr = document.createElement('tr');
  tr.className = 'hidden';
  tr.dataset.regionGroup = regionId;

  const nameTd = document.createElement('td');
  nameTd.style.textAlign = 'left';
  nameTd.style.paddingLeft = '2rem';
  nameTd.textContent = council;
  tr.appendChild(nameTd);

  const totalTd = document.createElement('td');
  totalTd.textContent = formatNumber(c.totalDistricts);
  tr.appendChild(totalTd);

  for (const party of parties) {
    const td = document.createElement('td');
    td.textContent = c.seatsByParty[party] != null ? formatNumber(c.seatsByParty[party]) : '—';
    tr.appendChild(td);
  }
  for (const party of parties) {
    const td = document.createElement('td');
    td.textContent = c.votesByParty[party] != null ? formatNumber(c.votesByParty[party]) : '—';
    tr.appendChild(td);
  }

  const undeclaredTd = document.createElement('td');
  undeclaredTd.textContent = formatNumber(c.undeclaredDistricts);
  tr.appendChild(undeclaredTd);

  return tr;
}

main().catch((err) => renderError(content, err));
