/**
 * MidpointCreation - Creates new vertices at midpoints between selected adjacent vertices
 * Works with multiple selected vertices that form a contiguous sequence
 */
class MidpointCreation {
    constructor(classifier, fixedCountyVertices) {
        this.classifier = classifier;
        this.fixedCountyVertices = fixedCountyVertices;
        this.tolerance = 0.000001; // Coordinate matching tolerance
    }

    /**
     * Create midpoint vertices between selected adjacent vertices
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<Object>} selectedVertices - Selected vertices with polygonIndex, ringIndex, vertexIndex
     * @returns {Object} - { success: boolean, polygons: Array, message: string }
     */
    createMidpoints(polygons, selectedVertices) {
        if (selectedVertices.length < 2) {
            return {
                success: false,
                polygons,
                message: 'At least 2 vertices must be selected'
            };
        }

        console.log(`Creating midpoints for ${selectedVertices.length} selected vertices`);

        // Deep copy for rollback
        const originalPolygons = JSON.parse(JSON.stringify(polygons));

        // Group selected vertices by polygon and ring
        const groups = this.groupVerticesByRing(selectedVertices);

        if (groups.length === 0) {
            return {
                success: false,
                polygons: originalPolygons,
                message: 'No valid vertex groups found'
            };
        }

        // Validate that all groups have adjacent vertices
        for (const group of groups) {
            const ring = polygons[group.polygonIndex].rings[group.ringIndex];
            if (!this.areVerticesAdjacent(group.vertices, ring.length)) {
                return {
                    success: false,
                    polygons: originalPolygons,
                    message: 'Selected vertices must be adjacent (consecutive in polygon)'
                };
            }
        }

        // All midpoint operations within a polygon are geometrically safe — adding a vertex
        // on an existing edge never changes the polygon shape. No vertex type is blocked.
        //
        // For correct future classification, pre-scan each adjacent pair and record which
        // new midpoints need to be registered as FIXED (FIXED+FIXED edge) so VertexClassifier
        // continues to classify them correctly. CC+CC midpoints self-classify via propagation.
        const pairsToRegisterFixed = []; // { x, y, counties }

        for (const group of groups) {
            const ring = polygons[group.polygonIndex].rings[group.ringIndex];
            const sorted = group.vertices.slice().sort((a, b) => a.vertexIndex - b.vertexIndex);

            for (let i = 0; i < sorted.length - 1; i++) {
                const va = ring[sorted[i].vertexIndex];
                const vb = ring[sorted[i + 1].vertexIndex];
                const typeA = this.classifier.classify(va.x, va.y, polygons);
                const typeB = this.classifier.classify(vb.x, vb.y, polygons);

                if (typeA === VertexClassifier.FIXED && typeB === VertexClassifier.FIXED) {
                    const mid = { x: (va.x + vb.x) / 2, y: (va.y + vb.y) / 2 };
                    const countiesA = this.classifier.getCountiesAtVertex(va.x, va.y, polygons);
                    const countiesB = this.classifier.getCountiesAtVertex(vb.x, vb.y, polygons);
                    const shared = new Set([...countiesA].filter(c => countiesB.has(c)));
                    pairsToRegisterFixed.push({ x: mid.x, y: mid.y, counties: shared.size > 0 ? shared : countiesA });
                }
                // CC+CC: propagateMidpointsToSharedEdges inserts the midpoint into all sharing
                // polygons, so VertexClassifier will auto-detect it as CROSS_COUNTY.
                // All other pairs: midpoint is ORDINARY — no registration needed.
            }
        }

        let totalMidpointsCreated = 0;
        const affectedPolygonIds = new Set();

        // Process each group independently
        for (const group of groups) {
            const { polygonIndex, ringIndex, vertices } = group;

            // Sort vertices by index to ensure correct order
            const sortedVertices = vertices.sort((a, b) => a.vertexIndex - b.vertexIndex);

            console.log(`Processing group: polygon=${polygonIndex}, ring=${ringIndex}, vertices=${sortedVertices.length}`);

            // Get the ring
            const ring = polygons[polygonIndex].rings[ringIndex];
            const maxIdx = ring.length - 1;

            // Create midpoints between consecutive selected vertices
            const midpoints = [];

            // For all cases: just create midpoints between consecutive selected vertices
            if (sortedVertices.length === 2) {
                const idx1 = sortedVertices[0].vertexIndex;
                const idx2 = sortedVertices[1].vertexIndex;

                // Normal case: use the actual vertex indices selected
                const v1Idx = Math.min(idx1, idx2);
                const v2Idx = Math.max(idx1, idx2);

                const v1 = ring[v1Idx];
                const v2 = ring[v2Idx];

                const midpoint = {
                    x: (v1.x + v2.x) / 2,
                    y: (v1.y + v2.y) / 2
                };

                midpoints.push({
                    position: v1Idx + 1,
                    vertex: midpoint,
                    v1Coords: { x: v1.x, y: v1.y },
                    v2Coords: { x: v2.x, y: v2.y }
                });

                console.log(`Midpoint between vertex ${v1Idx} (${v1.x}, ${v1.y}) and vertex ${v2Idx} (${v2.x}, ${v2.y}): (${midpoint.x}, ${midpoint.y})`);
            } else {
                // Multiple consecutive vertices
                for (let i = 0; i < sortedVertices.length - 1; i++) {
                    const v1Idx = sortedVertices[i].vertexIndex;
                    const v2Idx = sortedVertices[i + 1].vertexIndex;

                    const v1 = ring[v1Idx];
                    const v2 = ring[v2Idx];

                    // Calculate midpoint
                    const midpoint = {
                        x: (v1.x + v2.x) / 2,
                        y: (v1.y + v2.y) / 2
                    };

                    midpoints.push({
                        position: v1Idx + 1, // Insert after v1
                        vertex: midpoint,
                        v1Coords: { x: v1.x, y: v1.y },
                        v2Coords: { x: v2.x, y: v2.y }
                    });

                    console.log(`Midpoint between (${v1.x}, ${v1.y}) and (${v2.x}, ${v2.y}): (${midpoint.x}, ${midpoint.y})`);
                }
            }

            // Insert midpoints in reverse order to maintain correct indices
            for (let i = midpoints.length - 1; i >= 0; i--) {
                const mp = midpoints[i];
                ring.splice(mp.position, 0, mp.vertex);
                totalMidpointsCreated++;
            }

            // Update all polygons that share the same edge
            const edgesAffected = midpoints.map(mp => ({
                v1: mp.v1Coords,
                v2: mp.v2Coords,
                midpoint: mp.vertex
            }));

            // Find and update all occurrences of these edges in other polygons
            this.propagateMidpointsToSharedEdges(polygons, edgesAffected, polygonIndex);

            affectedPolygonIds.add(polygonIndex);
        }

        // Collect all affected polygon IDs from propagation
        const allAffectedIds = Array.from(affectedPolygonIds);

        // Register any FIXED midpoints so VertexClassifier continues to classify them as FIXED.
        // This must run after insertion so their coordinates are final.
        if (this.fixedCountyVertices && pairsToRegisterFixed.length > 0) {
            for (const { x, y, counties } of pairsToRegisterFixed) {
                this.fixedCountyVertices.addFixedVertex(x, y, counties);
            }
        }

        console.log(`Created ${totalMidpointsCreated} midpoint(s) across ${allAffectedIds.length} polygon(s)`);

        return {
            success: true,
            polygons,
            message: `Created ${totalMidpointsCreated} midpoint(s)`,
            affectedPolygonIds: allAffectedIds
        };
    }

