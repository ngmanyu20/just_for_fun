/**
 * referendum.js — page controller for referendum.html (Agent 2c).
 *
 * FEATURE_SPEC.md Section 5: one referendum question, fixed display layers
 * Authority -> County -> Precinct (no toggle), scoped by whichever seat
 * types referendum_meta.json's seat_types[] lists. Only geographic seat
 * types (currently AlmaVale) reach the map; GeneralDirect is a functional
 * constituency and always renders as its own flat table (never on a map,
 * per BUILD_NOTES.md's explicit reminder).
 *
 * Data access goes exclusively through js/data.js (per BUILD_NOTES.md) --
 * this file never fetches or parses a raw data/* file itself.
 *
 * Degrades gracefully if js/map/referendumMap.js (owned by the parallel
 * "2a" map agent) isn't available yet: the Authority/County selectors and
 * precinct table drive the exact same drill-down state and stay fully
 * functional with or without the visual map.
 */

import * as Data from '../data.js';
import { renderNav } from '../nav.js';

const NOW = new Date();

// ---------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------

const els = {};
let shapeIndex = null;
let referendumMeta = null;
let seatTypeIds = new Set();
let almaValeData = null; // { referendumId, question, national, statusSummary, precinctRows }
let precinctRowById = new Map();
let map = null; // mounted js/map/referendumMap.js instance, or null if unavailable
let lastLoadedAt = null; // read by reloadControl() when renderHeaderSkeleton() rebuilds it

const drill = { authority: null, county: null, precinct: null };
const errors = [];

function reportError(context, err) {
  console.error(`[referendum] ${context}:`, err);
  errors.push(`${context}: ${err && err.message ? err.message : err}`);
}

// ---------------------------------------------------------------------
// Formatting / status helpers
// ---------------------------------------------------------------------

function fmtInt(n) {
  return Math.round(n || 0).toLocaleString();
}

function fmtPct(n) {
  return `${(n || 0).toFixed(1)}%`;
}

function statusClass(status) {
  switch (status) {
    case Data.STATUS.DECLARED:
      return 'declared';
    case Data.STATUS.COUNTING:
      return 'counting';
    case Data.STATUS.VERIFYING:
      return 'verifying';
    default:
      return 'not-received';
  }
}

function statusBadge(status) {
  const span = document.createElement('span');
  span.className = `status-badge status-badge--${statusClass(status)}`;
  span.textContent = status;
  return span;
}

/**
 * Renders a diverging Yes/No bar + legend into `container`.
 * @param {HTMLElement} container
 * @param {{yes:number, no:number, validVotes:number, yesPercent:number, noPercent:number}} summary
 */
function renderYesNoBar(container, summary) {
  container.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'ref-bar';

  if (summary.validVotes > 0) {
    const yesSeg = document.createElement('div');
    yesSeg.className = 'ref-bar__segment ref-bar__segment--yes';
    yesSeg.style.width = `${summary.yesPercent}%`;
    yesSeg.textContent = summary.yesPercent >= 14 ? `Yes ${fmtInt(summary.yes)} (${fmtPct(summary.yesPercent)})` : '';
    yesSeg.title = `Yes: ${fmtPct(summary.yesPercent)} (${fmtInt(summary.yes)} votes)`;

    const noSeg = document.createElement('div');
    noSeg.className = 'ref-bar__segment ref-bar__segment--no';
    noSeg.style.width = `${summary.noPercent}%`;
    noSeg.textContent = summary.noPercent >= 14 ? `No ${fmtInt(summary.no)} (${fmtPct(summary.noPercent)})` : '';
    noSeg.title = `No: ${fmtPct(summary.noPercent)} (${fmtInt(summary.no)} votes)`;

    bar.append(yesSeg, noSeg);
  }
  container.appendChild(bar);

  const legend = document.createElement('div');
  legend.className = 'ref-bar-legend';
  legend.innerHTML =
    '<span><span class="ref-bar-legend__swatch ref-swatch--yes"></span>Yes</span>' +
    '<span><span class="ref-bar-legend__swatch ref-swatch--no"></span>No</span>';
  container.appendChild(legend);
}

// ---------------------------------------------------------------------
// Per-seat-type results (Section 5: votes come only from whichever seat
// types are scoped in via seat_types[] -- never assume both AlmaVale and
// GeneralDirect are present). AlmaVale and GeneralDirect are different
// electorates voting on the same question, so their Yes/No totals are
// never summed together -- each seat type gets its own result card below.
// ---------------------------------------------------------------------

/** Electorate-weighted percentage across a set of {totalElectorate, weightedElectorate} parts (e.g. "% declared", "% with turnout known"). */
function combineElectorateWeighted(parts) {
  let total = 0;
  let weighted = 0;
  for (const p of parts) {
    total += p.totalElectorate;
    weighted += p.weightedElectorate;
  }
  return total > 0 ? (weighted / total) * 100 : 0;
}

/**
 * Electorate-weighted % of a statusSummary that's reached at least "Counting"
 * -- the point Turnout itself becomes known per-row (Section 2's table),
 * looser than `percentDeclared`. Used to decide whether a summary card's
 * Turnout line can drop "so far" (every unit's Turnout is now a settled
 * number, not still climbing as more units reach Counting).
 */
