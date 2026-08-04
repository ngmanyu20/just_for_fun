/**
 * shapes.js — geography loading, joins, drill-down, and neighbor-based
 * load limiting (FEATURE_SPEC.md Section 1).
 *
 * Hierarchy recap:
 *   General Election: Constituency -> County-or-District (site-wide toggle) -> Precinct
 *   Referendum:        Authority -> County -> Precinct (fixed, no toggle)
 *
 * Ground-truth joins (verified in FEATURE_SPEC.md Section 1 and re-verified
 * against the live files while building this module):
 *   - df_polygon.csv (Shape_ID = Precinct): County, District, Constituency all present per row.
 *   - df_county.csv: County -> Constituency (always exactly one) and County -> Zone (always exactly one).
 *   - df_authority.csv: Authority is the *same 36-value set* as df_county.csv's Zone column,
 *     joined by name only (there is no literal Authority column anywhere else).
 *   - 12 District names straddle two Constituencies; Counties never straddle.
 *
 * Data-shape finding not spelled out in FEATURE_SPEC.md (flagged in the
 * data-layer report, confirmed and corrected below): County and District
 * are NOT parallel 1-polygon-per-unit structures. `df_county.csv` has
 * exactly one row per County code (659 rows, 659 distinct codes) — one
 * polygon per unit. `df_districts.csv` has 1,779 rows but only a few dozen
 * distinct District names (37 per FEATURE_SPEC.md's original count; the
 * live shapefiles currently have 38 — this number drifts across shapefile
 * regenerations, don't hardcode it), each District's shape assembled from
 * many small fragment rows — genuine ward-sized sub-districts, not just
 * decorative geometry pieces of one unit.
 *
 * **The fragment-to-precinct join is an exact label match on
 * `District_Ward`, NOT `District_ID` and NOT spatial**: `df_polygon.csv`'s
 * `District_Ward` ("Ward N") does NOT correspond to `df_districts.csv`'s
 * `District_ID` (N) despite sharing an overlapping 1..N numbering range per
 * District name — that was verified false by point-in-polygon testing
 * (fragment District_ID=38's own polygon spatially contains precincts
 * labeled `Ward 7`, not `Ward 38`) during an earlier data snapshot, which is
 * why this module used a spatial (point-in-polygon centroid) join for a
 * time. The shapefile data has since been regenerated and `df_districts.csv`
 * now carries its OWN `District_Ward` column (distinct from `District_ID`)
 * that matches `df_polygon.csv`'s `District_Ward` values exactly: joining
 * precincts to fragments on `(District, District_Ward)` — fragment's own
 * label, not the row-order `District_ID` — resolves all 20,850 precincts
 * with zero misses and zero duplicate `(District, District_Ward)` keys in
 * `df_districts.csv` (re-verified against the live files; the old
 * `"Alma Causeway"` / `District_ID "1"` duplicate cited as evidence against
 * a label join is also gone from the current data — down to one row). This
 * is what makes each (District, District_Ward) fragment a genuine,
 * independently meaningful sub-district — its own clickable Layer-2 unit
 * with its own precincts and its own results, the same way a County is —
 * rather than just a geometry piece of one merged District blob.
 * `getDistrictFragmentsForConstituency` / `getPrecinctsForDistrictFragment`
 * below are built on this label join; `getDistrictNamesForConstituency` /
 * `getDistrictGeometryFragments` / `getPrecinctsForDistrict` remain as the
 * coarser "whole District, merged" utilities for anything that still wants
 * that view (e.g. the Local Representative seat's own "one vote per whole
 * District" rule — FEATURE_SPEC.md Section 4 — which counts by District
 * name, not by the 1,779 fragment rows).
 *
 * `_fragmentId` stays synthesized with an index suffix (below) as a
 * defensive measure even though `(District, District_ID)` is unique in the
 * current data — cheap insurance against a future regeneration
 * reintroducing a duplicate.
 */

import { fetchCSV } from './csv.js';
import { dataPath } from './config.js';
import { buildAdjacency, unitAndNeighbors } from './adjacency.js';

