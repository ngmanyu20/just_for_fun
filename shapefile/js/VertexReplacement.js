/**
 * VertexReplacement - Handles vertex replacement by dragging to adjacent vertex
 * Replaces all occurrences of source vertex with target vertex across all polygons
 */
class VertexReplacement {
    constructor(classifier) {
        this.classifier = classifier;
        this.tolerance = 0.000001; // Coordinate matching tolerance
    }

    /**
     * Replace a vertex by dragging it to an adjacent vertex
     * @param {Array<Object>} polygons - All polygons
     * @param {Object} sourceVertex - { polygonIndex, ringIndex, vertexIndex, x, y }
     * @param {Object} targetVertex - { polygonIndex, ringIndex, vertexIndex, x, y }
     * @returns {Object} - { success: boolean, polygons: Array, message: string }
     */
    replaceVertex(polygons, sourceVertex, targetVertex) {
        const { polygonIndex: srcPolyIdx, ringIndex: srcRingIdx, vertexIndex: srcVertIdx } = sourceVertex;
        const { polygonIndex: tgtPolyIdx, ringIndex: tgtRingIdx, vertexIndex: tgtVertIdx } = targetVertex;

        // Validate input
        if (!polygons[srcPolyIdx] || !polygons[srcPolyIdx].rings[srcRingIdx]) {
            return { success: false, polygons, message: 'Invalid source vertex reference' };
        }

        if (!polygons[tgtPolyIdx] || !polygons[tgtPolyIdx].rings[tgtRingIdx]) {
            return { success: false, polygons, message: 'Invalid target vertex reference' };
        }

        const srcVertex = polygons[srcPolyIdx].rings[srcRingIdx][srcVertIdx];
        const tgtVertex = polygons[tgtPolyIdx].rings[tgtRingIdx][tgtVertIdx];

        const srcType = this.classifier.classify(srcVertex.x, srcVertex.y, polygons);
        const tgtType = this.classifier.classify(tgtVertex.x, tgtVertex.y, polygons);

        // Fixed vertices are always blocked — no exceptions
        if (srcType === VertexClassifier.FIXED) {
            return {
                success: false,
                polygons,
                message: `Cannot replace ${this.classifier.label(srcType)} vertex`
            };
        }
        if (tgtType === VertexClassifier.FIXED) {
            return {
                success: false,
                polygons,
                message: `Cannot replace to ${this.classifier.label(tgtType)} vertex`
            };
        }

        // Cross-county vertices: allow only when both source and target are cross-county
        // on the exact same county boundary (safe simplification along the border)
        if (srcType === VertexClassifier.CROSS_COUNTY || tgtType === VertexClassifier.CROSS_COUNTY) {
            if (srcType === VertexClassifier.CROSS_COUNTY && tgtType === VertexClassifier.CROSS_COUNTY) {
                const srcCounties = this.classifier.getCountiesAtVertex(srcVertex.x, srcVertex.y, polygons);
                const tgtCounties = this.classifier.getCountiesAtVertex(tgtVertex.x, tgtVertex.y, polygons);
                const srcCountySet = Array.from(srcCounties).sort().join(',');
                const tgtCountySet = Array.from(tgtCounties).sort().join(',');
                if (srcCountySet === tgtCountySet) {
                    console.log(`✓ Allowing replacement: both vertices on same cross-county boundary (${srcCountySet})`);
                    // fall through — allowed
                } else {
                    return {
                        success: false,
                        polygons,
                        message: `Cannot replace across different county boundaries (${srcCountySet} → ${tgtCountySet})`
                    };
                }
            } else {
                // One is cross-county, the other is not — would corrupt the boundary
                return {
                    success: false,
                    polygons,
                    message: `Cannot mix ${this.classifier.label(srcType)} and ${this.classifier.label(tgtType)} vertices in replacement`
                };
            }
        }

        // Verify target is adjacent to source in at least one polygon
        if (!this.areAdjacent(polygons, sourceVertex, targetVertex)) {
            return {
                success: false,
                polygons,
                message: 'Target vertex must be adjacent (next/previous) to source vertex'
            };
        }

        // Find all occurrences of source vertex
        const occurrences = this.findOccurrences(polygons, srcVertex);

        if (occurrences.length === 0) {
            return { success: false, polygons, message: 'Source vertex not found' };
        }

        console.log(`Replacing ${occurrences.length} occurrences of vertex (${srcVertex.x}, ${srcVertex.y}) with (${tgtVertex.x}, ${tgtVertex.y})`);

        // Deep copy for rollback
        const originalPolygons = JSON.parse(JSON.stringify(polygons));

        // Replace all occurrences
        let replacedCount = 0;
        occurrences.forEach(occ => {
            const ring = polygons[occ.polygonIndex].rings[occ.ringIndex];
            ring[occ.vertexIndex] = { x: tgtVertex.x, y: tgtVertex.y };
            replacedCount++;
        });

        // Remove consecutive duplicates in all affected polygons
        const affectedPolygonIds = [...new Set(occurrences.map(occ => occ.polygonIndex))];
        affectedPolygonIds.forEach(polyId => {
            polygons[polyId].rings.forEach((ring, ringIdx) => {
                polygons[polyId].rings[ringIdx] = this.removeConsecutiveDuplicates(ring);
            });
        });

        // Validate all affected polygons still have valid rings
        for (const polyId of affectedPolygonIds) {
            const polygon = polygons[polyId];
            for (const ring of polygon.rings) {
                if (ring.length < 4) { // Need at least 3 unique vertices + closing
                    console.log(`Validation failed: ring has only ${ring.length} vertices after replacement`);
                    return {
                        success: false,
                        polygons: originalPolygons,
                        message: 'Replacement would create invalid polygon (too few vertices)'
                    };
                }
            }
        }

        // CRITICAL: Detect and fill any gaps created by vertex replacement
        const gapPolygons = this.detectAndFillGaps(polygons, affectedPolygonIds);

        if (gapPolygons.length > 0) {
            console.log(`Detected ${gapPolygons.length} gap(s), creating fill polygons...`);

            // Add gap polygons to the list
            gapPolygons.forEach(gap => {
                polygons.push(gap);
            });

            // Return message with gap info
            return {
                success: true,
                polygons,
                message: `Replaced ${replacedCount} vertex occurrences - Created ${gapPolygons.length} gap fill polygon(s)`,
                affectedPolygonIds,
                gapPolygons: gapPolygons
            };
        }

        return {
            success: true,
            polygons,
            message: `Replaced ${replacedCount} vertex occurrences`,
            affectedPolygonIds
        };
    }