function percentTurnoutKnown(statusSummary) {
  const counting = statusSummary.byStatus[Data.STATUS.COUNTING].electorate;
  const declared = statusSummary.byStatus[Data.STATUS.DECLARED].electorate;
  return combineElectorateWeighted([{ totalElectorate: statusSummary.totalElectorate, weightedElectorate: counting + declared }]);
}

/** Sums GeneralDirect's own seats into one Yes/No summary + declared/turnout-known % -- a within-seat-type aggregate, not a cross-seat-type one. */
function aggregateGeneralDirect(data) {
  let yes = 0;
  let no = 0;
  let electorate = 0;
  let turnout = 0;
  const declaredParts = [];
  const turnoutKnownParts = [];
  for (const seat of data.seats) {
    yes += seat.summary.yes;
    no += seat.summary.no;
    electorate += seat.summary.electorate;
    turnout += seat.summary.turnout || 0; // seat.summary.turnout is null iff zero rows have reached Counting yet
    const s = seat.statusSummary;
    declaredParts.push({ totalElectorate: s.totalElectorate, weightedElectorate: s.byStatus[Data.STATUS.DECLARED].electorate });
    turnoutKnownParts.push({
      totalElectorate: s.totalElectorate,
      weightedElectorate: s.byStatus[Data.STATUS.COUNTING].electorate + s.byStatus[Data.STATUS.DECLARED].electorate,
    });
  }
  const validVotes = yes + no;
  return {
    summary: {
      yes,
      no,
      validVotes,
      yesPercent: validVotes > 0 ? (yes / validVotes) * 100 : 0,
      noPercent: validVotes > 0 ? (no / validVotes) * 100 : 0,
      electorate,
      turnout,
    },
    percentDeclared: combineElectorateWeighted(declaredParts),
    percentTurnoutKnown: combineElectorateWeighted(turnoutKnownParts),
  };
}

// ---------------------------------------------------------------------
// Header + per-section summary
// ---------------------------------------------------------------------

function renderHeaderSkeleton() {
  const el = document.getElementById('referendum-header');
  el.innerHTML = '';
  const h1 = document.createElement('h1');
  h1.textContent = referendumMeta.question || `Referendum ${referendumMeta.referendum_id}`;
  el.appendChild(h1);
  const meta = document.createElement('div');
  meta.className = 'ref-header__meta';
  meta.innerHTML = `<span>Referendum #${referendumMeta.referendum_id}</span><span>${referendumMeta.election_date || ''}</span>`;
  meta.appendChild(reloadControl());
  el.appendChild(meta);
  els.headerMeta = meta;
}

/**
 * "Reload results" button + last-updated/error status text, rebuilt fresh
 * on every renderHeaderSkeleton() call (`el.innerHTML = ''` there clears
 * any previous one). Clicking it clears every data-layer cache (data.js's
 * refreshAllData()) and re-runs the full load+render sequence in place --
 * no page navigation/reload needed to pick up updated data/* files.
 */
function reloadControl() {
  const wrap = document.createElement('div');
  wrap.className = 'reload-control';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'reload-btn';
  btn.textContent = 'Reload results';
  const status = document.createElement('span');
  status.className = 'reload-status';
  status.textContent = lastLoadedAt ? `Updated ${lastLoadedAt.toLocaleTimeString()}` : '';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Reloading…';
    status.textContent = '';
    status.classList.remove('reload-status--error');
    loadAndRenderReferendum({ forceRefresh: true }).catch((err) => {
      console.error('[referendum] reload failed:', err);
      btn.disabled = false;
      btn.textContent = 'Reload results';
      status.classList.add('reload-status--error');
      status.textContent = `Reload failed: ${err && err.message ? err.message : err}`;
    });
  });
  wrap.append(btn, status);
  return wrap;
}

/**
 * Moves the (already-mounted) "Reload results" control from the page
 * header into the map's own toolbar, once `tryMountMap()` has confirmed a
 * `.map-toolbar` actually exists -- relocates the same DOM node (not a
 * copy), so its click listener/state stay intact. Left in the header
 * (where `renderHeaderSkeleton()` puts it) whenever the map itself never
 * mounts (e.g. no AlmaVale seat type this referendum, or js/map/referendumMap.js
 * unavailable), so the button never disappears.
 */
function relocateReloadControlIntoMap() {
  const toolbar = els.mapHost && els.mapHost.querySelector('.map-toolbar');
  const control = els.headerMeta && els.headerMeta.querySelector('.reload-control');
  if (toolbar && control) toolbar.appendChild(control);
}

function renderSectionSummaries(sectionResults) {
  const el = document.getElementById('referendum-summary');
  el.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = 'Results';
  el.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'ref-summary__grid';

  if (sectionResults.AlmaVale) {
    const statusSummary = sectionResults.AlmaVale.statusSummary;
    grid.appendChild(
      sectionSummaryCard('Alma Vale', sectionResults.AlmaVale.national, statusSummary.percentDeclared, percentTurnoutKnown(statusSummary))
    );
  }
  if (sectionResults.GeneralDirect) {
    const agg = aggregateGeneralDirect(sectionResults.GeneralDirect);
    grid.appendChild(sectionSummaryCard('General Direct', agg.summary, agg.percentDeclared, agg.percentTurnoutKnown));
  }

  el.appendChild(grid);
}

