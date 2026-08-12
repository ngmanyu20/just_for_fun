/**
 * mapCore.js — internal rendering engine shared by electionMap.js and
 * referendumMap.js. NOT part of the Phase 2 map component contract
 * (BUILD_NOTES.md only promises `mountElectionMap`/`mountReferendumMap`) —
 * this module exists purely to avoid duplicating the D3/SVG plumbing (scale
 * fitting, path building, zoom/pan, tooltip, legend) between the two public
 * components, which otherwise share almost all of their rendering code and
 * differ only in *which* geographic hierarchy they drill through.
 *
 * Geometry note (FEATURE_SPEC.md): `geometry`/`centroid` columns are a
 * custom local X/Y coordinate system (WKT-like `POLYGON ((x y, ...))`
 * strings), NOT real lat/lng — so this renders as plain 2D SVG geometry via
 * a hand-fitted linear scale, not a geographic map projection.
 */

import { parseWKTPolygon } from '../data.js';

// ---------------------------------------------------------------------
// D3 loading — checks for an already-present global first (so a host page
// that already includes D3, or a test harness that pre-seeds
// `window.d3`/`globalThis.d3`, never triggers a network request), otherwise
// injects the CDN UMD build once and waits for it to load. No local vendor
// copy is bundled (see build report for the tradeoff).
// ---------------------------------------------------------------------

const D3_CDN_URL = 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js';
let _d3Promise = null;