    /**
     * Check if two vertices are adjacent in any polygon
     * @param {Array<Object>} polygons - All polygons
     * @param {Object} vertex1 - First vertex with polygonIndex, ringIndex, vertexIndex
     * @param {Object} vertex2 - Second vertex with polygonIndex, ringIndex, vertexIndex
     * @returns {boolean} - True if adjacent
     */
    areAdjacent(polygons, vertex1, vertex2) {
        // Get actual coordinates
        const v1 = polygons[vertex1.polygonIndex].rings[vertex1.ringIndex][vertex1.vertexIndex];
        const v2 = polygons[vertex2.polygonIndex].rings[vertex2.ringIndex][vertex2.vertexIndex];

        // Check all polygons for adjacency
        for (let polyIdx = 0; polyIdx < polygons.length; polyIdx++) {
            const polygon = polygons[polyIdx];
            for (let ringIdx = 0; ringIdx < polygon.rings.length; ringIdx++) {
                const ring = polygon.rings[ringIdx];

                for (let i = 0; i < ring.length; i++) {
                    const curr = ring[i];
                    const next = ring[(i + 1) % ring.length];
                    const prev = ring[(i - 1 + ring.length) % ring.length];

                    // Check if curr matches v1 and next/prev matches v2
                    if (this.verticesMatch(curr, v1)) {
                        if (this.verticesMatch(next, v2) || this.verticesMatch(prev, v2)) {
                            return true;
                        }
                    }

                    // Check if curr matches v2 and next/prev matches v1
                    if (this.verticesMatch(curr, v2)) {
                        if (this.verticesMatch(next, v1) || this.verticesMatch(prev, v1)) {
                            return true;
                        }
                    }
                }
            }
        }

        return false;
    }

