/**
 * election-overview.js — General Election home page (index.html).
 * FEATURE_SPEC.md Section 4: "overview (seats won per party, by seat type)
 * -> seat type -> individual seat detail." This is the first hop.
 *
 * Judgment call: `Data.getOverview()`'s `tally` credits a party with a seat
 * as soon as `resolveWinningParty` returns one, even from a partially
 * Declared seat (see results.js's doc comment -- that's correct for the
 * seat-level math, Declared rows only feed vote totals either way). This
 * page does its own gating on top via `isResultCertain()` so a seat only
 * counts toward the headline "seats won" tally once its result is
 * mathematically certain (results.js's `certainty.resultCertain`, from
 * `resolveSupplementaryVoteCertainty()`) -- otherwise it's shown as still
 * undecided. That certainty can arrive before every row backing the seat
 * has literally reached Declared, once the outstanding undeclared ballots
 * are too few to change the outcome.
 *
 * General Proportional is different: its `party.seats` are already safe to
 * credit before all 10 reporting sectors are Declared. While
 * `proportional.isFinal` is false, `getGeneralProportionalResult()` used
 * `computeGuaranteedMinimumAllocation()` (proportional.js) to compute them,
 * which is specifically each party's guaranteed-minimum seat count -- the
 * number it keeps no matter how the outstanding sectors report -- so unlike
 * the SV seat types above, there's no need to wait for 100% before crediting
 * them here; doing so just means the total climbs (never drops) as more
 * sectors declare instead of jumping from 0 straight to final.
 */

import * as Data from '../data.js';
import {
  formatNumber,
  formatPercent,
  isResultCertain,
  spectrumColor,
  spectrumSummaryRow,
  SEAT_TYPE_PAGE,
  SEAT_TYPE_LABEL,
  renderError,
  el,
} from './election-common.js';
import { renderNav, renderBreadcrumbs } from '../nav.js';

const content = document.getElementById('content');

