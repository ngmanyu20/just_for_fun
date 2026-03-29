/**
 * PolygonSimplifier
 *
 * Removes topologically and geometrically redundant vertices:
 *   A vertex V is removable when ALL of the following hold:
 *   1. Degree(V) == 2  →  exactly two distinct neighbours across every polygon ring
 *   2. prev(V), V, next(V) are collinear  →  V lies exactly on the edge prev→next
 *   3. Every ring containing V has ≥ 4 unique vertices  →  removal leaves a valid polygon (≥ 3)
 *
 * The algorithm:
 *   a) Collect every unique coordinate (skip WKT closing duplicates).
 *   b) For each unique coordinate evaluate the three conditions.
 *   c) Batch-remove all marked vertices (back-to-front within each ring) and fix
 *      each ring's closing vertex.
 */
class PolygonSimplifier {
    constructor() {
        this.coordTol      = 1e-6;  // coordinate matching tolerance
        this.collinearTol  = 1e-6;  // |cross-product| threshold for collinearity
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * Simplify all polygons in-place.
     * @param   {Array}  polygons
     * @returns {{ polygons: Array, removedCount: number }}
     */
    simplify(polygons) {
        const unique   = this._collectUniqueCoords(polygons);
        const toRemove = [];

        for (const coord of unique.values()) {
            if (this._isRemovable(coord, polygons)) toRemove.push(coord);
        }

        let removedCount = 0;
        for (const coord of toRemove) {
            removedCount += this._removeFromAllRings(coord, polygons);
        }

        return { polygons, removedCount };
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    /** Build a Map<coordKey, {x,y}> of every unique vertex (closing vertex excluded). */
    _collectUniqueCoords(polygons) {
        const map = new Map();
        for (const poly of polygons) {
            for (const ring of poly.rings) {
                for (let i = 0; i < ring.length - 1; i++) {   // -1 skips closing duplicate
                    const k = this._key(ring[i]);
                    if (!map.has(k)) map.set(k, { x: ring[i].x, y: ring[i].y });
                }
            }
        }
        return map;
    }

    /**
     * Return true when coord satisfies all three removal conditions.
     * Scans every ring of every polygon that contains this coordinate.
     */
    _isRemovable(coord, polygons) {
        const neighborKeys   = new Set();
        const neighborCoords = new Map();    // key → {x,y}
        const occurrences    = [];           // { ring } — rings that contain this coord

        for (const poly of polygons) {
            for (const ring of poly.rings) {
                const uLen = ring.length - 1; // unique vertex count (closing excluded)

                for (let vi = 0; vi < uLen; vi++) {
                    if (!this._match(ring[vi], coord)) continue;

                    const prevIdx = (vi - 1 + uLen) % uLen;
                    const nextIdx = (vi + 1)         % uLen;
                    const prev    = ring[prevIdx];
                    const next    = ring[nextIdx];

                    const pk = this._key(prev);
                    const nk = this._key(next);
                    neighborKeys.add(pk);
                    neighborKeys.add(nk);
                    if (!neighborCoords.has(pk)) neighborCoords.set(pk, prev);
                    if (!neighborCoords.has(nk)) neighborCoords.set(nk, next);

                    occurrences.push({ ring });
                }
            }
        }

        if (occurrences.length === 0) return false;

        // Condition 1 — degree == 2
        if (neighborKeys.size !== 2) return false;

        // Condition 2 — collinearity
        const [nA, nB] = Array.from(neighborCoords.values());
        if (!this._collinear(nA, coord, nB)) return false;

        // Condition 3 — removal leaves each ring with ≥ 3 unique vertices
        for (const { ring } of occurrences) {
            if (ring.length - 1 < 4) return false;  // 4 unique − 1 = 3 ✓ minimum
        }

        return true;
    }

    /** Remove every occurrence of coord from every ring (back-to-front) and repair closing vertex. */
    _removeFromAllRings(coord, polygons) {
        let count = 0;
        for (const poly of polygons) {
            for (const ring of poly.rings) {
                const indices = [];
                for (let i = 0; i < ring.length - 1; i++) {   // skip closing
                    if (this._match(ring[i], coord)) indices.push(i);
                }
                for (let i = indices.length - 1; i >= 0; i--) {
                    ring.splice(indices[i], 1);
                    count++;
                }
                // Keep WKT closing vertex consistent with the (possibly new) first vertex
                if (ring.length >= 2) {
                    ring[ring.length - 1] = { x: ring[0].x, y: ring[0].y };
                }
            }
        }
        return count;
    }

    // ─── Math / comparison utilities ─────────────────────────────────────────

    /**
     * True when b lies exactly on the line through a and c.
     * Uses the 2-D cross-product: (c−a) × (b−a) == 0
     */
    _collinear(a, b, c) {
        const dx    = c.x - a.x;
        const dy    = c.y - a.y;
        const cross = dx * (b.y - a.y) - dy * (b.x - a.x);
        return Math.abs(cross) < this.collinearTol;
    }

    _match(a, b) {
        return Math.abs(a.x - b.x) < this.coordTol &&
               Math.abs(a.y - b.y) < this.coordTol;
    }

    _key(v) {
        return `${v.x.toFixed(6)},${v.y.toFixed(6)}`;
    }
}
