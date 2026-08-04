/**
 * Tests for adjacency.js: WKT parsing edge cases (multi-ring geometries
 * that actually occur in this dataset) plus a real-data run building the
 * Constituency-level (40 units) and Authority-level (36 units) adjacency
 * graphs from data/shapes/df_constituency.csv and data/shapes/df_authority.csv,
 * checking the results are sane (every unit resolves, most have >=1
 * neighbor, no crash on the full real geometry column).
 *
 * Run with: node election-site/js/data/test/adjacency.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCSV } from '../csv.js';
import { parseWKTPolygon, buildAdjacency, unitAndNeighbors } from '../adjacency.js';

let failures = 0;
function check(cond, label, extra) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${label}${extra ? ' -- ' + JSON.stringify(extra) : ''}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.resolve(__dirname, '../../../../data');

// --- WKT parsing ---
check(parseWKTPolygon('').length === 0, 'empty WKT -> []');
check(parseWKTPolygon(null).length === 0, 'null WKT -> [] (no throw)');
check(parseWKTPolygon('garbage').length === 0, 'malformed WKT -> [] (no throw)');

{
  const rings = parseWKTPolygon('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))');
  check(rings.length === 1, 'single-ring polygon parses to 1 ring');
  check(rings[0].length === 5, 'single-ring polygon has 5 points (closed ring)');
  check(rings[0][0].x === 0 && rings[0][0].y === 0, 'first point parsed correctly');
}

{
  // The exact shape of the multi-ring (sliver-hole) rows found in
  // data/shapes/df_polygon.csv (e.g. Shape_ID D07_039).
  const wkt =
    'POLYGON ((3105.89 1466.7, 3105.62 1468.1, 3106 1466, 3104.75 1466, 3105.89 1466.7), (3104.6716 1466.4204, 3104.67 1466.43, 3105.89 1466.7, 3104.6716 1466.4204))';
  const rings = parseWKTPolygon(wkt);
  check(rings.length === 2, 'multi-ring (sliver hole) WKT parses to 2 rings', rings);
}

// --- buildAdjacency: a minimal 2x1 grid of unit squares sharing one edge ---
{
  const shapes = [
    { id: 'A', geometry: 'POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))' },
    { id: 'B', geometry: 'POLYGON ((1 0, 2 0, 2 1, 1 1, 1 0))' }, // shares the x=1 edge with A
    { id: 'C', geometry: 'POLYGON ((5 5, 6 5, 6 6, 5 6, 5 5))' }, // isolated, far away
  ];
  const adjacency = buildAdjacency(shapes);
  check(adjacency.get('A').includes('B'), 'A and B (sharing an edge) are adjacent');
  check(adjacency.get('B').includes('A'), 'adjacency is symmetric');
  check(adjacency.get('C').length === 0, 'C (isolated) has no neighbors');
  check(
    JSON.stringify(unitAndNeighbors(adjacency, 'A').sort()) === JSON.stringify(['A', 'B']),
    'unitAndNeighbors includes the unit itself plus neighbors'
  );
  check(JSON.stringify(unitAndNeighbors(adjacency, 'C')) === JSON.stringify(['C']), 'unitAndNeighbors with no neighbors returns just the unit');
}

// --- Real data: Constituency level (40 units) ---
{
  const csvText = readFileSync(path.join(dataRoot, 'shapes', 'df_constituency.csv'), 'utf-8');
  const rows = parseCSV(csvText);
  check(rows.length === 40, '40 constituencies loaded', rows.length);

  const shapes = rows.map((r) => ({ id: r.Constituency, geometry: r.geometry }));
  const start = Date.now();
  const adjacency = buildAdjacency(shapes);
  const elapsedMs = Date.now() - start;
  check(adjacency.size === 40, 'adjacency graph has an entry for all 40 constituencies');

  let withNeighbors = 0;
  for (const [, neighbors] of adjacency) if (neighbors.length > 0) withNeighbors++;
  check(withNeighbors >= 30, `most constituencies (${withNeighbors}/40) have at least one neighbor`, withNeighbors);
  check(elapsedMs < 5000, `constituency adjacency build completed quickly (${elapsedMs}ms)`, elapsedMs);
}

// --- Real data: Authority level (36 units) ---
{
  const csvText = readFileSync(path.join(dataRoot, 'shapes', 'df_authority.csv'), 'utf-8');
  const rows = parseCSV(csvText);
  check(rows.length === 36, '36 authorities loaded', rows.length);
  const shapes = rows.map((r) => ({ id: r.Authority, geometry: r.geometry }));
  const adjacency = buildAdjacency(shapes);
  check(adjacency.size === 36, 'adjacency graph has an entry for all 36 authorities');
}

// --- Real data: District level (~1779 units, larger set, still must not
//     crash or hang given the multi-ring/sliver geometries seen in df_polygon.csv) ---
{
  const csvText = readFileSync(path.join(dataRoot, 'shapes', 'df_districts.csv'), 'utf-8');
  const rows = parseCSV(csvText);
  // NOTE: (District, District_ID) is NOT a unique composite key in this file
  // -- "Alma Causeway"/District_ID "1" appears twice with different geometry
  // (see the data-layer report's flagged findings). shapes.js therefore uses
  // the row index to build a guaranteed-unique district-part id; mirrored
  // here so this test doesn't silently under-count shapes via a Map key collision.
  const shapes = rows.map((r, i) => ({ id: `${r.District}__${r.District_ID}__${i}`, geometry: r.geometry }));
  const start = Date.now();
  const adjacency = buildAdjacency(shapes);
  const elapsedMs = Date.now() - start;
  check(adjacency.size === shapes.length, `district adjacency graph covers all ${shapes.length} district parts`);
  check(elapsedMs < 15000, `district-level adjacency build completed in reasonable time (${elapsedMs}ms)`, elapsedMs);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