async function main() {
  renderNav(document.getElementById('nav'), 'index.html');
  renderBreadcrumbs(document.getElementById('breadcrumbs'), [{ label: 'General Election' }]);

  const [overview, electionMeta] = await Promise.all([Data.getOverview(), Data.loadElectionMeta()]);
  document.title = `${electionMeta.election_name} — Results`;

  // ---- per-seat-type "fully declared?" + decided-seat tallies ----
  const svTypes = ['AlmaVale', 'HomeDistricts', 'GeneralDirect'];
  const decidedCounts = {}; // party -> seatTypeId -> count
  const declaredSeatCounts = {}; // seatTypeId -> {decided, total}

  for (const seatTypeId of svTypes) {
    const seats = overview.seatTypes[seatTypeId];
    let decided = 0;
    for (const seat of seats) {
      // GeneralDirect's derived Local Representative seat (Section 4) has
      // no statusSummary/certainty of its own -- it's gated by its own
      // margin-safe rule instead (localRepresentative.js: no second round
      // for this seat, so `seat.isFinal`/`winnerParty` only go true once
      // the remaining undeclared Districts can no longer catch up). Every
      // other seat here is a real Supplementary Vote seat, gated by
      // `certainty.resultCertain` (resolveSupplementaryVoteCertainty() in
      // data/supplementaryVote.js) rather than literal 100%-declared --
      // mathematical certainty can arrive earlier than that, once
      // outstanding undeclared ballots can no longer change the outcome.
      const final = seat.isDerived ? !!seat.isFinal : isResultCertain(seat);
      if (final && seat.winnerParty) {
        decided++;
        decidedCounts[seat.winnerParty] = decidedCounts[seat.winnerParty] || {};
        decidedCounts[seat.winnerParty][seatTypeId] = (decidedCounts[seat.winnerParty][seatTypeId] || 0) + 1;
      }
    }
    declaredSeatCounts[seatTypeId] = { decided, total: seats.length };
  }

  const proportional = overview.seatTypes.GeneralProportional;
  let proportionalDecided = 0;
  for (const list of proportional.lists) {
    for (const party of list.parties) {
      if (!party.seats) continue;
      decidedCounts[party.abbreviation] = decidedCounts[party.abbreviation] || {};
      decidedCounts[party.abbreviation].GeneralProportional = (decidedCounts[party.abbreviation].GeneralProportional || 0) + party.seats;
      proportionalDecided += party.seats;
    }
  }
  declaredSeatCounts.GeneralProportional = { decided: proportionalDecided, total: proportional.seatType.count };

  // ---- build DOM ----
  const frag = document.createDocumentFragment();

  const header = el('div', { className: 'page-header' }, [
    el('div', {}, [
      el('h1', { text: electionMeta.election_name }),
      el('div', { className: 'page-header__meta', text: `${electionMeta.election_type} · ${electionMeta.election_date}` }),
    ]),
  ]);
  frag.appendChild(header);

  // `electionMeta.parties[]` plus any list-parties General Proportional
  // carries that don't map to a real parties[] entry -- its `Right` list-
  // party (FEATURE_SPEC.md "Open items": implemented literally, not mapped
  // to GCCA/RA) would otherwise silently vanish from every party-keyed
  // breakdown below (seats bar, spectrum totals, the table), even though
  // declaredSeatCounts.GeneralProportional.decided still counts it -- see
  // buildDisplayParties().
  const displayParties = buildDisplayParties(electionMeta, proportional);

  // 1. Total seats won so far (numbers + bar), spectrum-ordered Left -> MR -> Right.
  frag.appendChild(renderSeatsBar(electionMeta, displayParties, decidedCounts, declaredSeatCounts));

  // Spectrum-level vote totals, per seat type -- feeds the table's
  // Left/MR/Right vote-share columns below. Alma Vale's raw columns are
  // already spectrum-labeled (round1.Left/MR/Right, Declared precincts
  // only, Section 3); General Proportional's `lists[]` are one list per
  // spectrum in this election's config (Section 4), so its vote share is
  // already computed by the data layer, no re-aggregation needed.
  const almaValeSpectrumVotes = { Left: 0, MR: 0, Right: 0 };
  for (const seat of overview.seatTypes.AlmaVale) {
    almaValeSpectrumVotes.Left += seat.round1.Left;
    almaValeSpectrumVotes.MR += seat.round1.MR;
    almaValeSpectrumVotes.Right += seat.round1.Right;
  }
  // Home Districts / General Direct: same round1.Left/MR/Right shape as
  // Alma Vale (buildSupplementaryVoteSeatSummary / the derived Local
  // Representative seat both populate it -- see results.js), summed the
  // same way, purely for the table's Left/MR/Right vote-share columns below
  // (no seat-count bar for these two, unlike Alma Vale/Proportional above).
  const homeDistrictsSpectrumVotes = { Left: 0, MR: 0, Right: 0 };
  for (const seat of overview.seatTypes.HomeDistricts) {
    homeDistrictsSpectrumVotes.Left += seat.round1.Left;
    homeDistrictsSpectrumVotes.MR += seat.round1.MR;
    homeDistrictsSpectrumVotes.Right += seat.round1.Right;
  }
  const generalDirectSpectrumVotes = { Left: 0, MR: 0, Right: 0 };
  for (const seat of overview.seatTypes.GeneralDirect) {
    generalDirectSpectrumVotes.Left += seat.round1.Left;
    generalDirectSpectrumVotes.MR += seat.round1.MR;
    generalDirectSpectrumVotes.Right += seat.round1.Right;
  }
  const proportionalSpectrumVotes = {};
  for (const list of proportional.lists) {
    proportionalSpectrumVotes[list.id] = list.votes;
  }

  // 2. The full seat-type-by-party breakdown table -- Left/MR/Right
  // vote-share columns keyed by the spectrum totals computed above.
  const spectrumVotesByType = {
    AlmaVale: almaValeSpectrumVotes,
    HomeDistricts: homeDistrictsSpectrumVotes,
    GeneralDirect: generalDirectSpectrumVotes,
    GeneralProportional: proportionalSpectrumVotes,
  };
  frag.appendChild(renderPartyTallyTable(displayParties, decidedCounts, declaredSeatCounts, spectrumVotesByType, electionMeta));

  // 3. Referendum result summary, only if this election cycle actually has
  // one (referendum/referendum_meta.json -- absent for most cycles, so a
  // 404 from Data.loadReferendumMeta() here just means "no referendum",
  // not an error worth surfacing).
  const referendumBlock = await renderReferendumSummary();
  if (referendumBlock) frag.appendChild(referendumBlock);

  content.replaceChildren(frag);
}