    /**
     * Find all occurrences of a vertex in polygons
     * @param {Array<Object>} polygons - All polygons
     * @param {Object} vertex - Vertex coordinate { x, y }
     * @returns {Array<Object>} - Array of { polygonIndex, ringIndex, vertexIndex }
     */
    findOccurrences(polygons, vertex) {
        const occurrences = [];

        polygons.forEach((polygon, polyIndex) => {
            polygon.rings.forEach((ring, ringIndex) => {
                ring.forEach((v, vertexIndex) => {
                    if (this.verticesMatch(v, vertex)) {
                        occurrences.push({
                            polygonIndex: polyIndex,
                            ringIndex: ringIndex,
                            vertexIndex: vertexIndex
                        });
                    }
                });
            });
        });

        return occurrences;
    }

    /**
     * Remove consecutive duplicate vertices from a ring
     * @param {Array<Object>} ring - Polygon ring
     * @returns {Array<Object>} - Cleaned ring
     */
    removeConsecutiveDuplicates(ring) {
        if (ring.length === 0) return ring;

        const cleaned = [ring[0]];

        for (let i = 1; i < ring.length; i++) {
            const prev = cleaned[cleaned.length - 1];
            const curr = ring[i];

            // Only add if different from previous
            if (!this.verticesMatch(prev, curr)) {
                cleaned.push(curr);
            }
        }

        // Ensure ring is closed properly
        if (cleaned.length > 1) {
            const first = cleaned[0];
            const last = cleaned[cleaned.length - 1];

            if (!this.verticesMatch(first, last)) {
                // Not closed, add closing vertex
                cleaned.push({ x: first.x, y: first.y });
            }
        }

        return cleaned;
    }

    /**
     * Get all counties that share a vertex
     * @param {Array<Object>} polygons - All polygons
     * @param {Object} vertex - Vertex coordinate { x, y }
     * @returns {Set<string>} - Set of unique county names
     */
    getCountiesForVertex(polygons, vertex) {
        const counties = new Set();
        const occurrences = this.findOccurrences(polygons, vertex);

        occurrences.forEach(occ => {
            const polygon = polygons[occ.polygonIndex];
            if (polygon.county) {
                counties.add(polygon.county);
            }
        });

        return counties;
    }

    /**
     * Check if two vertices match within tolerance
     * @param {Object} v1 - Vertex 1
     * @param {Object} v2 - Vertex 2
     * @returns {boolean} - True if match
     */
    verticesMatch(v1, v2) {
        return Math.abs(v1.x - v2.x) < this.tolerance &&
               Math.abs(v1.y - v2.y) < this.tolerance;
    }

    /**
     * Get coordinate key for a vertex
     * @param {Object} vertex - Vertex
     * @returns {string} - Coordinate key
     */
    getCoordKey(vertex) {
        return `${vertex.x.toFixed(6)},${vertex.y.toFixed(6)}`;
    }

    /**
     * Get normalized edge key for edge map
     * @param {Object} v1 - First vertex
     * @param {Object} v2 - Second vertex
     * @returns {string} - Normalized edge key
     */
    getEdgeKey(v1, v2) {
        // Normalize: smaller coordinate first
        const k1 = this.getCoordKey(v1);
        const k2 = this.getCoordKey(v2);
        return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
    }

