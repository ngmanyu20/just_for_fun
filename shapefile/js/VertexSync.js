/**
 * VertexSync - Synchronizes shared vertices between neighboring polygons
 * Ensures all vertices on shared boundaries are exactly aligned
 */
class VertexSync {
    constructor(tolerance = 0.01) {
        this.tolerance = tolerance;
        this.debugMode = false; // Set to true for detailed logging
    }

    /**
     * Collect all vertices from a polygon
     * @param {Object} polygon - Polygon with rings
     * @returns {Array<Object>} - Array of {x, y} points
     */
    collectVertices(polygon) {
        const vertices = [];
        polygon.rings.forEach(ring => {
            ring.forEach(point => {
                vertices.push({ x: point.x, y: point.y });
            });
        });
        return vertices;
    }

    /**
     * Deduplicate points by snapping to tolerance grid
     * @param {Array<Object>} points - Array of {x, y} points
     * @returns {Array<Object>} - Deduplicated points
     */
    deduplicatePoints(points) {
        if (!points || points.length === 0) return [];

        const scale = 1.0 / this.tolerance;
        const seen = new Set();
        const result = [];

        points.forEach(point => {
            const key = `${Math.round(point.x * scale)},${Math.round(point.y * scale)}`;
            if (!seen.has(key)) {
                seen.add(key);
                result.push(point);
            }
        });

        return result;
    }

    /**
     * Find points on a line segment
     * @param {Object} a - Start point {x, y}
     * @param {Object} b - End point {x, y}
     * @param {Array<Object>} candidates - Candidate points
     * @returns {Array<Object>} - Points on segment, sorted by parameter t
     */
    pointsOnSegment(a, b, candidates) {
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const vv = vx * vx + vy * vy;

        if (vv === 0) return [];

        // Bounding box with tolerance
        const minX = Math.min(a.x, b.x) - this.tolerance;
        const maxX = Math.max(a.x, b.x) + this.tolerance;
        const minY = Math.min(a.y, b.y) - this.tolerance;
        const maxY = Math.max(a.y, b.y) + this.tolerance;

        const onSegment = [];

        candidates.forEach(p => {
            // Quick bbox check
            if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) {
                return;
            }

            // Exclude endpoints
            const isStartPoint = Math.abs(p.x - a.x) <= this.tolerance && Math.abs(p.y - a.y) <= this.tolerance;
            const isEndPoint = Math.abs(p.x - b.x) <= this.tolerance && Math.abs(p.y - b.y) <= this.tolerance;
            if (isStartPoint || isEndPoint) {
                return;
            }

            // Calculate distance to segment
            const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / vv;

            // Check if point is on segment (within tolerance)
            if (t >= -1e-12 && t <= 1 + 1e-12) {
                // Calculate closest point on segment
                const closestX = a.x + t * vx;
                const closestY = a.y + t * vy;
                const dist = Math.sqrt(Math.pow(p.x - closestX, 2) + Math.pow(p.y - closestY, 2));

                if (dist <= this.tolerance) {
                    onSegment.push({ t, point: p });
                }
            }
        });

