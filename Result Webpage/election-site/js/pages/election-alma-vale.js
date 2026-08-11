/**
 * election-alma-vale.js — Alma Vale seat-type page (40 seats, one per
 * constituency, Supplementary Vote). FEATURE_SPEC.md Section 4's seat list,
 * grouped/sorted per Section 1's presentation-order rule.
 *
 * `Data.getAlmaValeSeats()` already returns seats in `orderConstituencies()`
 * order and stamps `region`/`constituencyCode` on each summary (see
 * results.js), so this page groups by consecutive `region` rather than
 * re-deriving the order itself.
 *
 * Geo layout (map + right-hand drill-down panel) mirrors referendum.html's
 * `.ref-geo-layout` (BUILD_NOTES.md's referendum-page overhaul) — a
 * County/District toggle, a shared 1st/2nd-Pref toggle (`listPrefView`,
 * below it) that drives the map's own hover tooltip AND this page's own
 * "vote result for the selected polygon" panel AND the clickable summary
 * list all at once, and that summary list itself drilling the map without
 * needing to click the SVG. This page's own CSS equivalent of `.ref-geo-*`
 * is `.egeo-*` (css/results.css) — not shared with referendum.css since the
 * two page families don't link each other's stylesheets (BUILD_NOTES.md's
 * file ownership split).
 */

import * as Data from '../data.js';
import {
  formatNumber,
  formatPercent,
  formatTurnout,
  statusBadge,
  isResultCertain,
  partyPill,
  seatDetailHref,
  dominantStatus,
  spectrumColor,
  spectrumSummaryRow,
  renderError,
  el,
  mapToggleControls,
  mountElectionMapDefensively,
  currentMapMode,
} from './election-common.js';
import { statusLinesHtml, aggregateStatusLabel } from '../map/resultsTable.js';
import { renderNav, renderBreadcrumbs } from '../nav.js';

let mapHandle = null;
let shapeIndex = null;
let participationRows = null;
let electionMeta = null;
let seatsGlobal = [];
let seatByConstituency = new Map();

const els = {};
const drill = { level: 'top', constituency: null, secondId: null, precinctId: null };
const seatDetailCache = new Map(); // constituency -> Promise<seat detail> (mirrors electionMap.js's own cache)

// '1st' | '2nd' -- ONE shared toggle (controls area, below the
// County/District toggle) driving FOUR things at once, so "1st Pref" and
// "2nd Pref (actual)" always mean the same choice everywhere on the page --
// there used to be a second, independent "Display (1st Round)"/"Display
// (2nd Round)" toggle for the map's own fill colors, merged into this one
// button pair since the two were never meant to disagree:
//  - the map's own hover tooltip (electionMap.js's `setResultView`),
//  - the map's own shape fill COLORS (`setColorMode` -- '1st' ->
//    'first-round', '2nd' -> 'actual'; every level still computes and shows
//    its OWN independent result either way, never deferring to a parent/
//    child unit -- see electionMap.js's `colorForUnitSv`/`colorForPrecinct`
//    doc comments),
//  - the unit-summary box's round table,
//  - and the summary list's Left/MR/Right columns.
// '2nd' always means the ACTUAL settled tally/result (a copy of round1 when
// no runoff was needed, the real round2 once certain, "Undecided" while
// neither is true yet for the list, a 3-column what-if-eliminated table for
// the summary box, or -- for the map's colors -- each shape's own
// forced-elimination round2 winner, unconditional on certainty since a
// single shape's own SV computation is never itself a "might still flip"
// guess the way a list label's certainty-gated figure would be).
//
// DEFAULTS to '1st' while fewer than 20 of the 40 Alma Vale seats have a
// DECLARED WINNER -- `certainty.resultCertain`, the SAME "has this seat
// declared" gate `isResultCertain()` uses everywhere else on this page (a
// seat can be certain well before its own `percentDeclared` hits 100 --
// that's the whole point of the margin-safe certainty rule; 100%-counted is
// a much stricter, different fact and would undercount) -- computed fresh
// on every `loadAndRenderPage()` (`applyDefaultPrefView()` below). With that
// few seats decided, most "actual"/2nd-round figures would themselves be
// forced-elimination guesses off a handful of precincts, so the plain
// 1st-preference figure is the more honest default early on; once at least
// half the seats have a declared winner, '2nd' becomes the default instead.
// Only a DEFAULT -- never overrides an explicit click on the toggle
// (`listPrefViewUserSet` below), including across "Reload results".
let listPrefView = '1st';
let listPrefViewUserSet = false;

/** This toggle's own 'first-round'/'actual' spelling for `mapHandle.setColorMode`/`mountElectionMapDefensively`'s `colorMode` option. */
function mapColorModeFor(view) {
  return view === '2nd' ? 'actual' : 'first-round';
}

/**
 * Recomputes `listPrefView`'s default from the current seat data, per its
 * own doc comment -- called once per `loadAndRenderPage()`, before the
 * toggle/map are built, so both start in sync with whichever view ends up
 * default. No-op once the user has clicked the toggle themselves
 * (`listPrefViewUserSet`) -- a reload shouldn't silently revert an explicit
 * choice.
 * @param {Array<Object>} seats `Data.getAlmaValeSeats()` result (40 seats)
 */
function applyDefaultPrefView(seats) {
  if (listPrefViewUserSet) return;
  const declaredCount = seats.filter((s) => isResultCertain(s)).length;
  listPrefView = declaredCount < 20 ? '1st' : '2nd';
}

// Monotonic guard against out-of-order async renders (same pattern as
// referendum.js's renderSeq) — a click can re-enter renderPanel() while a
// previous call's awaited fetch is still pending.
let renderSeq = 0;

// Timestamp of the load that's currently on screen -- read by reloadControl()
// when it's (re)built as part of loadAndRenderPage()'s own frag, so the
// button always reflects the load it belongs to.
let lastLoadedAt = null;

const content = document.getElementById('content');

async function main() {
  renderNav(document.getElementById('nav'), 'election-alma-vale.html');
  renderBreadcrumbs(document.getElementById('breadcrumbs'), [
    { label: 'General Election', href: 'index.html' },
    { label: 'Alma Vale' },
  ]);
  await loadAndRenderPage();
}

/**
 * Everything else main() used to do, factored out so the "Reload results"
 * button (reloadControl()) can re-run it on its own -- renderNav/
 * renderBreadcrumbs above append into #nav/#breadcrumbs rather than
 * replacing their contents (nav.js), so they must only ever run once; this
 * function only ever replaces #content's children (or a mount div rebuilt
 * fresh underneath it), which is safe to repeat any number of times.
 * @param {{forceRefresh?: boolean}} [opts] forceRefresh clears every cache
 *   (data.js's refreshAllData() + this page's own seatDetailCache) so the
 *   fetch actually hits the network again instead of replaying old data.
 */