/**
 * Sums a list of per-unit Yes/No summaries (each already shaped like
 * summarizeYesNo()'s return value) into one combined Yes/No/validVotes/
 * percent figure -- used to roll General Direct's per-Constituency
 * referendum results (data/referendum.js's getGeneralDirectReferendumResults
 * returns one summary per seat, not a national total) into a single line,
 * same aggregation referendum.js's own page does for its summary card.
 * @param {Array<{yes:number, no:number}>} summaries
 */
function aggregateYesNo(summaries) {
  let yes = 0;
  let no = 0;
  for (const s of summaries) {
    yes += s.yes;
    no += s.no;
  }
  const validVotes = yes + no;
  return {
    yes,
    no,
    validVotes,
    yesPercent: validVotes > 0 ? (yes / validVotes) * 100 : 0,
    noPercent: validVotes > 0 ? (no / validVotes) * 100 : 0,
  };
}

/**
 * "Referendum Result" summary card: the question text plus one line per
 * referendum seat type (AlmaVale / GeneralDirect -- the only two
 * data/referendum.js currently knows how to summarize, same restriction
 * referendum.js's own page has), each showing whichever side (Yes/No) is
 * currently ahead and its share of the Declared-only valid vote (Yes+No,
 * spoiled ballots excluded by construction -- summarizeYesNo() never counts
 * them into `validVotes`). Returns `null` (nothing to append) when this
 * election cycle has no referendum_meta.json, or when it has one but not a
 * single seat type in it returned data.
 */
async function renderReferendumSummary() {
  let referendumMeta;
  try {
    referendumMeta = await Data.loadReferendumMeta();
  } catch {
    return null; // no referendum this cycle
  }

  const seatTypeIds = (referendumMeta.seat_types || []).map((st) => st.id);
  const lines = [];
  for (const seatTypeId of seatTypeIds) {
    try {
      if (seatTypeId === 'AlmaVale') {
        const result = await Data.getAlmaValeReferendumResults();
        lines.push({ seatTypeId, summary: result.national });
      } else if (seatTypeId === 'GeneralDirect') {
        const result = await Data.getGeneralDirectReferendumResults();
        lines.push({ seatTypeId, summary: aggregateYesNo(result.seats.map((s) => s.summary)) });
      }
    } catch (err) {
      console.error(`[election-overview] referendum results for ${seatTypeId}:`, err);
    }
  }
  if (lines.length === 0) return null;

  const card = document.createElement('div');
  card.className = 'referendum-summary';

  const h2 = document.createElement('h2');
  h2.className = 'section-heading';
  h2.textContent = 'Referendum Result';
  card.appendChild(h2);

  const questionLink = document.createElement('a');
  questionLink.href = 'referendum.html';
  questionLink.textContent = `Question ${referendumMeta.referendum_id}: ${referendumMeta.question}`;
  card.appendChild(el('div', { className: 'referendum-summary__question' }, [questionLink]));

  for (const { seatTypeId, summary } of lines) {
    const label = SEAT_TYPE_LABEL[seatTypeId] || seatTypeId;
    const line = el('div', { className: 'referendum-summary__line' }, [document.createTextNode(`Results in ${label} - `)]);
    if (summary.validVotes > 0) {
      const outcome = summary.yes >= summary.no ? 'Yes' : 'No';
      const pct = summary.yes >= summary.no ? summary.yesPercent : summary.noPercent;
      line.appendChild(
        el('strong', {
          className: `referendum-summary__outcome referendum-summary__outcome--${outcome.toLowerCase()}`,
          text: `${outcome} ${formatPercent(pct)}`,
        })
      );
    } else {
      line.appendChild(document.createTextNode('No results declared yet'));
    }
    card.appendChild(line);
  }

  return card;
}