    /**
     * Detect and fill gaps created by vertex replacement
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<number>} affectedIds - IDs of polygons affected by replacement
     * @returns {Array<Object>} - New gap polygons to fill detected gaps
     */
    detectAndFillGaps(polygons, affectedIds) {
        console.log('Detecting gaps in affected polygons...');

        // Build edge map: track which polygons share each edge
        // IMPORTANT: Check ALL polygons, not just affected ones, to properly detect shared edges
        const edgeMap = new Map();

        polygons.forEach((polygon, polyId) => {
            polygon.rings.forEach((ring, ringIndex) => {
                for (let i = 0; i < ring.length - 1; i++) {
                    const v1 = ring[i];
                    const v2 = ring[i + 1];

                    // Create normalized edge key (smaller coord first for consistency)
                    const edgeKey = this.getEdgeKey(v1, v2);

                    if (!edgeMap.has(edgeKey)) {
                        edgeMap.set(edgeKey, []);
                    }

                    edgeMap.get(edgeKey).push({
                        polyId,
                        ringIndex,
                        vertexIndex: i,
                        v1: { x: v1.x, y: v1.y },
                        v2: { x: v2.x, y: v2.y }
                    });
                }
            });
        });

        // Find unmatched edges (edges that appear only once = gap boundary)
        // BUT only consider edges from affected polygons
        const unmatchedEdges = [];
        edgeMap.forEach((edgeInstances, edgeKey) => {
            if (edgeInstances.length === 1) {
                // Check if this edge belongs to an affected polygon
                const belongsToAffected = edgeInstances.some(inst => affectedIds.includes(inst.polyId));
                if (belongsToAffected) {
                    unmatchedEdges.push(edgeInstances[0]);
                }
            }
        });

        if (unmatchedEdges.length === 0) {
            console.log('No gaps detected');
            return [];
        }

        console.log(`Found ${unmatchedEdges.length} unmatched edges`);

        // Group unmatched edges into closed loops (gap polygons)
        const gapLoops = this.buildGapLoops(unmatchedEdges);

        if (gapLoops.length === 0) {
            console.log('Unmatched edges do not form closed loops');
            return [];
        }

        // Create gap polygon objects
        const gapPolygons = gapLoops.map((loop, idx) => {
            // Determine neighbors and county assignment
            const neighbors = this.findGapNeighbors(loop, polygons, affectedIds);
            const assignedCounty = this.assignGapCounty(loop, neighbors, polygons);

            const gapId = `gap_${Date.now()}_${idx}`;

            console.log(`Creating gap polygon ${gapId} for county ${assignedCounty}`);

            return {
                id: gapId,
                county: assignedCounty,
                parent: neighbors.map(n => n.id).join(','),
                rings: [loop],
                originalWKT: '',
                layerType: 'subCounty',
                isGap: true,
                gapMetadata: {
                    createdBy: 'vertex_replacement',
                    timestamp: Date.now(),
                    neighbors: neighbors.map(n => n.id),
                    neighborCounties: [...new Set(neighbors.map(n => n.county))],
                    assignedCounty: assignedCounty
                }
            };
        });

        return gapPolygons;
    }