async function loadAndRenderPage(opts = {}) {
  if (opts.forceRefresh) {
    seatDetailCache.clear();
    Data.refreshAllData();
  }

  const [seats, meta, shapeIdx, partRows] = await Promise.all([
    Data.getAlmaValeSeats(),
    Data.loadElectionMeta(),
    Data.getShapeIndex(),
    Data.loadPartyParticipation(),
  ]);
  seatsGlobal = seats;
  electionMeta = meta;
  shapeIndex = shapeIdx;
  participationRows = partRows;
  seatByConstituency = new Map(seats.map((s) => [s.constituency, s]));
  applyDefaultPrefView(seats);
  document.title = 'Alma Vale — Results';
  lastLoadedAt = new Date();

  const frag = document.createDocumentFragment();
  const headerReload = reloadControl();
  els.headerReload = headerReload;
  frag.appendChild(
    el('div', { className: 'page-header' }, [
      el('div', {}, [
        el('h1', { text: 'Alma Vale' }),
        el('div', { className: 'page-header__meta', text: '40 seats' }),
      ]),
      headerReload,
    ])
  );

  // Vote-share bar (same spectrum-colored bar as the home page), with each
  // segment's own decided-seat count shown inline and, below the bar, each
  // segment's total votes + vote-share percentage in small grey text.
  frag.appendChild(voteShareBar(electionMeta, seats, partRows));

  // Geo layout: map (left) + drill-down panel (right — toggle, selected-
  // polygon result, clickable summary list). See file doc comment.
  frag.appendChild(sectionTitle('Constituency map'));
  frag.appendChild(buildGeoLayout());

  // Full detail table (every seat's Electorate/Vote/Turnout/per-spectrum
  // Final+1st/Spoil/Status) stays below as its own section, same role
  // referendum.html's General Direct flat table plays alongside its own
  // geo layout — a complete list next to a lighter, map-driven one. Two
  // tickboxes above it toggle the Electorate/Vote/Turnout columns and the
  // Spoil column on/off (see `columnToggleControls`/`fullResultsTable`).
  frag.appendChild(sectionTitle('Full results by constituency'));
  const spectrumColumns = (electionMeta.spectrums || []).map((s) => ({ id: s.id, label: s.id }));
  frag.appendChild(fullResultsTable(seats, electionMeta, spectrumColumns));

  content.replaceChildren(frag);

  mapHandle = await mountElectionMapDefensively(els.mapMount, {
    resultView: listPrefView,
    colorMode: mapColorModeFor(listPrefView),
    onUnitClick: (unit) => {
      if (!unit || !unit.level) return;
      selectUnit(unit, { fromMap: true }).catch((err) => console.error('[election-alma-vale] onUnitClick:', err));
    },
  });
  relocateReloadControlIntoMap();

  await selectUnit({ level: 'top' });
}

/**
 * Moves the (already-mounted) "Reload results" control from the page
 * header into the map's own toolbar, once `mountElectionMapDefensively()`
 * has confirmed a `.map-toolbar` actually exists -- relocates the same DOM
 * node (not a copy), so its click listener/state stay intact. Left in the
 * header (where `loadAndRenderPage()` puts it) whenever the map itself
 * never mounts (js/map/electionMap.js unavailable), so the button never
 * disappears.
 */
function relocateReloadControlIntoMap() {
  const toolbar = els.mapMount && els.mapMount.querySelector('.map-toolbar');
  if (toolbar && els.headerReload) toolbar.appendChild(els.headerReload);
}

/**
 * "Reload results" button + last-updated/error status text, rebuilt fresh
 * on every loadAndRenderPage() call (it's part of the page-header inside
 * `frag`, so a stale button never lingers). Clicking it clears every cache
 * (data.js's refreshAllData() + this page's own seatDetailCache, see
 * loadAndRenderPage) and re-runs the full load+render sequence in place --
 * no page navigation/reload needed to pick up updated data/* files.
 */
function reloadControl() {
  const wrap = el('div', { className: 'reload-control' });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'reload-btn';
  btn.textContent = 'Reload results';
  const status = el('span', {
    className: 'reload-status page-header__meta',
    text: lastLoadedAt ? `Updated ${lastLoadedAt.toLocaleTimeString()}` : '',
  });
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Reloading…';
    status.textContent = '';
    status.classList.remove('reload-status--error');
    loadAndRenderPage({ forceRefresh: true }).catch((err) => {
      console.error('[election-alma-vale] reload failed:', err);
      btn.disabled = false;
      btn.textContent = 'Reload results';
      status.classList.add('reload-status--error');
      status.textContent = `Reload failed: ${err && err.message ? err.message : err}`;
    });
  });
  wrap.append(btn, status);
  return wrap;
}

// ---------------------------------------------------------------------
// Geo layout: map + right-hand drill-down panel
// ---------------------------------------------------------------------

function buildGeoLayout() {
  const layout = el('div', { className: 'egeo-layout' });

  const mapMount = document.createElement('div');
  mapMount.id = 'map-mount';
  mapMount.textContent = 'Loading map…';
  layout.appendChild(mapMount);
  els.mapMount = mapMount;

  const panel = el('div', { className: 'egeo-panel' });

  const controls = el('div', { className: 'egeo-controls card' });
  const controlsTopRow = el('div', { className: 'egeo-controls__row' });
  controlsTopRow.appendChild(
    mapToggleControls((mode) => {
      if (mapHandle && mapHandle.setMode) mapHandle.setMode(mode);
      onModeChanged();
    })
  );
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'egeo-controls__reset';
  resetBtn.textContent = 'Reset to top view';
  resetBtn.addEventListener('click', () => {
    selectUnit({ level: 'top' }).catch((err) => console.error('[election-alma-vale] reset:', err));
  });
  controlsTopRow.appendChild(resetBtn);
  controls.appendChild(controlsTopRow);

  const prefToggle = buildPrefToggle();
  controls.appendChild(prefToggle);
  els.prefToggle = prefToggle;

  panel.appendChild(controls);

  const unitSummary = el('div', { className: 'egeo-unit-summary' });
  panel.appendChild(unitSummary);
  els.unitSummary = unitSummary;

  const unitList = el('div', { className: 'egeo-list' });
  panel.appendChild(unitList);
  els.unitList = unitList;

  layout.appendChild(panel);
  return layout;
}

/**
 * "1st Pref" / "2nd Pref (actual)" toggle -- see `listPrefView`'s doc
 * comment for the four things it drives at once (including the map's own
 * fill colors, via `mapColorModeFor()` -- there used to be a second,
 * separate "Display (1st Round)"/"Display (2nd Round)" toggle for just
 * that, merged into this single button pair since the two were never meant
 * to disagree). Lives in the controls card, right below the County/District
 * toggle.
 */
function buildPrefToggle() {
  const wrap = el('div', { className: 'egeo-pref-toggle' });
  for (const view of ['1st', '2nd']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'egeo-pref-toggle__btn';
    btn.textContent = view === '1st' ? '1st Pref' : '2nd Pref (actual)';
    btn.dataset.view = view;
    btn.setAttribute('aria-pressed', String(view === listPrefView));
    btn.addEventListener('click', () => {
      listPrefViewUserSet = true;
      if (listPrefView === view) return;
      listPrefView = view;
      syncPrefToggleButtons();
      if (mapHandle && mapHandle.setResultView) mapHandle.setResultView(view);
      if (mapHandle && mapHandle.setColorMode) mapHandle.setColorMode(mapColorModeFor(view));
      renderPanel().catch((err) => console.error('[election-alma-vale] pref view change:', err));
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

function syncPrefToggleButtons() {
  if (!els.prefToggle) return;
  for (const btn of els.prefToggle.children) {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === listPrefView));
  }
}

/** Mode toggled: the map itself collapses any active second/precinct unit back to constituency level (electionMap.js's setMode) — mirror that here so the panel doesn't show a now-stale drilled-in unit. */
function onModeChanged() {
  if (drill.level === 'second' || drill.level === 'precinct') {
    drill.level = drill.constituency ? 'constituency' : 'top';
    drill.secondId = null;
    drill.precinctId = null;
  }
  renderPanel().catch((err) => console.error('[election-alma-vale] mode change render:', err));
}

/**
 * Drill-state transition, mirroring referendum.js's `selectUnit`. `unit` is
 * either `{level:'top'}` or the map component's own onUnitClick payload
 * shape (`{level, id, constituency?, mode?}` — see BUILD_NOTES.md's map
 * component contract).
 */
async function selectUnit(unit, opts = {}) {
  const level = unit && unit.level;

  if (level === 'top') {
    drill.level = 'top';
    drill.constituency = null;
    drill.secondId = null;
    drill.precinctId = null;
  } else if (level === 'constituency') {
    drill.level = 'constituency';
    drill.constituency = unit.id;
    drill.secondId = null;
    drill.precinctId = null;
  } else if (level === 'second') {
    drill.level = 'second';
    drill.secondId = unit.id;
    drill.precinctId = null;
    if (unit.constituency) drill.constituency = unit.constituency;
  } else if (level === 'precinct') {
    drill.level = 'precinct';
    drill.precinctId = unit.id;
    if (unit.constituency) drill.constituency = unit.constituency;
    if (!drill.secondId) {
      const precinct = shapeIndex.polygonById.get(unit.id);
      if (precinct) {
        drill.secondId =
          currentMapMode() === 'county' ? precinct.County : (Data.getDistrictFragmentForPrecinct(shapeIndex, precinct) || {})._fragmentId || null;
      }
    }
  } else {
    return;
  }

  if (mapHandle && !opts.fromMap) {
    try {
      if (level === 'top') mapHandle.reset();
      else mapHandle.drillTo(level, unit.id);
    } catch (err) {
      console.error('[election-alma-vale] map.reset/drillTo:', err);
    }
  }

  await renderPanel();
}

/**
 * Switch which drill LEVEL is showing without changing what's selected at
 * each level (unlike `selectUnit`, which always clears anything deeper) --
 * lets the "jump to Constituency / County / Precinct" buttons below restore
 * a previously-drilled precinct/second unit instead of forgetting it.
 * @param {'constituency'|'second'|'precinct'} level
 */
async function switchLevel(level) {
  if (level === drill.level) return;
  if (level === 'constituency' && !drill.constituency) return;
  if (level === 'second' && !drill.secondId) return;
  if (level === 'precinct' && !drill.precinctId) return;

  drill.level = level;

  if (mapHandle) {
    try {
      if (level === 'constituency') mapHandle.drillTo('constituency', drill.constituency);
      else if (level === 'second') mapHandle.drillTo('second', drill.secondId);
      else if (level === 'precinct') mapHandle.drillTo('precinct', drill.precinctId);
    } catch (err) {
      console.error('[election-alma-vale] switchLevel drillTo:', err);
    }
  }

  await renderPanel();
}

/**
 * "Jump to" level buttons for the unit-summary box: Constituency/County
 * (or District)/Precinct when three levels deep, just Constituency/County
 * (or District) when two levels deep -- null (nothing rendered) at the top
 * or constituency level, where there's nothing deeper to jump between yet.
 */
function levelSwitchButtons() {
  if (drill.level !== 'second' && drill.level !== 'precinct') return null;
  const mode = currentMapMode();
  const secondLabel = mode === 'county' ? 'County' : 'District';
  const levels =
    drill.level === 'precinct'
      ? [['constituency', 'Constituency'], ['second', secondLabel], ['precinct', 'Precinct']]
      : [['constituency', 'Constituency'], ['second', secondLabel]];

  const wrap = el('div', { className: 'egeo-level-switch' });
  for (const [lvl, label] of levels) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'egeo-level-switch__btn';
    btn.textContent = label;
    const active = lvl === drill.level;
    btn.setAttribute('aria-pressed', String(active));
    if (active) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => switchLevel(lvl).catch((err) => console.error('[election-alma-vale] level switch:', err)));
    }
    wrap.appendChild(btn);
  }
  return wrap;
}