// ---------------------------------------------------------------------
// Raw file loaders (memoized by csv.js's URL-keyed cache already; no
// need to re-memoize here).
// ---------------------------------------------------------------------

/** @returns {Promise<Array<Object>>} 20,850 precinct rows (Shape_ID-keyed). */
export function loadPolygons() {
  return fetchCSV(dataPath('shapes/df_polygon.csv'));
}

/** @returns {Promise<Array<Object>>} 659 county rows (County-keyed, 1 polygon each). */
export function loadCounties() {
  return fetchCSV(dataPath('shapes/df_county.csv'));
}

/**
 * @returns {Promise<Array<Object>>} 1,779 district *fragment* rows (many
 *   rows share one District name — see module doc). Each row gets a
 *   `_fragmentId` unique key attached, since (District, District_ID) can
 *   collide in the source data.
 */
export async function loadDistrictFragments() {
  const rows = await fetchCSV(dataPath('shapes/df_districts.csv'));
  return rows.map((row, i) => ({ ...row, _fragmentId: `${row.District}__${row.District_ID}__${i}` }));
}

/** @returns {Promise<Array<Object>>} 36 authority rows (Authority-keyed, 1 polygon each). */
export function loadAuthorities() {
  return fetchCSV(dataPath('shapes/df_authority.csv'));
}

/** @returns {Promise<Array<Object>>} 40 constituency rows (Constituency-keyed, 1 polygon each). */
export function loadConstituencies() {
  return fetchCSV(dataPath('shapes/df_constituency.csv'));
}

// ---------------------------------------------------------------------
// "Lean" loaders -- same rows as loadPolygons()/loadCounties()/
// loadConstituencies() above, minus the `geometry`/`centroid` columns
// (generated by scripts/build_lean_shapes.py at the repo root, run as this
// site's Render build command -- see render.yaml). `geometry` is what makes
// df_polygon.csv ~8MB; most of that is dead weight for any page that's only
// joining Shape_ID -> Constituency/District/County to group results, never
// drawing a shape. Used by getShapeJoinIndex() below -- NOT by
// getShapeIndex()/buildShapeIndexFromRows(), which map-rendering pages still
// need full geometry from, unchanged.
// ---------------------------------------------------------------------

function loadPolygonsLean() {
  return fetchCSV(dataPath('shapes/df_polygon_lean.csv'));
}

function loadCountiesLean() {
  return fetchCSV(dataPath('shapes/df_county_lean.csv'));
}

function loadConstituenciesLean() {
  return fetchCSV(dataPath('shapes/df_constituency_lean.csv'));
}

