/**
 * electionMap.js — General Election choropleth: Constituency (top) ->
 * County-or-District (second layer, site-wide toggle) -> Precinct (bottom,
 * `Shape_ID`/`Polygon`). FEATURE_SPEC.md Section 1.
 *
 * Public contract (BUILD_NOTES.md "Map component contract" — 2b/2c build
 * against this signature):
 *   mountElectionMap(container, options) -> { reset, setMode, setResultView, setColorMode, drillTo, destroy }
 *
 * **Presentation model (NYT/AP-style "one path expanded, everything else at
 * its own natural level")**: all 40 constituencies are ALWAYS rendered.
 * Clicking one expands it in place into its counties/districts, while every
 * other constituency stays a plain constituency-level shape (still
 * clickable — clicking a different one switches which is expanded).
 * Clicking a county/district inside the expanded constituency further
 * expands THAT one into its precincts, while its siblings stay at
 * county/district level and every other constituency stays at constituency
 * level. There is deliberately no "neighboring units" concept here — since
 * literally everything is always shown (just at varying detail), there's
 * nothing to decide about how much surrounding context to load, which is
 * what several rounds of geometric-adjacency bugs were actually about. The
 * view auto-zooms to whatever's currently expanded (`zoomTransformToFit` in
 * mapCore.js) so the drilled-in detail is still usable at national-map
 * scale. Total rendered shapes stays well under Section 1's >10,000-polygon
 * concern by construction: 40 constituencies + one constituency's
 * counties/districts (tens) + one county/district's precincts (up to a few
 * hundred).
 *
 * District mode's Layer-2 unit is one ward-level fragment (District +
 * District_ID), not the whole merged District — see shapes.js's module doc
 * for the spatial (point-in-polygon) join this relies on (NOT the
 * District_Ward label, which looks like a join key but isn't one). Its
 * display label is "{District} District {District_ID}" (e.g. "Durdham Mews
 * District 2"), built by `districtFragmentLabel()` below.
 *
 * Data-access rule: everything geographic/electoral comes from `../data.js`
 * (getShapeIndex, getCountiesForConstituency, getDistrictFragmentsForConstituency,
 * getPrecinctsForDistrictFragment, getDistrictFragmentForPrecinct,
 * getPrecinctsForCounty, getAlmaValeSeats, getAlmaValeSeatDetail) — this
 * module never fetches or parses a raw `data/*` file itself.
 */

import * as Data from '../data.js';
import {
  ensureD3,
  ringsOf,
  buildChrome,
  renderShapes,
  renderLegend,
  spectrumColorVar,
  statusColorVar,
  computeExtent,
  zoomTransformToFit,
} from './mapCore.js';
import { aggregateStatusLabel, resultsTableHtml, statusLinesHtml } from './resultsTable.js';

// Not received/Verifying/Counting all read as a neutral "no result yet"
// gray at the aggregate level (Constituency/County/District), or a
// dedicated flat white for a single actively-Verifying/Counting precinct
// (see `neutralColorVar`/`colorForPrecinct` below) -- same simplification
// already made on the referendum map (BUILD_NOTES.md) -- so the legend only
// needs the three spectrums, which are the only colors it's still
// ambiguous to identify by eye alone.
const LEGEND_ITEMS = [
  { label: 'Left', color: 'var(--spectrum-left)' },
  { label: 'Middle Right', color: 'var(--spectrum-mr)' },
  { label: 'Right', color: 'var(--spectrum-right)' },
];

/**
 * @param {HTMLElement} container
 * @param {{
 *   mode: 'county'|'district',
 *   lockToConstituency?: string,
 *   onUnitClick?: (unit: Object) => void,
 *   resultView?: '1st'|'2nd',
 *   colorMode?: 'first-round'|'actual',
 * }} options
 */
