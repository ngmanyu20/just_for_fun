/**
 * adjacency.js — WKT polygon parsing + geometric-adjacency (shared-border)
 * computation, for the >10,000-polygon load-limiting rule (FEATURE_SPEC.md
 * Section 1: "clicking a unit loads only its children plus the children of
 * neighboring units at the same level").
 *
 * Pure functions, no fetch/DOM — importable straight into Node for tests.
 *
 * Technique follows the existing polygon editor's `AdjacencyGraph.js`
 * (`E:\Coding Site\just_for_fun\shapefile\js\AdjacencyGraph.js`): two
 * polygons are adjacent when they share an *edge*, not just a corner point
 * — approximated here the same way that file's `rebuildForAffected()` does,
 * by rounding vertices to a tolerance grid and counting how many rounded
 * vertices two polygons have in common (>=2 shared vertices implies a
 * shared edge; a single shared corner point does not count). This is an
 * O(total vertices) vertex-hash pass rather than an O(n^2) edge-pair scan,
 * which matters here: even the smallest adjacency graph this module builds
 * (Authority, 36 units) is cheap either way, but County (~659) and District
 * (~1779) are not, and this same code path is reused for all of them.
 *
 * Per FEATURE_SPEC.md Section 1, only three levels ever need neighbor-based
 * load limiting: Constituency (drilling to County/District), County or
 * District (drilling to Precinct), and Authority (the Referendum page's
 * top layer, drilling to County). Precinct is the bottom layer with nothing
 * to drill into below it, so no precinct-level adjacency graph is built —
 * see results.js / shapes.js for where these are actually invoked.
 *
 * Adjacency is precomputed once per shape collection and cached by the
 * caller (see shapes.js's `getOrBuildAdjacency`) — never recomputed per
 * click, per the task's explicit requirement.
 */

const DEFAULT_TOLERANCE = 0.01; // matches the coordinate precision seen in this dataset's WKT (2 decimal places, with occasional 4-decimal slivers)

/**
 * Parse a WKT `POLYGON (...)` (optionally multi-ring, i.e. with holes) into
 * an array of rings, each an array of `{x, y}` points. Never throws on
 * malformed input — returns `[]` so a bad geometry cell degrades to "no
 * edges, no adjacency" rather than crashing the whole adjacency build.
 *
 * Multi-ring example seen in this dataset (a handful of precincts have a
 * tiny near-zero-area second ring, likely a digitization artifact):
 *   POLYGON ((x y, x y, ...), (x y, x y, ...))
 *
 * @param {string} wkt e.g. "POLYGON ((2883.27 1328.07, 2878.63 1333.14, ...))"
 * @returns {Array<Array<{x:number,y:number}>>}
 */
export function parseWKTPolygon(wkt) {
  if (!wkt) return [];
  const s = String(wkt).trim();
  const start = s.indexOf('((');
  const end = s.lastIndexOf('))');
  if (start === -1 || end === -1 || end <= start) return [];
  const inner = s.slice(start + 2, end); // ring1..., ring2... (rings separated by "), (")
  const ringStrings = inner.split(/\)\s*,\s*\(/);
  const rings = [];
  for (const ringStr of ringStrings) {
    const points = [];
    for (const pair of ringStr.split(',')) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
    }
    if (points.length > 0) rings.push(points);
  }
  return rings;
}

/**
 * Build a geometric-adjacency graph for a set of shapes.
 *
 * @param {Array<{id:string, geometry:string}>} shapes Each item needs a
 *   stable `id` and its raw WKT `geometry` string.
 * @param {number} [tolerance] Grid-rounding tolerance for vertex matching.
 * @returns {Map<string, string[]>} id -> sorted array of neighbor ids.
 */
export function buildAdjacency(shapes, tolerance = DEFAULT_TOLERANCE) {
  const adjacency = new Map();
  for (const shape of shapes) adjacency.set(shape.id, new Set());

  const vertexToIds = new Map(); // roundedVertexKey -> Set<id>
  for (const shape of shapes) {
    const rings = parseWKTPolygon(shape.geometry);
    if (rings.length === 0) continue;
    for (const ring of rings) {
      // Skip the closing duplicate vertex (first === last in a closed ring).
      const len =
        ring.length > 1 && ring[0].x === ring[ring.length - 1].x && ring[0].y === ring[ring.length - 1].y
          ? ring.length - 1
          : ring.length;
      for (let i = 0; i < len; i++) {
        const key = vertexKey(ring[i], tolerance);
        if (!vertexToIds.has(key)) vertexToIds.set(key, new Set());
        vertexToIds.get(key).add(shape.id);
      }
    }
  }

  // Count shared (rounded) vertices per pair; >=2 shared vertices implies
  // a shared edge (a single shared point is just a corner touch).
  const pairCount = new Map();
  for (const ids of vertexToIds.values()) {
    if (ids.size < 2) continue;
    const idList = [...ids];
    for (let a = 0; a < idList.length; a++) {
      for (let b = a + 1; b < idList.length; b++) {
        const key = idList[a] < idList[b] ? `${idList[a]}\u0000${idList[b]}` : `${idList[b]}\u0000${idList[a]}`;
        pairCount.set(key, (pairCount.get(key) || 0) + 1);
      }
    }
  }

  for (const [key, count] of pairCount) {
    if (count < 2) continue;
    const sep = key.indexOf('\u0000');
    const id1 = key.slice(0, sep);
    const id2 = key.slice(sep + 1);
    adjacency.get(id1)?.add(id2);
    adjacency.get(id2)?.add(id1);
  }

  const result = new Map();
  for (const [id, neighbors] of adjacency) result.set(id, [...neighbors].sort());
  return result;
}

/** Rounds a vertex to the given tolerance grid and returns a string key. */
function vertexKey(point, tolerance) {
  const gx = Math.round(point.x / tolerance);
  const gy = Math.round(point.y / tolerance);
  return `${gx},${gy}`;
}

/**
 * Given an adjacency graph and a unit id, return `[unitId, ...neighborIds]`
 * — the set of "same-level" ids whose children should be loaded together
 * under the load-limiting rule (Section 1). Always includes the unit
 * itself even if it has no neighbors (isolated shapes are valid, e.g. an
 * enclave, and should still show their own children).
 *
 * `hops` extends this to a BFS radius beyond immediate neighbors (e.g.
 * `hops: 2` also includes neighbors-of-neighbors) — some callers want a
 * wider context radius than others (e.g. County mode's second layer wants
 * a 2-hop constituency neighborhood, wider than the 1-hop default used
 * elsewhere).
 * @param {Map<string,string[]>} adjacency
 * @param {string} unitId
 * @param {number} [hops]
 * @returns {string[]}
 */
export function unitAndNeighbors(adjacency, unitId, hops = 1) {
  let frontier = new Set([unitId]);
  const visited = new Set([unitId]);
  for (let h = 0; h < hops && frontier.size > 0; h++) {
    const nextFrontier = new Set();
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) || []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          nextFrontier.add(neighbor);
        }
      }
    }
    frontier = nextFrontier;
  }
  return [...visited];
}