function groupBy(rows, field) {
  const map = new Map();
  for (const row of rows) {
    const key = row[field];
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

// ---------------------------------------------------------------------
// Shape index — the joined, queryable view over all 5 shapes/ files.
// Built once and cached (module-level singleton promise): every join map
// AND every adjacency graph in here is computed exactly once per page
// load, never recomputed per click, per the task's explicit requirement.
// ---------------------------------------------------------------------

let _shapeIndexPromise = null;

/**
 * Get the (memoized) shape index. Safe to call as often as needed — the
 * underlying build only runs once.
 * @returns {Promise<ShapeIndex>}
 */
export function getShapeIndex() {
  if (!_shapeIndexPromise) _shapeIndexPromise = buildShapeIndex();
  return _shapeIndexPromise;
}

/** Escape hatch for tests that want a fresh index (e.g. after swapping fixtures). */
export function _resetShapeIndexCache() {
  _shapeIndexPromise = null;
}

// ---------------------------------------------------------------------
// Shape JOIN index -- a lighter getShapeIndex() for callers that only need
// to resolve Shape_ID -> Constituency/District/County (results.js grouping
// results by seat, referendum.js rolling precincts up to Authority/County)
// and never touch geometry, adjacency, or district-fragment drill-down.
// Built from the lean loaders above, so it skips fetching `geometry`/
// `centroid` entirely (df_polygon.csv's ~8MB -> ~1.6MB) AND skips
// df_districts.csv/df_authority.csv altogether, since no join-only caller
// needs either. Kept as a separate singleton/cache from getShapeIndex() --
// a page that also renders a map still calls getShapeIndex() for that, this
// is only for pages/computations that don't.
// ---------------------------------------------------------------------

let _shapeJoinIndexPromise = null;

/**
 * Get the (memoized) shape JOIN index -- see module doc above. Safe to call
 * as often as needed.
 * @returns {Promise<{polygonById:Map, polygonsByCounty:Map, countiesByZone:Map, constituencies:Array}>}
 */
export function getShapeJoinIndex() {
  if (!_shapeJoinIndexPromise) _shapeJoinIndexPromise = buildShapeJoinIndex();
  return _shapeJoinIndexPromise;
}

/** Escape hatch for tests that want a fresh join index. */
export function _resetShapeJoinIndexCache() {
  _shapeJoinIndexPromise = null;
}

async function buildShapeJoinIndex() {
  const [polygons, counties, constituencies] = await Promise.all([
    loadPolygonsLean(),
    loadCountiesLean(),
    loadConstituenciesLean(),
  ]);
  return buildShapeJoinIndexFromRows({ polygons, counties, constituencies });
}

/**
 * Pure join logic for the lean index, factored out the same way
 * buildShapeIndexFromRows() is, for plain-Node testability.
 * @param {{polygons:Array, counties:Array, constituencies:Array}} rows
 */
export function buildShapeJoinIndexFromRows({ polygons, counties, constituencies }) {
  return {
    polygonById: new Map(polygons.map((p) => [p.Shape_ID, p])),
    polygonsByCounty: groupBy(polygons, 'County'),
    countiesByZone: groupBy(counties, 'Zone'),
    constituencies,
  };
}

async function buildShapeIndex() {
  const [polygons, counties, districtFragments, authorities, constituencies] = await Promise.all([
    loadPolygons(),
    loadCounties(),
    loadDistrictFragments(),
    loadAuthorities(),
    loadConstituencies(),
  ]);
  return buildShapeIndexFromRows({ polygons, counties, districtFragments, authorities, constituencies });
}

/**
 * Pure join logic, factored out of `buildShapeIndex()` so it's testable
 * under plain Node without a `fetch` shim (feed it CSV rows read via
 * `fs` + `parseCSV` directly — see test/shapes.test.mjs). Note
 * `districtFragments` must already carry the synthesized `_fragmentId`
 * that `loadDistrictFragments()` attaches (District/District_ID is not a
 * reliable unique key in the source data — see module doc).
 * @param {{polygons:Array, counties:Array, districtFragments:Array, authorities:Array, constituencies:Array}} rows
 * @returns {ShapeIndex}
 */
export function buildShapeIndexFromRows({ polygons, counties, districtFragments, authorities, constituencies }) {
  const index = {
    polygons,
    counties,
    districtFragments,
    authorities,
    constituencies,

    polygonById: new Map(polygons.map((p) => [p.Shape_ID, p])),
    polygonsByCounty: groupBy(polygons, 'County'),
    polygonsByDistrict: groupBy(polygons, 'District'),
    polygonsByConstituency: groupBy(polygons, 'Constituency'),

    countyByCode: new Map(counties.map((c) => [c.County, c])),
    countiesByConstituency: groupBy(counties, 'Constituency'),
    countiesByZone: groupBy(counties, 'Zone'),

    districtFragmentsByName: groupBy(districtFragments, 'District'),
    districtFragmentById: new Map(districtFragments.map((f) => [f._fragmentId, f])),
    districtNames: [...new Set(districtFragments.map((d) => d.District))].sort(),

    authorityByName: new Map(authorities.map((a) => [a.Authority, a])),

    constituencyByName: new Map(constituencies.map((c) => [c.Constituency, c])),

    // Lazily built & cached adjacency graphs, keyed by level. Built on
    // first request via getAdjacency() below, not eagerly here, since not
    // every page needs every level's graph (e.g. the Referendum page never
    // needs District-level adjacency).
    _adjacency: {},
  };

  return index;
}

// ---------------------------------------------------------------------
// Adjacency (neighbor) graphs — precomputed once per level, cached on the
// shape index. See adjacency.js for the shared-border technique.
// ---------------------------------------------------------------------

const ADJACENCY_LEVELS = Object.freeze({
  CONSTITUENCY: 'constituency',
  COUNTY: 'county',
  DISTRICT: 'district',
  DISTRICT_FRAGMENT: 'districtFragment',
  AUTHORITY: 'authority',
});

/**
 * Get (building + caching on first call) the adjacency graph for a level.
 * @param {ShapeIndex} shapeIndex
 * @param {'constituency'|'county'|'district'|'authority'} level
 * @returns {Map<string, string[]>}
 */
export function getAdjacency(shapeIndex, level) {
  if (shapeIndex._adjacency[level]) return shapeIndex._adjacency[level];

  let shapes;
  switch (level) {
    case ADJACENCY_LEVELS.CONSTITUENCY:
      shapes = shapeIndex.constituencies.map((c) => ({ id: c.Constituency, geometry: c.geometry }));
      break;
    case ADJACENCY_LEVELS.COUNTY:
      shapes = shapeIndex.counties.map((c) => ({ id: c.County, geometry: c.geometry }));
      break;
    case ADJACENCY_LEVELS.DISTRICT:
      // Multiple fragment rows share one District name on purpose — see
      // module doc; buildAdjacency() naturally folds same-id shapes
      // together since it buckets vertices by id, not by row. Coarse
      // (whole-District) adjacency — see DISTRICT_FRAGMENT below for the
      // per-ward level the map's District mode actually drills through.
      shapes = shapeIndex.districtFragments.map((d) => ({ id: d.District, geometry: d.geometry }));
      break;
    case ADJACENCY_LEVELS.DISTRICT_FRAGMENT:
      // One shape per fragment row (`_fragmentId`, unique even where
      // District+District_ID collides — see module doc) — the actual
      // Layer-2 unit granularity in District mode, one level finer than
      // DISTRICT above.
      shapes = shapeIndex.districtFragments.map((d) => ({ id: d._fragmentId, geometry: d.geometry }));
      break;
    case ADJACENCY_LEVELS.AUTHORITY:
      shapes = shapeIndex.authorities.map((a) => ({ id: a.Authority, geometry: a.geometry }));
      break;
    default:
      throw new Error(`data layer: unknown adjacency level "${level}"`);
  }

  const adjacency = buildAdjacency(shapes);
  shapeIndex._adjacency[level] = adjacency;
  return adjacency;
}

export { ADJACENCY_LEVELS };

/**
 * The >10,000-polygon load-limiting rule (Section 1): given the level the
 * user is currently browsing and the unit they clicked, return that unit's
 * id plus its geometric neighbors' ids at the same level — the set whose
 * children should be loaded together. `hops` widens this to a BFS radius
 * beyond immediate (1-hop) neighbors when a caller wants more context.
 * @param {ShapeIndex} shapeIndex
 * @param {'constituency'|'county'|'district'|'districtFragment'|'authority'} level
 * @param {string} unitId
 * @param {number} [hops]
 * @returns {string[]}
 */
export function getUnitAndNeighborIds(shapeIndex, level, unitId, hops = 1) {
  const adjacency = getAdjacency(shapeIndex, level);
  return unitAndNeighbors(adjacency, unitId, hops);
}

// ---------------------------------------------------------------------
// Constituency presentation order (Section 1): group by Region, sort
// within region by Constituency_Code ascending.
// ---------------------------------------------------------------------

/**
 * Parse a Constituency_Code like "C01"/"H10"/"SE05" into a comparable
 * {prefix, num} pair for natural (not lexicographic) ordering.
 * @param {string} code
 */
function parseConstituencyCode(code) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(code || '').trim());
  if (!m) return { prefix: String(code || ''), num: 0 };
  return { prefix: m[1], num: Number(m[2]) };
}