export async function mountElectionMap(container, options = {}) {
  const d3 = await ensureD3();
  const [shapeIndex, almaValeSeats, electionMeta, participationRows] = await Promise.all([
    Data.getShapeIndex(),
    Data.getAlmaValeSeats(),
    Data.loadElectionMeta(),
    Data.loadPartyParticipation(),
  ]);
  const seatByConstituency = new Map(almaValeSeats.map((s) => [s.constituency, s]));
  const orderedConstituencies = Data.orderConstituencies(shapeIndex.constituencies);
  const districtFragmentById = shapeIndex.districtFragmentById;

  /** "{District} District {District_ID}" — District mode's per-ward unit label (e.g. "Durdham Mews District 2"). */
  function districtFragmentLabel(fragment) {
    return `${fragment.District} District ${fragment.District_ID}`;
  }

  /** A fragment's owning Constituency, from its own (spatially-joined) precincts — see shapes.js module doc. */
  function ownerConstituencyForFragment(fragment) {
    const precincts = Data.getPrecinctsForDistrictFragment(shapeIndex, fragment.District, fragment.District_ID);
    return precincts.length ? precincts[0].Constituency : null;
  }

  const chrome = buildChrome(container, d3, { title: 'General Election' });
  renderLegend(chrome.legend, LEGEND_ITEMS);

  const state = {
    mode: options.mode === 'district' ? 'district' : 'county',
    lockToConstituency: options.lockToConstituency || null,
    activeConstituency: options.lockToConstituency || null,
    activeSecondId: null, // county code, or district fragment id
    selectedPrecinctId: null,
    // '1st'|'2nd' -- shared toggle (election-alma-vale.js's `listPrefView`,
    // set via `setResultView` below) driving every tooltip's results table.
    // Tooltips are computed live on hover, not cached, so changing this
    // needs no re-render -- see `setResultView`.
    resultView: options.resultView === '2nd' ? '2nd' : '1st',
    // 'first-round'|'actual' -- the shared "Display Color" toggle
    // (election-alma-vale.js's own `mapColorMode`, set via `setColorMode`
    // below) driving every shape's FILL color, independently of
    // `resultView` above (which only affects tooltip/list NUMBERS, never
    // the map itself). Unlike `resultView`, changing this DOES need a
    // re-render -- fill colors are baked into the shapes array each
    // `renderAll()` call, not recomputed live on hover. See
    // `colorForUnitSv`/`colorForPrecinct`'s doc comments for what each mode
    // means and why neither one ever defers to a parent/child unit's own
    // result.
    colorMode: options.colorMode === 'first-round' ? 'first-round' : 'actual',
  };

  // The active second unit's OWN FPTP (first-preference-only) result
  // (District mode only) — set during renderAll()'s precinct-tier build,
  // read by tooltipForPrecinct's "D" column so every precinct in a
  // District shows that SAME District's confirmed-winner fact (FEATURE_SPEC
  // Section 4's Local Representative rule: plurality of first-preference
  // votes, not the Supplementary Vote method), not a separate per-precinct
  // notion of it.
  let activeUnitFptp = null;

  // Per-constituency precinct-result detail is fetched lazily and cached
  // for the life of this mount (the underlying CSV fetch is already
  // memoized by csv.js; this cache just skips re-running the client-side
  // filter/SV recompute on repeat visits to the same constituency).
  const seatDetailCache = new Map(); // constituency -> Promise<seatDetail>
  function seatDetailFor(constituencyName) {
    if (!seatDetailCache.has(constituencyName)) {
      seatDetailCache.set(constituencyName, Data.getAlmaValeSeatDetail(constituencyName));
    }
    return seatDetailCache.get(constituencyName);
  }

  /**
   * Fetch (and merge) precinct-level result info for every distinct
   * constituency represented among a set of rendered precincts.
   * @param {string[]} constituencyNames
   * @returns {Promise<Map<string, {status:string, electorate:number, turnout:number, result?:Object}>>}
   */
  async function loadPrecinctResults(constituencyNames) {
    const unique = [...new Set(constituencyNames)];
    const details = await Promise.all(unique.map((name) => seatDetailFor(name)));
    const map = new Map();
    for (const detail of details) {
      for (const p of detail.precincts) map.set(p.shapeId, p);
    }
    return map;
  }

  /**
   * Fallback color for a Constituency/County/District aggregate with
   * nothing Declared yet, and for a precinct that hasn't even been
   * received -- one flat neutral gray (`--status-not-received`) regardless
   * of whether the underlying data is genuinely "not received" or a mix of
   * Verifying/Counting, matching the referendum map's own
   * `neutralColorVar()`. A single Verifying/Counting *precinct* gets its
   * own distinct color instead -- see `colorForPrecinct` below.
   */
  function neutralColorVar() {
    return statusColorVar('Not received');
  }

  /**
   * A Declared precinct's fill color is THIS PRECINCT's OWN result, full
   * stop -- never the constituency's, never any other unit's. The shared
   * "Display Color" toggle (`state.colorMode`, `election-alma-vale.js`'s
   * `mapColorMode`) picks WHICH of this precinct's own facts to show, but
   * every level (Constituency/County-District/Precinct) always computes
   * and shows its OWN answer independently -- by design, a Left-leaning
   * constituency can contain a Right-leaning County/District which itself
   * contains an MR-leading precinct, all shown simultaneously and
   * correctly, with no unit ever overriding another's color:
   *  - `'first-round'`: this precinct's own 1st-preference plurality leader
   *    (`Data.round1PluralityLeader(info.result.round1)`) -- the
   *    Supplementary Vote transfer round never enters into it, even if one
   *    happened.
   *  - `'actual'`: this precinct's own ACTUAL result -- `info.result.winner`,
   *    i.e. `computeSupplementaryVote()`'s own forced-elimination round2
   *    winner when nobody got a majority. This is always a fully-settled
   *    fact for a single already-Declared precinct (all its ballots are
   *    known — see `results.js`'s per-precinct `result` field), never a
   *    "leading but might still flip" guess the way a partial-count
   *    aggregate's own round2 would be.
   * Falls back to a dedicated tie color (`--precinct-tie`, css/map.css)
   * only in the near-impossible case the chosen figure has no leader at all
   * (an exact tie).
   *
   * Opacity is that same spectrum's own vote SHARE in THIS precinct (`Data.
   * voteShareFor`), not percent-counted — a single already-Declared
   * precinct is either 0% or 100% counted, so percent-counted opacity would
   * just be a flat on/off switch here, telling you nothing about the actual
   * result (see `colorForUnitSv`'s doc comment for the same reasoning one
   * level up). In `'first-round'` mode that's round1's own 3-way share; in
   * `'actual'` mode it's round2's 2-way share once a runoff happened
   * (`info.result.round2`), else round1's share (an outright majority).
   */
  function colorForPrecinct(info) {
    if (!info) return { fill: neutralColorVar(), fillOpacity: 0.5, className: 'map-shape--nodata' };
    if (info.status === 'Declared' && info.result) {
      const firstRound = state.colorMode === 'first-round';
      const winnerSpectrum = firstRound ? Data.round1PluralityLeader(info.result.round1) : info.result.winner;
      const round2 = firstRound ? null : info.result.round2;
      if (winnerSpectrum) {
        const color = spectrumColorVar(winnerSpectrum);
        if (color) {
          const share = Data.voteShareFor(winnerSpectrum, info.result.round1, round2);
          return { fill: color, fillOpacity: shareOpacity(share), className: 'map-shape--declared' };
        }
      }
      return { fill: 'var(--precinct-tie)', fillOpacity: 1, className: 'map-shape--declared map-shape--tie' };
    }
    if (info.status === 'Verifying' || info.status === 'Counting') {
      return { fill: 'var(--ref-progress)', fillOpacity: 0.85, className: `map-shape--${slug(info.status)}` };
    }
    return { fill: neutralColorVar(), fillOpacity: 0.85, className: `map-shape--${slug(info.status)}` };
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/\s+/g, '-');
  }

  /**
   * Fill-opacity ("color depth") from a 0..1 vote share -- floored so even
   * a bare plurality still reads as a filled-in shape, capped at 1 for a
   * landslide. `null` (nothing valid to compute a share from yet) falls
   * back to the same floor. Shared by every County/District/Precinct color
   * function below -- see `Data.voteShareFor`'s doc comment for why these
   * three use vote SHARE, not percent-counted, for opacity.
   * @param {number|null} share
   */
  function shareOpacity(share) {
    return Math.max(0.35, Math.min(1, share ?? 0.35));
  }

  /**
   * County-level fill color: THIS COUNTY's OWN Supplementary Vote result
   * (`Data.getAlmaValeSupplementaryVoteForShapeIds`), independently of
   * every other unit — same "each level shows its own answer, nothing ever
   * overrides anything else" rule `colorForPrecinct` above documents (its
   * doc comment has the full reasoning). `state.colorMode` picks which of
   * this county's own facts to show:
   *  - `'first-round'`: this county's own 1st-preference plurality leader
   *    (`Data.round1PluralityLeader(sv.round1)`), ignoring the transfer
   *    round entirely.
   *  - `'actual'`: this county's own ACTUAL result, INCLUDING its own
   *    Supplementary Vote round2 — recomputed fresh off `sv.totals`
   *    (`Data.computeSupplementaryVote`) rather than trusting `sv.winner`
   *    (which is the "safe to call currently-leading" figure `results.js`
   *    exposes for text labels elsewhere, gated by certainty — this color
   *    mode intentionally wants the raw forced-elimination result
   *    unconditionally, so it doesn't reuse that field).
   * Opacity is that spectrum's own vote SHARE (`Data.voteShareFor`) rather
   * than percent-counted — percent-counted doesn't tell you anything about
   * how convincingly this county is leading, and at County granularity a
   * handful of late precincts swinging the opacity around (with no color
   * change at all) reads as noise, not signal. County mode has no
   * "confirmed District winner" concept (see `colorForFptp` below for
   * District mode's own rule), so this stays SV-based, matching what Alma
   * Vale SEATS themselves use.
   * @param {Object} sv result of getAlmaValeSupplementaryVoteForShapeIds
   */
  function colorForUnitSv(sv) {
    const firstRound = state.colorMode === 'first-round';
    const winnerSpectrum = firstRound ? Data.round1PluralityLeader(sv.round1) : Data.computeSupplementaryVote(sv.totals).winner;
    if (winnerSpectrum) {
      const color = spectrumColorVar(winnerSpectrum);
      const round2 = firstRound ? null : sv.round2;
      const share = Data.voteShareFor(winnerSpectrum, sv.round1, round2);
      return { fill: color, fillOpacity: shareOpacity(share) };
    }
    return { fill: neutralColorVar(), fillOpacity: 0.75 };
  }

  /**
   * District-fragment fill color, driven by the FPTP (first-preference-
   * only) party plurality — FEATURE_SPEC.md Section 4's Local
   * Representative rule ("sum votes per party ... whichever party has the
   * plurality wins that District"), NOT the Supplementary Vote method. This
   * is deliberately the SAME rule the tooltip's "D" column uses, so the
   * fragment's color and its "who wins this District" tick always agree —
   * the fragment's results TABLE still shows the area's own Supplementary
   * Vote round1/round2 breakdown (a different, still-true fact about how
   * its precincts' Alma Vale ballots broke down), just not what decides
   * this color or the D tick. Opacity is the winning spectrum's own share
   * of this fragment's FPTP vote (not percent-counted — see
   * `colorForUnitSv`'s doc comment for why). Not affected by the shared
   * `state.colorMode` "Display Color" toggle (`colorForUnitSv`/
   * `colorForPrecinct`'s own doc comments) — FPTP has no transfer round at
   * all, so "1st-preference leader" and "actual result" are the exact same
   * figure here.
   * @param {Object} fptp result of getAlmaValeFirstPreferenceWinnerForShapeIds
   */
  function colorForFptp(fptp) {
    if (fptp.winnerSpectrum) {
      const color = spectrumColorVar(fptp.winnerSpectrum);
      const totalVotes = Object.values(fptp.spectrumVotes || {}).reduce((a, b) => a + b, 0);
      const share = totalVotes > 0 ? (fptp.spectrumVotes[fptp.winnerSpectrum] || 0) / totalVotes : null;
      return { fill: color, fillOpacity: shareOpacity(share) };
    }
    return { fill: neutralColorVar(), fillOpacity: 0.75 };
  }

  function setBreadcrumb(parts) {
    const clean = parts.filter((p) => p != null);
    chrome.breadcrumb.innerHTML = clean
      .map((p, i) => (i === clean.length - 1 ? `<strong>${p}</strong>` : `<span>${p}</span> &raquo; `))
      .join('');
  }

  /**
   * Constituency-level tooltip: results table + status lines, Section 3/2.
   * No "D" column — there's no finer unit to distinguish it from here.
   * `confirmedWinnerSpectrum` (the "C" tick) and the round2 figures'
   * certainty both come from `seat.certainty` (results.js's
   * `resolveSupplementaryVoteCertainty()`) rather than literal 100%
   * declared, matching the rule the seat-list tables use — see
   * `election-common.js`'s `isResultCertain()`.
   */
  function tooltipForConstituency(shape) {
    const name = shape.meta.row.Constituency;
    const seat = shape.meta.seat;
    if (!seat) return `<strong>${name}</strong>`;
    const participation = Data.findParticipation(participationRows, 'AlmaVale', seat.constituency);
    const pct = seat.statusSummary.percentDeclared;
    const certainty = seat.certainty;
    const confirmedWinnerSpectrum = certainty && certainty.resultCertain ? seat.winnerSpectrum : null;
    const roundTwoCertain = !!(certainty && (seat.round2 ? certainty.participantsCertain : certainty.stage === 'round1-majority'));
    return `
      <strong>${name}</strong>
      ${resultsTableHtml({
        round1: seat.round1,
        round2: seat.round2,
        eliminated: seat.eliminated,
        nil: seat.nil,
        spoil: seat.totals.Spoil || 0,
        participation,
        confirmedWinnerSpectrum,
        roundTwoCertain,
        view: state.resultView,
      })}
      ${statusLinesHtml(aggregateStatusLabel(pct), pct, seat.totals.Turnout, seat.totals.Electorate, certainty)}
    `;
  }

  /**
   * `roundTwoCertain` gate shared by `tooltipForSecond`/`tooltipForPrecinct`:
   * whether the CONSTITUENCY's own round1/round2 split is safe to treat as
   * settled (results.js's `resolveSupplementaryVoteCertainty()`) — every
   * sub-unit's "2nd Pref (actual)" table defers to this SAME constituency-
   * wide certainty rather than computing its own, so a fully-Declared
   * county doesn't show a settled round2 while the constituency's real
   * runoff pairing is still unresolved.
   * @param {Object|null} constituencySeat seatByConstituency.get(...)
   */
  function constituencyRoundTwoCertain(constituencySeat) {
    const certainty = constituencySeat && constituencySeat.certainty;
    return !!(certainty && (constituencySeat.round2 ? certainty.participantsCertain : certainty.stage === 'round1-majority'));
  }

  /**
   * County/District-level tooltip: results table + status lines. The
   * results TABLE'S 1st-round figures come from the unit's own full
   * Supplementary Vote computation (`sv` — a real fact about how its
   * precincts' Alma Vale ballots broke down), but its 2nd-round figures are
   * this SAME unit's own totals re-run under the CONSTITUENCY's real
   * elimination (`Data.computeHypotheticalRunoff`), not `sv.round2`/
   * `sv.eliminated` (this unit's own independently-recomputed elimination)
   * — there is only ONE real runoff for the whole seat, and two counties in
   * the same constituency showing different eliminated spectrums would be
   * showing two different, mutually-inconsistent "real" runoffs (see
   * BUILD_NOTES.md's 2026-08-04 fix for the reported symptom). The "D"
   * column ("this District is confirmed won") is District-mode-only and
   * uses a DIFFERENT computation (`fptp` — first-preference-only plurality
   * by party, FEATURE_SPEC.md Section 4's Local Representative rule) — a
   * County isn't an electoral sub-unit with its own "confirmed winner"
   * concept the way a District is, so County mode never gets a D column at
   * all (only C, the overall Constituency seat's confirmed winner, which
   * still applies everywhere and is always SV-based since that's how Alma
   * Vale seats themselves are decided).
   */
  function tooltipForSecond(shape) {
    const label = state.mode === 'county' ? 'County' : 'District';
    const displayName = state.mode === 'county' ? shape.rawId : districtFragmentLabel(shape.meta.unit.fragment);
    const sv = shape.meta.sv;
    const fptp = shape.meta.fptp;
    const participation = Data.findParticipation(participationRows, 'AlmaVale', state.activeConstituency);
    const constituencySeat = seatByConstituency.get(state.activeConstituency);
    const constituencyCertainty = constituencySeat && constituencySeat.certainty;
    const confirmedWinnerSpectrum =
      constituencyCertainty && constituencyCertainty.resultCertain ? constituencySeat.winnerSpectrum : null;
    const unitPct = sv.statusSummary.percentDeclared;
    // "D" (this District's own confirmed winner) stays FPTP-plurality-based
    // (Local Representative's method, not Supplementary Vote) and District-
    // mode-only, per this function's doc comment — untouched by the SV
    // certainty rule below, which only governs the SV results table itself.
    const confirmedUnitWinnerSpectrum = state.mode === 'district' ? (unitPct >= 100 ? fptp.winnerSpectrum : null) : undefined;
    const roundTwoCertain = constituencyRoundTwoCertain(constituencySeat);
    const constituencyEliminated = constituencySeat ? constituencySeat.eliminated : null;
    const unitRunoff = constituencyEliminated ? Data.computeHypotheticalRunoff(sv.totals, constituencyEliminated) : null;
    return `
      <strong>${displayName}</strong>
      <div class="map-tooltip__status">${label}</div>
      ${resultsTableHtml({
        round1: sv.round1,
        round2: unitRunoff ? unitRunoff.round2 : null,
        eliminated: unitRunoff ? unitRunoff.eliminated : null,
        nil: unitRunoff ? unitRunoff.nil : null,
        spoil: sv.totals.Spoil || 0,
        participation,
        confirmedWinnerSpectrum,
        confirmedUnitWinnerSpectrum,
        roundTwoCertain,
        view: state.resultView,
      })}
      ${statusLinesHtml(aggregateStatusLabel(unitPct), unitPct, sv.totals.Turnout, sv.totals.Electorate, sv.certainty)}
    `;
  }

  /**
   * Precinct-level tooltip: same results table + status lines, this one
   * precinct's own single row (never an aggregate, so its status stays the
   * literal per-row value, not `aggregateStatusLabel`).
   *
   * The "D" column here does NOT mean "this one precinct is declared" (that
   * would be near-trivial — a precinct is either Declared or it isn't). It
   * means "the District this precinct belongs to is confirmed won" — the
   * same fact `tooltipForSecond` shows for that District fragment as a
   * whole, propagated down to every precinct inside it via `activeUnitFptp`
   * (computed once per render, see `renderAll`, using the FPTP
   * first-preference plurality rule — the same Local Representative
   * counting rule from FEATURE_SPEC.md Section 4, NOT the Supplementary
   * Vote method). County mode has no D column at all (see
   * `tooltipForSecond`'s doc comment).
   *
   * The results table's 2nd-round figures are this precinct's own totals
   * re-run under the CONSTITUENCY's real elimination
   * (`Data.computeHypotheticalRunoff`), exactly like `tooltipForSecond` —
   * NOT this precinct's own isolated round2 (`info.result.round2`, computed
   * from just this one row, which eliminates whichever spectrum is LOWEST
   * *within this one precinct* — a fact that can legitimately disagree with
   * the constituency-wide elimination). `roundTwoCertain` is likewise the
   * CONSTITUENCY's own certainty, not a per-precinct match check — a
   * Declared precinct's own votes are always a known, certain fact once
   * expressed under a given elimination, so the only remaining question is
   * whether that elimination (the constituency's) is itself certain yet.
   */
  function tooltipForPrecinct(shape) {
    const row = shape.meta.row;
    const info = shape.meta.info;
    const status = info ? info.status : 'Not received';
    const declared = status === 'Declared' && info.result;
    const round1 = declared ? info.result.round1 : { Left: 0, MR: 0, Right: 0 };
    const participation = Data.findParticipation(participationRows, 'AlmaVale', row.Constituency);
    const percentDeclared = declared ? 100 : 0;
    const constituencySeat = seatByConstituency.get(row.Constituency);
    const constituencyCertainty = constituencySeat && constituencySeat.certainty;
    const confirmedWinnerSpectrum = constituencyCertainty && constituencyCertainty.resultCertain ? constituencySeat.winnerSpectrum : null;
    const confirmedUnitWinnerSpectrum =
      state.mode === 'district'
        ? activeUnitFptp && activeUnitFptp.statusSummary.percentDeclared >= 100
          ? activeUnitFptp.winnerSpectrum
          : null
        : undefined;
    const roundTwoCertain = constituencyRoundTwoCertain(constituencySeat);
    const constituencyEliminated = constituencySeat ? constituencySeat.eliminated : null;
    const unitRunoff = declared && info.totals && constituencyEliminated ? Data.computeHypotheticalRunoff(info.totals, constituencyEliminated) : null;
    return `
      <strong>${row.Shape_ID}</strong>
      ${resultsTableHtml({
        round1,
        round2: unitRunoff ? unitRunoff.round2 : null,
        eliminated: unitRunoff ? unitRunoff.eliminated : null,
        nil: unitRunoff ? unitRunoff.nil : null,
        spoil: declared ? info.spoil || 0 : 0,
        participation,
        confirmedWinnerSpectrum,
        confirmedUnitWinnerSpectrum,
        roundTwoCertain,
        view: state.resultView,
      })}
      ${statusLinesHtml(status, percentDeclared, info ? info.turnout : null, info ? info.electorate : 0)}
    `;
  }

  function fireUnitClick(unit) {
    if (typeof options.onUnitClick === 'function') options.onUnitClick(unit);
  }

  // ---------------------------------------------------------------------
  // The one render pass: builds all three tiers (whichever are active)
  // into a single shapes array, then auto-zooms to whatever's expanded.
  // ---------------------------------------------------------------------

  async function renderAll() {
    const shapes = [];
    activeUnitFptp = null; // recomputed below only when a District fragment is actually drilled into

    for (const c of orderedConstituencies) {
      if (c.Constituency === state.activeConstituency) continue; // expanded below instead
      const seat = seatByConstituency.get(c.Constituency);
      // Same `state.colorMode` "Display Color" toggle as every level below
      // (`colorForUnitSv`/`colorForPrecinct`'s doc comments) -- this
      // constituency's own 1st-preference plurality leader, or its own
      // ACTUAL result (recomputed off `seat.totals` so it's the raw
      // forced-elimination figure, not `seat.winnerSpectrum`'s
      // certainty-gated "safe to call currently-leading" one). Opacity
      // stays percent-Declared here (unlike County/District/Precinct) --
      // at this aggregate scale, "how much of the seat has reported" is
      // still a useful fact on its own, separate from which figure is shown.
      const winnerSpectrum =
        seat && (state.colorMode === 'first-round' ? Data.round1PluralityLeader(seat.round1) : Data.computeSupplementaryVote(seat.totals).winner);
      const color = winnerSpectrum
        ? { fill: spectrumColorVar(winnerSpectrum), fillOpacity: Math.max(0.35, (seat.percentDeclared || 0) / 100) }
        : { fill: neutralColorVar(), fillOpacity: 0.75 };
      shapes.push({
        id: `c::${c.Constituency}`,
        level: 'constituency',
        rawId: c.Constituency,
        rings: ringsOf(c),
        fill: color.fill,
        fillOpacity: color.fillOpacity,
        className: 'map-shape--constituency',
        meta: { row: c, seat },
      });
    }

    let secondUnits = [];
    if (state.activeConstituency) {
      secondUnits =
        state.mode === 'county'
          ? Data.getCountiesForConstituency(shapeIndex, state.activeConstituency).map((row) => ({ id: row.County, row }))
          : Data.getDistrictFragmentsForConstituency(shapeIndex, state.activeConstituency).map((fragment) => ({
              id: fragment._fragmentId,
              fragment,
            }));

      const resultsMap = await loadPrecinctResults([state.activeConstituency]);

      // Compute each visible unit's full SV result (round1+round2, Spoil,
      // Turnout — see results.js's getAlmaValeSupplementaryVoteForShapeIds)
      // in parallel, once per render — this drives the tooltip's results
      // table in both modes, and County mode's fill color too (Counties
      // aren't a District/seat concept, so they just show the genuine SV
      // breakdown with no separate "who wins" rule).
      const visibleUnits = secondUnits.filter((unit) => unit.id !== state.activeSecondId);
      const unitMemberIds = visibleUnits.map((unit) =>
        state.mode === 'county'
          ? Data.getPrecinctsForCounty(shapeIndex, unit.id).map((p) => p.Shape_ID)
          : Data.getPrecinctsForDistrictFragment(shapeIndex, unit.fragment.District, unit.fragment.District_ID).map((p) => p.Shape_ID)
      );

      // District mode's fill color and D-tick use FPTP first-preference
      // plurality (the Local-Representative counting rule, FEATURE_SPEC.md
      // Section 4: "sum votes per party within each District"). Each
      // (District, District_Ward) fragment row is its OWN independently-
      // contested District for this rule (1,779 total nationwide, not the
      // ~38 District *names* — see localRepresentative.js's module doc),
      // so this is computed directly on each visible fragment's own
      // precincts (`unitMemberIds`, already fragment-scoped above) — no
      // whole-District aggregation across fragments/constituencies needed.
      const [unitSvResults, unitFptpResults] = await Promise.all([
        Promise.all(unitMemberIds.map((ids) => Data.getAlmaValeSupplementaryVoteForShapeIds(state.activeConstituency, ids))),
        state.mode === 'district'
          ? Promise.all(unitMemberIds.map((ids) => Data.getAlmaValeFirstPreferenceWinnerForShapeIds(ids)))
          : Promise.resolve([]),
      ]);

      for (let i = 0; i < visibleUnits.length; i++) {
        const unit = visibleUnits[i];
        const sv = unitSvResults[i];
        const fptp = state.mode === 'district' ? unitFptpResults[i] : null;
        const rings = state.mode === 'county' ? ringsOf(unit.row) : ringsOf(unit.fragment);
        const color = state.mode === 'district' ? colorForFptp(fptp) : colorForUnitSv(sv);
        shapes.push({
          id: `s::${unit.id}`,
          level: 'second',
          rawId: unit.id,
          rings,
          fill: color.fill,
          fillOpacity: color.fillOpacity,
          className: 'map-shape--second-primary',
          meta: { unit, sv, fptp },
        });
      }

      if (state.activeSecondId) {
        const activeFragment = state.mode === 'district' ? districtFragmentById.get(state.activeSecondId) : null;
        const precincts =
          state.mode === 'county'
            ? Data.getPrecinctsForCounty(shapeIndex, state.activeSecondId)
            : activeFragment
            ? Data.getPrecinctsForDistrictFragment(shapeIndex, activeFragment.District, activeFragment.District_ID, state.activeConstituency)
            : [];

        // The active District fragment's own confirmed-winner fact (FPTP
        // first-preference plurality, the Local Representative counting
        // rule — NOT the Supplementary Vote method), propagated to every
        // precinct inside it (see tooltipForPrecinct's "D" column doc
        // comment) — County mode has no such concept, so this stays null
        // there.
        activeUnitFptp =
          state.mode === 'district' && activeFragment
            ? await Data.getAlmaValeFirstPreferenceWinnerForShapeIds(precincts.map((p) => p.Shape_ID))
            : null;

        for (const p of precincts) {
          const info = resultsMap.get(p.Shape_ID);
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
        if (shape.level === 'constituency') setActiveConstituency(shape.rawId);
        else if (shape.level === 'second') setActiveSecondUnit(shape.rawId);
        else selectPrecinct(shape);
      },
      onHover: (id, event) => {
        const shape = shapes.find((s) => s.id === id);
        if (!shape) return;
        const html =
          shape.level === 'constituency' ? tooltipForConstituency(shape) : shape.level === 'second' ? tooltipForSecond(shape) : tooltipForPrecinct(shape);
        chrome.showTooltip(event, html);
      },
      onHoverEnd: chrome.hideTooltip,
    });

    updateBreadcrumb();
    autoZoomToActive(shapes, scales);
  }

  function updateBreadcrumb() {
    const parts = ['Constituencies'];
    if (state.activeConstituency) {
      parts.push(state.activeConstituency, state.mode === 'county' ? 'Counties' : 'Districts');
    }
    if (state.activeSecondId) {
      const activeFragment = state.mode === 'district' ? districtFragmentById.get(state.activeSecondId) : null;
      parts.push(state.mode === 'county' ? state.activeSecondId : activeFragment ? districtFragmentLabel(activeFragment) : state.activeSecondId);
    }
    setBreadcrumb(parts);
  }

  /** Auto-zoom to whatever's currently expanded (NYT-style), so drilled-in detail stays usable at national-map scale. */
  function autoZoomToActive(shapes, scales) {
    let focusLevel = null;
    if (state.activeSecondId) focusLevel = 'precinct';
    else if (state.activeConstituency) focusLevel = 'second';

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
    const transform = zoomTransformToFit(d3, extent, scales.xScale, scales.yScale, chrome.width, chrome.height, 30, chrome.maxZoomScale);
    if (transform) chrome.zoomTo(transform);
    else chrome.resetZoom();
  }

  // ---------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------

  function setActiveConstituency(name) {
    if (state.lockToConstituency && name !== state.lockToConstituency) return;
    state.activeConstituency = name;
    state.activeSecondId = null;
    state.selectedPrecinctId = null;
    fireUnitClick({ level: 'constituency', id: name });
    renderAll();
  }

  function setActiveSecondUnit(id) {
    state.activeSecondId = id;
    state.selectedPrecinctId = null;
    fireUnitClick({ level: 'second', id, mode: state.mode, constituency: state.activeConstituency });
    renderAll();
  }

  function selectPrecinct(shape) {
    state.selectedPrecinctId = shape.rawId;
    fireUnitClick({ level: 'precinct', id: shape.rawId, constituency: shape.meta.row.Constituency, status: shape.meta.info?.status });
    renderAll();
  }

  // ---------------------------------------------------------------------
  // Controller
  // ---------------------------------------------------------------------

  function reset() {
    state.activeConstituency = state.lockToConstituency || null;
    state.activeSecondId = null;
    state.selectedPrecinctId = null;
    renderAll();
  }
  const onResetClick = () => reset();
  chrome.resetBtn.addEventListener('click', onResetClick);

  /** Up one level: collapse the expanded precinct view, then the expanded constituency view (unless locked). */
  function goUp() {
    if (state.activeSecondId) {
      state.activeSecondId = null;
      state.selectedPrecinctId = null;
      renderAll();
      return;
    }
    if (state.activeConstituency && !state.lockToConstituency) {
      state.activeConstituency = null;
      renderAll();
    }
  }
  const onUpClick = () => goUp();
  chrome.upBtn.addEventListener('click', onUpClick);

  function setMode(mode) {
    if (mode !== 'county' && mode !== 'district') return;
    if (state.mode === mode) return;
    state.mode = mode;
    state.activeSecondId = null; // county codes vs district fragment ids don't carry over
    state.selectedPrecinctId = null;
    renderAll();
  }

  /** Switch the shared 1st/2nd Pref toggle driving every tooltip's results table -- no re-render needed, tooltips are built live on hover. */
  function setResultView(view) {
    if (view !== '1st' && view !== '2nd') return;
    state.resultView = view;
  }

  /** Switch the shared "Display Color" toggle -- unlike `setResultView`, this changes what's actually painted onto the shapes, so it needs a re-render. */
  function setColorMode(mode) {
    if (mode !== 'first-round' && mode !== 'actual') return;
    if (state.colorMode === mode) return;
    state.colorMode = mode;
    renderAll();
  }

  function drillTo(level, id) {
    if (level === 'constituency') {
      if (state.lockToConstituency && id !== state.lockToConstituency) return;
      state.activeConstituency = id;
      state.activeSecondId = null;
      state.selectedPrecinctId = null;
    } else if (level === 'second') {
      if (state.mode === 'county') {
        const county = shapeIndex.countyByCode.get(id);
        if (!county) return;
        if (state.lockToConstituency && county.Constituency !== state.lockToConstituency) return;
        state.activeConstituency = county.Constituency;
      } else {
        const fragment = districtFragmentById.get(id);
        if (!fragment) return;
        const owner = ownerConstituencyForFragment(fragment);
        if (!owner || (state.lockToConstituency && owner !== state.lockToConstituency)) return;
        state.activeConstituency = owner;
      }
      state.activeSecondId = id;
      state.selectedPrecinctId = null;
    } else if (level === 'precinct') {
      const precinct = shapeIndex.polygonById.get(id);
      if (!precinct) return;
      if (state.lockToConstituency && precinct.Constituency !== state.lockToConstituency) return;
      state.activeConstituency = precinct.Constituency;
      if (state.mode === 'county') {
        state.activeSecondId = precinct.County;
      } else {
        const fragment = Data.getDistrictFragmentForPrecinct(shapeIndex, precinct);
        state.activeSecondId = fragment ? fragment._fragmentId : null;
      }
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

  await renderAll();

  return { reset, setMode, setResultView, setColorMode, drillTo, destroy };
}
