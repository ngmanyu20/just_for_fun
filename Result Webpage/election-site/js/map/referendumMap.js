/**
 * referendumMap.js — Referendum choropleth: Authority (top, all 36) ->
 * County (second layer) -> Precinct (bottom). Fixed layers, no site-wide
 * toggle (FEATURE_SPEC.md Section 5).
 *
 * Public contract (BUILD_NOTES.md "Map component contract"):
 *   mountReferendumMap(container, options) -> { reset, drillTo, destroy }
 *
 * Only `AlmaVale` (Shape_ID-keyed, geographic) referendum results ever
 * reach this map — `GeneralDirect` is a functional constituency and is
 * rendered as its own flat table elsewhere (Section 4/5); this module never
 * wires it in.
 *
 * **Presentation model**, matching js/map/electionMap.js's simplified "one
 * path expanded, everything else at its own natural level" approach
 * (NYT/AP style) instead of a separate neighbor-loading/context-shape
 * concept: all 36 authorities are ALWAYS rendered. Clicking one expands it
 * in place into its counties, while every other authority stays at
 * authority level (still clickable — clicking a different one switches
 * which is expanded). Clicking a county inside the expanded authority
 * further expands it into its precincts, while sibling counties stay at
 * county level and every other authority stays at authority level. The
 * view auto-zooms to whatever's currently expanded (`zoomTransformToFit` in
 * mapCore.js) so the drilled-in detail is still usable at national-map
 * scale.
 *
 * Coloring judgment call (flagged in the build report): FEATURE_SPEC.md's
 * Section 3 spectrum-coloring rule is specific to the General Election
 * choropleth. The referendum has no spectrum — only Yes/No — so Declared
 * precincts here are colored by the leading side using two new custom
 * properties (`--ref-yes` / `--ref-no`) defined in css/map.css (not
 * base.css, which only defines the spectrum/status custom properties).
 * Not-yet-declared precincts keep using the shared status-color pipeline
 * exactly like the election map, per Section 2.
 */

import * as Data from '../data.js';
import {
  ensureD3,
  ringsOf,
  buildChrome,
  renderShapes,
  renderLegend,
  statusColorVar,
  computeExtent,
  zoomTransformToFit,
  formatPercent,
} from './mapCore.js';
import { aggregateStatusLabel, statusLinesHtml } from './resultsTable.js';

// Not received/Verifying/Counting all read as the same neutral "no result
// yet" gray on this map (see `neutralColorVar` below) rather than each
// getting its own hue, so the legend only needs the two outcomes that
// actually get a distinct color.
const LEGEND_ITEMS = [
  { label: 'Yes leading', color: 'var(--ref-yes)' },
  { label: 'No leading', color: 'var(--ref-no)' },
];

function slug(s) {
  return String(s).toLowerCase().replace(/\s+/g, '-');
}

/**
 * @param {HTMLElement} container
 * @param {{ onUnitClick?: (unit: Object) => void }} options
 */