/**
 * Sort constituency rows into the canonical presentation order: grouped by
 * Region, regions in alphabetical order (the spec's own example — Capital,
 * Highland, Lowland — happens to be alphabetical; the spec does not state
 * an explicit region ordering beyond that example, so alphabetical is this
 * module's documented, deterministic choice — flagged in the data-layer
 * report), and within each region sorted by Constituency_Code ascending
 * (natural sort: alpha prefix, then numeric suffix, e.g. C01 < C02 < ... < C20).
 * @param {Array<Object>} constituencyRows rows from df_constituency.csv
 * @returns {Array<Object>} same rows, sorted
 */
export function orderConstituencies(constituencyRows) {
  return [...constituencyRows].sort((a, b) => {
    if (a.Region !== b.Region) return a.Region < b.Region ? -1 : 1;
    const ca = parseConstituencyCode(a.Constituency_Code);
    const cb = parseConstituencyCode(b.Constituency_Code);
    if (ca.prefix !== cb.prefix) return ca.prefix < cb.prefix ? -1 : 1;
    return ca.num - cb.num;
  });
}

/**
 * Convenience: ordered constituency rows grouped by Region, in
 * presentation order — the shape most nav menus / seat lists want.
 * @param {Array<Object>} constituencyRows
 * @returns {Array<{region:string, constituencies:Array<Object>}>}
 */
