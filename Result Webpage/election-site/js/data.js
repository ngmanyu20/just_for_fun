/**
 * data.js — THE data layer. Single public entry point for the whole site.
 *
 * This module (together with the files under ./data/ it re-exports) is the
 * ONLY code in this project allowed to fetch or parse a raw file under
 * `data/` (FEATURE_SPEC.md Section 8's `shapes/`, `results/`, `referendum/`,
 * `meta/`). Every page/component elsewhere imports from here — never from
 * `./data/*.js` directly, and never via a raw `fetch('data/...')` call of
 * its own. That's the shared contract the rest of the build (Phase 2's
 * map/results/referendum agents) is built against.
 *
 * Usage:
 *   import * as Data from './js/data.js';
 *   const seats = await Data.getAlmaValeSeats();
 *   const shapeIndex = await Data.getShapeIndex();
 *
 * Architecture (see ./data/*.js for full documentation on each):
 *   csv.js                 - CSV parser + fetch/cache helpers (the only fetch() calls in the project)
 *   config.js               - data/ root resolution, manifest-path helpers
 *   status.js                - time-gating (Not received/Verifying/Counting/Declared), electorate-weighted % declared
 *   meta.js                   - election_meta.json / referendum_meta.json / df_party_participation.csv loading + lookups
 *   shapes.js                  - shapes/ loading, joins, split-district handling, presentation order, neighbor/adjacency
 *   adjacency.js                 - WKT polygon parsing + geometric-adjacency graph builder (used by shapes.js)
 *   supplementaryVote.js          - Alma Vale / Home Districts / General Direct counting method
 *   proportional.js                - General Proportional's two-stage Hare quota + largest remainder
 *   localRepresentative.js          - Local Representative's derived-seat rule
 *   results.js                       - General Election orchestration (the main per-seat-type API)
 *   referendum.js                     - Referendum page orchestration
 *
 * Every pure algorithm module (status.js, supplementaryVote.js,
 * proportional.js, localRepresentative.js, adjacency.js's buildAdjacency/
 * parseWKTPolygon) has no fetch/DOM dependency and is unit-tested directly
 * under plain Node — see ./data/test/*.test.mjs, most importantly
 * proportional.test.mjs's check against FEATURE_SPEC.md Section 4's exact
 * worked example (45 seats, Valid Votes=159,833 -> NRD 10, LRP 9, GRF 19,
 * Right 7).
 *
 * Hosting note: this data layer uses `fetch()` to load data/*, which
 * requires the site to be served over http(s) (a local static server is
 * fine) — browsers block fetching local files under a bare `file://`
 * origin, so opening election-site/index.html directly by double-clicking
 * it will not load any data.
 */

// -- Status / time-gating (Section 2) --
export {
  STATUS,
  computeStatus,
  statusAtLeast,
  percentDeclared,
  summarizeStatus,
  parseTimestamp,
  toNumber,
} from './data/status.js';

// -- Meta (election_meta.json / referendum_meta.json / party participation) --
export {
  loadElectionMeta,
  loadReferendumMeta,
  loadPartyParticipation,
  findSeatType,
  seatTypeResultsUrl,
  findParty,
  findSpectrum,
  flattenLists,
  findParticipation,
} from './data/meta.js';

// -- Shapes: loading, joins, drill-down, presentation order, adjacency (Section 1) --
export {
  loadPolygons,
  loadCounties,
  loadDistrictFragments,
  loadAuthorities,
  loadConstituencies,
  getShapeIndex,
  getShapeJoinIndex,
  ADJACENCY_LEVELS,
  getAdjacency,
  getUnitAndNeighborIds,
  orderConstituencies,
  groupConstituenciesByRegion,
  getCountiesForConstituency,
  getDistrictNamesForConstituency,
  getDistrictGeometryFragments,
  getPrecinctsForCounty,
  getPrecinctsForConstituency,
  getPrecinctsForDistrict,
  getPrecinctsForDistrictFragment,
  getDistrictFragmentsForConstituency,
  getDistrictFragmentForPrecinct,
  getAuthorityForCounty,
  getAuthorityForPrecinct,
  getCountiesForAuthority,
  getPrecinctsForAuthority,
} from './data/shapes.js';

// -- Geometry helpers (for the map renderer -- Section 1) --
export { parseWKTPolygon } from './data/adjacency.js';

// -- Supplementary Vote method internals (Alma Vale / Home Districts / General Direct) --
export {
  SPECTRUMS,
  TRANSFER_COLUMNS,
  sumSupplementaryVoteRows,
  computeSupplementaryVote,
  computeSupplementaryVoteFromRows,
  computeHypotheticalRunoff,
  resolveWinningParty,
} from './data/supplementaryVote.js';

// -- General Proportional two-stage Hare quota + largest remainder (final),
// plus the guaranteed-minimum method used before all 10 sectors declare --
export { computeProportionalAllocation, computeGuaranteedMinimumAllocation } from './data/proportional.js';

// -- Local Representative derivation --
export { deriveLocalRepresentative, buildSpectrumDisplayLabels } from './data/localRepresentative.js';

// -- General Election high-level orchestration (the main API most pages want) --
export {
  getAlmaValeSeats,
  getAlmaValeSeatDetail,
  getAlmaValeSupplementaryVoteForShapeIds,
  getAlmaValeFirstPreferenceWinnerForShapeIds,
  getHomeDistrictsSeats,
  getGeneralDirectSeats,
  getGeneralProportionalResult,
  getOverview,
} from './data/results.js';

// -- Referendum page orchestration --
export {
  getAlmaValeReferendumResults,
  getAlmaValeReferendumForAuthority,
  getAlmaValeReferendumForCounty,
  getGeneralDirectReferendumResults,
} from './data/referendum.js';