/**
 * "Status: In Progress" until the outcome is mathematically safe from the
 * still-undeclared electorate -- i.e. the current Yes/No margin exceeds the
 * maximum vote pool that could still land (the not-yet-Declared share of
 * `electorate`, the same electorate-weighted pool `percentDeclared` is
 * computed from). Only once no realistic remaining count could flip the
 * lead does this call it "Agree" or "Disagree".
 */
function referendumStatusLabel(summary, percentDeclared) {
  const margin = Math.abs(summary.yes - summary.no);
  const remaining = Math.max(0, summary.electorate * (1 - percentDeclared / 100));
  const decided = summary.validVotes > 0 && margin > remaining;
  if (!decided) return { text: 'In Progress', className: 'ref-status--progress' };
  return summary.yes > summary.no
    ? { text: 'Agree', className: 'ref-status--yes' }
    : { text: 'Disagree', className: 'ref-status--no' };
}

function sectionSummaryCard(title, summary, percentDeclared, turnoutKnownPct) {
  const card = document.createElement('div');
  card.className = 'ref-summary__card';

  const h3 = document.createElement('h3');
  h3.textContent = title;
  card.appendChild(h3);

  const barHost = document.createElement('div');
  card.appendChild(barHost);
  renderYesNoBar(barHost, summary);

  const status = referendumStatusLabel(summary, percentDeclared);
  const statusLine = document.createElement('div');
  statusLine.className = `ref-summary__status ${status.className}`;
  statusLine.textContent = `Status: ${status.text}`;
  card.appendChild(statusLine);

  // Turnout is only ever a "so far" figure while some electorate hasn't yet
  // reached Counting -- once every unit has (turnoutKnownPct >= 100), the
  // number's settled, not still climbing, so the label drops "so far".
  const turnoutLabel = turnoutKnownPct >= 100 ? 'Turnout' : 'Turnout so far';

  const totalsTop = document.createElement('div');
  totalsTop.className = 'ref-summary__totals';
  totalsTop.innerHTML = `
    <span>Electorate: ${fmtInt(summary.electorate)}</span>
    <span>${turnoutLabel}: ${fmtInt(summary.turnout)}</span>
  `;
  card.appendChild(totalsTop);

  const totalsBottom = document.createElement('div');
  totalsBottom.className = 'ref-summary__totals';
  totalsBottom.innerHTML = `
    <span>Valid votes: ${fmtInt(summary.validVotes)}</span>
    <span>${fmtPct(percentDeclared)} in</span>
  `;
  card.appendChild(totalsBottom);

  return card;
}

// ---------------------------------------------------------------------
// Geographic (AlmaVale) section: Authority -> County -> Precinct
// ---------------------------------------------------------------------

async function initGeoSection() {
  els.mapHost = document.getElementById('referendum-map');
  els.geoPanel = document.getElementById('referendum-geo-panel');

  buildGeoPanelSkeleton();
  await tryMountMap();
  await selectUnit({ level: 'top' });
}

function buildGeoPanelSkeleton() {
  els.geoPanel.innerHTML = '';

  const controls = document.createElement('div');
  controls.className = 'ref-drill-controls card';

  const authorityLabel = document.createElement('label');
  authorityLabel.textContent = 'Authority';
  authorityLabel.htmlFor = 'ref-authority-select';
  const authoritySelect = document.createElement('select');
  authoritySelect.id = 'ref-authority-select';
  authoritySelect.appendChild(new Option('All authorities (top level)', ''));
  const authorities = [...shapeIndex.authorities].sort((a, b) => a.Authority.localeCompare(b.Authority));
  for (const a of authorities) authoritySelect.appendChild(new Option(a.Authority, a.Authority));
  authoritySelect.addEventListener('change', () => {
    const p = authoritySelect.value ? selectUnit({ level: 'authority', id: authoritySelect.value }) : selectUnit({ level: 'top' });
    p.catch((err) => reportError('Authority select change', err));
  });

  const countyLabel = document.createElement('label');
  countyLabel.textContent = 'County';
  countyLabel.htmlFor = 'ref-county-select';
  const countySelect = document.createElement('select');
  countySelect.id = 'ref-county-select';
  countySelect.disabled = true;
  countySelect.addEventListener('change', () => {
    if (!countySelect.value) return;
    selectUnit({ level: 'county', id: countySelect.value }).catch((err) => reportError('County select change', err));
  });

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.textContent = 'Reset to top view';
  resetBtn.addEventListener('click', () => {
    selectUnit({ level: 'top' }).catch((err) => reportError('Reset button', err));
  });

  controls.append(authorityLabel, authoritySelect, countyLabel, countySelect, resetBtn);

  const unitSummary = document.createElement('div');
  unitSummary.id = 'ref-unit-summary';
  unitSummary.className = 'ref-unit-summary';

  const precinctList = document.createElement('div');
  precinctList.id = 'ref-precinct-list';
  precinctList.className = 'ref-precinct-list';

  els.geoPanel.append(controls, unitSummary, precinctList);

  els.authoritySelect = authoritySelect;
  els.countySelect = countySelect;
  els.unitSummary = unitSummary;
  els.precinctList = precinctList;
}