/** @returns {Promise<Object>} the D3 namespace object. */
export function ensureD3() {
  if (typeof globalThis.d3 !== 'undefined') return Promise.resolve(globalThis.d3);
  if (_d3Promise) return _d3Promise;
  _d3Promise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('mapCore: no `document` available to inject the D3 script tag'));
      return;
    }
    const existing = document.querySelector(`script[data-mapcore-d3]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(globalThis.d3));
      existing.addEventListener('error', () => reject(new Error('mapCore: failed to load D3 from CDN')));
      return;
    }
    const script = document.createElement('script');
    script.src = D3_CDN_URL;
    script.dataset.mapcoreD3 = 'true';
    script.onload = () => resolve(globalThis.d3);
    script.onerror = () => reject(new Error('mapCore: failed to load D3 from CDN'));
    document.head.appendChild(script);
  });
  return _d3Promise;
}

// ---------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------

/**
 * Parse a shape row's WKT geometry into rings, tolerating missing/blank
 * geometry (returns []) so one bad row never crashes a whole layer render.
 * @param {{geometry?: string}} row
 * @returns {Array<Array<{x:number,y:number}>>}
 */
export function ringsOf(row) {
  if (!row || !row.geometry) return [];
  return parseWKTPolygon(row.geometry);
}

/**
 * Bounding box across a set of shapes' rings.
 * @param {Array<{rings: Array<Array<{x:number,y:number}>>}>} shapes
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null} null if no points at all
 */
export function computeExtent(shapes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const shape of shapes) {
    for (const ring of shape.rings) {
      for (const p of ring) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Build plain x/y scale functions that fit `extent` into a `width` x
 * `height` viewport with uniform scaling (aspect-ratio preserved,
 * centered) and Y flipped (data Y increases "north", SVG Y increases
 * downward — flipping gives a conventional north-up look).
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} extent
 * @param {number} width
 * @param {number} height
 * @param {number} [padding]
 * @returns {{xScale:(x:number)=>number, yScale:(y:number)=>number}}
 */
export function buildScales(extent, width, height, padding = 16) {
  const dataW = Math.max(extent.maxX - extent.minX, 1e-6);
  const dataH = Math.max(extent.maxY - extent.minY, 1e-6);
  const availW = Math.max(width - padding * 2, 1);
  const availH = Math.max(height - padding * 2, 1);
  const scale = Math.min(availW / dataW, availH / dataH);
  const offsetX = padding + (availW - dataW * scale) / 2 - extent.minX * scale;
  const offsetY = padding + (availH - dataH * scale) / 2;
  const xScale = (x) => x * scale + offsetX;
  const yScale = (y) => offsetY + (extent.maxY - y) * scale;
  return { xScale, yScale };
}

/**
 * Build an SVG path `d` string for a (possibly multi-ring) polygon using
 * D3's line generator for the actual point-to-path plotting.
 * @param {Object} d3
 * @param {Array<Array<{x:number,y:number}>>} rings
 * @param {(x:number)=>number} xScale
 * @param {(y:number)=>number} yScale
 * @returns {string}
 */
export function ringsPathD(d3, rings, xScale, yScale) {
  const line = d3.line().x((p) => xScale(p.x)).y((p) => yScale(p.y));
  return rings
    .filter((ring) => ring.length > 0)
    .map((ring) => `${line(ring)}Z`)
    .join(' ');
}

// ---------------------------------------------------------------------
// Color helpers — reuse css/base.css's --spectrum-* / --status-* custom
// properties; never redefine their values here.
// ---------------------------------------------------------------------

const SPECTRUM_VAR = { Left: '--spectrum-left', MR: '--spectrum-mr', Right: '--spectrum-right' };
const STATUS_VAR = {
  'Not received': '--status-not-received',
  Verifying: '--status-verifying',
  Counting: '--status-counting',
  Declared: '--status-declared',
};

/** @returns {string|null} CSS `var(...)` reference for a spectrum id, or null if unknown. */
export function spectrumColorVar(spectrumId) {
  const v = SPECTRUM_VAR[spectrumId];
  return v ? `var(${v})` : null;
}

/** @returns {string} CSS `var(...)` reference for a status label (falls back to not-received). */
export function statusColorVar(status) {
  return `var(${STATUS_VAR[status] || STATUS_VAR['Not received']})`;
}

/**
 * Resolves a `var(--custom-prop)` string (as returned by spectrumColorVar/
 * statusColorVar) to its actual computed color, by reading the custom
 * property straight off `:root`. Returns the input unchanged if it isn't a
 * `var(...)` reference, or resolution isn't possible for any reason (no
 * `document`, property not actually a hex color, etc.) -- callers that need
 * a literal RGB value (`tintColor` below) already treat "didn't resolve" as
 * "just use the original color", so this never needs to throw.
 */
function resolveCssColor(colorRef) {
  if (typeof colorRef !== 'string') return colorRef;
  const m = colorRef.match(/^var\((--[\w-]+)\)$/);
  if (!m || typeof document === 'undefined' || typeof getComputedStyle !== 'function') return colorRef;
  const value = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
  return value || colorRef;
}

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

// Fixed light-gray mix target for `tintColor` -- NOT theme-dependent (no
// dark-mode variant) on purpose: the whole point is a result that reads the
// same regardless of the page's own background, rather than blending
// toward whatever that background happens to be (see `tintColor`'s doc
// comment for why that's the actual problem being solved).
const TINT_TARGET = { r: 232, g: 232, b: 236 };

/**
 * Mixes a `var(--...)`/hex color reference toward a fixed light gray by
 * `ratio` (1 = color unchanged, 0 = pure light gray), returning a literal
 * hex string. Used for the mobile-only "solid vote-share shading" path in
 * electionMap.js's `shareFillColor` -- a semi-transparent `fill-opacity`
 * blends toward whatever the PAGE background happens to be, which reads
 * fine against base.css's white light-mode background but reads as a dim,
 * muddy smear against dark mode's near-black one. Mixing at the color level
 * instead, toward a FIXED reference, produces the same legible pastel-to-
 * vivid result regardless of theme. Returns the input unchanged if it can't
 * be resolved to a literal hex color (e.g. `resolveCssColor` gave up).
 * @param {string} colorRef
 * @param {number} ratio 0..1
 */
export function tintColor(colorRef, ratio) {
  const rgb = hexToRgb(resolveCssColor(colorRef));
  if (!rgb) return colorRef;
  const t = Math.max(0, Math.min(1, ratio));
  return rgbToHex({
    r: TINT_TARGET.r + (rgb.r - TINT_TARGET.r) * t,
    g: TINT_TARGET.g + (rgb.g - TINT_TARGET.g) * t,
    b: TINT_TARGET.b + (rgb.b - TINT_TARGET.b) * t,
  });
}

/** Pick the highest-value key of a {Left,Right,MR} totals object, or null if all zero. */
export function argmaxSpectrum(totals) {
  let best = null;
  let bestVal = 0;
  for (const key of ['Left', 'Right', 'MR']) {
    const v = totals[key] || 0;
    if (v > bestVal) {
      bestVal = v;
      best = key;
    }
  }
  return best;
}

export function formatPercent(n) {
  return `${(n || 0).toFixed(1)}%`;
}

/**
 * Single source of truth for "is this the phone-width layout" (css/
 * mobile.css's own breakpoint) -- used wherever map behavior itself (not
 * just its CSS) needs to differ on a phone: the zoom ceiling and fill-color
 * contrast floor below, plus electionMap.js's own color-floor use. Desktop/
 * tablet behavior at every call site is whatever it already was before this
 * existed -- this only ever ADDS a mobile-specific branch, never changes
 * the un-matched (desktop) path.
 */
export function isCompactViewport() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
}

// ---------------------------------------------------------------------
// Chrome (SVG scaffold + toolbar + legend + tooltip), shared by both map
// components. Built once per mount; layers are re-rendered into the same
// zoom layer on every drill/reset.
// ---------------------------------------------------------------------

/**
 * @param {HTMLElement} container
 * @param {Object} d3
 * @param {{title?: string}} [opts]
 */
export function buildChrome(container, d3, opts = {}) {
  container.innerHTML = '';
  container.classList.add('map-root');

  const toolbar = document.createElement('div');
  toolbar.className = 'map-toolbar';

  const breadcrumb = document.createElement('div');
  breadcrumb.className = 'map-breadcrumb';
  toolbar.appendChild(breadcrumb);

  container.appendChild(toolbar);

  const stage = document.createElement('div');
  stage.className = 'map-stage';
  container.appendChild(stage);

  const width = 960;
  const height = 640;

  const svg = d3
    .select(stage)
    .append('svg')
    .attr('class', 'map-svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  const zoomLayer = svg.append('g').attr('class', 'map-zoom-layer');
  const shapeLayer = zoomLayer.append('g').attr('class', 'map-shape-layer');

  // Max zoom scale is a FRACTION of the viewBox's fixed 960x640 extent, not
  // an absolute pixel size -- at the same scale, a phone-width map (css/
  // mobile.css's full-bleed treatment puts this around 350-380 CSS px) and a
  // desktop-width one (~900px+) both show the identical fraction of the
  // country, just rendered into far fewer physical pixels on the phone. A
  // tiny precinct that's comfortably visible at 20x on desktop can still be
  // sliver-thin on mobile at that same scale. Compact viewports get a
  // proportionally higher ceiling so pinch/tap-to-zoom can actually reach a
  // similarly legible size, rather than bottoming out below it.
  const maxZoomScale = isCompactViewport() ? 50 : 20;

  const zoom = d3
    .zoom()
    .scaleExtent([1, maxZoomScale])
    .on('zoom', (event) => {
      zoomLayer.attr('transform', event.transform);
    });
  svg.call(zoom);

  // Control cluster: zoom in/out, up-one-level, and reset, stacked together
  // in the map's top-left corner (previously zoom was scroll/drag-only and
  // reset lived alone in the toolbar) — one place for every navigation
  // action on the map itself.
  const controls = document.createElement('div');
  controls.className = 'map-controls';
  const zoomInBtn = controlButton('+', 'Zoom in');
  const zoomOutBtn = controlButton('−', 'Zoom out');
  const upBtn = controlButton('⌃', 'Up one level');
  const resetBtn = controlButton('×', 'Reset');
  controls.append(zoomInBtn, zoomOutBtn, upBtn, resetBtn);
  stage.appendChild(controls);

  zoomInBtn.addEventListener('click', () => svg.transition().duration(200).call(zoom.scaleBy, 1.4));
  zoomOutBtn.addEventListener('click', () => svg.transition().duration(200).call(zoom.scaleBy, 1 / 1.4));

  const tooltip = document.createElement('div');
  tooltip.className = 'map-tooltip';
  tooltip.hidden = true;
  stage.appendChild(tooltip);

  const legend = document.createElement('div');
  legend.className = 'map-legend';
  container.appendChild(legend);

  const statusLine = document.createElement('div');
  statusLine.className = 'map-status-line';
  container.appendChild(statusLine);

  function resetZoom() {
    svg.transition().duration(200).call(zoom.transform, d3.zoomIdentity);
  }

  /** Apply an arbitrary d3.zoomIdentity-based transform (see `zoomTransformToFit` below). */
  function zoomTo(transform, duration = 400) {
    svg.transition().duration(duration).call(zoom.transform, transform);
  }

  function showTooltip(event, html) {
    // On a phone, a tap fires the same hover/click handlers a mouse would,
    // so this hover tooltip used to pop up right on top of the shape the
    // user just tapped -- AND the tap's own onUnitClick already opens the
    // bottom-sheet card (css/mobile.css) with the same result. Two
    // overlapping info boxes over a map that's already small; the sheet is
    // the one actually meant for touch, so the hover tooltip just stays
    // hidden here instead of fighting it for the same screen space. Desktop
    // (a real mouse hover, no sheet involved) is unaffected.
    if (isCompactViewport()) return;
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    positionTooltip(event);
  }

  function positionTooltip(event) {
    const rect = stage.getBoundingClientRect();
    const x = (event.clientX ?? 0) - rect.left + 12;
    const y = (event.clientY ?? 0) - rect.top + 12;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  return {
    container,
    toolbar,
    breadcrumb,
    resetBtn,
    upBtn,
    stage,
    svg,
    shapeLayer,
    tooltip,
    legend,
    statusLine,
    width,
    height,
    maxZoomScale,
    resetZoom,
    zoomTo,
    showTooltip,
    positionTooltip,
    hideTooltip,
  };
}

/**
 * Build a d3.zoomIdentity transform that fits a data-space bounding box
 * (already run through the SAME xScale/yScale a render call used) into the
 * viewport, for "auto-zoom to the active region" behavior (e.g. NYT-style
 * maps zooming into a clicked state). Returns `null` if there's nothing
 * sensible to fit (empty extent).
 * @param {Object} d3
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} extent data-space extent to fit
 * @param {(x:number)=>number} xScale
 * @param {(y:number)=>number} yScale
 * @param {number} width viewport width
 * @param {number} height viewport height
 * @param {number} [padding]
 * @param {number} [maxScale] matches the zoom behavior's own scaleExtent max
 */
export function zoomTransformToFit(d3, extent, xScale, yScale, width, height, padding = 30, maxScale = 20) {
  if (!extent) return null;
  const x0 = xScale(extent.minX);
  const x1 = xScale(extent.maxX);
  const y0 = yScale(extent.maxY); // Y is flipped by buildScales
  const y1 = yScale(extent.minY);
  const screenW = Math.max(x1 - x0, 1e-6);
  const screenH = Math.max(y1 - y0, 1e-6);
  const scale = Math.min((width - padding * 2) / screenW, (height - padding * 2) / screenH, maxScale);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return d3.zoomIdentity.translate(width / 2 - scale * cx, height / 2 - scale * cy).scale(scale);
}

function controlButton(label, title) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'map-controls__btn';
  btn.textContent = label;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

/**
 * Render a legend of {label, color} swatches (color = a css `var(...)` string).
 * @param {HTMLElement} el
 * @param {Array<{label:string,color:string}>} items
 */
export function renderLegend(el, items) {
  el.innerHTML = '';
  for (const item of items) {
    const swatch = document.createElement('span');
    swatch.className = 'map-legend__item';
    const dot = document.createElement('span');
    dot.className = 'map-legend__dot';
    dot.style.background = item.color;
    swatch.appendChild(dot);
    swatch.appendChild(document.createTextNode(item.label));
    el.appendChild(swatch);
  }
}

/**
 * Data-join a set of shapes into `<path>` elements inside `shapeLayer`,
 * fitting the scale to their combined extent. This is the core primitive
 * both map components call once per layer/render.
 *
 * @param {Object} d3
 * @param {d3.Selection} shapeLayer
 * @param {number} width
 * @param {number} height
 * @param {Array<{
 *   id: string,
 *   rings: Array<Array<{x:number,y:number}>>,
 *   fill: string,
 *   fillOpacity?: number,
 *   className?: string,
 *   interactive?: boolean,
 * }>} shapes
 * @param {{
 *   onClick?: (id:string, event) => void,
 *   onHover?: (id:string, event) => void,
 *   onHoverEnd?: (id:string, event) => void,
 * }} handlers
 */
export function renderShapes(d3, shapeLayer, width, height, shapes, handlers = {}) {
  const extent = computeExtent(shapes);
  const scales = extent ? buildScales(extent, width, height) : { xScale: (x) => x, yScale: (y) => y };

  const sel = shapeLayer.selectAll('path.map-shape').data(shapes, (d) => d.id);

  sel.exit().remove();

  const entered = sel
    .enter()
    .append('path')
    .attr('class', (d) => `map-shape ${d.className || ''}`.trim());

  const merged = entered.merge(sel);

  merged
    .attr('d', (d) => ringsPathD(d3, d.rings, scales.xScale, scales.yScale))
    .attr('fill', (d) => d.fill)
    .style('fill-opacity', (d) => (d.fillOpacity == null ? 1 : d.fillOpacity))
    .attr('class', (d) => `map-shape ${d.className || ''}`.trim())
    .style('cursor', (d) => (d.interactive === false ? 'default' : 'pointer'))
    .on('click', function onClickHandler(event, d) {
      if (d.interactive === false) return;
      handlers.onClick?.(d.id, event);
    })
    .on('mousemove', function onMoveHandler(event, d) {
      handlers.onHover?.(d.id, event);
    })
    .on('mouseleave', function onLeaveHandler(event, d) {
      handlers.onHoverEnd?.(d.id, event);
    });

  return scales;
}