        // Sort by parameter t
        onSegment.sort((a, b) => a.t - b.t);
        return onSegment.map(item => item.point);
    }

    /**
     * Insert vertices into a ring where they lie on edges
     * @param {Array<Object>} ring - Ring coordinates [{x, y}, ...]
     * @param {Array<Object>} candidatePoints - Points to insert
     * @returns {Array<Object>} - New ring with inserted vertices
     */
    insertVerticesIntoRing(ring, candidatePoints) {
        if (ring.length < 3) return ring;

        // Ensure ring is closed
        const isClosed = Math.abs(ring[0].x - ring[ring.length - 1].x) < this.tolerance &&
                        Math.abs(ring[0].y - ring[ring.length - 1].y) < this.tolerance;

        const workingRing = isClosed ? ring : [...ring, { ...ring[0] }];

        // Deduplicate candidates
        const uniqueCandidates = this.deduplicatePoints(candidatePoints);

        if (this.debugMode && uniqueCandidates.length > 0) {
            console.log(`    Checking ${uniqueCandidates.length} candidate vertices against ${workingRing.length - 1} edges`);
        }

        const newRing = [];
        const segmentCount = workingRing.length - 1;
        let totalInserted = 0;

        for (let i = 0; i < segmentCount; i++) {
            const a = workingRing[i];
            const b = workingRing[i + 1];

            newRing.push({ ...a });

            // Find points on this segment
            const pointsToInsert = this.pointsOnSegment(a, b, uniqueCandidates);

            if (this.debugMode && pointsToInsert.length > 0) {
                console.log(`    Edge ${i}: (${a.x.toFixed(3)}, ${a.y.toFixed(3)}) → (${b.x.toFixed(3)}, ${b.y.toFixed(3)}) - inserting ${pointsToInsert.length} vertices`);
            }

            // Insert points in order
            pointsToInsert.forEach(p => {
                // Avoid duplicate adjacent points
                const lastPoint = newRing[newRing.length - 1];
                if (Math.abs(p.x - lastPoint.x) > this.tolerance ||
                    Math.abs(p.y - lastPoint.y) > this.tolerance) {
                    newRing.push({ ...p });
                    totalInserted++;
                }
            });
        }

        // Ensure closed
        if (newRing.length > 0) {
            const first = newRing[0];
            const last = newRing[newRing.length - 1];
            if (Math.abs(first.x - last.x) > this.tolerance ||
                Math.abs(first.y - last.y) > this.tolerance) {
                newRing.push({ ...first });
            }
        }

        return newRing;
    }

    /**
     * Synchronize vertices for a set of polygons with their neighbors
     * @param {Array<Object>} polygons - Array of all polygons
     * @param {Object} adjacencyGraph - Adjacency graph with getNeighbors method
     * @param {Set<number>} affectedIndices - Indices of polygons to sync (optional)
     * @returns {Array<Object>} - Polygons with synchronized vertices
     */
    syncVertices(polygons, adjacencyGraph, affectedIndices = null) {
        console.log('Starting vertex synchronization...');

        // If no specific indices provided, sync all
        const indicesToSync = affectedIndices || new Set(polygons.map((_, i) => i));

        // Pre-collect all vertices for each polygon
        const verticesByIndex = polygons.map(poly => this.collectVertices(poly));

        // Create updated polygons array
        const updatedPolygons = polygons.map((poly, index) => {
            // Skip if not in affected set
            if (!indicesToSync.has(index)) {
                return poly;
            }

            // Get neighbor IDs
            const neighborIds = adjacencyGraph.getNeighbors(poly.id);
            if (neighborIds.length === 0) {
                return poly;
            }

            // Collect vertices from all neighbors
            const neighborVertices = [];
            neighborIds.forEach(neighborId => {
                const neighborIndex = polygons.findIndex(p => p.id === neighborId);
                if (neighborIndex >= 0 && verticesByIndex[neighborIndex]) {
                    neighborVertices.push(...verticesByIndex[neighborIndex]);
                }
            });

            if (neighborVertices.length === 0) {
                return poly;
            }

            // Deduplicate neighbor vertices
            const uniqueNeighborVertices = this.deduplicatePoints(neighborVertices);

            // Process each ring
            const updatedRings = poly.rings.map(ring => {
                const originalLength = ring.length;
                const updatedRing = this.insertVerticesIntoRing(ring, uniqueNeighborVertices);
                const verticesAdded = updatedRing.length - originalLength;

                if (verticesAdded > 0) {
                    console.log(`  Polygon ${poly.id}: inserted ${verticesAdded} vertices (${originalLength} → ${updatedRing.length})`);
                }

                return updatedRing;
            });

            // Return updated polygon
            return {
                ...poly,
                rings: updatedRings
            };
        });

        console.log(`Synchronized vertices for ${indicesToSync.size} polygons`);
        return updatedPolygons;
    }

    /**
     * Synchronize vertices after split operation
     * @param {Array<Object>} allPolygons - All polygons including split ones
     * @param {Object} adjacencyGraph - Adjacency graph
     * @param {number} startIndex - Index where split polygons start
     * @param {number} count - Number of split polygons
     * @param {Object} parentPolygon - Original parent polygon before split (optional)
     * @param {Array<string>} parentNeighborIds - IDs of parent's neighbors before split (optional)
     * @returns {Array<Object>} - Polygons with synchronized vertices
     */
    syncAfterSplit(allPolygons, adjacencyGraph, startIndex, count, parentPolygon = null, parentNeighborIds = null) {
        console.log(`Syncing vertices after split: ${count} polygons at index ${startIndex}`);

        // CRITICAL: Collect ALL vertices from ALL split polygons first
        // This solves the chicken-and-egg problem where polygons need shared vertices
        // to be detected as neighbors, but need to be neighbors to get shared vertices
        const splitIndices = new Set();
        const allSplitVertices = [];

        for (let i = 0; i < count; i++) {
            const splitIndex = startIndex + i;
            splitIndices.add(splitIndex);
            const vertices = this.collectVertices(allPolygons[splitIndex]);
            allSplitVertices.push(...vertices);
        }

        // CRITICAL: If parent polygon provided, also collect its vertices
        // The parent's boundary vertices touched external neighbors before split
        // Split polygons on the boundary should inherit these vertices
        if (parentPolygon) {
            console.log(`Collecting vertices from parent polygon: ${parentPolygon.id}`);
            const parentVertices = this.collectVertices(parentPolygon);
            allSplitVertices.push(...parentVertices);
            console.log(`Added ${parentVertices.length} vertices from parent polygon`);
        }

        const uniqueSplitVertices = this.deduplicatePoints(allSplitVertices);
        console.log(`Collected ${uniqueSplitVertices.length} unique vertices from ${count} split polygons`);

        // Pre-pass: Insert vertices from sibling split polygons into each split polygon
        // This ensures split polygons share boundaries even if not detected as neighbors yet
        console.log(`Pre-pass: syncing split polygons with ALL sibling vertices`);
        let syncedPolygons = [...allPolygons];

        for (let i = 0; i < count; i++) {
            const splitIndex = startIndex + i;
            const poly = syncedPolygons[splitIndex];

            // Insert ALL split vertices (from siblings) into this polygon
            const updatedRings = poly.rings.map(ring => {
                const originalLength = ring.length;
                const updatedRing = this.insertVerticesIntoRing(ring, uniqueSplitVertices);
                const verticesAdded = updatedRing.length - originalLength;

                if (verticesAdded > 0) {
                    console.log(`  Pre-pass: Polygon ${poly.id}: inserted ${verticesAdded} vertices (${originalLength} → ${updatedRing.length})`);
                }

                return updatedRing;
            });

            syncedPolygons[splitIndex] = {
                ...poly,
                rings: updatedRings
            };
        }

        // CRITICAL: If parent's neighbors provided, collect them FIRST
        // These neighbors need to be updated even if adjacency graph doesn't detect them yet
        const parentOriginalNeighbors = new Set();
        if (parentPolygon && parentNeighborIds && parentNeighborIds.length > 0) {
            console.log(`Parent polygon ${parentPolygon.id} had ${parentNeighborIds.length} neighbors before split`);

            parentNeighborIds.forEach(neighborId => {
                const neighborIndex = syncedPolygons.findIndex(p => p.id === neighborId);
                if (neighborIndex >= 0) {
                    parentOriginalNeighbors.add(neighborIndex);
                    console.log(`  - Parent's neighbor: ${neighborId} at index ${neighborIndex}`);
                }
            });
        }

        // CRITICAL: Rebuild adjacency graph after pre-pass to detect newly synchronized boundaries
        console.log(`Rebuilding adjacency graph after pre-pass...`);
        adjacencyGraph.buildAdjacencyList(syncedPolygons);

        // Collect external neighbor indices (polygons that touch split polygons but aren't split themselves)
        const externalNeighborIndices = new Set();

        // FIRST: Add parent's original neighbors to external neighbors
        // These MUST be included even if not detected by adjacency graph yet
        parentOriginalNeighbors.forEach(idx => {
            externalNeighborIndices.add(idx);
        });
        console.log(`Added ${parentOriginalNeighbors.size} parent's original neighbors to external neighbors`);

        // SECOND: Add neighbors detected by adjacency graph
        for (let i = 0; i < count; i++) {
            const splitIndex = startIndex + i;
            const splitPoly = syncedPolygons[splitIndex];
            const neighborIds = adjacencyGraph.getNeighbors(splitPoly.id);

            neighborIds.forEach(neighborId => {
                const neighborIndex = syncedPolygons.findIndex(p => p.id === neighborId);
                if (neighborIndex >= 0 && !splitIndices.has(neighborIndex)) {
                    externalNeighborIndices.add(neighborIndex);
                }
            });
        }

        console.log(`Found ${externalNeighborIndices.size} total external neighbors of split polygons (including parent's neighbors)`);

        // Pass 1: Sync external neighbors - insert split vertices into them
        if (externalNeighborIndices.size > 0) {
            console.log(`Pass 1: Syncing ${externalNeighborIndices.size} external neighbors with split vertices`);

            for (const neighborIndex of externalNeighborIndices) {
                const poly = syncedPolygons[neighborIndex];

                // Insert ALL split vertices into this external neighbor
                const updatedRings = poly.rings.map(ring => {
                    const originalLength = ring.length;
                    const updatedRing = this.insertVerticesIntoRing(ring, uniqueSplitVertices);
                    const verticesAdded = updatedRing.length - originalLength;

                    if (verticesAdded > 0) {
                        console.log(`  External neighbor ${poly.id}: inserted ${verticesAdded} vertices (${originalLength} → ${updatedRing.length})`);
                    }

                    return updatedRing;
                });

                syncedPolygons[neighborIndex] = {
                    ...poly,
                    rings: updatedRings
                };
            }

            // Rebuild adjacency graph after Pass 1 to detect newly updated external neighbors
            console.log(`Rebuilding adjacency graph after Pass 1...`);
            adjacencyGraph.buildAdjacencyList(syncedPolygons);
        }

        // Pass 2: Sync split polygons with updated external neighbor vertices
        console.log(`Pass 2: Syncing ${splitIndices.size} split polygons with updated external neighbor vertices`);

        // Collect vertices from external neighbors
        const externalNeighborVertices = [];
        for (const neighborIndex of externalNeighborIndices) {
            const vertices = this.collectVertices(syncedPolygons[neighborIndex]);
            externalNeighborVertices.push(...vertices);
        }

        if (externalNeighborVertices.length > 0) {
            const uniqueExternalVertices = this.deduplicatePoints(externalNeighborVertices);
            console.log(`Collected ${uniqueExternalVertices.length} unique vertices from external neighbors`);

            for (let i = 0; i < count; i++) {
                const splitIndex = startIndex + i;
                const poly = syncedPolygons[splitIndex];

                // Insert external neighbor vertices into split polygons
                const updatedRings = poly.rings.map(ring => {
                    const originalLength = ring.length;
                    const updatedRing = this.insertVerticesIntoRing(ring, uniqueExternalVertices);
                    const verticesAdded = updatedRing.length - originalLength;

                    if (verticesAdded > 0) {
                        console.log(`  Split polygon ${poly.id}: inserted ${verticesAdded} external vertices (${originalLength} → ${updatedRing.length})`);
                    }

                    return updatedRing;
                });

                syncedPolygons[splitIndex] = {
                    ...poly,
                    rings: updatedRings
                };
            }

            // Rebuild adjacency graph after Pass 2 to detect newly updated split polygons
            console.log(`Rebuilding adjacency graph after Pass 2...`);
            adjacencyGraph.buildAdjacencyList(syncedPolygons);
        }

        // Pass 3: Final multi-directional sync to ensure complete propagation
        const allAffectedIndices = new Set([...splitIndices, ...externalNeighborIndices]);
        console.log(`Pass 3: Final sync of ${allAffectedIndices.size} affected polygons (split + external neighbors)`);
        syncedPolygons = this.syncVertices(syncedPolygons, adjacencyGraph, allAffectedIndices);

        // Pass 4: One more round for split polygons to catch any remaining vertices
        console.log(`Pass 4: Final sync of ${splitIndices.size} split polygons`);
        syncedPolygons = this.syncVertices(syncedPolygons, adjacencyGraph, splitIndices);

        return syncedPolygons;
    }

    /**
     * Synchronize vertices after merge/combine operation
     * @param {Array<Object>} allPolygons - All polygons including merged one
     * @param {Object} adjacencyGraph - Adjacency graph
     * @param {number} mergedIndex - Index of merged polygon
     * @returns {Array<Object>} - Polygons with synchronized vertices
     */
    syncAfterMerge(allPolygons, adjacencyGraph, mergedIndex) {
        console.log(`Syncing vertices after merge at index ${mergedIndex}`);

        // Collect merged polygon and its neighbors
        const affectedIndices = new Set([mergedIndex]);

        const mergedPoly = allPolygons[mergedIndex];
        const neighborIds = adjacencyGraph.getNeighbors(mergedPoly.id);

        neighborIds.forEach(neighborId => {
            const neighborIndex = allPolygons.findIndex(p => p.id === neighborId);
            if (neighborIndex >= 0) {
                affectedIndices.add(neighborIndex);
            }
        });

        console.log(`Syncing ${affectedIndices.size} affected polygons (merged + neighbors)`);
        return this.syncVertices(allPolygons, adjacencyGraph, affectedIndices);
    }

    /**
     * Get statistics about vertex synchronization
     * @param {Array<Object>} originalPolygons - Original polygons
     * @param {Array<Object>} syncedPolygons - Synchronized polygons
     * @returns {Object} - Statistics
     */
    getStats(originalPolygons, syncedPolygons) {
        let totalOriginalVertices = 0;
        let totalSyncedVertices = 0;
        let polygonsModified = 0;

        originalPolygons.forEach((originalPoly, index) => {
            const syncedPoly = syncedPolygons[index];

            const originalCount = originalPoly.rings.reduce((sum, ring) => sum + ring.length, 0);
            const syncedCount = syncedPoly.rings.reduce((sum, ring) => sum + ring.length, 0);

            totalOriginalVertices += originalCount;
            totalSyncedVertices += syncedCount;

            if (syncedCount > originalCount) {
                polygonsModified++;
            }
        });

        return {
            totalOriginalVertices,
            totalSyncedVertices,
            verticesAdded: totalSyncedVertices - totalOriginalVertices,
            polygonsModified,
            percentageModified: ((polygonsModified / originalPolygons.length) * 100).toFixed(1)
        };
    }
}
