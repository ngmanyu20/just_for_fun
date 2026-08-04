/**
 * election-common.js — shared DOM/formatting helpers for the General
 * Election pages (index.html + election-*.html). Not part of the data
 * layer contract — pure presentation utilities that sit on top of it.
 *
 * Judgment call (flagged): FEATURE_SPEC.md Section 4 says a seat-type
 * overview should "reflect partial completion honestly." js/data.js's
 * getOverview()/getAlmaValeSeats()/etc. compute a winner from whatever rows
 * are currently Declared, even if the seat isn't fully reported yet (see
 * results.js's own doc comment on Declared-only vote totals). That's the
 * right behavior for the seat-detail math, but the *overview* page needs to
 * distinguish "fully declared, this is final" from "partial data, this is
 * provisional" before crediting a party with a won seat. `isFullyDeclared`
 * below is this page layer's gate for that — it does not change or
 * reimplement any election-method math, only decides whether to *display*
 * a computed winner as decided.
 */

import { STATUS, findParty } from '../data.js';

// ---------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------

export function formatNumber(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString() : '0';
}

export function formatPercent(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${Number(n).toFixed(digits)}%`;
}

/**
 * Turnout is only visible once a row has reached "Counting" (Section 2) —
 * the data layer returns `null` (not `0`) for a row/unit that hasn't yet,
 * so this renders that as "not yet counted" rather than a misleading "0".
 */
export function formatTurnout(n) {
  return n == null ? '—' : formatNumber(n);
}

// ---------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------

const STATUS_CLASS = {
  [STATUS.NOT_RECEIVED]: 'not-received',
  [STATUS.VERIFYING]: 'verifying',
  [STATUS.COUNTING]: 'counting',
  [STATUS.DECLARED]: 'declared',
};

/** @returns {HTMLElement} a `.status-badge` element (base.css) for `status`. */
export function statusBadge(status) {
  const span = document.createElement('span');
  const cls = STATUS_CLASS[status] || 'not-received';
  span.className = `status-badge status-badge--${cls}`;
  span.textContent = status || STATUS.NOT_RECEIVED;
  return span;
}

/**
 * A seat/sector's underlying data is only "final" once every contributing
 * row is Declared (electorate-weighted %, not just >0%) — Section 2's
 * status pipeline applies per-row, and "partial" data should never be
 * presented as a settled outcome.
 * @param {{totalRows:number, byStatus:Object}} statusSummary result of
 *   `summarizeStatus()` (re-exported via the seat summary objects).
 */
export function isFullyDeclared(statusSummary) {
  if (!statusSummary || !statusSummary.totalRows) return false;
  const declared = statusSummary.byStatus && statusSummary.byStatus[STATUS.DECLARED];
  return !!declared && declared.count === statusSummary.totalRows;
}

/**
 * Declaration gate for a Supplementary Vote seat/sub-row (Alma Vale, Home
 * Districts, General Direct -- results.js's `certainty` field, computed by
 * `resolveSupplementaryVoteCertainty()` in data/supplementaryVote.js). A
 * result becomes safe to present as settled once it's mathematically
 * certain the outstanding undeclared ballots can't change it -- which can
 * happen well before every row is literally Declared (e.g. 99.8% declared
 * with a wide enough margin) -- so this replaces `isFullyDeclared()` as the
 * winner-display gate for any seat carrying a `certainty` field. Seats from
 * a different election method (General Proportional's HareQuotaLRM) have
 * no `certainty` field and are unaffected -- they keep using `isFullyDeclared()`.
 * @param {{certainty?: {resultCertain: boolean}}} seat
 */
export function isResultCertain(seat) {
  return !!(seat && seat.certainty && seat.certainty.resultCertain);
}

// ---------------------------------------------------------------------
// Spectrum / party color
// ---------------------------------------------------------------------

const SPECTRUM_CSS_VAR = { Left: '--spectrum-left', MR: '--spectrum-mr', Right: '--spectrum-right' };

/** Resolve a spectrum id ('Left'|'MR'|'Right') to its CSS custom-property color (base.css). */
export function spectrumColor(spectrumId) {
  const varName = SPECTRUM_CSS_VAR[spectrumId];
  if (!varName) return '#999999';
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return val || '#999999';
}

function clamp255(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return { r: 153, g: 153, b: 153 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function rgbToHex({ r, g, b }) {
  const h = (n) => clamp255(n).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Mix `hex` toward `towardHex` by `amount` (0..1). Simple linear RGB blend. */
function mixHex(hex, towardHex, amount) {
  const a = hexToRgb(hex);
  const b = hexToRgb(towardHex);
  return rgbToHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  });
}

/**
 * Ordinal, single-hue lightness ramp for a base spectrum/party color —
 * "three shades of that party's spectrum color" (FEATURE_SPEC.md Section
 * 4). Per the dataviz skill: an ordinal ramp is one hue + monotone
 * lightness steps (not the 8-hue categorical formula, which doesn't apply
 * here since every step shares one hue by design). Steps are a fixed mix
 * toward white/black rather than eyeballed hex values, so they stay
 * reproducible and consistent across every chart on the site.
 * @param {string} hex base color
 * @param {number} [count=3]
 * @returns {string[]} lightest -> darkest
 */
export function shadeSteps(hex, count = 3) {
  if (count <= 1) return [hex];
  if (count === 2) return [mixHex(hex, '#ffffff', 0.3), mixHex(hex, '#000000', 0.22)];
  if (count === 3) return [mixHex(hex, '#ffffff', 0.42), hex, mixHex(hex, '#000000', 0.32)];
  // Generic N (e.g. a future list with 4+ member parties): evenly spaced
  // lightness steps between the same light/dark extremes used above, so an
  // N=3 ramp and an N=5 ramp stay visually consistent with each other.
  const lightExtreme = mixHex(hex, '#ffffff', 0.42);
  const darkExtreme = mixHex(hex, '#000000', 0.32);
  const steps = [];
  for (let i = 0; i < count; i++) steps.push(mixHex(lightExtreme, darkExtreme, i / (count - 1)));
  return steps;
}

/**
 * Big-number + label row, one item per spectrum, positioned along a fixed
 * ideological-spectrum ruler (Left pinned to the start, Right to the end,
 * everything else evenly spaced between — NOT proportional to the values
 * shown, just axis labeling). `.spectrum-summary` (css/results.css).
 * Shared by the overview page's seats-so-far header and Alma Vale's
 * vote-share header — each supplies its own big-number/label pair per
 * spectrum via `getContent`.
 * @param {Object} electionMeta
 * @param {(spectrum:{id:string,name:string}) => {value:string, label:string}} getContent
 */
export function spectrumSummaryRow(electionMeta, getContent) {
  const row = el('div', { className: 'spectrum-summary' });
  const spectrums = electionMeta.spectrums;
  spectrums.forEach((spectrum, i) => {
    const { value, label } = getContent(spectrum);
    const posPct = spectrums.length > 1 ? (i / (spectrums.length - 1)) * 100 : 50;
    const anchor = posPct <= 0 ? 'start' : posPct >= 100 ? 'end' : 'center';
    row.appendChild(
      el('div', { className: `spectrum-summary__item spectrum-summary__item--${anchor}`, attrs: { style: `left:${posPct}%` } }, [
        el('div', { className: 'spectrum-summary__value', attrs: { style: `color:${spectrumColor(spectrum.id)}` }, text: value }),
        el('div', { className: 'spectrum-summary__label', attrs: { style: `color:${spectrumColor(spectrum.id)}` }, text: label }),
      ])
    );
  });
  return row;
}

/**
 * Small colored-dot + abbreviation "pill" for a party — no candidate names
 * anywhere (Section 3), so this is the finest-grained identity marker used
 * on any page.
 * @param {Object} electionMeta
 * @param {string|null} abbrev party abbreviation, or null/undefined for "no result yet"
 */
export function partyPill(electionMeta, abbrev) {
  const wrap = document.createElement('span');
  wrap.className = 'party-pill' + (abbrev ? '' : ' party-pill--muted');
  const party = abbrev ? findParty(electionMeta, abbrev) : null;
  const dot = document.createElement('span');
  dot.className = 'party-pill__dot';
  dot.style.background = party ? spectrumColor(party.spectrum) : '#999999';
  wrap.appendChild(dot);
  const label = document.createElement('span');
  label.textContent = abbrev || 'Undecided';
  wrap.appendChild(label);
  return wrap;
}

// ---------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------

/**
 * Build the href for a seat's detail page. Local Representative (General
 * Direct's derived seat, Section 4) routes to its own sub-page instead of
 * the normal precinct/sub-row detail view.
 * @param {string} seatTypeId
 * @param {string} constituency
 * @param {string} [subConstituency]
 */
export function seatDetailHref(seatTypeId, constituency) {
  if (seatTypeId === 'GeneralDirect' && constituency === 'Local Representative') {
    return 'election-local-representative.html';
  }
  const params = new URLSearchParams({ type: seatTypeId, constituency });
  return `election-seat.html?${params.toString()}`;
}

export const SEAT_TYPE_PAGE = {
  AlmaVale: 'election-alma-vale.html',
  HomeDistricts: 'election-home-districts.html',
  GeneralDirect: 'election-general-direct.html',
  GeneralProportional: 'election-general-proportional.html',
};

export const SEAT_TYPE_LABEL = {
  AlmaVale: 'Alma Vale',
  HomeDistricts: 'Home Districts',
  GeneralDirect: 'General Direct',
  GeneralProportional: 'General Proportional',
};

/** Render a DOM error message into `container` (used from every page's top-level catch). */
export function renderError(container, err) {
  console.error(err);
  const div = document.createElement('div');
  div.className = 'error-msg';
  div.textContent = `Couldn't load this page's data: ${err && err.message ? err.message : err}`;
  container.replaceChildren(div);
}

/** Clear a container and append one or more nodes. */
export function setContent(container, ...nodes) {
  container.replaceChildren(...nodes);
}

// ---------------------------------------------------------------------
// Map mounting (shared between election-alma-vale.js's unlocked national
// map and election-seat.js's lockToConstituency map). FEATURE_SPEC.md
// Section 1's County/District toggle is "site-wide", so both pages read/
// write the same localStorage key rather than each keeping their own
// independent mode — switching it on one page carries over to the other.
// ---------------------------------------------------------------------

export const MAP_MODE_KEY = 'electionMapMode';

/** @returns {'county'|'district'} the shared, persisted map mode. */
export function currentMapMode() {
  return localStorage.getItem(MAP_MODE_KEY) === 'district' ? 'district' : 'county';
}

/**
 * `.map-toggle` County/District buttons (css/results.css). `onChange(mode)`
 * fires after the shared localStorage key is updated, so the caller can
 * push the new mode into its own live map handle.
 * @param {(mode: 'county'|'district') => void} onChange
 */
export function mapToggleControls(onChange) {
  const wrap = el('div', { className: 'map-toggle' });
  const savedMode = currentMapMode();
  for (const mode of ['county', 'district']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = mode === 'county' ? 'County' : 'District';
    btn.setAttribute('aria-pressed', String(mode === savedMode));
    btn.addEventListener('click', () => {
      localStorage.setItem(MAP_MODE_KEY, mode);
      wrap.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      onChange(mode);
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

/**
 * Mount js/map/electionMap.js into `mount`, degrading to a visible
 * placeholder instead of throwing if that module is unavailable (it's
 * built/owned separately from the pages that embed it).
 * @param {HTMLElement} mount
 * @param {Object} [mapOptions] passed to mountElectionMap; `mode` defaults to the shared toggle's current value
 * @returns {Promise<Object|null>} the map controller ({reset,setMode,drillTo,destroy}), or null if unavailable
 */
export async function mountElectionMapDefensively(mount, mapOptions = {}) {
  try {
    const mod = await import('../map/electionMap.js');
    mount.textContent = '';
    return await mod.mountElectionMap(mount, { mode: currentMapMode(), ...mapOptions });
  } catch (err) {
    console.warn('Map component unavailable:', err);
    mount.textContent = 'Map unavailable (js/map/electionMap.js not ready yet).';
    return null;
  }
}

/** Convenience: create an element with class/text/children in one call. */
export function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  if (opts.html != null) node.innerHTML = opts.html; // only used for trusted, static markup (e.g. &raquo;)
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

// ---------------------------------------------------------------------
// Shared table renderer for Home Districts / General Direct (FEATURE_SPEC.md
// Section 4): flat list of Constituency-basis seats, collapsible when a
// seat aggregates multiple Sub_Constituency rows.
//
// Phase 3 fix: results.js's getConstituencyGroupedSeats() now attaches a
// `subRows` array (one entry per named Sub_Constituency, each with its own
// Supplementary Vote count/status breakdown) to any seat with more than one
// underlying row -- see buildSubRowSummaries() in js/data/results.js. The
// expand affordance below renders those named rows directly, per Section
// 4's "the UI shows Constituency as a collapsible/expandable row containing
// its Sub_Constituency rows."
// ---------------------------------------------------------------------

/**
 * @param {HTMLElement} tbody
 * @param {Array<Object>} seats result of getHomeDistrictsSeats()/getGeneralDirectSeats()
 * @param {Object} electionMeta
 * @param {string} seatTypeId
 */
export function renderConstituencySeatRows(tbody, seats, electionMeta, seatTypeId) {
  let rowIndex = 0;
  for (const seat of seats) {
    rowIndex++;
    const rowId = `seat-row-${rowIndex}`;
    const expandable = !seat.isDerived && seat.subRowCount > 1;

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
    const a = document.createElement('a');
    a.href = seatDetailHref(seatTypeId, seat.constituency);
    a.textContent = seat.constituency;
    nameWrap.appendChild(a);
    if (seat.isDerived) nameWrap.appendChild(el('span', { className: 'page-header__meta', text: '(derived)' }));
    nameTd.appendChild(nameWrap);
    tr.appendChild(nameTd);

    tr.appendChild(statusCell(seat));
    tr.appendChild(percentCell(seat));
    tr.appendChild(resultCell(seat, electionMeta));

    tbody.appendChild(tr);

    if (expandable) {
      const detailTr = document.createElement('tr');
      detailTr.id = rowId;
      detailTr.className = 'subrow-detail hidden';
      const td = document.createElement('td');
      td.colSpan = 4;
      const inner = el('div', { className: 'subrow-detail__inner' });
      inner.appendChild(
        el('div', {
          className: 'page-header__meta',
          text: `This seat's total aggregates ${seat.subRowCount} Sub_Constituency reporting rows (FEATURE_SPEC.md Section 4 -- "the sub-rows are reporting granularity, not separate seats").`,
        })
      );
      if (Array.isArray(seat.subRows) && seat.subRows.length) {
        inner.appendChild(subRowTable(seat.subRows, electionMeta));
      } else {
        // Defensive fallback (should not normally happen once subRowCount > 1) --
        // e.g. a single Sub_Constituency name repeated across >1 raw row.
        const chips = el('div', { className: 'subrow-status-chips' });
        for (const statusKey of [STATUS.DECLARED, STATUS.COUNTING, STATUS.VERIFYING, STATUS.NOT_RECEIVED]) {
          const bucket = seat.statusSummary.byStatus[statusKey];
          if (!bucket || !bucket.count) continue;
          const chip = statusBadge(statusKey);
          chip.textContent = `${bucket.count} × ${statusKey}`;
          chips.appendChild(chip);
        }
        inner.appendChild(chips);
      }
      td.appendChild(inner);
      detailTr.appendChild(td);
      tbody.appendChild(detailTr);
    }
  }
}

