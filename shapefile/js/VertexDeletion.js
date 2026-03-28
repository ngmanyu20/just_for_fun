/**
 * VertexDeletion - Handles safe deletion of vertices with county isolation
 * Implements the vertex deletion algorithm with crucial vertex checks
 */
class VertexDeletion {
    constructor(classifier) {
        this.classifier = classifier;
        this.tolerance = 0.000001; // Coordinate matching tolerance
        this.areaTolerance = 0.0001; // Area difference tolerance for validation
    }

    /**
     * Delete a vertex with county isolation
     * @param {Array<Object>} polygons - All polygons
     * @param {Object} vertexToDelete - { polygonIndex, ringIndex, vertexIndex }
     * @returns {Object} - { success: boolean, polygons: Array, message: string }
     */
    deleteVertex(polygons, vertexToDelete) {
        const { polygonIndex, ringIndex, vertexIndex } = vertexToDelete;
        const polygon = polygons[polygonIndex];

        if (!polygon || !polygon.rings[ringIndex]) {
            return { success: false, polygons, message: 'Invalid vertex reference' };
        }

        const vertex = polygon.rings[ringIndex][vertexIndex];
        const d = { x: vertex.x, y: vertex.y };

        // Block deletion of protected vertices (fixed or cross-county)
        if (this.classifier.isProtected(d.x, d.y, polygons)) {
            const type = this.classifier.classify(d.x, d.y, polygons);
            return {
                success: false,
                polygons,
                message: `Cannot delete ${this.classifier.label(type)} vertex`
            };
        }

        // Step 1: Find all occurrences of this vertex
        const occurrences = this.findOccurrences(polygons, d);

        if (occurrences.length === 0) {
            return { success: false, polygons, message: 'Vertex not found' };
        }

        console.log(`Found ${occurrences.length} occurrences of vertex at (${d.x}, ${d.y})`);

        // Record each occurrence's prev/next BEFORE deletion so we can reconstruct
        // the gap ring directly — the edge-map approach in detectAndFillGaps is
        // unreliable when outer boundary unmatched edges share a vertex with the
        // gap triangle, causing the greedy loop builder to go off track.
        const pNeighborPairs = occurrences.map(occ => {
            const ring = polygons[occ.polygonIndex].rings[occ.ringIndex];
            const n = ring.length - 1; // unique vertex count (closing dup excluded)
            const idx = occ.vertexIndex;
            const prev = ring[(idx - 1 + n) % n];
            const next = ring[(idx + 1) % n];
            return {
                polyIndex: occ.polygonIndex,
                prev: { x: prev.x, y: prev.y },
                next: { x: next.x, y: next.y }
            };
        });

        // Step 2: Group occurrences by county
        const groups = this.groupByCounty(polygons, occurrences);

        console.log(`Processing ${groups.size} county groups`);

        // Deep copy polygons for rollback capability
        const originalPolygons = JSON.parse(JSON.stringify(polygons));

        // CRITICAL: Check if vertex is crucial in ANY county group
        // If it's crucial anywhere, we cannot delete it at all (would create gaps)
        for (const [county, occGroup] of groups) {
            if (this.isCrucialVertex(polygons, d, occGroup)) {
                console.log(`Vertex is crucial in county ${county} - cannot delete (would affect neighbors)`);
                return {
                    success: false,
                    polygons: originalPolygons,
                    message: `Cannot delete vertex: crucial in county ${county} (would create gaps with neighbors)`
                };
            }
        }

        // Step 3: Process each county group independently
        for (const [county, occGroup] of groups) {
            console.log(`\nProcessing county: ${county} (${occGroup.length} occurrences)`);

            // Get patch polygon IDs
            const patchIds = [...new Set(occGroup.map(occ => occ.polygonIndex))];

            // Backup this county's patch
            const patchBackup = patchIds.map(id => JSON.parse(JSON.stringify(polygons[id])));

            // Crucial check already done above for all counties

            // Check if vertex is collinear everywhere in this group
            const isCollinear = this.isCollinearEverywhere(polygons, occGroup);

            if (isCollinear) {
                console.log('CASE A: Collinear everywhere - simple removal');

                // Remove vertex from each occurrence
                for (const occ of occGroup) {
                    const ring = polygons[occ.polygonIndex].rings[occ.ringIndex];
                    polygons[occ.polygonIndex].rings[occ.ringIndex] = this.removeVertexFromRing(ring, occ.vertexIndex);
                }

                // Synchronize vertices in patch
                this.synchronizeVerticesInPatch(polygons, patchIds);

                // Validate no gaps/overlaps (simplified - just check ring validity)
                if (!this.validatePatch(polygons, patchIds)) {
                    console.log('Validation failed, rolling back county patch');
                    // Rollback this county patch
                    patchIds.forEach((id, idx) => {
                        polygons[id] = patchBackup[idx];
                    });
                    return {
                        success: false,
                        polygons: originalPolygons,
                        message: `Collinear delete failed in county ${county}`
                    };
                }

            } else {
                console.log('CASE B: Non-collinear - requires edge adjustment');

                // For non-collinear case, we'll use a simpler approach:
                // Remove the vertex and let neighboring vertices adjust naturally
                for (const occ of occGroup) {
                    const ring = polygons[occ.polygonIndex].rings[occ.ringIndex];
                    polygons[occ.polygonIndex].rings[occ.ringIndex] = this.removeVertexFromRing(ring, occ.vertexIndex);
                }

                // Synchronize vertices in patch
                this.synchronizeVerticesInPatch(polygons, patchIds);

                // Validate
                if (!this.validatePatch(polygons, patchIds)) {
                    console.log('Validation failed, rolling back county patch');
                    patchIds.forEach((id, idx) => {
                        polygons[id] = patchBackup[idx];
                    });
                    return {
                        success: false,
                        polygons: originalPolygons,
                        message: `Non-collinear delete failed in county ${county}`
                    };
                }
            }

            console.log(`Successfully processed county ${county}`);
        }

        // Step 4: Detect gaps and absorb into the adjacent polygon with the longest shared boundary.
        // When 3+ polygons shared the deleted vertex, build the gap ring directly from the
        // pre-recorded prev/next neighbors — this is immune to the greedy loop builder going
        // off track along outer boundary unmatched edges that share a vertex with the gap triangle.
        const affectedPolygonIds = [...new Set(occurrences.map(occ => occ.polygonIndex))];
        let absorbedIds = [];

        if (pNeighborPairs.length >= 3) {
            const gapRing = this.buildGapRingFromNeighbors(pNeighborPairs);
            if (gapRing && gapRing.length >= 4) {
                console.log(`Built gap ring directly from pre-deletion neighbors: ${gapRing.length - 1} vertices`);
                const polyId = this.absorbGapIntoNeighbor(gapRing, polygons, affectedPolygonIds);
                if (polyId >= 0) absorbedIds = [polyId];
            }
            // Fallback to edge-map detection if direct method fails
            if (absorbedIds.length === 0) {
                console.log('Direct gap ring failed, falling back to edge-map detection');
                absorbedIds = this.detectAndFillGaps(polygons, affectedPolygonIds);
            }
        } else {
            absorbedIds = this.detectAndFillGaps(polygons, affectedPolygonIds);
        }

        if (absorbedIds.length > 0) {
            const allSyncIds = [...new Set([...affectedPolygonIds, ...absorbedIds])];
            this.synchronizeVerticesInPatch(polygons, allSyncIds);
        }

        return {
            success: true,
            polygons,
            message: `Vertex deleted successfully (${occurrences.length} occurrences across ${groups.size} counties)${absorbedIds.length > 0 ? ` - Absorbed ${absorbedIds.length} gap(s) into adjacent polygon(s)` : ''}`
        };
    }

