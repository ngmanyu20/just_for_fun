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
     * Return all removable collinear coordinates without mutating anything.
     * Each entry is {x, y} for a vertex that satisfies all three removal conditions.
     * @param   {Array}  polygons
     * @returns {Array<{x:number, y:number}>}
     */
    findRedundantVertices(polygons) {
        const unique   = this._collectUniqueCoords(polygons);
        const toRemove = [];
        for (const coord of unique.values()) {
            if (this._isRemovable(coord, polygons)) toRemove.push(coord);
        }
        return toRemove;
    }

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

    // ─── RDP (Ramer-Douglas-Peucker) API ─────────────────────────────────────

    /**
     * Simplify one polygon using the Ramer-Douglas-Peucker algorithm.
     * Vertices shared with adjacent polygons are never removed.
     *
     * @param {Array}  polygons   - All loaded polygons
     * @param {number} targetIdx  - Index of polygon to simplify
     * @param {number} epsilon    - Max perpendicular distance (data units); 0 = exact collinear only
     * @returns {number}          - Number of vertices removed
     */
    simplifyRDP(polygons, targetIdx, epsilon) {
        if (epsilon < 0) epsilon = 0;
        const poly       = polygons[targetIdx];
        const pinnedKeys = this._buildPinnedSet(polygons, targetIdx);
        let removed = 0;
        for (let ri = 0; ri < poly.rings.length; ri++) {
            const orig       = poly.rings[ri];
            const simplified = this._rdpRing(orig, pinnedKeys, epsilon);
            removed += orig.length - simplified.length;
            poly.rings[ri] = simplified;
        }
        return removed;
    }

    /** Vertices of targetIdx that appear in any other polygon → must not be moved. */
    _buildPinnedSet(polygons, targetIdx) {
        const otherKeys = new Set();
        for (let i = 0; i < polygons.length; i++) {
            if (i === targetIdx) continue;
            for (const ring of polygons[i].rings) {
                for (let j = 0; j < ring.length - 1; j++) otherKeys.add(this._key(ring[j]));
            }
        }
        const pinned = new Set();
        for (const ring of polygons[targetIdx].rings) {
            for (let j = 0; j < ring.length - 1; j++) {
                if (otherKeys.has(this._key(ring[j]))) pinned.add(this._key(ring[j]));
            }
        }
        return pinned;
    }

    /**
     * Apply RDP to a single closed ring.
     * Pinned vertices and index-0 are always kept.
     * The ring is split at anchor points; RDP runs on each arc independently.
     */
    _rdpRing(ring, pinnedKeys, epsilon) {
        const uLen = ring.length - 1;   // unique vertices (closing excluded)
        if (uLen < 4) return ring.slice();

        // Collect mandatory anchors: index 0 (seam) + all pinned vertices
        const keep = new Set([0]);
        for (let i = 0; i < uLen; i++) {
            if (pinnedKeys.has(this._key(ring[i]))) keep.add(i);
        }

        let anchors = [...keep].sort((a, b) => a - b);

        // Need ≥ 2 anchors so each arc has a well-defined start/end line
        if (anchors.length === 1) {
            let maxD = -1, antipodal = Math.floor(uLen / 2);
            for (let i = 1; i < uLen; i++) {
                const d = Math.hypot(ring[i].x - ring[0].x, ring[i].y - ring[0].y);
                if (d > maxD) { maxD = d; antipodal = i; }
            }
            keep.add(antipodal);
            anchors = [...keep].sort((a, b) => a - b);
        }

        // RDP on each arc between consecutive anchors
        for (let s = 0; s < anchors.length; s++) {
            const a0 = anchors[s];
            const a1 = anchors[(s + 1) % anchors.length];

            // Intermediate indices from a0+1 to a1-1 (wrapping)
            const inter = [];
            let cur = (a0 + 1) % uLen;
            while (cur !== a1 && inter.length <= uLen) {
                inter.push(cur);
                cur = (cur + 1) % uLen;
            }
            if (inter.length === 0) continue;

            this._rdpKeep(ring, inter, ring[a0], ring[a1], epsilon, keep);
        }

        const sorted = [...keep].sort((a, b) => a - b);
        const newRing = sorted.map(i => ({ x: ring[i].x, y: ring[i].y }));
        newRing.push({ x: newRing[0].x, y: newRing[0].y });
        return newRing;
    }

    /**
     * Recursive RDP on a sub-array of ring indices.
     * Adds to keepSet the indices of vertices that must be retained.
     */
    _rdpKeep(ring, indices, startPt, endPt, epsilon, keepSet) {
        if (indices.length === 0) return;
        let maxDist = -1, maxI = 0;
        for (let i = 0; i < indices.length; i++) {
            const d = this._perpDist(startPt, endPt, ring[indices[i]]);
            if (d > maxDist) { maxDist = d; maxI = i; }
        }
        if (maxDist < epsilon) return;   // all intermediate vertices removable
        keepSet.add(indices[maxI]);
        this._rdpKeep(ring, indices.slice(0, maxI),       startPt,          ring[indices[maxI]], epsilon, keepSet);
        this._rdpKeep(ring, indices.slice(maxI + 1), ring[indices[maxI]], endPt,                epsilon, keepSet);
    }

    /** Perpendicular distance from point p to the line through a and b. */
    _perpDist(a, b, p) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-14) return Math.hypot(p.x - a.x, p.y - a.y);
        return Math.abs(dx * (a.y - p.y) - dy * (a.x - p.x)) / Math.sqrt(len2);
    }
}
