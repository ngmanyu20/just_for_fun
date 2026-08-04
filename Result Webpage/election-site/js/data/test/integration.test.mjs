/**
 * End-to-end integration test of the whole data layer (election-site/js/data.js)
 * against the REAL files under data/ -- not a fixture.
 *
 * data.js/csv.js call the browser's global `fetch()`, which Node doesn't
 * provide for `file://` URLs (and the default ESM loader doesn't support
 * dynamically importing modules over `http://` either, which would have
 * been the alternative: spin up a static server and import data.js from
 * it so import.meta.url-based path resolution naturally produces http
 * URLs). So this test takes the smallest honest option: monkey-patch
 * `global.fetch` in THIS TEST PROCESS ONLY to serve `file://` URLs from
 * disk via `fs`, then import the real, unmodified data.js and drive it
 * through actual page-level calls (getAlmaValeSeats, getOverview,
 * getGeneralProportionalResult, the referendum functions, ...). No
 * production file is touched or forked for this -- every module under
 * election-site/js/data/ still makes its normal fetch() calls; only where
 * those calls resolve to is intercepted.
 *
 * Run with: node election-site/js/data/test/integration.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const originalFetch = global.fetch;
global.fetch = async (url) => {
  const href = typeof url === 'string' ? url : url.href;
  if (!href.startsWith('file://')) return originalFetch(url);
  const filePath = fileURLToPath(href);
  if (!existsSync(filePath)) {
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => '', json: async () => ({}) };
  }
  const text = readFileSync(filePath, 'utf-8');
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};

const Data = await import('../../data.js');

let failures = 0;
function check(cond, label, extra) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${label}${extra !== undefined ? ' -- ' + JSON.stringify(extra) : ''}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// A fixed "now" in the past relative to every timestamp currently in the
// data (which are all blank per Section 7's simulation checklist) doesn't
// matter for that reason, but pin it anyway for reproducibility.
const NOW = new Date('2026-08-03T12:00:00Z');

// --- Meta loads ---
const electionMeta = await Data.loadElectionMeta();
check(electionMeta.seat_types.length === 4, 'election_meta.json: 4 seat types loaded', electionMeta.seat_types.length);

const referendumMeta = await Data.loadReferendumMeta();
check(referendumMeta.seat_types.length === 2, 'referendum_meta.json: 2 seat types loaded', referendumMeta.seat_types.length);

// --- Shape index ---
const shapeIndex = await Data.getShapeIndex();
check(shapeIndex.polygonById.size === 20850, 'shape index: 20,850 precincts', shapeIndex.polygonById.size);

// --- Alma Vale: Section 7 notes this file starts out empty, but Agent 1b
//     fills it in concurrently -- by the time this test ran, real rows had
//     already landed (confirmed: data/results/df_results_alma_vale.csv
//     went from 0 to 20,850 data rows partway through this build). Rather
//     than assert a specific fill state (which would make this test flaky
//     against a moving target), assert the invariants that must hold
//     REGARDLESS of how complete the data is: full roster always present,
//     every value finite, percentDeclared always in [0,100], winner only
//     ever a real party or null (never crashes/NaN/undefined). ---
{
  const seats = await Data.getAlmaValeSeats(NOW);
  check(seats.length === 40, 'getAlmaValeSeats: all 40 seats present regardless of fill state', seats.length);
  check(
    seats.every((s) => Number.isFinite(s.percentDeclared) && s.percentDeclared >= 0 && s.percentDeclared <= 100),
    'getAlmaValeSeats: percentDeclared always finite and in [0,100]'
  );
  check(
    seats.every((s) => s.winnerParty === null || typeof s.winnerParty === 'string'),
    'getAlmaValeSeats: winnerParty is always null or a party abbreviation, never crashes'
  );
  const anyDeclared = seats.some((s) => s.percentDeclared > 0);
  console.log(`    (informational) Alma Vale fill state at test time: ${anyDeclared ? 'partially/fully populated' : 'still empty'} (data/1b is concurrent)`);
  // Presentation order: Region groups should appear in the documented order.
  const regionsInOrder = [...new Set(seats.map((s) => s.region))];
  check(JSON.stringify(regionsInOrder) === JSON.stringify(['Capital', 'Highland', 'Lowland']), 'getAlmaValeSeats: region order is Capital, Highland, Lowland', regionsInOrder);

  const detail = await Data.getAlmaValeSeatDetail(seats[0].constituency, NOW);
  check(Array.isArray(detail.precincts) && detail.precincts.length > 0, `getAlmaValeSeatDetail("${seats[0].constituency}"): precinct list populated`, detail.precincts.length);
}

// --- Home Districts: 5 seats, real (if incomplete) data ---
{
  const seats = await Data.getHomeDistrictsSeats(NOW);
  check(seats.length === 5, 'getHomeDistrictsSeats: 5 seats', seats.length);
  check(
    seats.every((s) => Number.isFinite(s.electorate)),
    'getHomeDistrictsSeats: electorate is always a finite number'
  );
}

// --- General Direct: 10 seats including derived Local Representative ---
{
  const seats = await Data.getGeneralDirectSeats(NOW);
  check(seats.length === 10, 'getGeneralDirectSeats: 10 seats (9 direct + 1 derived)', seats.length);
  const localRep = seats.find((s) => s.constituency === 'Local Representative');
  check(!!localRep, 'getGeneralDirectSeats: Local Representative seat present');
  check(localRep.isDerived === true, 'Local Representative seat is flagged isDerived');
  check(
    seats.filter((s) => s.constituency !== 'Local Representative').every((s) => !s.isDerived),
    'only Local Representative is flagged as derived'
  );
}

// --- General Proportional: national allocation. As with Alma Vale above,
//     don't assert a specific fill state -- assert the invariants: seats
//     never exceed the 45-seat total, every list/party seat count is a
//     non-negative integer, no crash regardless of how many of the 10
//     sectors are Declared yet. ---
{
  const result = await Data.getGeneralProportionalResult(NOW);
  check(Number.isFinite(result.validVotes) && result.validVotes >= 0, 'getGeneralProportionalResult: validVotes finite and non-negative', result.validVotes);
  const totalSeatsAllocated = result.lists.reduce((s, l) => s + l.seats, 0);
  check(totalSeatsAllocated <= 45, `getGeneralProportionalResult: total seats allocated (${totalSeatsAllocated}) never exceeds 45`);
  check(
    result.lists.every((l) => l.parties.every((p) => Number.isInteger(p.seats) && p.seats >= 0)),
    'getGeneralProportionalResult: every party seat count is a non-negative integer'
  );
  check(result.sectors.length === 10, 'getGeneralProportionalResult: all 10 sector rows returned for status display', result.sectors.length);
  console.log(`    (informational) General Proportional fill state at test time: validVotes=${result.validVotes}, seats allocated=${totalSeatsAllocated}/45`);
}

// --- Overview ties everything together ---
{
  const overview = await Data.getOverview(NOW);
  check(Object.keys(overview.seatTypes).length === 4, 'getOverview: covers all 4 seat types');
  check(typeof overview.tally === 'object', 'getOverview: tally object returned, no crash');
}

// --- Referendum: AlmaVale (geographic) + GeneralDirect (flat table) ---
{
  const almaValeRef = await Data.getAlmaValeReferendumResults(NOW);
  check(almaValeRef.precinctRows.length === 20850, 'getAlmaValeReferendumResults: 20,850 precinct rows', almaValeRef.precinctRows.length);
  check(
    Number.isFinite(almaValeRef.national.validVotes) && almaValeRef.national.validVotes >= 0,
    'getAlmaValeReferendumResults: national valid votes finite and non-negative regardless of fill state'
  );

  const sampleAuthority = shapeIndex.authorities[0].Authority;
  const forAuthority = await Data.getAlmaValeReferendumForAuthority(sampleAuthority, NOW);
  check(forAuthority.precinctRows.length > 0, `getAlmaValeReferendumForAuthority("${sampleAuthority}"): precincts resolved via 2-hop join`, forAuthority.precinctRows.length);

  const generalDirectRef = await Data.getGeneralDirectReferendumResults(NOW);
  check(generalDirectRef.seats.length === 9, 'getGeneralDirectReferendumResults: 9 flat-table seats (Local Representative has no referendum row either)', generalDirectRef.seats.length);
}

// --- Adjacency reused across calls (precomputed once) ---
{
  const a1 = Data.getAdjacency(shapeIndex, 'authority');
  const a2 = Data.getAdjacency(shapeIndex, 'authority');
  check(a1 === a2, 'authority adjacency graph cached across calls');
  const neighbors = Data.getUnitAndNeighborIds(shapeIndex, 'authority', shapeIndex.authorities[0].Authority);
  check(neighbors.length >= 1, 'getUnitAndNeighborIds works through the public barrel');
}

global.fetch = originalFetch;

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