async function tryMountMap() {
  try {
    // Built in parallel by a different agent (BUILD_NOTES.md's map
    // component contract) -- may not exist yet, or may still be mid-edit.
    const mod = await import('../map/referendumMap.js');
    if (!mod || typeof mod.mountReferendumMap !== 'function') {
      throw new Error('referendumMap.js loaded but does not export mountReferendumMap()');
    }
    els.mapHost.textContent = '';
    map = await mod.mountReferendumMap(els.mapHost, {
      onUnitClick: (unit) => {
        // Contract (BUILD_NOTES.md) only specifies "(unit) => void" -- the
        // payload shape isn't documented beyond that. Assumed here to
        // mirror drillTo(level, id)'s own parameters ({level, id}), the
        // most natural inference; guarded so a differently-shaped payload
        // is ignored rather than throwing.
        if (!unit || !unit.level || !unit.id) return;
        selectUnit({ level: unit.level, id: unit.id }, { fromMap: true }).catch((err) =>
          reportError('onUnitClick from map', err)
        );
      },
    });
    relocateReloadControlIntoMap();
  } catch (err) {
    map = null;
    reportError('Map component (js/map/referendumMap.js) unavailable', err);
    els.mapHost.innerHTML = '';
    const p = document.createElement('p');
    p.textContent =
      'Map component not available yet (js/map/referendumMap.js). Use the Authority/County selectors and the table below to drill down.';
    els.mapHost.appendChild(p);
  }
}

async function selectUnit(unit, opts = {}) {
  try {
    const level = unit && unit.level;
    const id = unit && unit.id;

    if (level === 'top') {
      drill.authority = null;
      drill.county = null;
      drill.precinct = null;
    } else if (level === 'authority') {
      drill.authority = id;
      drill.county = null;
      drill.precinct = null;
    } else if (level === 'county') {
      drill.county = id;
      drill.precinct = null;
      if (!drill.authority) {
        const auth = Data.getAuthorityForCounty(shapeIndex, id);
        if (auth) drill.authority = auth.Authority;
      }
    } else if (level === 'precinct') {
      drill.precinct = id;
      if (!drill.county) {
        const precinct = shapeIndex.polygonById.get(id);
        if (precinct) {
          drill.county = precinct.County;
          if (!drill.authority) {
            const auth = Data.getAuthorityForCounty(shapeIndex, precinct.County);
            if (auth) drill.authority = auth.Authority;
          }
        }
      }
    } else {
      return;
    }

    syncControls();

    if (map && !opts.fromMap) {
      try {
        if (level === 'top') map.reset();
        else map.drillTo(level, id);
      } catch (err) {
        reportError('map.reset/drillTo', err);
      }
    }

    await renderUnitSummaryAndList();
  } catch (err) {
    reportError('selectUnit', err);
  } finally {
    renderErrors();
  }
}

function syncControls() {
  els.authoritySelect.value = drill.authority || '';

  els.countySelect.innerHTML = '';
  if (drill.authority) {
    els.countySelect.disabled = false;
    els.countySelect.appendChild(new Option('All counties in this authority', ''));
    const counties = Data.getCountiesForAuthority(shapeIndex, drill.authority)
      .slice()
      .sort((a, b) => a.County.localeCompare(b.County));
    for (const c of counties) els.countySelect.appendChild(new Option(c.County, c.County));
    els.countySelect.value = drill.county || '';
  } else {
    els.countySelect.disabled = true;
  }
}

// Monotonic guard against out-of-order async renders: selectUnit() can be
// re-entered while a previous call's `await` is still pending (concretely:
// js/map/referendumMap.js's drillTo('precinct', id) internally re-enters
// its county view and synchronously fires its own county-level
// onUnitClick, which starts a second, nested renderUnitSummaryAndList()
// call before the outer one has finished). Each call captures the seq
// value at its start and re-checks it after every await -- a call whose
// seq has been superseded by a newer one silently drops its own DOM
// writes instead of clobbering the newer (more current) render.
let renderSeq = 0;

async function renderUnitSummaryAndList() {
  const seq = ++renderSeq;
  els.unitSummary.textContent = 'Loading…';
  els.precinctList.innerHTML = '';

  if (drill.precinct) {
    renderPrecinctDetail(drill.precinct);
    finalizeUnitSummary();
    renderPrecinctTableForCounty(drill.county, { highlight: drill.precinct });
    return;
  }

  if (drill.county) {
    const summary = await Data.getAlmaValeReferendumForCounty(drill.county, NOW);
    if (seq !== renderSeq) return; // superseded by a newer selection while awaiting
    renderUnitSummaryBlock(`County ${drill.county}`, summary.summary, summary.statusSummary, summary.precinctRows.length);
    finalizeUnitSummary();
    renderPrecinctTableForCounty(drill.county);
    return;
  }

  if (drill.authority) {
    const summary = await Data.getAlmaValeReferendumForAuthority(drill.authority, NOW);
    if (seq !== renderSeq) return;
    renderUnitSummaryBlock(
      `Authority: ${drill.authority}`,
      summary.summary,
      summary.statusSummary,
      summary.precinctRows.length,
      `${summary.counties.length} counties`
    );
    finalizeUnitSummary();
    await renderCountyTableForAuthority(drill.authority, seq);
    return;
  }

  renderUnitSummaryBlock(
    'Alma Vale',
    almaValeData.national,
    almaValeData.statusSummary,
    almaValeData.precinctRows.length
  );
  finalizeUnitSummary();
  await renderAuthorityTable(seq);
}