    /**
     * Group selected vertices by polygon and ring
     * @param {Array<Object>} selectedVertices - Selected vertices
     * @returns {Array<Object>} - Array of groups { polygonIndex, ringIndex, vertices }
     */
    groupVerticesByRing(selectedVertices) {
        const groups = new Map();

        selectedVertices.forEach(vertex => {
            const key = `${vertex.polygonIndex}_${vertex.ringIndex}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    polygonIndex: vertex.polygonIndex,
                    ringIndex: vertex.ringIndex,
                    vertices: []
                });
            }
            groups.get(key).vertices.push(vertex);
        });

        return Array.from(groups.values());
    }

    /**
     * Check if vertices are adjacent (consecutive indices)
     * Handles special case: closing vertex (last vertex) is adjacent to first vertex
     * Also treats selection order as irrelevant (A,B is same as B,A)
     * @param {Array<Object>} vertices - Vertices with vertexIndex
     * @param {number} ringLength - Total number of vertices in the ring
     * @returns {boolean} - True if all vertices are consecutive
     */
    areVerticesAdjacent(vertices, ringLength) {
        if (vertices.length < 2) return true;

        // For exactly 2 vertices, check if they're adjacent (including wrap-around)
        if (vertices.length === 2) {
            const idx1 = vertices[0].vertexIndex;
            const idx2 = vertices[1].vertexIndex;

            // Regular consecutive check
            if (Math.abs(idx1 - idx2) === 1) {
                return true;
            }

            // Wrap-around check: first and last vertex are adjacent
            // The last vertex (ringLength - 1) is the closing vertex, same as vertex 0
            const maxIdx = ringLength - 1;
            if ((idx1 === 0 && idx2 === maxIdx) || (idx1 === maxIdx && idx2 === 0)) {
                console.log(`Vertices ${idx1} and ${idx2} are adjacent (wrap-around/closing vertex)`);
                return true;
            }

            console.log(`Vertices ${idx1} and ${idx2} are not adjacent`);
            return false;
        }

        // For more than 2 vertices, check if they form a consecutive sequence
        const sorted = vertices.slice().sort((a, b) => a.vertexIndex - b.vertexIndex);

        // Check if consecutive
        for (let i = 0; i < sorted.length - 1; i++) {
            if (sorted[i + 1].vertexIndex !== sorted[i].vertexIndex + 1) {
                console.log(`Vertices not adjacent: gap between ${sorted[i].vertexIndex} and ${sorted[i + 1].vertexIndex}`);
                return false;
            }
        }

        return true;
    }

    /**
     * Propagate midpoint insertions to shared edges in neighboring polygons
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<Object>} edgesAffected - Edges where midpoints were added
     * @param {number} sourcePolygonIndex - Index of source polygon
     */
    propagateMidpointsToSharedEdges(polygons, edgesAffected, sourcePolygonIndex) {
        // For each affected edge, find all polygons that share it
        edgesAffected.forEach(({ v1, v2, midpoint }) => {
            console.log(`Propagating midpoint (${midpoint.x}, ${midpoint.y}) for edge (${v1.x}, ${v1.y}) - (${v2.x}, ${v2.y})`);

            // Search all polygons for this edge
            polygons.forEach((polygon, polyIdx) => {
                if (polyIdx === sourcePolygonIndex) return; // Skip source polygon

                polygon.rings.forEach((ring, ringIdx) => {
                    // Look for the edge v1->v2 or v2->v1
                    for (let i = 0; i < ring.length - 1; i++) {
                        const curr = ring[i];
                        const next = ring[i + 1];

                        // Check if this is the same edge (either direction)
                        const isForward = this.verticesMatch(curr, v1) && this.verticesMatch(next, v2);
                        const isReverse = this.verticesMatch(curr, v2) && this.verticesMatch(next, v1);

                        if (isForward || isReverse) {
                            // Check if midpoint already exists (avoid duplicates)
                            const midpointExists = ring.some(v => this.verticesMatch(v, midpoint));

                            if (!midpointExists) {
                                // Insert midpoint between curr and next
                                ring.splice(i + 1, 0, { x: midpoint.x, y: midpoint.y });
                                console.log(`  -> Inserted midpoint in polygon ${polyIdx}, ring ${ringIdx} at position ${i + 1}`);

                                // Important: break to avoid processing the newly inserted vertex
                                break;
                            } else {
                                console.log(`  -> Midpoint already exists in polygon ${polyIdx}, ring ${ringIdx}`);
                            }
                        }
                    }
                });
            });
        });
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
}
