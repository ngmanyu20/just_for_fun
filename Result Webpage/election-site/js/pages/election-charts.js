/**
 * election-charts.js — D3 bar charts for the General Election pages
 * (Alma Vale round 1 / round 2, General Proportional stage 1 / stage 2).
 *
 * D3 is loaded via a CDN `<script>` tag on each page that needs a chart
 * (see the html files) rather than vendored — d3@7, https://cdn.jsdelivr.net.
 * This module reads the resulting `window.d3` global; it does not `import`
 * d3 as an ES module. Chose the CDN over vendoring per BUILD_NOTES.md's
 * "your choice, state which" — no offline/build-time requirement for this
 * demo, so a CDN script tag is the smaller diff.
 *
 * Mark spec + interaction rules follow the dataviz skill loaded for this
 * build: bars capped at 24px thick with a 2px surface gap, 4px rounded
 * data-end square at the baseline (drawn as a path, not `rx` on all four
 * corners), hairline recessive gridlines, direct value labels only where
 * they fit, and a shared hover tooltip (value leads, label follows) whose
 * text is inserted via textContent/DOM (category/series labels come from
 * CSV-derived data and are treated as untrusted for innerHTML purposes).
 */

import { TRANSFER_COLUMNS, SPECTRUMS, findSpectrum } from '../data.js';
import { formatNumber, spectrumColor, shadeSteps } from './election-common.js';

const d3 = window.d3;

const MARGIN = { top: 20, right: 16, bottom: 50, left: 54 };
const BAR_MAX_WIDTH = 24;
const NIL_COLOR = '#9aa0a6';

let _tooltipEl = null;
function getTooltipEl() {
  if (_tooltipEl) return _tooltipEl;
  const div = document.createElement('div');
  div.className = 'bar-tooltip';
  document.body.appendChild(div);
  _tooltipEl = div;
  return div;
}

function showTooltip(event, d, valueFormat) {
  const tooltip = getTooltipEl();
  tooltip.replaceChildren();
  const valueEl = document.createElement('div');
  valueEl.className = 'bar-tooltip__value';
  valueEl.textContent = valueFormat(d.value);
  const labelEl = document.createElement('div');
  labelEl.textContent = d.tooltipLabel || d.label;
  tooltip.appendChild(valueEl);
  tooltip.appendChild(labelEl);
  tooltip.style.opacity = '1';
  tooltip.style.left = `${event.clientX + 14}px`;
  tooltip.style.top = `${event.clientY + 14}px`;
}

function hideTooltip() {
  if (_tooltipEl) _tooltipEl.style.opacity = '0';
}

/** SVG path for a bar with rounded top corners, square at the baseline. */
function roundedTopBarPath(x, y, w, h, r) {
  if (h <= 0) return `M${x},${y} L${x + w},${y} Z`;
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return [
    `M${x},${y + h}`,
    `L${x},${y + rr}`,
    `Q${x},${y} ${x + rr},${y}`,
    `L${x + w - rr},${y}`,
    `Q${x + w},${y} ${x + w},${y + rr}`,
    `L${x + w},${y + h}`,
    'Z',
  ].join(' ');
}

/**
 * Generic grouped bar chart. Not exported — every chart on this site goes
 * through one of the named builders below so labeling/tooltip conventions
 * stay consistent; this is the shared renderer they call into.
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {Array<{id:string, label:string, tooltipLabel?:string, value:number, color:string}>} opts.bars
 * @param {string} [opts.yLabel]
 * @param {(n:number)=>string} [opts.valueFormat]
 * @param {number} [opts.height]
 */