export function groupConstituenciesByRegion(constituencyRows) {
  const ordered = orderConstituencies(constituencyRows);
  const groups = [];
  const byRegion = new Map();
  for (const row of ordered) {
    if (!byRegion.has(row.Region)) {
      const group = { region: row.Region, constituencies: [] };
      byRegion.set(row.Region, group);
      groups.push(group);
    }
    byRegion.get(row.Region).constituencies.push(row);
  }
  return groups;
}

// ---------------------------------------------------------------------
// Drill-down children, with split-district handling (Section 1).
// ---------------------------------------------------------------------

/**
 * Layer-2 County units belonging to a Constituency. Counties never
 * straddle constituencies (verified, Section 1), so this is a plain filter.
 * @param {ShapeIndex} shapeIndex
 * @param {string} constituencyName
 * @returns {Array<Object>}
 */
export function getCountiesForConstituency(shapeIndex, constituencyName) {
  return shapeIndex.countiesByConstituency.get(constituencyName) || [];
}

/**
 * Layer-2 District *names* that have at least one precinct inside a given
 * Constituency (derived from df_polygon.csv, the precinct-grain ground
 * truth — not from df_districts.csv's fragment rows, since a straddling
 * district's fragments aren't individually tagged with which constituency
 * they fall in).
 * @param {ShapeIndex} shapeIndex
 * @param {string} constituencyName
 * @returns {string[]} sorted District names
 */
export function getDistrictNamesForConstituency(shapeIndex, constituencyName) {
  const precincts = shapeIndex.polygonsByConstituency.get(constituencyName) || [];
  return [...new Set(precincts.map((p) => p.District))].sort();
}

/**
 * All geometry fragment rows that make up a named District's shape
 * (District mode's Layer-2 rendering unit — see module doc).
 * @param {ShapeIndex} shapeIndex
 * @param {string} districtName
 * @returns {Array<Object>}
 */
export function getDistrictGeometryFragments(shapeIndex, districtName) {
  return shapeIndex.districtFragmentsByName.get(districtName) || [];
}

/**
 * Layer-3 precincts inside a County.
 * @param {ShapeIndex} shapeIndex
 * @param {string} countyCode
 * @returns {Array<Object>}
 */
export function getPrecinctsForCounty(shapeIndex, countyCode) {
  return shapeIndex.polygonsByCounty.get(countyCode) || [];
}

/**
 * All precincts belonging to a Constituency (every County within it,
 * flattened) — County mode's precinct layer uses this for "the whole
 * owning constituency", a broader scope than a single County's own
 * precincts.
 * @param {ShapeIndex} shapeIndex
 * @param {string} constituencyName
 * @returns {Array<Object>}
 */
