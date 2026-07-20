/**
 * GridSplitter - Splits a rectangular/quad polygon into an N (cols) x M (rows)
 * grid of new rectangular polygons, using bilinear interpolation between the
 * source polygon's 4 corners. For an axis-aligned rectangle this reduces to an
 * exact even grid; for a slightly rotated/skewed quad it still produces
 * gap-free cells.
 *
 * The ring may contain extra near-collinear vertices along its 4 edges (common
 * after prior edits, since vertex-sync inserts boundary vertices to keep
 * neighboring polygons gap-free) — corners are detected by turning angle, and
 * only those 4 corners drive the split. Any boundary vertices a neighbor still
 * needs are restored afterward by PolygonEditor's existing vertexSync pass.
 */
class GridSplitter {
    constructor() {
        this.tolerance = 0.000001;
        // Vertices whose turn angle is below this are treated as lying on a
        // straight edge; above it, they're treated as a rectangle corner.
        this.cornerAngleThresholdDeg = 20;
    }

    /**
     * Split a single polygon into a cols x rows grid.
     * @param {Array<Object>} polygons - All polygons
     * @param {number} sourcePolyIndex - Index of the polygon to split
     * @param {number} cols - Number of columns along the X-axis
     * @param {number} rows - Number of rows along the Y-axis
     * @returns {Object} - { success, polygons, message, newPolygons }
     */
    splitPolygon(polygons, sourcePolyIndex, cols, rows) {
        const sourcePolygon = polygons[sourcePolyIndex];
        const sourceRing = sourcePolygon.rings[0];
        const pts = sourceRing.slice(0, -1); // drop the closing duplicate vertex

        const cornerResult = this.detectCorners(pts);
        if (!cornerResult.valid) {
            return { success: false, polygons, message: cornerResult.message };
        }

        const newPolygons = this.buildGridPolygons(pts, cornerResult.corners, sourcePolygon, sourcePolygon.county, cols, rows);

        if (newPolygons.length === 0) {
            return { success: false, polygons, message: 'Failed to create valid grid polygons' };
        }

        const updatedPolygons = [...polygons];
        updatedPolygons.splice(sourcePolyIndex, 1);
        newPolygons.forEach(p => updatedPolygons.push(p));

        return {
            success: true,
            polygons: updatedPolygons,
            message: `Split polygon into a ${cols}x${rows} grid (${newPolygons.length} new polygons)`,
            newPolygons
        };
    }

    /**
     * Identify the 4 true corners of a (possibly over-vertexed) ring by
     * turning angle, ignoring near-collinear vertices along straight edges.
     * @param {Array<Object>} pts - Unique ring vertices (no closing duplicate), in ring order
     * @returns {{valid: boolean, corners?: number[], message?: string}}
     */
    detectCorners(pts) {
        const n = pts.length;
        if (n < 4) {
            return {
                valid: false,
                message: `Grid split requires at least 4 vertices to form a rectangle. This polygon has ${n} vertices.`
            };
        }

        const corners = [];
        for (let i = 0; i < n; i++) {
            const prev = pts[(i - 1 + n) % n];
            const curr = pts[i];
            const next = pts[(i + 1) % n];
            const v1x = curr.x - prev.x, v1y = curr.y - prev.y;
            const v2x = next.x - curr.x, v2y = next.y - curr.y;
            const len1 = Math.hypot(v1x, v1y), len2 = Math.hypot(v2x, v2y);
            if (len1 < this.tolerance || len2 < this.tolerance) continue; // duplicate point

            const dot = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (len1 * len2)));
            const angleDeg = Math.acos(dot) * 180 / Math.PI;
            if (angleDeg > this.cornerAngleThresholdDeg) corners.push(i);
        }

        if (corners.length !== 4) {
            return {
                valid: false,
                message: `Grid split requires a 4-corner polygon (rectangle). Detected ${corners.length} corner${corners.length === 1 ? '' : 's'} among ${n} vertices — this isn't a simple rectangle.`
            };
        }

        return { valid: true, corners };
    }

    /**
     * Bilinear interpolation between 4 ring-ordered corners.
     * u sweeps corners[0] -> corners[1] (and corners[3] -> corners[2]).
     * v sweeps corners[0] -> corners[3] (and corners[1] -> corners[2]).
     */
    interpolate(corners, u, v) {
        const [c0, c1, c2, c3] = corners;
        return {
            x: (1 - u) * (1 - v) * c0.x + u * (1 - v) * c1.x + u * v * c2.x + (1 - u) * v * c3.x,
            y: (1 - u) * (1 - v) * c0.y + u * (1 - v) * c1.y + u * v * c2.y + (1 - u) * v * c3.y
        };
    }

    /**
     * Build the (cols+1) x (rows+1) point grid, then cols*rows cell rings.
     * @param {Array<Object>} pts - Unique ring vertices (no closing duplicate)
     * @param {number[]} cornerIndices - Indices into pts of the 4 detected corners, in ring order
     */
    buildGridPolygons(pts, cornerIndices, sourcePolygon, county, cols, rows) {
        const corners = cornerIndices.map(idx => pts[idx]);
        const newPolygons = [];

        // grid[i][j] = point at u = i/cols, v = j/rows
        const grid = [];
        for (let i = 0; i <= cols; i++) {
            const column = [];
            for (let j = 0; j <= rows; j++) {
                column.push(this.interpolate(corners, i / cols, j / rows));
            }
            grid.push(column);
        }

        for (let i = 0; i < cols; i++) {
            for (let j = 0; j < rows; j++) {
                const p00 = grid[i][j];
                const p10 = grid[i + 1][j];
                const p11 = grid[i + 1][j + 1];
                const p01 = grid[i][j + 1];

                let cellRing = [
                    { x: p00.x, y: p00.y },
                    { x: p10.x, y: p10.y },
                    { x: p11.x, y: p11.y },
                    { x: p01.x, y: p01.y },
                    { x: p00.x, y: p00.y }
                ];

                let area = this.calculatePolygonArea(cellRing);
                if (area < 0) {
                    cellRing.pop();
                    cellRing.reverse();
                    cellRing.push({ x: cellRing[0].x, y: cellRing[0].y });
                    area = -area;
                }

                if (Math.abs(area) > this.tolerance) {
                    newPolygons.push({
                        id: `${sourcePolygon.id}_split_${Date.now()}_${i}_${j}`,
                        county: county,
                        parent: sourcePolygon.parent || county,
                        rings: [cellRing],
                        layerType: sourcePolygon.layerType || 'subCounty',
                        isSplit: true,
                        splitMetadata: {
                            createdBy: 'grid_split',
                            timestamp: Date.now(),
                            sourcePolygon: sourcePolygon.id,
                            cols,
                            rows,
                            col: i,
                            row: j
                        }
                    });
                }
            }
        }

        return newPolygons;
    }

    /**
     * Calculate polygon area using shoelace formula.
     */
    calculatePolygonArea(ring) {
        let area = 0;
        for (let i = 0; i < ring.length - 1; i++) {
            const v1 = ring[i];
            const v2 = ring[i + 1];
            area += (v1.x * v2.y - v2.x * v1.y);
        }
        return area / 2;
    }
}