    /**
     * Find all occurrences of a vertex in polygons
     * @param {Array<Object>} polygons - All polygons
     * @param {Object} d - Vertex coordinate { x, y }
     * @returns {Array<Object>} - Array of { polygonIndex, ringIndex, vertexIndex }
     */
    findOccurrences(polygons, d) {
        const occurrences = [];

        polygons.forEach((polygon, polyIndex) => {
            polygon.rings.forEach((ring, ringIndex) => {
                ring.forEach((vertex, vertexIndex) => {
                    // Skip WKT closing duplicate — last vertex is always a repeat of index 0
                    if (vertexIndex === ring.length - 1 && this.verticesMatch(vertex, ring[0])) return;
                    if (this.verticesMatch(vertex, d)) {
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
     * Group occurrences by county
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<Object>} occurrences - Vertex occurrences
     * @returns {Map<string, Array>} - Map of county -> occurrences
     */
    groupByCounty(polygons, occurrences) {
        const groups = new Map();

        occurrences.forEach(occ => {
            const county = polygons[occ.polygonIndex].county || 'Unknown';
            if (!groups.has(county)) {
                groups.set(county, []);
            }
            groups.get(county).push(occ);
        });

        return groups;
    }

    /**
     * Check if vertex is crucial (conditions 1-2 only)
     * @param {Array<Object>} polygons - All polygons
     * @param {Object} d - Vertex coordinate
     * @param {Array<Object>} occGroup - Occurrences in this county
     * @returns {boolean} - True if crucial
     */
    isCrucialVertex(polygons, d, occGroup) {
        for (const occ of occGroup) {
            const ring = polygons[occ.polygonIndex].rings[occ.ringIndex];

            // Condition 1 & 2: Minimum vertices check
            // A polygon needs at least 3 vertices (4 with closing point)
            // Removing one would leave only 2 unique points
            if (ring.length <= 4) {
                console.log(`Ring has only ${ring.length} vertices - crucial`);
                return true;
            }
        }

        return false;
    }

    /**
     * Check if vertex is collinear at all occurrences
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<Object>} occGroup - Occurrences
     * @returns {boolean} - True if collinear everywhere
     */
    isCollinearEverywhere(polygons, occGroup) {
        for (const occ of occGroup) {
            const ring = polygons[occ.polygonIndex].rings[occ.ringIndex];
            const idx = occ.vertexIndex;

            if (!this.isCollinear(ring, idx)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Check if a vertex is collinear with its neighbors
     * @param {Array<Object>} ring - Polygon ring
     * @param {number} idx - Vertex index
     * @returns {boolean} - True if collinear
     */
    isCollinear(ring, idx) {
        const len = ring.length;
        const prev = ring[(idx - 1 + len) % len];
        const curr = ring[idx];
        const next = ring[(idx + 1) % len];

        // Calculate cross product to check collinearity
        const dx1 = curr.x - prev.x;
        const dy1 = curr.y - prev.y;
        const dx2 = next.x - curr.x;
        const dy2 = next.y - curr.y;

        const crossProduct = Math.abs(dx1 * dy2 - dy1 * dx2);

        // If cross product is very small, points are collinear
        return crossProduct < this.tolerance * 10;
    }

    /**
     * Remove vertex from ring and cleanup
     * @param {Array<Object>} ring - Polygon ring
     * @param {number} idx - Index to remove
     * @returns {Array<Object>} - Cleaned ring
     */
    removeVertexFromRing(ring, idx) {
        const newRing = ring.filter((_, i) => i !== idx);
        // Fix stale closing point when the first vertex was removed:
        // the old closing duplicate (copy of the former index 0) is now at the tail
        // but no longer matches the new first vertex.
        if (newRing.length > 1) {
            const first = newRing[0];
            const last  = newRing[newRing.length - 1];
            if (!this.verticesMatch(first, last)) {
                newRing[newRing.length - 1] = { ...first };
            }
        }
        return this.cleanupRing(newRing);
    }

    /**
     * Cleanup ring (remove consecutive duplicates)
     * @param {Array<Object>} ring - Polygon ring
     * @returns {Array<Object>} - Cleaned ring
     */
    cleanupRing(ring) {
        if (ring.length === 0) return ring;

        const cleaned = [ring[0]];

        for (let i = 1; i < ring.length; i++) {
            const prev = cleaned[cleaned.length - 1];
            const curr = ring[i];

            if (!this.verticesMatch(prev, curr)) {
                cleaned.push(curr);
            }
        }

        // Check if first and last are duplicates (closing point)
        if (cleaned.length > 1 && this.verticesMatch(cleaned[0], cleaned[cleaned.length - 1])) {
            cleaned.pop();
            cleaned.push({ ...cleaned[0] }); // Ensure proper closing
        }

        return cleaned;
    }

    /**
     * Synchronize shared vertices within patch
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<number>} patchIds - Polygon IDs in patch
     */
    synchronizeVerticesInPatch(polygons, patchIds) {
        // Build coordinate map
        const coordMap = new Map();

        patchIds.forEach(polyId => {
            const polygon = polygons[polyId];
            polygon.rings.forEach((ring, ringIndex) => {
                ring.forEach((vertex, vertexIndex) => {
                    const key = this.getCoordKey(vertex);
                    if (!coordMap.has(key)) {
                        coordMap.set(key, []);
                    }
                    coordMap.get(key).push({ polyId, ringIndex, vertexIndex, vertex });
                });
            });
        });

        // Synchronize vertices with same coordinates
        coordMap.forEach((locations) => {
            if (locations.length > 1) {
                // Use first vertex as reference
                const reference = locations[0].vertex;

                locations.forEach(loc => {
                    polygons[loc.polyId].rings[loc.ringIndex][loc.vertexIndex] = {
                        x: reference.x,
                        y: reference.y
                    };
                });
            }
        });
    }

    /**
     * Validate patch (simplified - check ring validity)
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<number>} patchIds - Polygon IDs to validate
     * @returns {boolean} - True if valid
     */
    validatePatch(polygons, patchIds) {
        for (const id of patchIds) {
            const polygon = polygons[id];

            for (const ring of polygon.rings) {
                // Check minimum vertices (at least 3 unique points)
                if (ring.length < 3) {
                    console.log(`Invalid ring: only ${ring.length} vertices`);
                    return false;
                }

                // Check for self-intersection (basic check)
                // This is a simplified check - full validation would need robust geometry library
                if (ring.length < 4) {
                    console.log('Invalid ring: too few vertices');
                    return false;
                }
            }
        }

        return true;
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
     * Detect and fill gaps created by vertex deletion
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<number>} affectedIds - IDs of polygons affected by deletion
     * @returns {Array<Object>} - New gap polygons to fill detected gaps
     */
    /**
     * Build the gap ring directly from the prev/next neighbors recorded before deletion.
     * Each pair has { prev, next } — the vertices that flanked the deleted point in one polygon.
     * After deletion, the gap is bounded by the chain: next_0 → next_1 → ... → next_0,
     * where pair_i is found by matching pair.prev == current next.
     * @param {Array<{polyIndex, prev, next}>} pairs
     * @returns {Array<Object>|null} Closed ring (last === first) or null if chain broken
     */
    buildGapRingFromNeighbors(pairs) {
        const ring = [];
        let current = pairs[0].next;
        ring.push({ ...current });

        const used = new Set([0]);

        for (let step = 0; step < pairs.length - 1; step++) {
            let found = false;
            for (let i = 0; i < pairs.length; i++) {
                if (used.has(i)) continue;
                if (this.verticesMatch(pairs[i].prev, current)) {
                    current = pairs[i].next;
                    ring.push({ ...current });
                    used.add(i);
                    found = true;
                    break;
                }
            }
            if (!found) {
                console.warn('buildGapRingFromNeighbors: chain broken at step', step);
                return null;
            }
        }

        // Close the ring
        if (!this.verticesMatch(ring[ring.length - 1], ring[0])) {
            ring.push({ ...ring[0] });
        }

        return ring;
    }

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

        // Absorb each gap into the neighbor with the longest shared boundary
        const absorbedPolyIds = [];
        for (const loop of gapLoops) {
            const polyId = this.absorbGapIntoNeighbor(loop, polygons, affectedIds);
            if (polyId >= 0) {
                absorbedPolyIds.push(polyId);
            } else {
                console.log('Gap could not be absorbed — no shared edge found with any affected polygon');
            }
        }

        return absorbedPolyIds;
    }

    /**
     * Absorb a gap ring into the adjacent polygon with the longest shared boundary.
     * Finds the shared edge (same direction in both rings), then inserts the gap's
     * remaining vertices into the neighbor ring at that position.
     * @param {Array<Object>} gapRing  - Closed ring of the gap (last vertex == first)
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<number>} affectedIds - Candidate polygon indices
     * @returns {number} Index of the polygon that absorbed the gap, or -1 if none found
     */
    absorbGapIntoNeighbor(gapRing, polygons, affectedIds) {
        let bestPolyId = -1;
        let bestLength = 0;
        let bestEdgeI  = -1;
        let bestGapJ   = -1;

        for (const polyId of affectedIds) {
            const ring = polygons[polyId].rings[0];
            let totalLen = 0;
            let firstI = -1;
            let firstJ = -1;

            for (let i = 0; i < ring.length - 1; i++) {
                for (let j = 0; j < gapRing.length - 1; j++) {
                    if (this.verticesMatch(ring[i],     gapRing[j]) &&
                        this.verticesMatch(ring[i + 1], gapRing[j + 1])) {
                        totalLen += Math.hypot(ring[i+1].x - ring[i].x, ring[i+1].y - ring[i].y);
                        if (firstI < 0) { firstI = i; firstJ = j; }
                    }
                }
            }

            if (totalLen > bestLength) {
                bestLength = totalLen;
                bestPolyId = polyId;
                bestEdgeI  = firstI;
                bestGapJ   = firstJ;
            }
        }

        if (bestPolyId < 0) return -1;

        // Build the interior path: gap vertices going backward from bestGapJ
        // to (bestGapJ+1)%n, i.e. the "other way" around the gap ring
        const n = gapRing.length - 1; // unique vertex count (no closing duplicate)
        const interior = [];
        const stop = (bestGapJ + 1) % n;
        let k = (bestGapJ - 1 + n) % n;
        while (k !== stop) {
            interior.push({ ...gapRing[k] });
            k = (k - 1 + n) % n;
        }

        // Insert interior path into neighbor ring between bestEdgeI and bestEdgeI+1
        const ring = polygons[bestPolyId].rings[0];
        polygons[bestPolyId].rings[0] = [
            ...ring.slice(0, bestEdgeI + 1),
            ...interior,
            ...ring.slice(bestEdgeI + 1)
        ];

        console.log(`Gap absorbed into polygon ${polygons[bestPolyId].id} ` +
                    `(shared length ${bestLength.toFixed(4)}, ${interior.length} vertex/vertices inserted)`);
        return bestPolyId;
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
}