export function getPrecinctsForConstituency(shapeIndex, constituencyName) {
  return shapeIndex.polygonsByConstituency.get(constituencyName) || [];
}

/**
 * Layer-3 precincts inside a District, applying the split-district rule
 * (Section 1): when `constituencyName` is given, only precincts inside
 * BOTH that District AND that Constituency are returned (both columns
 * already exist per-precinct in df_polygon.csv — no extra join needed).
 * Omit `constituencyName` to get the District's full extent (unfiltered
 * top-level County/District mode).
 * @param {ShapeIndex} shapeIndex
 * @param {string} districtName
 * @param {string} [constituencyName]
 * @returns {Array<Object>}
 */
export function getPrecinctsForDistrict(shapeIndex, districtName, constituencyName) {
  const precincts = shapeIndex.polygonsByDistrict.get(districtName) || [];
  if (!constituencyName) return precincts;
  return precincts.filter((p) => p.Constituency === constituencyName);
}

// ---------------------------------------------------------------------
// District *fragments* (District + District_Ward "ward" sub-units) — the
// finer-grained counterpart to the whole-District functions above. The
// fragment-to-precinct join is an exact label match on `District_Ward`
// (df_polygon.csv's own column against df_districts.csv's own column) —
// see module doc for the history of why this used to be a spatial join.
// ---------------------------------------------------------------------

/**
 * Compute (and cache on the shape index) which fragment each precinct in a
 * District belongs to, via an exact `(District, District_Ward)` label
 * match. Computed once per District name — every fragment/precinct-for-
 * fragment function below reads from this cache rather than re-matching
 * per call.
 * @param {ShapeIndex} shapeIndex
 * @param {string} districtName
 * @returns {Map<string, Object|null>} Shape_ID -> fragment row (or null if no fragment shares its District_Ward label)
 */
function getFragmentAssignments(shapeIndex, districtName) {
  if (!shapeIndex._fragmentAssignments) shapeIndex._fragmentAssignments = new Map();
  if (shapeIndex._fragmentAssignments.has(districtName)) return shapeIndex._fragmentAssignments.get(districtName);

  const fragments = shapeIndex.districtFragmentsByName.get(districtName) || [];
  const fragmentByWard = new Map(fragments.map((f) => [f.District_Ward, f]));
  const precincts = shapeIndex.polygonsByDistrict.get(districtName) || [];

  const assignment = new Map();
  for (const p of precincts) {
    assignment.set(p.Shape_ID, fragmentByWard.get(p.District_Ward) || null);
  }
  shapeIndex._fragmentAssignments.set(districtName, assignment);
  return assignment;
}

/**
 * Layer-3 precincts inside a single District fragment (one ward — spatial
 * membership, see above), applying the same split-district rule as
 * `getPrecinctsForDistrict` (Section 1): when `constituencyName` is given,
 * only precincts inside BOTH this ward AND that Constituency are returned.
 * Omit `constituencyName` for the ward's full extent.
 * @param {ShapeIndex} shapeIndex
 * @param {string} districtName
 * @param {string|number} districtId
 * @param {string} [constituencyName]
 * @returns {Array<Object>}
 */
export function getPrecinctsForDistrictFragment(shapeIndex, districtName, districtId, constituencyName) {
  const assignments = getFragmentAssignments(shapeIndex, districtName);
  const precincts = (shapeIndex.polygonsByDistrict.get(districtName) || []).filter((p) => {
    const frag = assignments.get(p.Shape_ID);
    return frag && String(frag.District_ID) === String(districtId);
  });
  if (!constituencyName) return precincts;
  return precincts.filter((p) => p.Constituency === constituencyName);
}

/**
 * Layer-2 District *fragments* that have at least one precinct inside a
 * given Constituency — one clickable unit per ward, the finer-grained
 * counterpart to `getDistrictNamesForConstituency`. A fragment with no
 * precincts in this Constituency (a split-District's far side, or one
 * whose polygon happens to contain no precinct centroids at all) is
 * excluded rather than shown as an empty unit.
 * @param {ShapeIndex} shapeIndex
 * @param {string} constituencyName
 * @returns {Array<Object>} fragment rows (District, District_ID, geometry, _fragmentId, ...)
 */