    /**
     * Build gap loops from unmatched edges
     * @param {Array<Object>} unmatchedEdges - Array of unmatched edge objects
     * @returns {Array<Array>} - Array of closed loops (each loop is array of vertices)
     */
    buildGapLoops(unmatchedEdges) {
        const loops = [];
        const usedEdges = new Set();

        // Build vertex-to-edges map for quick lookup
        const vertexEdgesMap = new Map();
        unmatchedEdges.forEach((edge, idx) => {
            const v1Key = this.getCoordKey(edge.v1);
            const v2Key = this.getCoordKey(edge.v2);

            if (!vertexEdgesMap.has(v1Key)) vertexEdgesMap.set(v1Key, []);
            if (!vertexEdgesMap.has(v2Key)) vertexEdgesMap.set(v2Key, []);

            vertexEdgesMap.get(v1Key).push({ edgeIdx: idx, vertex: edge.v2 });
            vertexEdgesMap.get(v2Key).push({ edgeIdx: idx, vertex: edge.v1 });
        });

        // Try to build loops starting from each unused edge
        for (let i = 0; i < unmatchedEdges.length; i++) {
            if (usedEdges.has(i)) continue;

            const loop = [];
            const startEdge = unmatchedEdges[i];
            let currentVertex = startEdge.v1;
            let currentEdgeIdx = i;

            loop.push({ x: currentVertex.x, y: currentVertex.y });
            usedEdges.add(currentEdgeIdx);

            // Follow edges to build a closed loop
            let maxIterations = unmatchedEdges.length * 2;
            let iterations = 0;

            while (iterations < maxIterations) {
                iterations++;

                // Move to the other end of current edge
                const edge = unmatchedEdges[currentEdgeIdx];
                const nextVertex = this.verticesMatch(currentVertex, edge.v1) ? edge.v2 : edge.v1;

                loop.push({ x: nextVertex.x, y: nextVertex.y });

                // Check if we've closed the loop
                if (this.verticesMatch(nextVertex, startEdge.v1)) {
                    // Closed loop found
                    if (loop.length >= 4) { // At least 3 unique vertices + closing
                        loops.push(loop);
                    }
                    break;
                }

                // Find next edge connected to nextVertex
                const nextVertexKey = this.getCoordKey(nextVertex);
                const connectedEdges = vertexEdgesMap.get(nextVertexKey) || [];

                let foundNext = false;
                for (const conn of connectedEdges) {
                    if (!usedEdges.has(conn.edgeIdx)) {
                        currentEdgeIdx = conn.edgeIdx;
                        currentVertex = nextVertex;
                        usedEdges.add(currentEdgeIdx);
                        foundNext = true;
                        break;
                    }
                }

                if (!foundNext) {
                    // Dead end, can't form a closed loop
                    break;
                }
            }
        }

        return loops;
    }

    /**
     * Find neighbor polygons for a gap loop
     * @param {Array<Object>} loop - Gap loop vertices
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<number>} affectedIds - IDs of affected polygons
     * @returns {Array<Object>} - Array of neighbor polygon objects
     */
    findGapNeighbors(loop, polygons, affectedIds) {
        const neighbors = [];
        const neighborSet = new Set();

        // For each vertex in the gap loop, find which polygon it belongs to
        loop.forEach(vertex => {
            affectedIds.forEach(polyId => {
                if (neighborSet.has(polyId)) return;

                const polygon = polygons[polyId];
                polygon.rings.forEach(ring => {
                    const hasVertex = ring.some(v => this.verticesMatch(v, vertex));
                    if (hasVertex && !neighborSet.has(polyId)) {
                        neighborSet.add(polyId);
                        neighbors.push({
                            id: polygon.id,
                            county: polygon.county,
                            polyId: polyId
                        });
                    }
                });
            });
        });

        return neighbors;
    }

    /**
     * Assign county to gap polygon based on nearest neighbor vertices
     * @param {Array<Object>} loop - Gap loop vertices
     * @param {Array<Object>} neighbors - Neighbor polygon info
     * @param {Array<Object>} polygons - All polygons
     * @returns {string} - Assigned county name
     */
    assignGapCounty(loop, neighbors, polygons) {
        // Count vertices per county
        const countyVertexCount = new Map();

        neighbors.forEach(neighbor => {
            const county = neighbor.county;
            if (!countyVertexCount.has(county)) {
                countyVertexCount.set(county, 0);
            }

            const polygon = polygons[neighbor.polyId];
            polygon.rings.forEach(ring => {
                loop.forEach(gapVertex => {
                    const hasVertex = ring.some(v => this.verticesMatch(v, gapVertex));
                    if (hasVertex) {
                        countyVertexCount.set(county, countyVertexCount.get(county) + 1);
                    }
                });
            });
        });

        // Assign to county with most shared vertices
        let maxCount = 0;
        let assignedCounty = neighbors.length > 0 ? neighbors[0].county : 'Unknown';

        countyVertexCount.forEach((count, county) => {
            if (count > maxCount) {
                maxCount = count;
                assignedCounty = county;
            }
        });

        console.log(`Gap assigned to county ${assignedCounty} (${maxCount} shared vertices)`);

        return assignedCounty;
    }
}