function renderBarChart(container, { bars, yLabel = '', valueFormat = formatNumber, height = 260 }) {
  container.replaceChildren();

  if (!d3) {
    const msg = document.createElement('p');
    msg.className = 'empty-msg';
    msg.textContent = 'Chart library (D3) failed to load.';
    container.appendChild(msg);
    return;
  }
  if (!bars || !bars.length || bars.every((b) => !b.value)) {
    const msg = document.createElement('p');
    msg.className = 'empty-msg';
    msg.textContent = 'No declared votes yet.';
    container.appendChild(msg);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'chart-svg-wrap';
  container.appendChild(wrap);

  const width = Math.max(bars.length * 64, 360);
  const svg = d3
    .select(wrap)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('role', 'img')
    .attr('aria-label', yLabel || 'bar chart');

  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

  const x = d3
    .scaleBand()
    .domain(bars.map((_, i) => String(i)))
    .range([0, innerW])
    .paddingInner(0.35)
    .paddingOuter(0.25);

  const maxVal = d3.max(bars, (b) => b.value) || 1;
  const y = d3.scaleLinear().domain([0, maxVal]).nice().range([innerH, 0]);

  // Recessive hairline gridlines (y-axis), per the skill's mark spec.
  g.append('g')
    .attr('class', 'chart-axis')
    .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(d3.format('~s')))
    .call((sel) => sel.select('.domain').remove())
    .call((sel) => sel.selectAll('line').attr('stroke-dasharray', 'none'));

  // Category axis.
  const xAxisG = g
    .append('g')
    .attr('class', 'chart-axis')
    .attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(x).tickFormat((_, i) => bars[i].label).tickSizeOuter(0));
  xAxisG
    .selectAll('text')
    .attr('transform', 'rotate(-18)')
    .style('text-anchor', 'end')
    .attr('dx', '-0.3em');

  const barW = Math.min(x.bandwidth(), BAR_MAX_WIDTH);
  const barOffset = (x.bandwidth() - barW) / 2;

  const barsSel = g
    .selectAll('path.bar')
    .data(bars)
    .join('path')
    .attr('class', 'bar')
    .attr('d', (d, i) => roundedTopBarPath(x(String(i)) + barOffset, y(d.value), barW, innerH - y(d.value), 4))
    .attr('fill', (d) => d.color)
    .attr('tabindex', 0)
    .style('cursor', 'pointer')
    .style('outline', 'none');

  barsSel
    .on('pointerenter pointermove', (event, d) => showTooltip(event, d, valueFormat))
    .on('pointerleave', hideTooltip)
    .on('focus', (event, d) => showTooltip(event, d, valueFormat))
    .on('blur', hideTooltip);

  // Direct value labels above each bar (sparing -- one per bar here since
  // there are at most 9, all part of the same story; skip if it would
  // collide with the top of the chart).
  g.selectAll('text.chart-bar-label')
    .data(bars)
    .join('text')
    .attr('class', 'chart-bar-label')
    .attr('x', (_, i) => x(String(i)) + x.bandwidth() / 2)
    .attr('y', (d) => Math.max(10, y(d.value) - 6))
    .attr('text-anchor', 'middle')
    .text((d) => (d.value > 0 ? valueFormat(d.value) : ''));
}

// ---------------------------------------------------------------------
// Legend (plain HTML row, not part of the SVG — mirrors marks-and-anatomy's
// "legend always present for >=2 series" rule).
// ---------------------------------------------------------------------

/**
 * @param {HTMLElement} container
 * @param {Array<{label:string, color:string}>} items
 */