export function getDistrictFragmentsForConstituency(shapeIndex, constituencyName) {
  const districtNames = getDistrictNamesForConstituency(shapeIndex, constituencyName);
  const result = [];
  for (const districtName of districtNames) {
    const assignments = getFragmentAssignments(shapeIndex, districtName);
    const fragmentsWithPrecinctsHere = new Set();
    for (const p of shapeIndex.polygonsByDistrict.get(districtName) || []) {
      if (p.Constituency !== constituencyName) continue;
      const frag = assignments.get(p.Shape_ID);
      if (frag) fragmentsWithPrecinctsHere.add(frag._fragmentId);
    }
    for (const fragment of shapeIndex.districtFragmentsByName.get(districtName) || []) {
      if (fragmentsWithPrecinctsHere.has(fragment._fragmentId)) result.push(fragment);
    }
  }
  return result;
}

/**
 * Reverse lookup: which District fragment (ward) a given precinct spatially
 * belongs to. Returns `null` if the precinct's centroid doesn't fall inside
 * any of its District's fragment polygons — callers should degrade
 * gracefully (e.g. a deep-link that silently no-ops) rather than throwing.
 * @param {ShapeIndex} shapeIndex
 * @param {{District:string, Shape_ID:string}} precinct
 * @returns {Object|null}
 */
export function getDistrictFragmentForPrecinct(shapeIndex, precinct) {
  const assignments = getFragmentAssignments(shapeIndex, precinct.District);
  return assignments.get(precinct.Shape_ID) || null;
}

// ---------------------------------------------------------------------
// Zone/Authority join (Section 1 / Section 5): df_polygon.County ->
// df_county.Zone -> df_authority.Authority (matched by name).
// ---------------------------------------------------------------------

/**
 * Resolve a County's Authority via its Zone (name-matched against
 * df_authority.csv's Authority column — the two are the same 36-value set).
 * @param {ShapeIndex} shapeIndex
 * @param {string} countyCode
 * @returns {Object|null}
 */
export function getAuthorityForCounty(shapeIndex, countyCode) {
  const county = shapeIndex.countyByCode.get(countyCode);
  if (!county) return null;
  return shapeIndex.authorityByName.get(county.Zone) || null;
}

/**
 * Resolve a precinct's Authority via the 2-hop join:
 * Shape_ID -> County (df_polygon) -> Zone (df_county) -> Authority (df_authority, by name).
 * @param {ShapeIndex} shapeIndex
 * @param {string} shapeId
 * @returns {Object|null}
 */
export function getAuthorityForPrecinct(shapeIndex, shapeId) {
  const precinct = shapeIndex.polygonById.get(shapeId);
  if (!precinct) return null;
  return getAuthorityForCounty(shapeIndex, precinct.County);
}

/**
 * Counties belonging to an Authority (Referendum page's Layer-2, joined by
 * Zone === Authority name).
 * @param {ShapeIndex} shapeIndex
 * @param {string} authorityName
 * @returns {Array<Object>}
 */
export function getCountiesForAuthority(shapeIndex, authorityName) {
  return shapeIndex.countiesByZone.get(authorityName) || [];
}

/**
 * Precincts belonging to an Authority (Referendum page's Layer-3), via
 * Authority -> its Counties -> their precincts.
 * @param {ShapeIndex} shapeIndex
 * @param {string} authorityName
 * @returns {Array<Object>}
 */
export function getPrecinctsForAuthority(shapeIndex, authorityName) {
  const counties = getCountiesForAuthority(shapeIndex, authorityName);
  const result = [];
  for (const county of counties) {
    const precincts = shapeIndex.polygonsByCounty.get(county.County);
    if (precincts) result.push(...precincts);
  }
  return result;
}

/**
 * @typedef {ReturnType<typeof buildShapeIndex> extends Promise<infer T> ? T : never} ShapeIndex
 */