// ---------------------------------------------------------------------
// Mobile "bottom sheet" presentation (css/mobile.css, phone widths only) --
// same technique as election-alma-vale.js's own finalizeUnitSummary(): once
// a unit deeper than the top level is selected, `.ref-unit-summary` gets a
// `--sheet` modifier that CSS turns into a floating card pinned to the
// bottom of the screen instead of the plain in-flow panel box it already is
// on desktop / at the top level, with a close (X) button back to the
// top-level view. No visual effect above mobile.css's 768px breakpoint.
// ---------------------------------------------------------------------
function finalizeUnitSummary() {
  const isSheet = !!(drill.precinct || drill.county || drill.authority);
  els.unitSummary.classList.toggle('ref-unit-summary--sheet', isSheet);
  if (!isSheet) return;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ref-unit-summary__close';
  closeBtn.setAttribute('aria-label', 'Close, back to Alma Vale overview');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => {
    selectUnit({ level: 'top' }).catch((err) => reportError('sheet close', err));
  });
  els.unitSummary.insertBefore(closeBtn, els.unitSummary.firstChild);
}

function renderUnitSummaryBlock(title, summary, statusSummary, precinctCount, extraNote) {
  els.unitSummary.innerHTML = '';
  const titleEl = document.createElement('div');
  titleEl.className = 'ref-unit-summary__title';
  titleEl.textContent = title;
  els.unitSummary.appendChild(titleEl);

  const barHost = document.createElement('div');
  els.unitSummary.appendChild(barHost);
  renderYesNoBar(barHost, summary);

  const declaredCount = statusSummary.byStatus[Data.STATUS.DECLARED].count;
  const info = document.createElement('p');
  info.className = 'ref-bar-legend';
  const parts = [`${fmtInt(precinctCount)} precincts`];
  if (extraNote) parts.push(extraNote);
  parts.push(`${fmtInt(declaredCount)} / ${fmtInt(precinctCount)} declared`);
  parts.push(`${fmtPct(statusSummary.percentDeclared)} in`);
  info.textContent = parts.join(', ');
  els.unitSummary.appendChild(info);
}

function renderPrecinctDetail(shapeId) {
  const row = precinctRowById.get(shapeId);
  els.unitSummary.innerHTML = '';
  const titleEl = document.createElement('div');
  titleEl.className = 'ref-unit-summary__title';
  titleEl.textContent = `Precinct ${shapeId}`;
  els.unitSummary.appendChild(titleEl);

  if (!row) {
    const p = document.createElement('p');
    p.textContent = 'No referendum data found for this precinct.';
    els.unitSummary.appendChild(p);
    return;
  }

  const status = Data.computeStatus(row, NOW);

  if (status === Data.STATUS.DECLARED) {
    const yes = Data.toNumber(row.Yes_Votes);
    const no = Data.toNumber(row.No_Votes);
    const validVotes = yes + no;
    const barHost = document.createElement('div');
    els.unitSummary.appendChild(barHost);
    renderYesNoBar(barHost, {
      yes,
      no,
      validVotes,
      yesPercent: validVotes > 0 ? (yes / validVotes) * 100 : 0,
      noPercent: validVotes > 0 ? (no / validVotes) * 100 : 0,
    });

    const info = document.createElement('p');
    info.className = 'ref-bar-legend';
    info.textContent = '100% declared';
    els.unitSummary.appendChild(info);
  } else {
    const p = document.createElement('p');
    p.textContent = 'Result not yet declared for this precinct.';
    els.unitSummary.appendChild(p);
  }
}