/**
 * `electionMeta.parties[]` (each already carrying its real spectrum), plus
 * any General Proportional list-party abbreviation that ISN'T one of those
 * entries -- namely `Right`, implemented as a literal column/party-like
 * abbreviation for that one race rather than mapped onto GCCA/RA
 * (FEATURE_SPEC.md "Open items"). Every party-keyed breakdown on this page
 * (spectrum totals, the seats bar, the table) iterates parties by abbreviation
 * to look seats up in `decidedCounts`, so without this, a pseudo-party like
 * `Right` would silently drop its seats from all three even though
 * `declaredSeatCounts.GeneralProportional.decided` still counts them.
 * Falls back to the owning list's own id as that pseudo-party's "spectrum"
 * (matches listColor()'s fallback in election-general-proportional.js) --
 * correct here because General Proportional's list ids ARE the spectrum ids.
 * @param {Object} electionMeta
 * @param {{lists: Array<{id:string, parties: Array<{abbreviation:string}>}>}} proportional
 * @returns {Array<{abbreviation:string, spectrum:string}>}
 */
function buildDisplayParties(electionMeta, proportional) {
  const seen = new Set(electionMeta.parties.map((p) => p.abbreviation));
  const displayParties = electionMeta.parties.map((p) => ({ abbreviation: p.abbreviation, spectrum: p.spectrum }));
  for (const list of proportional.lists) {
    for (const party of list.parties) {
      if (seen.has(party.abbreviation)) continue;
      seen.add(party.abbreviation);
      displayParties.push({ abbreviation: party.abbreviation, spectrum: list.id });
    }
  }
  return displayParties;
}

/**
 * One big number + label per spectrum (Left/Middle Right/Right), decided
 * seats only, summed across every party belonging to that spectrum — shown
 * above the seats-won-per-party bar. This is a fixed ideological-spectrum
 * ruler (Left pinned to the start, Right to the end, everything else
 * evenly spaced between — Middle Right sits at the midpoint here since
 * there are exactly 3 spectrums), NOT proportional to the seat/vote totals
 * — the bar underneath is what shows actual proportions; this row is axis
 * labeling, not a data mark.
 */
function seatsSpectrumSummaryRow(electionMeta, displayParties, decidedCounts, seatTypeIds) {
  return spectrumSummaryRow(electionMeta, (spectrum) => {
    const spectrumParties = displayParties.filter((p) => p.spectrum === spectrum.id).map((p) => p.abbreviation);
    const total = spectrumParties.reduce(
      (sum, abbrev) => sum + seatTypeIds.reduce((s, t) => s + ((decidedCounts[abbrev] && decidedCounts[abbrev][t]) || 0), 0),
      0
    );
    return { value: formatNumber(total), label: spectrum.name };
  });
}

/**
 * Total-seats-so-far block: the per-spectrum number row plus the
 * seats-won-per-party bar. Shown first on the page (before the vote-share
 * bars and the full table) — this is the headline "how many seats, right
 * now" figure the rest of the page elaborates on.
 */