export function renderLegend(container, items) {
  container.replaceChildren();
  for (const item of items) {
    const row = document.createElement('span');
    row.className = 'legend-row__item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = item.color;
    const label = document.createElement('span');
    label.textContent = item.label;
    row.appendChild(swatch);
    row.appendChild(label);
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------------
// Alma Vale (and any other Supplementary Vote seat) -- round 1 / round 2.
// ---------------------------------------------------------------------

const SHORT_SPECTRUM = { Left: 'L', Right: 'R', MR: 'M' };

/**
 * Round 1: all 9 first-pref x second-pref columns. Each spectrum's 3
 * columns render as 3 shades of that spectrum's color (Section 4) -- shade
 * is assigned by *destination* (to Left / to Right / to MR), so the same
 * shade slot means the same thing across all three spectrum clusters.
 * @param {HTMLElement} container
 * @param {Record<string, number>} totals the 9 TRANSFER_COLUMNS totals (e.g. seat.totals or detail totals)
 * @param {Object} electionMeta
 */
export function renderRound1Chart(container, totals, electionMeta) {
  const bars = TRANSFER_COLUMNS.map((col) => {
    const [source, dest] = col.split('_');
    const base = spectrumColor(source);
    const shades = shadeSteps(base, 3);
    const shadeIndex = SPECTRUMS.indexOf(dest); // 0=Left,1=Right,2=MR -- fixed, consistent across clusters
    const sourceMeta = findSpectrum(electionMeta, source);
    const destMeta = findSpectrum(electionMeta, dest);
    const sourceName = sourceMeta ? sourceMeta.name : source;
    const destName = destMeta ? destMeta.name : dest;
    const isNil = source === dest;
    return {
      id: col,
      label: `${SHORT_SPECTRUM[source]}→${SHORT_SPECTRUM[dest]}`,
      tooltipLabel: isNil
        ? `${sourceName}: no 2nd preference (exhausts to NIL if ${sourceName} is eliminated)`
        : `${sourceName} → ${destName} (2nd preference)`,
      value: Number(totals && totals[col]) || 0,
      color: shades[shadeIndex],
    };
  });
  renderBarChart(container, { bars, yLabel: 'Round 1 votes by 2nd preference' });
}

/**
 * Round 2: the two remaining spectrums (after the lowest is eliminated) +
 * NIL (exhausted ballots) -- only rendered when `computeSupplementaryVote`
 * reports a round 2 (no outright majority in round 1). Caller is
 * responsible for checking `svResult.round2` is non-null before calling
 * this (Section 4: "only when triggered").
 * @param {HTMLElement} container
 * @param {{round2: Record<string,number>, nil: number, eliminated: string}} svResult
 * @param {Object} electionMeta
 */
export function renderRound2Chart(container, svResult, electionMeta) {
  const remaining = Object.keys(svResult.round2 || {});
  const eliminatedMeta = findSpectrum(electionMeta, svResult.eliminated);
  const bars = remaining.map((s) => {
    const meta = findSpectrum(electionMeta, s);
    return {
      id: s,
      label: SHORT_SPECTRUM[s] || s,
      tooltipLabel: meta ? meta.name : s,
      value: Number(svResult.round2[s]) || 0,
      color: spectrumColor(s),
    };
  });
  bars.push({
    id: 'NIL',
    label: 'NIL',
    tooltipLabel: `Exhausted ballots (${eliminatedMeta ? eliminatedMeta.name : svResult.eliminated} eliminated, no 2nd preference)`,
    value: Number(svResult.nil) || 0,
    color: NIL_COLOR,
  });
  renderBarChart(container, { bars, yLabel: 'Round 2 votes' });
}

// ---------------------------------------------------------------------
// General Proportional -- stage 1 (per list) / stage 2 (per party within list).
// ---------------------------------------------------------------------

/**
 * Resolve a list's display color from its first member party's spectrum,
 * falling back to spectrumColor(list.id) when no member party resolves --
 * General Proportional's `Right` list-party has no `parties[]` entry of its
 * own (FEATURE_SPEC.md "Open items"), but its list id ("Right") is itself a
 * real spectrum id here.
 */
function listColor(list, electionMeta) {
  for (const abbrev of list.parties.map((p) => (typeof p === 'string' ? p : p.abbreviation))) {
    const party = electionMeta.parties.find((p) => p.abbreviation === abbrev);
    if (party) return spectrumColor(party.spectrum);
  }
  return spectrumColor(list.id);
}

/**
 * Stage 1: seats-per-list allocation, one bar per list, colored by the
 * list's (dominant) spectrum.
 * @param {HTMLElement} container
 * @param {Array<Object>} lists `computeProportionalAllocation()`'s `lists[]`
 * @param {Object} electionMeta
 */
export function renderStage1Chart(container, lists, electionMeta) {
  const bars = lists.map((list) => ({
    id: list.id,
    label: list.id,
    tooltipLabel: `${list.id} list — ${formatNumber(list.votes)} votes (${list.percent.toFixed(1)}%), ${list.seats} seat${list.seats === 1 ? '' : 's'}${list.qualified ? '' : ' — below the 15% gate'}`,
    value: list.votes,
    color: listColor(list, electionMeta),
  }));
  renderBarChart(container, { bars, yLabel: 'List votes (Stage 1)' });
}

/**
 * Stage 2: seats-within-a-list allocation for one multi-party list, each
 * member party shown as a shade of the list's spectrum color (Section 3:
 * "party-level bars use shades of the parent spectrum's color"). Caller
 * should only invoke this for lists with 2+ parties (single-party lists
 * skip Stage 2 entirely per the algorithm).
 * @param {HTMLElement} container
 * @param {Object} list one entry from `lists[]` with `list.parties.length >= 2`
 * @param {Object} electionMeta
 */
export function renderStage2Chart(container, list, electionMeta) {
  const base = listColor(list, electionMeta);
  const shades = shadeSteps(base, list.parties.length);
  const bars = list.parties.map((party, i) => {
    const meta = electionMeta.parties.find((p) => p.abbreviation === party.abbreviation);
    return {
      id: party.abbreviation,
      label: party.abbreviation,
      tooltipLabel: `${meta ? meta.name : party.abbreviation} — ${formatNumber(party.votes)} votes (${party.percent.toFixed(1)}% of valid), ${party.seats} seat${party.seats === 1 ? '' : 's'}`,
      value: party.votes,
      color: shades[i],
    };
  });
  renderBarChart(container, { bars, yLabel: `${list.id} list — seats within list (Stage 2)`, height: 220 });
}