async function renderPanel() {
  const seq = ++renderSeq;
  els.unitSummary.textContent = 'Loading…';
  els.unitList.innerHTML = '';

  if (drill.level === 'precinct') {
    await renderPrecinctSummary(drill.precinctId, drill.constituency);
    if (seq !== renderSeq) return;
    finalizeUnitSummary();
    await renderPrecinctList(drill.constituency, drill.secondId, seq, { highlight: drill.precinctId });
    return;
  }

  if (drill.level === 'second') {
    await renderSecondSummary(drill.constituency, drill.secondId);
    if (seq !== renderSeq) return;
    finalizeUnitSummary();
    await renderPrecinctList(drill.constituency, drill.secondId, seq);
    return;
  }

  if (drill.level === 'constituency') {
    renderConstituencySummary(drill.constituency);
    finalizeUnitSummary();
    await renderSecondList(drill.constituency, seq);
    return;
  }

  renderTopSummary();
  finalizeUnitSummary();
  renderConstituencyList();
}

// ---------------------------------------------------------------------
// Mobile "bottom sheet" presentation (css/mobile.css, phone widths only) --
// once a unit deeper than the top level is selected, `.egeo-unit-summary`
// gets a `--sheet` modifier that CSS turns into a floating card pinned to
// the bottom of the screen (NYT-style tap-a-region-for-a-card interaction),
// instead of the plain in-flow panel box it already is on desktop / at the
// top level. A small close (X) button (only present while the sheet is up)
// returns to the top-level view. Purely additive DOM/class changes -- they
// have zero visual effect above mobile.css's 768px breakpoint, since
// nothing outside that media query reacts to the `--sheet` class or the
// `.egeo-unit-summary__close` button.
// ---------------------------------------------------------------------
function finalizeUnitSummary() {
  const isSheet = drill.level !== 'top';
  els.unitSummary.classList.toggle('egeo-unit-summary--sheet', isSheet);
  if (!isSheet) return;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'egeo-unit-summary__close';
  closeBtn.setAttribute('aria-label', 'Close, back to Alma Vale overview');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => {
    selectUnit({ level: 'top' }).catch((err) => console.error('[election-alma-vale] sheet close:', err));
  });
  els.unitSummary.insertBefore(closeBtn, els.unitSummary.firstChild);
}

// ---------------------------------------------------------------------
// "Vote result for a polygon" — the panel's unit-summary box:
// `renderRoundBody` (below) switches between a plain 1st-preference
// breakdown and the combined hypothetical-runoff table depending on the
// shared `listPrefView` toggle, plus `statusLinesHtml` (js/map/resultsTable.js,
// the same Turnout/Status lines the map's own hover tooltip uses).
// ---------------------------------------------------------------------

function renderTopSummary() {
  els.unitSummary.innerHTML = '';
  els.unitSummary.appendChild(el('div', { className: 'egeo-unit-summary__title', text: 'Alma Vale' }));
  els.unitSummary.appendChild(
    el('p', {
      className: 'page-header__meta',
      text: 'Click a constituency on the map, or select one from the list below, to see its results.',
    })
  );
}

/**
 * Whether the constituency's real elimination (`eliminatedReal`) is safe to
 * treat as settled -- the SAME `participantsCertain`/`round1-majority` gate
 * `unitActualRunoff` (below) and `electionMap.js`'s `constituencyRoundTwoCertain`
 * use. `hypotheticalRunoffTable`/`titleSuffix` need this too, since they're
 * deciding the identical question (which, if any, of the 3 columns counts
 * as "the real one") from the same underlying fact.
 * @param {Object|null|undefined} certainty constituency seat's `certainty`
 * @param {string|null} eliminatedReal constituency seat's `eliminated`
 */
function runoffParticipantsCertain(certainty, eliminatedReal) {
  return !!(certainty && (eliminatedReal ? certainty.participantsCertain : certainty.stage === 'round1-majority'));
}

/**
 * Round-view dispatcher for the "vote result for a polygon" box: the plain
 * 1st-preference breakdown in '1st' view, or the combined 3-column
 * hypothetical-runoff table in '2nd' view (`listPrefView`, shared with the
 * map tooltip and summary list). Returns a "No votes counted yet." message
 * instead of either table if there's nothing to show yet.
 * @param {{round1:Object, totals:Object|null, eliminatedReal:string|null, certainty:Object|null, spoil:number, participation:Object|null}} data
 */
function renderRoundBody(data) {
  const totalValid1 = (data.round1.Left || 0) + (data.round1.MR || 0) + (data.round1.Right || 0);
  if (totalValid1 <= 0 && !data.spoil) {
    return el('p', { className: 'page-header__meta', text: 'No votes counted yet.' });
  }
  if (listPrefView === '1st') {
    const spectrumIds = electionMeta.spectrums.map((s) => s.id);
    const majoritySpectrum = spectrumIds.find((id) => (data.round1[id] || 0) > totalValid1 / 2) || null;
    return round1Table(data, totalValid1, majoritySpectrum);
  }
  return hypotheticalRunoffTable(data);
}

/**
 * Combined hypothetical-runoff table for '2nd' view: one row per party (+
 * Spoil/NIL), one column per possible 2-spectrum pairing (`Data.
 * computeHypotheticalRunoff` for each of the 3 possible eliminations) --
 * all 3 scenarios visible side by side instead of clicking through them one
 * at a time. Every column's own winner is bolded, hypothetical or not. If
 * `data.eliminatedReal` additionally matches one of the 3 eliminations AND
 * that elimination is itself certain (`runoffParticipantsCertain` above --
 * an actual runoff pairing is genuinely locked in, not just "currently
 * leading" off a partial count), that column stops being purely
 * speculative -- the caller (`titleSuffix`) drops the " (Hypothetical)"
 * suffix. The background tint in the winner's spectrum color is a further,
 * stricter gate on top of that: it only appears once the constituency's
 * overall result is ITSELF certain (`certainty.resultCertain`), because the
 * tint reads as "this is the actual outcome" -- a runoff pairing can be
 * locked in (who's in the final two) well before which of those two
 * actually wins is (see BUILD_NOTES.md's Supplementary Vote
 * declaration-certainty rework; `unitActualRunoff` below applies the exact
 * same two-stage gate to the summary list's bold/color).
 */