export async function mountReferendumMap(container, options = {}) {
  const d3 = await ensureD3();
  const shapeIndex = await Data.getShapeIndex();

  const chrome = buildChrome(container, d3, { title: 'Referendum' });
  renderLegend(chrome.legend, LEGEND_ITEMS);

  // The whole AlmaVale referendum results file is loaded once (it's a
  // single flat CSV, no per-scope endpoint) and indexed by Shape_ID; every
  // layer/aggregate below reads from this one in-memory map rather than
  // re-fetching (fetchCSV would return the same cached promise anyway, but
  // this also avoids re-deriving status per row on every render).
  const referendumResults = await Data.getAlmaValeReferendumResults();
  const rowByShapeId = new Map(referendumResults.precinctRows.map((r) => [r.Shape_ID, r]));

  function infoFor(shapeId) {
    const row = rowByShapeId.get(shapeId);
    if (!row) return null;
    const status = Data.computeStatus(row);
    const yes = Data.toNumber(row.Yes_Votes);
    const no = Data.toNumber(row.No_Votes);
    const electorate = Data.toNumber(row.Electorate);
    // Turnout is only visible once a row has reached "Counting" (Section 2)
    // -- looser than the Declared gate Yes/No votes use -- so this stays
    // null (not 0) until then, same convention js/data/referendum.js's
    // summarizeYesNo() uses for the same field.
    const turnout = Data.statusAtLeast(row, Data.STATUS.COUNTING) ? Data.toNumber(row.Turnout) : null;
    return { row, status, yes, no, electorate, turnout };
  }

  /**
   * Option/Votes/Pct tooltip table, shared by all three layers (Authority/
   * County aggregates and a single Precinct alike) -- leading option (more
   * votes) always sorted to the top row, per the same "winner first" rule
   * js/map/resultsTable.js's election-side table uses. Returns '' once
   * there are no valid votes to show yet (Section 2: hidden until
   * something's counted), matching that table's own convention.
   * @param {{yes:number, no:number}} votes
   */
  function referendumOptionsTableHtml({ yes, no }) {
    const total = (yes || 0) + (no || 0);
    if (total <= 0) return '';
    const options = [
      { label: 'Yes', votes: yes || 0, colorVar: 'var(--ref-yes)' },
      { label: 'No', votes: no || 0, colorVar: 'var(--ref-no)' },
    ].sort((a, b) => b.votes - a.votes);
    const rows = options
      .map((o) => {
        const pct = (o.votes / total) * 100;
        return `<tr><td><span class="map-tooltip__dot" style="background:${o.colorVar}"></span>${o.label}</td><td>${o.votes.toLocaleString()}</td><td>${formatPercent(pct)}</td></tr>`;
      })
      .join('');
    return `<table class="map-tooltip__table ref-options-table"><thead><tr><th>Option</th><th>Votes</th><th>Pct</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  /**
   * Fallback color for an Authority/County aggregate with nothing Declared
   * yet, and for a precinct that hasn't even been received. Only "Yes
   * leading"/"No leading" (once something's Declared) are meaningful
   * distinctions at the aggregate level, so an aggregate never breaks this
   * down by its precincts' individual Verifying/Counting/Not received mix
   * -- it's all the same neutral "no result yet" gray
   * (`--status-not-received`). A single precinct that's actively
   * Verifying/Counting gets its own distinct color instead -- see
   * `colorForPrecinct` below.
   */
  function neutralColorVar() {
    return statusColorVar('Not received');
  }

  function colorForPrecinct(info) {
    if (!info) return { fill: neutralColorVar(), fillOpacity: 0.5, className: 'map-shape--nodata' };
    if (info.status === 'Declared') {
      const fill = info.yes >= info.no ? 'var(--ref-yes)' : 'var(--ref-no)';
      return { fill, fillOpacity: 1, className: 'map-shape--declared' };
    }
    if (info.status === 'Verifying' || info.status === 'Counting') {
      return { fill: 'var(--ref-progress)', fillOpacity: 0.85, className: `map-shape--${slug(info.status)}` };
    }
    return { fill: neutralColorVar(), fillOpacity: 0.85, className: `map-shape--${slug(info.status)}` };
  }

  function aggregateUnit(shapeIds) {
    let yes = 0, no = 0, electorateTotal = 0, electorateDeclared = 0;
    let turnoutSum = 0, turnoutKnownCount = 0;
    for (const id of shapeIds) {
      const info = infoFor(id);
      if (!info) continue;
      electorateTotal += info.electorate;
      if (info.turnout != null) {
        turnoutSum += info.turnout;
        turnoutKnownCount++;
      }
      if (info.status === 'Declared') {
        electorateDeclared += info.electorate;
        yes += info.yes;
        no += info.no;
      }
    }
    const percentDeclared = electorateTotal > 0 ? (electorateDeclared / electorateTotal) * 100 : 0;
    const leadSide = yes + no > 0 ? (yes >= no ? 'Yes' : 'No') : null;
    const turnout = turnoutKnownCount > 0 ? turnoutSum : null;
    return { leadSide, percentDeclared, electorateTotal, yes, no, turnout };
  }

  function colorForAggregate(agg) {
    if (agg.leadSide) {
      const fill = agg.leadSide === 'Yes' ? 'var(--ref-yes)' : 'var(--ref-no)';
      const opacity = Math.max(0.35, Math.min(1, agg.percentDeclared / 100));
      return { fill, fillOpacity: opacity };
    }
    return { fill: neutralColorVar(), fillOpacity: 0.75 };
  }

  const state = {
    activeAuthority: null,
    activeCounty: null,
    selectedPrecinctId: null,
  };

  function setBreadcrumb(parts) {
    const clean = parts.filter((p) => p != null);
    chrome.breadcrumb.innerHTML = clean
      .map((p, i) => (i === clean.length - 1 ? `<strong>${p}</strong>` : `<span>${p}</span> &raquo; `))
      .join('');
  }

  /** Authority/County tooltip: Option/Votes/Pct table (leading option on top) + the shared Turnout/Status/% in trio. */
  function tooltipForAggregate(label, shape) {
    const agg = shape.meta.agg;
    const table = referendumOptionsTableHtml({ yes: agg.yes, no: agg.no });
    return `
      <strong>${shape.rawId}</strong>
      <div class="map-tooltip__status">${label}</div>
      ${table}
      ${statusLinesHtml(aggregateStatusLabel(agg.percentDeclared), agg.percentDeclared, agg.turnout, agg.electorateTotal)}
    `;
  }

  function tooltipForAuthority(shape) {
    return tooltipForAggregate('Authority', shape);
  }

  function tooltipForCounty(shape) {
    return tooltipForAggregate('County', shape);
  }

  /**
   * Precinct tooltip: same Option/Votes/Pct table, this one precinct's own
   * single row (never an aggregate, so its status stays the literal
   * per-row value rather than `aggregateStatusLabel` -- see that helper's
   * own doc comment).
   *
   * Section 2's Yes/No gate applies here same as everywhere else on the
   * site: `info.yes`/`info.no` are the raw CSV cell values regardless of
   * status (`infoFor()` doesn't blank them pre-Declared), so this only
   * passes them into the table once `status === 'Declared'` -- otherwise
   * the tooltip would leak a "final" vote split for a precinct that's only
   * Verifying/Counting/Not received.
   */
  function tooltipForPrecinct(shape) {
    const info = shape.meta.info;
    const status = info ? info.status : 'Not received';
    const declared = status === 'Declared';
    const yes = declared ? info.yes : 0;
    const no = declared ? info.no : 0;
    const percentDeclared = declared ? 100 : 0;
    const table = referendumOptionsTableHtml({ yes, no });
    return `
      <strong>${shape.rawId}</strong>
      ${table}
      ${statusLinesHtml(status, percentDeclared, info ? info.turnout : null, info ? info.electorate : 0)}
    `;
  }

  function fireUnitClick(unit) {
    if (typeof options.onUnitClick === 'function') options.onUnitClick(unit);
  }

  // ---------------------------------------------------------------------
  // The one render pass: builds all three tiers (whichever are active)
  // into a single shapes array, then auto-zooms to whatever's expanded —
  // same single-pass model as electionMap.js's renderAll().
  // ---------------------------------------------------------------------

  function renderAll() {
    const shapes = [];

    for (const a of shapeIndex.authorities) {
      if (a.Authority === state.activeAuthority) continue; // expanded below instead
      const precinctIds = Data.getPrecinctsForAuthority(shapeIndex, a.Authority).map((p) => p.Shape_ID);
      const agg = aggregateUnit(precinctIds);
      const color = colorForAggregate(agg);
      shapes.push({
        id: `a::${a.Authority}`,
        level: 'authority',
        rawId: a.Authority,
        rings: ringsOf(a),
        fill: color.fill,
        fillOpacity: color.fillOpacity,
        className: 'map-shape--authority',
        meta: { row: a, agg },
      });
    }

    if (state.activeAuthority) {
      const counties = Data.getCountiesForAuthority(shapeIndex, state.activeAuthority);
      for (const county of counties) {
        if (county.County === state.activeCounty) continue; // expanded below instead
        const precinctIds = Data.getPrecinctsForCounty(shapeIndex, county.County).map((p) => p.Shape_ID);
        const agg = aggregateUnit(precinctIds);
        const color = colorForAggregate(agg);
        shapes.push({
          id: `c::${county.County}`,
          level: 'county',
          rawId: county.County,
          rings: ringsOf(county),
          fill: color.fill,
          fillOpacity: color.fillOpacity,
          className: 'map-shape--second-primary',
          meta: { unit: county, agg },
        });
      }

      if (state.activeCounty) {
        const precincts = Data.getPrecinctsForCounty(shapeIndex, state.activeCounty);
        for (const p of precincts) {
          const info = infoFor(p.Shape_ID);
          const color = colorForPrecinct(info);
          shapes.push({
            id: `p::${p.Shape_ID}`,
            level: 'precinct',
            rawId: p.Shape_ID,
            rings: ringsOf(p),
            fill: color.fill,
            fillOpacity: color.fillOpacity,
            className: `${color.className}${p.Shape_ID === state.selectedPrecinctId ? ' map-shape--selected' : ''}`,
            meta: { row: p, info },
          });
        }
      }
    }

    const scales = renderShapes(d3, chrome.shapeLayer, chrome.width, chrome.height, shapes, {
      onClick: (id) => {
        const shape = shapes.find((s) => s.id === id);
        if (!shape) return;
        if (shape.level === 'authority') setActiveAuthority(shape.rawId);
        else if (shape.level === 'county') setActiveCounty(shape.rawId);
        else selectPrecinct(shape);
      },
      onHover: (id, event) => {
        const shape = shapes.find((s) => s.id === id);
        if (!shape) return;
        const html =
          shape.level === 'authority' ? tooltipForAuthority(shape) : shape.level === 'county' ? tooltipForCounty(shape) : tooltipForPrecinct(shape);
        chrome.showTooltip(event, html);
      },
      onHoverEnd: chrome.hideTooltip,
    });

    updateBreadcrumb();
    autoZoomToActive(shapes, scales);
  }

  function updateBreadcrumb() {
    const parts = ['Authorities'];
    if (state.activeAuthority) parts.push(state.activeAuthority, 'Counties');
    if (state.activeCounty) parts.push(state.activeCounty);
    setBreadcrumb(parts);
  }

  /** Auto-zoom to whatever's currently expanded (NYT-style), so drilled-in detail stays usable at national-map scale. */
  function autoZoomToActive(shapes, scales) {
    let focusLevel = null;
    if (state.activeCounty) focusLevel = 'precinct';
    else if (state.activeAuthority) focusLevel = 'county';

    if (!focusLevel) {
      chrome.resetZoom();
      return;
    }
    const focusShapes = shapes.filter((s) => s.level === focusLevel);
    if (!focusShapes.length) {
      chrome.resetZoom();
      return;
    }
    const extent = computeExtent(focusShapes);
    const transform = zoomTransformToFit(d3, extent, scales.xScale, scales.yScale, chrome.width, chrome.height);
    if (transform) chrome.zoomTo(transform);
    else chrome.resetZoom();
  }

  // ---------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------

  function setActiveAuthority(name) {
    state.activeAuthority = name;
    state.activeCounty = null;
    state.selectedPrecinctId = null;
    fireUnitClick({ level: 'authority', id: name });
    renderAll();
  }

  function setActiveCounty(id) {
    state.activeCounty = id;
    state.selectedPrecinctId = null;
    fireUnitClick({ level: 'county', id, authority: state.activeAuthority });
    renderAll();
  }

  function selectPrecinct(shape) {
    state.selectedPrecinctId = shape.rawId;
    fireUnitClick({ level: 'precinct', id: shape.rawId, county: shape.meta.row.County, status: shape.meta.info?.status });
    renderAll();
  }

  // ---------------------------------------------------------------------
  // Controller
  // ---------------------------------------------------------------------

  function reset() {
    state.activeAuthority = null;
    state.activeCounty = null;
    state.selectedPrecinctId = null;
    renderAll();
  }
  const onResetClick = () => reset();
  chrome.resetBtn.addEventListener('click', onResetClick);

  /** Up one level: collapse the expanded precinct view, then the expanded authority view. */
  function goUp() {
    if (state.activeCounty) {
      state.activeCounty = null;
      state.selectedPrecinctId = null;
      renderAll();
      return;
    }
    if (state.activeAuthority) {
      state.activeAuthority = null;
      renderAll();
    }
  }
  const onUpClick = () => goUp();
  chrome.upBtn.addEventListener('click', onUpClick);

  /**
   * Programmatic drill (used by referendum.js's Authority/County selectors
   * and precinct table rows). Sets state directly and re-renders — unlike
   * the previous neighbor-loading implementation, this never fires
   * `onUnitClick` itself (only a genuine shape click does, via
   * setActiveAuthority/setActiveCounty/selectPrecinct above), so callers
   * don't need to guard against a nested re-entrant click here.
   */
  function drillTo(level, id) {
    if (level === 'authority') {
      state.activeAuthority = id;
      state.activeCounty = null;
      state.selectedPrecinctId = null;
    } else if (level === 'county') {
      const county = shapeIndex.countyByCode.get(id);
      if (!county) return;
      const authority = Data.getAuthorityForCounty(shapeIndex, id);
      state.activeAuthority = authority ? authority.Authority : state.activeAuthority;
      state.activeCounty = id;
      state.selectedPrecinctId = null;
    } else if (level === 'precinct') {
      const precinct = shapeIndex.polygonById.get(id);
      if (!precinct) return;
      const authority = Data.getAuthorityForPrecinct(shapeIndex, id);
      state.activeAuthority = authority ? authority.Authority : state.activeAuthority;
      state.activeCounty = precinct.County;
      state.selectedPrecinctId = id;
    } else {
      return;
    }
    renderAll();
  }

  function destroy() {
    chrome.resetBtn.removeEventListener('click', onResetClick);
    chrome.upBtn.removeEventListener('click', onUpClick);
    container.innerHTML = '';
  }

  renderAll();

  return { reset, drillTo, destroy };
}