function renderSeatsBar(electionMeta, displayParties, decidedCounts, declaredSeatCounts) {
  const wrap = document.createElement('div');
  const seatTypeIds = ['AlmaVale', 'HomeDistricts', 'GeneralDirect', 'GeneralProportional'];

  const totalDecidedAllTypes = seatTypeIds.reduce((s, t) => s + declaredSeatCounts[t].decided, 0);
  const totalSeatsAllTypes = seatTypeIds.reduce((s, t) => s + declaredSeatCounts[t].total, 0);

  wrap.appendChild(seatsSpectrumSummaryRow(electionMeta, displayParties, decidedCounts, seatTypeIds));

  // Stacked proportion bar: decided seats by spectrum (one merged segment
  // per spectrum, not per party -- matches the spectrum-total numbers in
  // spectrumSummaryRow() above rather than splitting into each party's own
  // count), undecided as a hatched remainder. Iterates spectrum-by-spectrum
  // (Left -> MR -> Right) so Left is always leftmost and Right always
  // rightmost by construction.
  const bar = document.createElement('div');
  bar.className = 'party-tally-bar';
  for (const spectrum of electionMeta.spectrums) {
    const spectrumParties = displayParties.filter((p) => p.spectrum === spectrum.id);
    let count = 0;
    const breakdown = [];
    for (const party of spectrumParties) {
      const abbrev = party.abbreviation;
      const partyCount = seatTypeIds.reduce((s, t) => s + ((decidedCounts[abbrev] && decidedCounts[abbrev][t]) || 0), 0);
      if (!partyCount) continue;
      count += partyCount;
      breakdown.push(`${abbrev}: ${partyCount}`);
    }
    if (!count) continue;
    const widthPct = (count / totalSeatsAllTypes) * 100;
    const seg = document.createElement('div');
    seg.className = 'party-tally-bar__seg';
    seg.style.width = `${widthPct}%`;
    seg.style.background = spectrumColor(spectrum.id);
    seg.title = `${spectrum.name}: ${count} seat${count === 1 ? '' : 's'} (${breakdown.join(', ')})`;
    // Only label the segment inline once it's wide enough to hold a
    // number legibly -- narrow segments still have the count in `title`.
    if (widthPct >= 3) {
      seg.appendChild(el('span', { className: 'party-tally-bar__seg-label', text: formatNumber(count) }));
    }
    bar.appendChild(seg);
  }
  const undecidedTotal = totalSeatsAllTypes - totalDecidedAllTypes;
  if (undecidedTotal > 0) {
    const seg = document.createElement('div');
    seg.className = 'party-tally-bar__seg party-tally-bar__seg--undecided';
    seg.style.width = `${(undecidedTotal / totalSeatsAllTypes) * 100}%`;
    seg.title = `Undecided: ${undecidedTotal} seat${undecidedTotal === 1 ? '' : 's'}`;
    bar.appendChild(seg);
  }
  wrap.appendChild(bar);

  return wrap;
}

/**
 * Seat-type-by-party breakdown table — one row per seat type (its name
 * links to that seat type's own page), columns: Total seats, Declared, one
 * column per party abbreviation, then Left/MR/Right vote-share percentages
 * (of that seat type's own spectrum vote totals, not the seat count above).
 */
function renderPartyTallyTable(displayParties, decidedCounts, declaredSeatCounts, spectrumVotesByType, electionMeta) {
  const seatTypeIds = ['AlmaVale', 'HomeDistricts', 'GeneralDirect', 'GeneralProportional'];
  const parties = displayParties.map((p) => p.abbreviation);
  const spectrums = electionMeta.spectrums;

  const table = document.createElement('table');
  table.className = 'data-table party-tally-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Seat type</th><th>Total seats</th><th>Declared</th>${parties.map((a) => `<th>${a}</th>`).join('')}${spectrums
    .map((s) => `<th>${s.id}</th>`)
    .join('')}</tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const seatTypeId of seatTypeIds) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    const a = document.createElement('a');
    a.href = SEAT_TYPE_PAGE[seatTypeId];
    a.textContent = SEAT_TYPE_LABEL[seatTypeId];
    nameTd.appendChild(a);
    tr.appendChild(nameTd);

    tr.appendChild(numCell(declaredSeatCounts[seatTypeId].total));
    tr.appendChild(numCell(declaredSeatCounts[seatTypeId].decided));

    for (const abbrev of parties) {
      const count = (decidedCounts[abbrev] && decidedCounts[abbrev][seatTypeId]) || 0;
      tr.appendChild(numCell(count, { dashIfZero: true }));
    }

    const spectrumVotes = spectrumVotesByType[seatTypeId];
    const totalVotes = spectrums.reduce((s, sp) => s + (spectrumVotes[sp.id] || 0), 0);
    for (const spectrum of spectrums) {
      const votes = spectrumVotes[spectrum.id] || 0;
      const td = document.createElement('td');
      td.textContent = totalVotes > 0 ? formatPercent((votes / totalVotes) * 100) : '—';
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const wrap = document.createElement('div');
  wrap.appendChild(table);
  return wrap;
}

function numCell(count, { dashIfZero = false } = {}) {
  const td = document.createElement('td');
  td.textContent = dashIfZero && !count ? '—' : formatNumber(count);
  return td;
}

main().catch((err) => renderError(content, err));