/**
 * Named Sub_Constituency breakdown table for an expanded seat row (Section
 * 4's collapsible-row UI). Each sub-row carries its own SV-derived leading
 * party, resolved against the SAME seat-level participation row as the
 * parent (see buildSubRowSummaries() in js/data/results.js).
 * @param {Array<Object>} subRows result of the seat summary's `subRows`
 * @param {Object} electionMeta
 */
function subRowTable(subRows, electionMeta) {
  const table = document.createElement('table');
  table.className = 'data-table subrow-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Sub_Constituency</th><th>Status</th><th>% declared</th><th>Leading</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const sub of subRows) {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = sub.subConstituency || '(unnamed)';
    tr.appendChild(nameTd);
    tr.appendChild(statusCell(sub));
    tr.appendChild(percentCell(sub));
    tr.appendChild(resultCell(sub, electionMeta));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

export function statusCell(seat) {
  const td = document.createElement('td');
  if (seat.isDerived) {
    td.textContent = 'Derived';
    td.className = 'page-header__meta';
    return td;
  }
  td.appendChild(statusBadge(dominantStatus(seat)));
  return td;
}

/**
 * A single best-effort status for a multi-row seat that isn't fully
 * Declared yet (e.g. for a status chip where only one badge fits): if any
 * electorate-weight has been Declared/Counting, call it Counting; else
 * Verifying if anything has been received; else Not received. Shared
 * across the seat-type list pages and the seat detail page so they agree
 * on what "the seat's status" means before 100% declared.
 * @param {{statusSummary: Object}} seat
 */
export function dominantStatus(seat) {
  // The General Direct `Local Representative` seat (Section 4) is derived
  // from Alma Vale, not its own ballot data -- it has no statusSummary of
  // its own (see results.js's getLocalRepresentativeSeat). Callers that
  // iterate a mixed seat list (e.g. the overview page's mini-chips) hit
  // this; there's nothing meaningful to rank it against, so treat it as
  // "no status" rather than throwing.
  if (!seat || !seat.statusSummary) return STATUS.NOT_RECEIVED;
  if (seat.statusSummary.percentDeclared >= 100) return STATUS.DECLARED;
  const by = seat.statusSummary.byStatus;
  if (by[STATUS.COUNTING].count > 0 || seat.statusSummary.percentDeclared > 0) return STATUS.COUNTING;
  if (by[STATUS.VERIFYING].count > 0) return STATUS.VERIFYING;
  return STATUS.NOT_RECEIVED;
}

function percentCell(seat) {
  const td = document.createElement('td');
  td.textContent = seat.isDerived ? '—' : formatPercent(seat.statusSummary.percentDeclared);
  return td;
}

export function resultCell(seat, electionMeta) {
  const td = document.createElement('td');
  if (seat.isDerived) {
    td.appendChild(partyPill(electionMeta, seat.winnerParty));
    return td;
  }
  if (isFullyDeclared(seat.statusSummary) && seat.winnerParty) {
    td.appendChild(partyPill(electionMeta, seat.winnerParty));
  } else if (seat.statusSummary.percentDeclared > 0 && seat.winnerParty) {
    td.appendChild(el('span', { className: 'page-header__meta', text: `Leading: ${seat.winnerParty}` }));
  } else {
    td.appendChild(el('span', { className: 'party-pill party-pill--muted', text: '—' }));
  }
  return td;
}