function renderPrecinctTableForCounty(countyCode, opts = {}) {
  els.precinctList.innerHTML = '';
  if (!countyCode) return;
  const precincts = Data.getPrecinctsForCounty(shapeIndex, countyCode);

  const table = document.createElement('table');
  table.className = 'data-table ref-drill-table';
  table.innerHTML = '<thead><tr><th>Precinct</th><th>Yes</th><th>No</th><th>Lean</th><th>Status</th></tr></thead>';
  const tbody = document.createElement('tbody');

  for (const precinct of precincts) {
    const row = precinctRowById.get(precinct.Shape_ID);
    const status = row ? Data.computeStatus(row, NOW) : Data.STATUS.NOT_RECEIVED;
    const declared = status === Data.STATUS.DECLARED;
    const yes = declared && row ? Data.toNumber(row.Yes_Votes) : null;
    const no = declared && row ? Data.toNumber(row.No_Votes) : null;
    const validVotes = (yes || 0) + (no || 0);
    const yesPct = declared && validVotes > 0 ? (yes / validVotes) * 100 : null;
    const noPct = declared && validVotes > 0 ? (no / validVotes) * 100 : null;

    const tr = document.createElement('tr');
    tr.dataset.clickable = 'true';
    if (opts.highlight === precinct.Shape_ID) tr.style.fontWeight = '700';
    tr.addEventListener('click', () => {
      selectUnit({ level: 'precinct', id: precinct.Shape_ID }).catch((err) => reportError('Precinct row click', err));
    });

    const tdId = document.createElement('td');
    tdId.textContent = precinct.Shape_ID;

    const tdYes = document.createElement('td');
    tdYes.textContent = yes != null ? fmtInt(yes) : '—';

    const tdNo = document.createElement('td');
    tdNo.textContent = no != null ? fmtInt(no) : '—';

    const tdLean = document.createElement('td');
    tdLean.appendChild(renderLeanBar(yesPct, noPct));

    const tdStatus = document.createElement('td');
    tdStatus.appendChild(statusBadge(status));

    tr.append(tdId, tdYes, tdNo, tdLean, tdStatus);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  els.precinctList.appendChild(table);
}

/**
 * Compact Yes/No proportion bar for the drill tables' "Lean" column -- a
 * scaled-down `renderYesNoBar`, percentage-labeled but without a vote
 * count (the Yes/No columns next to it already carry the exact votes).
 * Renders an empty neutral strip if there's nothing declared yet.
 * @param {number|null} yesPercent
 * @param {number|null} noPercent
 */
function renderLeanBar(yesPercent, noPercent) {
  const bar = document.createElement('div');
  bar.className = 'ref-lean-bar';
  if (yesPercent == null || noPercent == null) return bar;
  const yesSeg = document.createElement('span');
  yesSeg.className = 'ref-lean-bar__seg ref-lean-bar__seg--yes';
  yesSeg.style.width = `${yesPercent}%`;
  yesSeg.textContent = yesPercent >= 20 ? `Yes ${fmtPct(yesPercent)}` : '';
  yesSeg.title = `Yes ${fmtPct(yesPercent)}`;
  const noSeg = document.createElement('span');
  noSeg.className = 'ref-lean-bar__seg ref-lean-bar__seg--no';
  noSeg.style.width = `${noPercent}%`;
  noSeg.textContent = noPercent >= 20 ? `No ${fmtPct(noPercent)}` : '';
  noSeg.title = `No ${fmtPct(noPercent)}`;
  bar.append(yesSeg, noSeg);
  return bar;
}

/**
 * Status cell for an aggregate drill-table row (Authority/County/
 * Constituency -- not a single precinct, which already has its own real
 * status badge). Once electorate-weighted `percentDeclared` reaches 100,
 * shows the same green "Declared" badge the rest of the site uses rather
 * than a redundant "100.0% in".
 * @param {number} percentDeclared
 */
function renderStatusCell(percentDeclared) {
  const td = document.createElement('td');
  if (percentDeclared >= 100) {
    td.appendChild(statusBadge(Data.STATUS.DECLARED));
  } else {
    td.textContent = `${fmtPct(percentDeclared)} in`;
  }
  return td;
}

/**
 * Shared Authority/County drill table: Authority/County | Yes | No | Lean |
 * Status. `entries` is `{id, s}[]` where `s` is that unit's referendum
 * summary result, or `null` if its fetch failed (rendered as an empty row
 * rather than throwing -- the same fallback both callers already had before
 * this was factored out into one function).
 * @param {string} idHeader 'Authority' or 'County'
 * @param {Array<{id:string, s:Object|null}>} entries
 * @param {(id:string) => void} onRowClick
 */
function renderDrillTable(idHeader, entries, onRowClick) {
  const table = document.createElement('table');
  table.className = 'data-table ref-drill-table';
  table.innerHTML = `<thead><tr><th>${idHeader}</th><th>Yes</th><th>No</th><th>Lean</th><th>Status</th></tr></thead>`;
  const tbody = document.createElement('tbody');

  for (const { id, s } of entries) {
    const hasVotes = !!s && s.summary.validVotes > 0;

    const tr = document.createElement('tr');
    tr.dataset.clickable = 'true';
    tr.addEventListener('click', () => onRowClick(id));

    const tdId = document.createElement('td');
    tdId.textContent = id;

    const tdYes = document.createElement('td');
    tdYes.textContent = hasVotes ? fmtInt(s.summary.yes) : '—';

    const tdNo = document.createElement('td');
    tdNo.textContent = hasVotes ? fmtInt(s.summary.no) : '—';

    const tdLean = document.createElement('td');
    tdLean.appendChild(renderLeanBar(hasVotes ? s.summary.yesPercent : null, hasVotes ? s.summary.noPercent : null));

    const tdStatus = renderStatusCell(s ? s.statusSummary.percentDeclared : 0);

    tr.append(tdId, tdYes, tdNo, tdLean, tdStatus);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  return table;
}

async function renderCountyTableForAuthority(authorityName, seq) {
  const counties = Data.getCountiesForAuthority(shapeIndex, authorityName)
    .slice()
    .sort((a, b) => a.County.localeCompare(b.County));

  const summaries = await Promise.all(counties.map((c) => Data.getAlmaValeReferendumForCounty(c.County, NOW).catch(() => null)));
  if (seq !== undefined && seq !== renderSeq) return; // superseded while awaiting -- see renderUnitSummaryAndList's seq guard

  const entries = counties.map((c, i) => ({ id: c.County, s: summaries[i] }));
  const table = renderDrillTable('County', entries, (id) => {
    selectUnit({ level: 'county', id }).catch((err) => reportError('County row click', err));
  });
  els.precinctList.innerHTML = '';
  els.precinctList.appendChild(table);
}

async function renderAuthorityTable(seq) {
  const authorities = [...shapeIndex.authorities].sort((a, b) => a.Authority.localeCompare(b.Authority));

  const summaries = await Promise.all(
    authorities.map((a) => Data.getAlmaValeReferendumForAuthority(a.Authority, NOW).catch(() => null))
  );
  if (seq !== undefined && seq !== renderSeq) return; // superseded while awaiting -- see renderUnitSummaryAndList's seq guard

  const entries = authorities.map((a, i) => ({ id: a.Authority, s: summaries[i] }));
  const table = renderDrillTable('Authority', entries, (id) => {
    selectUnit({ level: 'authority', id }).catch((err) => reportError('Authority row click', err));
  });
  els.precinctList.innerHTML = '';
  els.precinctList.appendChild(table);
}

// ---------------------------------------------------------------------
// Functional (GeneralDirect) section: flat table, never a map (Section 5).
// ---------------------------------------------------------------------

function renderFunctionalTable(data) {
  const host = document.getElementById('referendum-functional-table');
  host.innerHTML = '';

  const table = document.createElement('table');
  table.className = 'data-table ref-drill-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Constituency</th>
        <th>Yes</th>
        <th>No</th>
        <th>Lean</th>
        <th>Status</th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');

  let rowIndex = 0;
  for (const seat of data.seats) {
    rowIndex++;
    const expandable = Array.isArray(seat.subRows) && seat.subRows.length > 0;
    const subRowId = `ref-functional-subrow-${rowIndex}`;
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    if (expandable) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'expand-toggle';
      btn.textContent = '▸';
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-controls', subRowId);
      btn.style.marginRight = '0.4rem';
      btn.addEventListener('click', () => {
        const detailRow = document.getElementById(subRowId);
        const isHidden = detailRow.classList.toggle('hidden');
        btn.textContent = isHidden ? '▸' : '▾';
        btn.setAttribute('aria-expanded', String(!isHidden));
      });
      tdName.appendChild(btn);
    }
    tdName.appendChild(document.createTextNode(seat.constituency));

    const hasVotes = seat.summary.validVotes > 0;

    const tdYes = document.createElement('td');
    tdYes.textContent = hasVotes ? fmtInt(seat.summary.yes) : '—';

    const tdNo = document.createElement('td');
    tdNo.textContent = hasVotes ? fmtInt(seat.summary.no) : '—';

    const tdLean = document.createElement('td');
    tdLean.appendChild(renderLeanBar(hasVotes ? seat.summary.yesPercent : null, hasVotes ? seat.summary.noPercent : null));

    const tdStatus = renderStatusCell(seat.statusSummary.percentDeclared);

    tr.append(tdName, tdYes, tdNo, tdLean, tdStatus);
    tbody.appendChild(tr);

    if (expandable) {
      const detailTr = document.createElement('tr');
      detailTr.id = subRowId;
      detailTr.className = 'subrow-detail hidden';
      const td = document.createElement('td');
      td.colSpan = 5;
      td.appendChild(functionalSubRowTable(seat.subRows));
      detailTr.appendChild(td);
      tbody.appendChild(detailTr);
    }
  }

  tbody.appendChild(functionalTotalRow(data));

  table.appendChild(tbody);
  host.appendChild(table);
}

/**
 * Total row across all top-level General Direct constituencies (not the
 * expanded Sub_Constituency rows, which are already folded into their
 * parent seat's own Yes/No). Reuses `aggregateGeneralDirect()` -- the same
 * aggregate already backing the "General Direct" summary card up top -- so
 * the two totals can never drift apart from each other.
 * @param {Object} data sectionResults.GeneralDirect
 */
function functionalTotalRow(data) {
  const agg = aggregateGeneralDirect(data);
  const hasVotes = agg.summary.validVotes > 0;

  const tr = document.createElement('tr');
  tr.className = 'ref-total-row';

  const tdName = document.createElement('td');
  tdName.textContent = 'Total';

  const tdYes = document.createElement('td');
  tdYes.textContent = hasVotes ? fmtInt(agg.summary.yes) : '—';

  const tdNo = document.createElement('td');
  tdNo.textContent = hasVotes ? fmtInt(agg.summary.no) : '—';

  const tdLean = document.createElement('td');
  tdLean.appendChild(renderLeanBar(hasVotes ? agg.summary.yesPercent : null, hasVotes ? agg.summary.noPercent : null));

  const tdStatus = renderStatusCell(agg.percentDeclared);

  tr.append(tdName, tdYes, tdNo, tdLean, tdStatus);
  return tr;
}

/** Named Sub_Constituency Yes/No breakdown for an expanded General Direct referendum row. */
function functionalSubRowTable(subRows) {
  const table = document.createElement('table');
  table.className = 'data-table ref-drill-table subrow-table';
  table.innerHTML = '<thead><tr><th>Sub_Constituency</th><th>Yes</th><th>No</th><th>Lean</th><th>Status</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const sub of subRows) {
    const hasVotes = sub.summary.validVotes > 0;
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = sub.subConstituency || '(unnamed)';
    const tdYes = document.createElement('td');
    tdYes.textContent = hasVotes ? fmtInt(sub.summary.yes) : '—';
    const tdNo = document.createElement('td');
    tdNo.textContent = hasVotes ? fmtInt(sub.summary.no) : '—';
    const tdLean = document.createElement('td');
    tdLean.appendChild(renderLeanBar(hasVotes ? sub.summary.yesPercent : null, hasVotes ? sub.summary.noPercent : null));
    const tdStatus = renderStatusCell(sub.statusSummary.percentDeclared);
    tr.append(tdName, tdYes, tdNo, tdLean, tdStatus);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

// ---------------------------------------------------------------------
// Errors panel
// ---------------------------------------------------------------------

function renderErrors() {
  const el = document.getElementById('referendum-errors');
  if (errors.length === 0) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = '<h3>Some sections did not load fully</h3>';
  const ul = document.createElement('ul');
  for (const e of errors) {
    const li = document.createElement('li');
    li.textContent = e;
    ul.appendChild(li);
  }
  el.appendChild(ul);
}

function renderFatalError() {
  const el = document.getElementById('referendum-header');
  el.innerHTML =
    '<h1>Referendum</h1><p>Failed to load referendum data. Check the console, and confirm the site is being ' +
    'served over http(s) (not file://) with data/ reachable -- see BUILD_NOTES.md.</p>';
  renderErrors();
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

async function main() {
  renderNav(document.getElementById('nav'), 'referendum.html');
  await loadAndRenderReferendum();
}

/**
 * Everything else main() used to do, factored out so the "Reload results"
 * button (reloadControl(), wired into renderHeaderSkeleton()) can re-run it
 * on its own without re-invoking renderNav (nav.js's renderNav appends into
 * #nav rather than replacing its contents, so it must only run once --
 * calling it again would stack a second nav bar). Every section this
 * function touches (header, summary cards, geo panel, functional table) is
 * rebuilt via `.innerHTML = ''` + fresh children, so repeat calls are safe.
 * @param {{forceRefresh?: boolean}} [opts] forceRefresh clears every cache
 *   (data.js's refreshAllData()) so the fetch actually hits the network
 *   again instead of replaying old data, and clears the accumulated
 *   `errors` list from any previous load.
 */
async function loadAndRenderReferendum(opts = {}) {
  if (opts.forceRefresh) {
    Data.refreshAllData();
  }
  errors.length = 0;

  try {
    referendumMeta = await Data.loadReferendumMeta();
  } catch (err) {
    reportError('Failed to load referendum_meta.json', err);
    renderFatalError();
    return;
  }

  // Section 5: which seat types feed this referendum is read from the
  // manifest, not hardcoded -- everything below only renders/queries a
  // section if its seat type is actually present in seat_types[].
  seatTypeIds = new Set((referendumMeta.seat_types || []).map((st) => st.id));

  lastLoadedAt = new Date();
  renderHeaderSkeleton();

  const sectionResults = {};
  const tasks = [];

  if (seatTypeIds.has('AlmaVale')) {
    tasks.push(
      Data.getAlmaValeReferendumResults(NOW)
        .then((r) => {
          sectionResults.AlmaVale = r;
        })
        .catch((err) => reportError('AlmaVale referendum results', err))
    );
  }
  if (seatTypeIds.has('GeneralDirect')) {
    tasks.push(
      Data.getGeneralDirectReferendumResults(NOW)
        .then((r) => {
          sectionResults.GeneralDirect = r;
        })
        .catch((err) => reportError('GeneralDirect referendum results', err))
    );
  }
  await Promise.all(tasks);

  renderSectionSummaries(sectionResults);

  if (sectionResults.AlmaVale) {
    almaValeData = sectionResults.AlmaVale;
    precinctRowById = new Map(almaValeData.precinctRows.map((r) => [r.Shape_ID, r]));
    try {
      shapeIndex = await Data.getShapeIndex();
      document.getElementById('referendum-geo').hidden = false;
      await initGeoSection();
    } catch (err) {
      reportError('Geographic (Alma Vale) section', err);
    }
  }

  if (sectionResults.GeneralDirect) {
    try {
      document.getElementById('referendum-functional').hidden = false;
      renderFunctionalTable(sectionResults.GeneralDirect);
    } catch (err) {
      reportError('Functional (General Direct) section', err);
    }
  }

  renderErrors();
}

main().catch((err) => {
  reportError('Unhandled page error', err);
  renderErrors();
});