function hypotheticalRunoffTable(data) {
  const wrap = document.createElement('div');
  if (!data.totals) {
    wrap.appendChild(el('p', { className: 'page-header__meta', text: 'No votes counted yet.' }));
    return wrap;
  }

  const ids = ['Left', 'MR', 'Right'];
  const shortLabel = { Left: 'L', MR: 'MR', Right: 'R' };
  const pairs = [
    ['Left', 'MR'],
    ['Left', 'Right'],
    ['MR', 'Right'],
  ];
  const scenarios = pairs.map(([a, b]) => {
    const eliminated = ids.find((id) => id !== a && id !== b);
    return { a, b, eliminated, result: Data.computeHypotheticalRunoff(data.totals, eliminated) };
  });
  const participantsCertain = runoffParticipantsCertain(data.certainty, data.eliminatedReal);
  const realScenario = participantsCertain && data.eliminatedReal ? scenarios.find((s) => s.eliminated === data.eliminatedReal) : null;
  const realWinnerColor =
    realScenario && data.certainty && data.certainty.resultCertain && realScenario.result.winner
      ? spectrumColor(realScenario.result.winner)
      : null;

  const table = document.createElement('table');
  table.className = 'map-tooltip__table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(el('th', { text: 'Party' }));
  for (const s of scenarios) {
    const th = el('th', { text: `${shortLabel[s.a]}-${shortLabel[s.b]}` });
    if (s === realScenario && realWinnerColor) {
      th.style.background = realWinnerColor;
      th.style.color = '#fff';
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const spectrumId of ids) {
    const tr = document.createElement('tr');
    const tdParty = document.createElement('td');
    const dot = el('span', { className: 'map-tooltip__dot' });
    dot.style.background = spectrumColor(spectrumId);
    tdParty.appendChild(dot);
    tdParty.appendChild(document.createTextNode(partyAbbrevFor(data.participation, spectrumId)));
    tr.appendChild(tdParty);
    for (const s of scenarios) {
      const td = document.createElement('td');
      if (spectrumId === s.eliminated) {
        td.textContent = '0';
        td.className = 'page-header__meta';
      } else {
        td.textContent = formatNumber(s.result.round2[spectrumId] || 0);
        // Bold that scenario's own winner regardless of whether it's the
        // real column -- every hypothetical pairing gets its winner
        // highlighted, not just the (if any) real one.
        if (spectrumId === s.result.winner) td.style.fontWeight = '700';
      }
      if (s === realScenario && realWinnerColor) td.style.background = `${realWinnerColor}22`;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  const nilTr = document.createElement('tr');
  nilTr.className = 'map-tooltip__spoil-row';
  nilTr.appendChild(el('td', { text: 'Spoil / NIL' }));
  for (const s of scenarios) {
    const td = document.createElement('td');
    td.textContent = formatNumber((data.spoil || 0) + (s.result.nil || 0));
    if (s === realScenario && realWinnerColor) td.style.background = `${realWinnerColor}22`;
    nilTr.appendChild(td);
  }
  tbody.appendChild(nilTr);

  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/**
 * " (Hypothetical)" title suffix for '2nd' view when there's no CERTAIN
 * real elimination to anchor on yet -- either round1 already produced an
 * outright majority (no runoff, nothing to anchor on), or a runoff is
 * needed but which two spectrums make it isn't locked in yet
 * (`runoffParticipantsCertain`, same gate `hypotheticalRunoffTable` uses to
 * pick its own "real" column) -- in both cases every column in
 * `hypotheticalRunoffTable` is purely speculative (none of them is "what's
 * actually happening" yet). Empty string in '1st' view, or once a real,
 * certain elimination exists (that column gets highlighted instead -- see
 * `hypotheticalRunoffTable`).
 */
function titleSuffix(data) {
  if (listPrefView !== '2nd') return '';
  const totalValid1 = (data.round1.Left || 0) + (data.round1.MR || 0) + (data.round1.Right || 0);
  if (totalValid1 <= 0 && !data.spoil) return '';
  return runoffParticipantsCertain(data.certainty, data.eliminatedReal) && data.eliminatedReal ? '' : ' (Hypothetical)';
}

/**
 * Plain 1st-preference-shaped breakdown (Party | {roundLabel} Vote | Pct +
 * a Spoil row). `majoritySpectrum` bolds that row (Supplementary Vote's own
 * >50% rule); `highlightSpectrum` bolds a row for a different reason --
 * used by District mode's FPTP plurality winner, which is a genuine winner
 * once fully Declared but not necessarily a >50% majority. `roundLabel`
 * (default '1st') only changes the header text -- District mode has no
 * separate 2nd-round data, so '1st' and '2nd' Pref show the same numbers
 * here, just labeled to match whichever the shared toggle currently says.
 */
function round1Table(data, totalValid1, majoritySpectrum, highlightSpectrum, roundLabel = '1st') {
  const wrap = document.createElement('div');
  const table = document.createElement('table');
  table.className = 'map-tooltip__table';
  table.innerHTML = `<thead><tr><th>Party</th><th>${roundLabel} Vote</th><th>Pct</th></tr></thead>`;
  const tbody = document.createElement('tbody');

  const ordered = [...electionMeta.spectrums].sort((a, b) => (data.round1[b.id] || 0) - (data.round1[a.id] || 0));
  for (const s of ordered) {
    const v = data.round1[s.id] || 0;
    const pct = totalValid1 > 0 ? (v / totalValid1) * 100 : 0;
    const tr = document.createElement('tr');
    const tdParty = document.createElement('td');
    const dot = el('span', { className: 'map-tooltip__dot' });
    dot.style.background = spectrumColor(s.id);
    tdParty.appendChild(dot);
    tdParty.appendChild(document.createTextNode(partyAbbrevFor(data.participation, s.id)));
    tr.appendChild(tdParty);
    tr.appendChild(el('td', { text: formatNumber(v) }));
    tr.appendChild(el('td', { text: formatPercent(pct) }));
    if (s.id === majoritySpectrum || s.id === highlightSpectrum) tr.style.fontWeight = '700';
    tbody.appendChild(tr);
  }

  const spoilTotal = totalValid1 + (data.spoil || 0);
  const spoilTr = document.createElement('tr');
  spoilTr.className = 'map-tooltip__spoil-row';
  spoilTr.appendChild(el('td', { text: 'Spoil' }));
  spoilTr.appendChild(el('td', { text: formatNumber(data.spoil || 0) }));
  spoilTr.appendChild(el('td', { text: formatPercent(spoilTotal > 0 ? ((data.spoil || 0) / spoilTotal) * 100 : 0) }));
  tbody.appendChild(spoilTr);

  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function partyAbbrevFor(participation, spectrumId) {
  return (participation && participation[`${spectrumId}_Party`]) || spectrumId;
}

/** Appends `statusLinesHtml`'s Turnout/Status/% lines to `els.unitSummary`. */
function appendStatusLines(statusHtml) {
  const statusHost = document.createElement('div');
  statusHost.innerHTML = statusHtml;
  els.unitSummary.appendChild(statusHost);
}

/** "C01 The City of Alington" -- constituency code ahead of the name, wherever a constituency is displayed on this page. */
function constituencyLabel(name, code) {
  return code ? `${code} ${name}` : name;
}

function renderConstituencySummary(constituencyName) {
  const seat = seatByConstituency.get(constituencyName);
  els.unitSummary.innerHTML = '';
  const switchBtns = levelSwitchButtons();
  if (switchBtns) els.unitSummary.appendChild(switchBtns);
  if (!seat) {
    els.unitSummary.appendChild(el('div', { className: 'egeo-unit-summary__title', text: constituencyLabel(constituencyName, null) }));
    els.unitSummary.appendChild(el('p', { text: 'No data found for this constituency.' }));
    return;
  }

  const participation = Data.findParticipation(participationRows, 'AlmaVale', seat.constituency);
  const data = {
    round1: seat.round1,
    totals: seat.totals,
    eliminatedReal: seat.eliminated,
    certainty: seat.certainty,
    spoil: seat.totals.Spoil || 0,
    participation,
  };

  els.unitSummary.appendChild(
    el('div', { className: 'egeo-unit-summary__title', text: constituencyLabel(constituencyName, seat.constituencyCode) + titleSuffix(data) })
  );
  els.unitSummary.appendChild(renderRoundBody(data));
  appendStatusLines(
    statusLinesHtml(
      aggregateStatusLabel(seat.statusSummary.percentDeclared),
      seat.statusSummary.percentDeclared,
      seat.totals.Turnout,
      seat.totals.Electorate,
      seat.certainty
    )
  );
}

async function renderSecondSummary(constituencyName, secondId) {
  const mode = currentMapMode();
  let precinctIds = [];
  let label = secondId;

  if (mode === 'county') {
    precinctIds = Data.getPrecinctsForCounty(shapeIndex, secondId).map((p) => p.Shape_ID);
  } else {
    const fragment = shapeIndex.districtFragmentById.get(secondId);
    if (fragment) {
      // Constituency-filtered, unlike the sibling list's own unfiltered
      // fragment scope (renderSecondList) -- once drilled in, this and the
      // precinct list below it should agree on exactly the same precincts
      // the map itself shows for this constituency's slice of the fragment
      // (see getPrecinctsForDistrictFragment's doc comment, and
      // electionMap.js's own `activeFragment` precinct-list call).
      precinctIds = Data.getPrecinctsForDistrictFragment(shapeIndex, fragment.District, fragment.District_ID, constituencyName).map(
        (p) => p.Shape_ID
      );
      label = `${fragment.District} District ${fragment.District_ID}`;
    }
  }

  els.unitSummary.innerHTML = '';
  const switchBtns = levelSwitchButtons();
  if (switchBtns) els.unitSummary.appendChild(switchBtns);

  const participation = Data.findParticipation(participationRows, 'AlmaVale', constituencyName);
  const constituencySeat = seatByConstituency.get(constituencyName);

  // Same Supplementary Vote computation for BOTH modes (the 9 transfer
  // columns exist per-precinct regardless of which map grouping we're
  // browsing under) -- gives the box the identical round1/hypothetical-
  // runoff presentation at every level (Constituency/County/District/
  // Precinct), per the user's own request. `eliminatedReal` always comes
  // from the CONSTITUENCY seat, not this unit's own recompute (`sv.eliminated`
  // would be THIS unit's own locally-lowest spectrum, which can legitimately
  // differ from one county/district to the next even though only one
  // elimination actually governs the whole seat -- see `unitActualRunoff`'s
  // doc comment for the same rule applied to the list below).
  const sv = await Data.getAlmaValeSupplementaryVoteForShapeIds(constituencyName, precinctIds);
  const data = {
    round1: sv.round1,
    totals: sv.totals,
    eliminatedReal: constituencySeat ? constituencySeat.eliminated : sv.eliminated,
    certainty: constituencySeat ? constituencySeat.certainty : sv.certainty,
    spoil: sv.totals.Spoil || 0,
    participation,
  };
  els.unitSummary.appendChild(el('div', { className: 'egeo-unit-summary__title', text: label + titleSuffix(data) }));
  els.unitSummary.appendChild(el('div', { className: 'page-header__meta', text: mode === 'county' ? 'County' : 'District' }));
  els.unitSummary.appendChild(renderRoundBody(data));
  appendStatusLines(
    statusLinesHtml(
      aggregateStatusLabel(sv.statusSummary.percentDeclared),
      sv.statusSummary.percentDeclared,
      sv.totals.Turnout,
      sv.totals.Electorate,
      sv.certainty
    )
  );
}

async function renderPrecinctSummary(shapeId, constituencyName) {
  const detail = await seatDetailFor(constituencyName);
  const row = detail.precincts.find((p) => p.shapeId === shapeId);

  els.unitSummary.innerHTML = '';
  const switchBtns = levelSwitchButtons();
  if (switchBtns) els.unitSummary.appendChild(switchBtns);
  if (!row) {
    els.unitSummary.appendChild(el('div', { className: 'egeo-unit-summary__title', text: shapeId }));
    els.unitSummary.appendChild(el('p', { text: 'No data found for this precinct.' }));
    return;
  }

  const declared = row.status === Data.STATUS.DECLARED && row.result;
  const round1 = declared ? row.result.round1 : { Left: 0, MR: 0, Right: 0 };
  const participation = Data.findParticipation(participationRows, 'AlmaVale', constituencyName);
  const constituencySeat = seatByConstituency.get(constituencyName);
  // `eliminatedReal` always the CONSTITUENCY's own elimination, not this
  // precinct's own locally-lowest spectrum (`row.result.eliminated`) --
  // see `unitActualRunoff`'s doc comment for why a single precinct can
  // otherwise disagree with its own constituency's real runoff.
  const data = {
    round1,
    totals: declared ? row.totals : null,
    eliminatedReal: constituencySeat ? constituencySeat.eliminated : declared ? row.result.eliminated : null,
    certainty: constituencySeat ? constituencySeat.certainty : null,
    spoil: declared ? row.spoil || 0 : 0,
    participation,
  };

  els.unitSummary.appendChild(el('div', { className: 'egeo-unit-summary__title', text: shapeId + titleSuffix(data) }));
  els.unitSummary.appendChild(renderRoundBody(data));
  appendStatusLines(statusLinesHtml(row.status, declared ? 100 : 0, row.turnout, row.electorate));
}

function seatDetailFor(constituencyName) {
  if (!seatDetailCache.has(constituencyName)) seatDetailCache.set(constituencyName, Data.getAlmaValeSeatDetail(constituencyName));
  return seatDetailCache.get(constituencyName);
}

// ---------------------------------------------------------------------
// "Summary list" — the panel's clickable drill table (Constituency ->
// County/District -> Precinct), the click-driven alternative to clicking
// the map itself. Mirrors referendum.js's renderAuthorityTable/
// renderCountyTableForAuthority/renderPrecinctTableForCounty.
// ---------------------------------------------------------------------

/**
 * This unit's own votes for the "2nd Pref (actual)" view, expressed under
 * the CONSTITUENCY-WIDE real elimination -- never independently re-derived
 * from just this unit's own votes. A sub-area's own lowest-round1 spectrum
 * can legitimately differ from the constituency's (that's just how the
 * votes happen to split locally), but there is only ONE real runoff for
 * the whole seat -- every county/district/precinct inside it should show
 * ITS OWN vote split under THAT SAME elimination, not a locally-recomputed
 * one, or two areas in the same constituency can appear to be running
 * completely different runoffs. Same rule `hypotheticalRunoffTable` uses
 * for the "real" column it highlights, and `electionMap.js`'s own tooltips
 * mirror this too (`tooltipForSecond`/`tooltipForPrecinct`).
 * @param {Object|null} constituencySeat seatByConstituency.get(constituencyName)
 * @param {Record<string,number>} round1 this unit's own round1 tally
 * @param {Record<string,number>|null} totals this unit's own 9-column totals (null if nothing to compute from yet)
 * @returns {{finalSource: Record<string,number>|null, winner: string|null}}
 */
function unitActualRunoff(constituencySeat, round1, totals) {
  const certainty = constituencySeat && constituencySeat.certainty;
  const roundTwoCertain = !!(certainty && (constituencySeat.round2 ? certainty.participantsCertain : certainty.stage === 'round1-majority'));
  if (!roundTwoCertain) return { finalSource: null, winner: null };
  const eliminated = constituencySeat.eliminated;
  // Winner only bolds once the CONSTITUENCY's overall result is itself
  // certain (not just which two spectrums made the runoff) -- a locally-
  // leading spectrum in one unit could still flip once more of the
  // constituency's votes are counted, same strictness the old per-unit
  // `certainty.resultCertain` gate had.
  if (!eliminated) return { finalSource: round1, winner: certainty.resultCertain ? certainty.winner : null }; // constituency decided outright in round 1 -- no runoff for anyone
  if (!totals) return { finalSource: null, winner: null };
  const result = Data.computeHypotheticalRunoff(totals, eliminated);
  return { finalSource: result.round2, winner: certainty.resultCertain ? result.winner : null };
}

/**
 * Left/MR/Right cells for one summary-list row. `values === null` renders
 * every cell as `emptyText` (e.g. "Undecided" for a genuinely-uncertain 2nd
 * Pref view, "—" for "no data yet") instead of a number.
 * @param {Record<string,number>|null} values
 * @param {{winnerSpectrum?: string|null, emptyText?: string, emptyClass?: string}} [opts]
 */
function spectrumVoteCells(values, opts = {}) {
  const { winnerSpectrum = null, emptyText = '—', emptyClass = 'page-header__meta' } = opts;
  return ['Left', 'MR', 'Right'].map((id) => {
    if (!values) return el('td', { className: emptyClass, text: emptyText });
    return el('td', { className: winnerSpectrum === id ? 'vote-cell--winner' : undefined, text: formatNumber(values[id] || 0) });
  });
}

function drillTable(headers) {
  const table = document.createElement('table');
  table.className = 'data-table egeo-drill-table';
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  for (const text of headers) tr.appendChild(el('th', { text }));
  thead.appendChild(tr);
  table.appendChild(thead);
  return table;
}

function renderConstituencyList() {
  const table = drillTable(['Constituency', 'Left', 'MR', 'Right', 'Status']);
  const tbody = document.createElement('tbody');
  for (const seat of seatsGlobal) {
    const tr = document.createElement('tr');
    tr.dataset.clickable = 'true';
    tr.addEventListener('click', () => {
      selectUnit({ level: 'constituency', id: seat.constituency }).catch((err) => console.error('[election-alma-vale] row click:', err));
    });
    tr.appendChild(el('td', { text: constituencyLabel(seat.constituency, seat.constituencyCode) }));
    if (listPrefView === '1st') {
      tr.append(...spectrumVoteCells(seat.round1));
    } else {
      const { finalSource, winner } = unitActualRunoff(seat, seat.round1, seat.totals);
      tr.append(...spectrumVoteCells(finalSource, { winnerSpectrum: winner, emptyText: 'Undecided', emptyClass: 'vote-cell--undecided' }));
    }
    const statusTd = document.createElement('td');
    statusTd.appendChild(statusBadge(dominantStatus(seat)));
    tr.appendChild(statusTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  els.unitList.innerHTML = '';
  els.unitList.appendChild(table);
}

async function renderSecondList(constituencyName, seq) {
  const mode = currentMapMode();
  const units =
    mode === 'county'
      ? Data.getCountiesForConstituency(shapeIndex, constituencyName).map((row) => ({ id: row.County, label: row.County }))
      : Data.getDistrictFragmentsForConstituency(shapeIndex, constituencyName).map((fragment) => ({
          id: fragment._fragmentId,
          label: `${fragment.District} District ${fragment.District_ID}`,
          fragment,
        }));

  // Unfiltered fragment scope in District mode, matching the map's own
  // coloring of these sibling shapes (electionMap.js's `unitMemberIds`) --
  // once one is actually drilled into, renderSecondSummary/renderPrecinctList
  // switch to the constituency-filtered scope instead (see their comments).
  const idLists = units.map((u) =>
    mode === 'county'
      ? Data.getPrecinctsForCounty(shapeIndex, u.id).map((p) => p.Shape_ID)
      : Data.getPrecinctsForDistrictFragment(shapeIndex, u.fragment.District, u.fragment.District_ID).map((p) => p.Shape_ID)
  );

  // Same Supplementary Vote computation for BOTH modes, matching
  // renderSecondSummary's box above -- the 9 transfer columns exist per
  // precinct regardless of which map grouping we're browsing under, so a
  // District row gets a real round-2 breakdown too instead of just
  // repeating its 1st-preference tally a second time. (The map's own
  // fill/D-tick stay FPTP-based per FEATURE_SPEC's Local Representative
  // rule -- this only changes what this informational list DISPLAYS.)
  const results = await Promise.all(idLists.map((ids) => Data.getAlmaValeSupplementaryVoteForShapeIds(constituencyName, ids)));
  if (seq !== renderSeq) return;

  const constituencySeat = seatByConstituency.get(constituencyName);
  const table = drillTable([mode === 'county' ? 'County' : 'District', 'Left', 'MR', 'Right', 'Status']);
  const tbody = document.createElement('tbody');
  units.forEach((u, i) => {
    const r = results[i];
    const tr = document.createElement('tr');
    tr.dataset.clickable = 'true';
    tr.addEventListener('click', () => {
      selectUnit({ level: 'second', id: u.id, constituency: constituencyName }).catch((err) => console.error('[election-alma-vale] row click:', err));
    });
    tr.appendChild(el('td', { text: u.label }));
    if (listPrefView === '1st') {
      tr.append(...spectrumVoteCells(r.round1));
    } else {
      const { finalSource, winner } = unitActualRunoff(constituencySeat, r.round1, r.totals);
      tr.append(...spectrumVoteCells(finalSource, { winnerSpectrum: winner, emptyText: 'Undecided', emptyClass: 'vote-cell--undecided' }));
    }
    const statusTd = document.createElement('td');
    statusTd.appendChild(statusBadge(dominantStatus({ statusSummary: r.statusSummary })));
    tr.appendChild(statusTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  els.unitList.innerHTML = '';
  els.unitList.appendChild(table);
}

async function renderPrecinctList(constituencyName, secondId, seq, opts = {}) {
  const mode = currentMapMode();
  let precincts = [];
  if (secondId) {
    if (mode === 'county') {
      precincts = Data.getPrecinctsForCounty(shapeIndex, secondId);
    } else {
      const fragment = shapeIndex.districtFragmentById.get(secondId);
      if (fragment) precincts = Data.getPrecinctsForDistrictFragment(shapeIndex, fragment.District, fragment.District_ID, constituencyName);
    }
  }

  const detail = await seatDetailFor(constituencyName);
  if (seq !== renderSeq) return;
  const infoById = new Map(detail.precincts.map((p) => [p.shapeId, p]));

  const table = drillTable(['Precinct', 'Left', 'MR', 'Right', 'Status']);
  const tbody = document.createElement('tbody');
  for (const precinct of precincts) {
    const info = infoById.get(precinct.Shape_ID);
    const declared = info && info.status === Data.STATUS.DECLARED && info.result;
    const tr = document.createElement('tr');
    tr.dataset.clickable = 'true';
    if (opts.highlight === precinct.Shape_ID) tr.style.fontWeight = '700';
    tr.addEventListener('click', () => {
      selectUnit({ level: 'precinct', id: precinct.Shape_ID, constituency: constituencyName }).catch((err) =>
        console.error('[election-alma-vale] row click:', err)
      );
    });
    tr.appendChild(el('td', { text: precinct.Shape_ID }));
    if (listPrefView === '1st') {
      tr.append(...spectrumVoteCells(declared ? info.result.round1 : null));
    } else {
      const { finalSource, winner } = declared
        ? unitActualRunoff(seatByConstituency.get(constituencyName), info.result.round1, info.totals)
        : { finalSource: null, winner: null };
      tr.append(
        ...spectrumVoteCells(finalSource, {
          winnerSpectrum: winner,
          emptyText: declared ? 'Undecided' : '—',
          emptyClass: declared ? 'vote-cell--undecided' : 'page-header__meta',
        })
      );
    }
    const statusTd = document.createElement('td');
    statusTd.appendChild(statusBadge(info ? info.status : Data.STATUS.NOT_RECEIVED));
    tr.appendChild(statusTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  els.unitList.innerHTML = '';
  els.unitList.appendChild(table);
}

// ---------------------------------------------------------------------
// Full results table (unchanged from before the layout reformat, just
// pulled into its own function and moved below the geo layout).
// ---------------------------------------------------------------------

function fullResultsTable(seats, electionMeta, spectrumColumns) {
  const container = document.createElement('div');
  const wrap = el('div', { className: 'scroll-table-wrap scroll-table-wrap--full-height' });
  const table = document.createElement('table');
  table.className = 'data-table seat-table gd-vote-table';
  table.appendChild(voteTableHead(spectrumColumns));
  const tbody = document.createElement('tbody');

  for (const group of groupSeatsByRegion(seats)) {
    const memberRows = [];
    tbody.appendChild(regionSubtotalRow(group.region, group.seats, spectrumColumns, memberRows));
    for (const seat of group.seats) {
      const row = seatRow(seat, electionMeta, spectrumColumns);
      memberRows.push(row);
      tbody.appendChild(row);
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  container.appendChild(columnToggleControls(table));
  container.appendChild(wrap);
  return container;
}

/**
 * Two column-visibility tickboxes above the full results table: one toggles
 * the Electorate/Vote/Turnout columns as a group, the other toggles Spoil --
 * both UNCHECKED (columns hidden) by default. Every cell belonging to one
 * of these column groups carries a `data-col-group` attribute (set in
 * `voteTableHead`/`appendTurnoutCells`/`appendVoteCells`/
 * `appendRegionSubtotalCells`); a tickbox's checked state just controls a
 * `hide-col-{group}` class on `table` itself (added by default, up front,
 * to match the unchecked starting state), and CSS (results.css) does the
 * hiding -- no need to rebuild or walk the table on every toggle.
 * @param {HTMLTableElement} table
 */
function columnToggleControls(table) {
  const wrap = el('div', { className: 'column-toggle' });
  const groups = [
    { key: 'evt', label: 'Electorate, Vote & Turnout' },
    { key: 'spoil', label: 'Spoil' },
  ];
  for (const group of groups) {
    const label = document.createElement('label');
    label.className = 'column-toggle__item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = false;
    table.classList.add(`hide-col-${group.key}`);
    checkbox.addEventListener('change', () => {
      table.classList.toggle(`hide-col-${group.key}`, !checkbox.checked);
    });
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(group.label));
    wrap.appendChild(label);
  }
  return wrap;
}

/**
 * Splits `seats` into consecutive same-`region` runs -- `Data.getAlmaValeSeats()`
 * already returns seats in `orderConstituencies()` order (see file doc
 * comment), so a single linear pass is enough; no separate sort/group-by
 * needed.
 * @param {Array<Object>} seats
 * @returns {Array<{region: string|undefined, seats: Array<Object>}>}
 */
function groupSeatsByRegion(seats) {
  const groups = [];
  let current = null;
  for (const seat of seats) {
    if (!current || current.region !== seat.region) {
      current = { region: seat.region, seats: [] };
      groups.push(current);
    }
    current.seats.push(seat);
  }
  return groups;
}

/**
 * A region's header row: doubles as an Electorate/Vote/Turnout/Final/1st/
 * Spoil SUBTOTAL across every seat in the region (Status is left blank --
 * summing per-seat statuses/winners has no single meaningful value), and an
 * expand/collapse toggle for the region's own seat rows. `memberRows` is
 * still empty when this row is built (the caller fills it in right after,
 * once each seat row exists) -- safe because the click handler only reads
 * it lazily, at click time, by which point it's fully populated.
 * @param {string|undefined} region
 * @param {Array<Object>} regionSeats
 * @param {Array<{id:string, label:string}>} spectrumColumns
 * @param {Array<HTMLTableRowElement>} memberRows out-param, filled in by the caller
 */
function regionSubtotalRow(region, regionSeats, spectrumColumns, memberRows) {
  const tr = document.createElement('tr');
  tr.className = 'seat-table__region-row';
  // The click target is the WHOLE row, not just the small ▾/▸ glyph --
  // that glyph alone (`.expand-toggle`: no border/background, 1.4rem wide)
  // is easy to miss as a clickable control, especially with no hover state
  // visible in a screenshot. Matches the `[data-clickable]` row pattern
  // the drill-down list tables below already use (renderConstituencyList
  // etc.) for the same reason.
  tr.dataset.clickable = 'true';

  const nameTd = document.createElement('td');
  const nameWrap = el('span', { className: 'seat-row__name' });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'expand-toggle';
  btn.textContent = '▾';
  btn.setAttribute('aria-expanded', 'true');
  nameWrap.appendChild(btn);
  nameWrap.appendChild(document.createTextNode(region || 'Other'));
  nameTd.appendChild(nameWrap);
  tr.appendChild(nameTd);

  // Single handler on the row itself (not also on `btn`) -- `btn` is
  // inside `tr`, so a click on it already bubbles up to this listener;
  // attaching a second one on `btn` would double-fire and toggle right
  // back to where it started.
  tr.addEventListener('click', () => {
    const collapse = !memberRows[0].classList.contains('hidden');
    for (const row of memberRows) row.classList.toggle('hidden', collapse);
    btn.textContent = collapse ? '▸' : '▾';
    btn.setAttribute('aria-expanded', String(!collapse));
  });

  appendRegionSubtotalCells(tr, regionSeats, spectrumColumns);
  return tr;
}

/**
 * Electorate/Vote/Spoil/per-spectrum Final(=current round)/1st sums across
 * a set of seats, for the region subtotal rows (`appendRegionSubtotalCells`).
 *
 * Final sums use each seat's own CURRENT round1/round2 tally regardless of
 * that seat's own `certainty` -- like the "1st" column and Home Districts'
 * Total row (election-home-districts.js's `currentVote()`), a sum-so-far
 * is a running current count, not a per-seat declaration, so it isn't
 * gated by `appendVoteCells`'s per-seat "Undecided" display rule.
 * @param {Array<Object>} seats
 * @param {Array<{id:string, label:string}>} spectrumColumns pass `[]` if only electorate/vote/spoil are needed
 * @returns {{electorate:number, vote:number, voteKnown:boolean, spoil:number, finalSums:Record<string,number>, firstSums:Record<string,number>}}
 */
function sumSeatFigures(seats, spectrumColumns) {
  let electorate = 0;
  let vote = 0;
  let voteKnown = false;
  let spoil = 0;
  const finalSums = {};
  const firstSums = {};
  for (const s of spectrumColumns) {
    finalSums[s.id] = 0;
    firstSums[s.id] = 0;
  }

  for (const seat of seats) {
    electorate += seat.electorate || 0;
    if (seat.turnout != null) {
      vote += seat.turnout;
      voteKnown = true;
    }
    for (const s of spectrumColumns) {
      const round1Value = seat.round1 ? seat.round1[s.id] || 0 : 0;
      finalSums[s.id] += seat.round2 ? seat.round2[s.id] || 0 : round1Value;
      firstSums[s.id] += round1Value;
    }
    spoil += seat.totals ? seat.totals.Spoil || 0 : 0;
  }

  return { electorate, vote, voteKnown, spoil, finalSums, firstSums };
}

/**
 * Electorate/Vote/Turnout%/Final×N/1st×N/Spoil cells across `regionSeats`,
 * plus a trailing blank Status cell -- same column order as `seatRow`'s
 * data cells (`appendTurnoutCells` + `appendVoteCells`), so the subtotal
 * lines up under the right headers.
 * @param {HTMLTableRowElement} tr
 * @param {Array<Object>} regionSeats
 * @param {Array<{id:string, label:string}>} spectrumColumns
 */
function appendRegionSubtotalCells(tr, regionSeats, spectrumColumns) {
  const { electorate, vote, voteKnown, spoil, finalSums, firstSums } = sumSeatFigures(regionSeats, spectrumColumns);
  tr.appendChild(colGroupTd(formatNumber(electorate), 'evt'));
  tr.appendChild(colGroupTd(formatTurnout(voteKnown ? vote : null), 'evt'));
  const turnoutPct = voteKnown && electorate ? (vote / electorate) * 100 : null;
  tr.appendChild(colGroupTd(turnoutPct != null ? formatPercent(turnoutPct) : '—', 'evt'));
  for (const s of spectrumColumns) tr.appendChild(el('td', { text: formatNumber(finalSums[s.id]) }));
  for (const s of spectrumColumns) tr.appendChild(el('td', { text: formatNumber(firstSums[s.id]) }));
  tr.appendChild(colGroupTd(formatNumber(spoil), 'spoil'));
  tr.appendChild(document.createElement('td'));
}

/**
 * Column layout matches election-general-direct.html's vote table
 * (Constituency, Electorate, Vote, Turnout, {spectrum} Final ×N, {spectrum}
 * 1st ×N, Spoil, Status) rather than the plain Status/%declared/Result
 * layout the other seat-type pages use -- Alma Vale is Supplementary Vote
 * same as General Direct, so the same round1/round2 figures apply per seat.
 */
function voteTableHead(spectrumColumns) {
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  const headers = [
    { text: 'Constituency' },
    { text: 'Electorate', colGroup: 'evt' },
    { text: 'Vote', colGroup: 'evt' },
    { text: 'Turnout', colGroup: 'evt' },
    ...spectrumColumns.map((s) => ({ text: `${s.label} Final` })),
    ...spectrumColumns.map((s) => ({ text: `${s.label} 1st` })),
    { text: 'Spoil', colGroup: 'spoil' },
    { text: 'Status' },
  ];
  for (const h of headers) {
    const th = el('th', { text: h.text });
    if (h.colGroup) th.dataset.colGroup = h.colGroup;
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  return thead;
}

function seatRow(seat, electionMeta, spectrumColumns) {
  const tr = document.createElement('tr');
  tr.className = 'seat-row';

  const nameTd = document.createElement('td');
  const nameWrap = el('span', { className: 'seat-row__name' });
  const a = document.createElement('a');
  a.href = seatDetailHref('AlmaVale', seat.constituency);
  a.textContent = seat.constituency;
  nameWrap.appendChild(a);
  if (seat.constituencyCode) nameWrap.appendChild(el('span', { className: 'page-header__meta', text: seat.constituencyCode }));
  nameTd.appendChild(nameWrap);
  tr.appendChild(nameTd);

  appendTurnoutCells(tr, seat);
  appendVoteCells(tr, seat, spectrumColumns);
  tr.appendChild(statusOrResultCell(seat, electionMeta));

  return tr;
}

/**
 * Electorate / Vote / Turnout % cells, mirroring election-general-direct.js's
 * appendTurnoutCells. Each cell carries `data-col-group="evt"` so
 * `columnToggleControls`'s "Electorate, Vote & Turnout" tickbox can hide
 * all three as a group.
 */
function appendTurnoutCells(tr, seat) {
  tr.appendChild(colGroupTd(formatNumber(seat.electorate), 'evt'));
  tr.appendChild(colGroupTd(formatTurnout(seat.turnout), 'evt'));
  const turnoutPct = seat.turnout != null && seat.electorate ? (seat.turnout / seat.electorate) * 100 : null;
  tr.appendChild(colGroupTd(turnoutPct != null ? formatPercent(turnoutPct) : '—', 'evt'));
}

/** A `<td>` tagged with `data-col-group` for `columnToggleControls`'s show/hide CSS. */
function colGroupTd(text, colGroup) {
  const td = el('td', { text });
  td.dataset.colGroup = colGroup;
  return td;
}

/**
 * Final/1st-preference vote cells + Spoil, mirroring election-general-direct.js's
 * appendVoteCells. Final is only ever the round1 copy (seat decided outright
 * in round 1) or the round2 running tally (runoff participants mathematically
 * certain -- results.js's `certainty.participantsCertain`) -- until one of
 * those is true, which two spectrums even make a runoff could still change,
 * so Final shows "Undecided" rather than a possibly-wrong pair's numbers.
 * @param {HTMLTableRowElement} tr
 * @param {Object} seat
 * @param {Array<{id:string, label:string}>} spectrumColumns
 */
function appendVoteCells(tr, seat, spectrumColumns) {
  const certainty = seat.certainty;
  const finalSource = certainty && certainty.stage === 'round1-majority'
    ? seat.round1
    : certainty && certainty.participantsCertain
    ? seat.round2 || {}
    : null;

  for (const s of spectrumColumns) {
    const isWinnerCell = certainty && certainty.resultCertain && s.id === certainty.winner;
    if (finalSource) {
      tr.appendChild(el('td', { className: isWinnerCell ? 'vote-cell--winner' : undefined, text: formatNumber(finalSource[s.id]) }));
    } else {
      tr.appendChild(el('td', { className: 'vote-cell--undecided', text: 'Undecided' }));
    }
  }
  for (const s of spectrumColumns) {
    tr.appendChild(el('td', { text: formatNumber(seat.round1 ? seat.round1[s.id] : undefined) }));
  }
  tr.appendChild(colGroupTd(formatNumber(seat.totals ? seat.totals.Spoil : undefined), 'spoil'));
}

/** Merged Status/Result cell, mirroring election-general-direct.js's statusOrResultCell. */
function statusOrResultCell(seat, electionMeta) {
  const td = document.createElement('td');
  if (isResultCertain(seat)) {
    td.appendChild(partyPill(electionMeta, seat.winnerParty));
  } else {
    td.appendChild(statusBadge(dominantStatus(seat)));
  }
  return td;
}

function sectionTitle(text) {
  return el('h2', { className: 'section-heading', text });
}

/**
 * Spectrum-colored vote-share bar for Alma Vale's national first-preference
 * totals (Declared precincts only, summed across all 40 seats' `round1`).
 * Above the bar, a big-number/label row mirrors the home page's
 * seats-so-far header (`spectrumSummaryRow`, election-common.js) — the big
 * number is this spectrum's decided-seat count within Alma Vale, and the
 * label is "{Party}: {Vote} ({Vote Pct})" instead of just the spectrum name,
 * using `buildSpectrumDisplayLabels`'s national display-party mapping
 * (localRepresentative.js — Left is fielded by either NRD or LRP depending
 * on constituency, so there's no single "the" Left party without it).
 * Each bar segment also shows its decided-seat count inline (matching the
 * home page's seats-won bar) -- the vote/pct figures already appear in the
 * summary row above, so the bar itself doesn't repeat them below.
 */
function voteShareBar(electionMeta, seats, participationRows) {
  const spectrumVotes = { Left: 0, MR: 0, Right: 0 };
  const spectrumSeats = { Left: 0, MR: 0, Right: 0 };
  for (const seat of seats) {
    spectrumVotes.Left += seat.round1.Left;
    spectrumVotes.MR += seat.round1.MR;
    spectrumVotes.Right += seat.round1.Right;
    if (isResultCertain(seat) && seat.winnerSpectrum) {
      spectrumSeats[seat.winnerSpectrum] = (spectrumSeats[seat.winnerSpectrum] || 0) + 1;
    }
  }
  const total = electionMeta.spectrums.reduce((s, sp) => s + (spectrumVotes[sp.id] || 0), 0);
  const partyLabels = Data.buildSpectrumDisplayLabels(participationRows);

  const summaryRow = spectrumSummaryRow(electionMeta, (spectrum) => {
    const votes = spectrumVotes[spectrum.id] || 0;
    const pct = total > 0 ? (votes / total) * 100 : 0;
    const partyLabel = partyLabels.get(spectrum.id) || spectrum.name;
    return {
      value: formatNumber(spectrumSeats[spectrum.id] || 0),
      label: `${partyLabel}: ${formatNumber(votes)} (${formatPercent(pct)})`,
    };
  });

  const bar = document.createElement('div');
  bar.className = 'vote-share-bar';

  for (const spectrum of electionMeta.spectrums) {
    const votes = spectrumVotes[spectrum.id] || 0;
    const pct = total > 0 ? (votes / total) * 100 : 0;
    const seatCount = spectrumSeats[spectrum.id] || 0;

    if (votes > 0) {
      const seg = el('div', {
        className: 'vote-share-bar__seg',
        attrs: { style: `width:${pct}%;background:${spectrumColor(spectrum.id)}` },
      });
      seg.title = `${spectrum.name}: ${formatNumber(votes)} votes (${formatPercent(pct)}) · ${seatCount} seat${seatCount === 1 ? '' : 's'}`;
      if (pct >= 4) seg.appendChild(el('span', { className: 'vote-share-bar__seg-label', text: formatNumber(seatCount) }));
      bar.appendChild(seg);
    }
  }

  return el('div', { className: 'vote-share-block' }, [summaryRow, bar]);
}

main().catch((err) => renderError(content, err));
