/**
 * VertexSplitter - Splits polygons using selected vertices
 * Creates new polygons from selected vertices while ensuring no gaps
 */
class VertexSplitter {
    constructor(classifier) {
        this.classifier = classifier;
        this.tolerance = 0.000001;
    }

    /**
     * Split polygon using selected vertices
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<Object>} selectedVertices - Selected vertex info [{polygonIndex, ringIndex, vertexIndex, x, y}, ...]
     * @param {number} selectedPolygonIndex - Index of the currently selected polygon (for context)
     * @returns {Object} - Result with success status, updated polygons, and message
     */
    splitByVertices(polygons, selectedVertices, selectedPolygonIndex = null) {
        console.log(`\n=== Split by Vertices ===`);
        console.log(`Selected vertices: ${selectedVertices.length}`);
        console.log(`Selected polygon index: ${selectedPolygonIndex}`);

        // Validate input
        if (selectedVertices.length < 3) {
            return {
                success: false,
                polygons,
                message: 'Need at least 3 vertices to split'
            };
        }

        // Validate all vertices are valid and share a county.
        // resolveVertexInfo distinguishes: orphaned vertex / missing county / cross-county.
        const vertexInfos = selectedVertices.map(v => ({
            v,
            info: this.classifier.resolveVertexInfo(v.x, v.y, polygons)
        }));

        for (const { v, info } of vertexInfos) {
            if (!info.found) {
                return {
                    success: false, polygons,
                    message: `Vertex (${v.x.toFixed(4)}, ${v.y.toFixed(4)}) does not belong to any polygon`
                };
            }
            if (info.counties.size === 0) {
                return {
                    success: false, polygons,
                    message: `Vertex (${v.x.toFixed(4)}, ${v.y.toFixed(4)}) has no county information`
                };
            }
        }

        let sharedCounties = new Set(vertexInfos[0].info.counties);
        for (let i = 1; i < vertexInfos.length; i++) {
            for (const c of sharedCounties) {
                if (!vertexInfos[i].info.counties.has(c)) sharedCounties.delete(c);
            }
        }
        if (sharedCounties.size === 0) {
            return {
                success: false, polygons,
                message: 'Selected vertices are not all in the same county'
            };
        }

        const recordedCounty = polygons[selectedVertices[0].polygonIndex].county;
        const county = sharedCounties.has(recordedCounty)
            ? recordedCounty
            : Array.from(sharedCounties)[0];

        // All vertex types are safe as split anchors: the split algorithm places every
        // selected vertex as a ring corner in both output polygons, so FIXED and
        // CROSS_COUNTY vertices remain at their original coordinates and the county
        // boundary shape is fully preserved. No vertex type is blocked for splitting.

        // Check for collinearity
        if (this.areCollinear(selectedVertices)) {
            return {
                success: false,
                polygons,
                message: 'Selected vertices are collinear - cannot form a polygon'
            };
        }

        // CRITICAL: Use the selected polygon as the source polygon
        // This resolves ambiguity when vertices are shared between multiple polygons
        let sourcePolyIndex = selectedPolygonIndex;

        // If no polygon is selected, try to find a common polygon
        if (sourcePolyIndex === null) {
            console.warn('No polygon selected - trying to find common polygon containing all vertices');
            const commonPolygons = this.findCommonPolygons(selectedVertices, polygons);

            if (commonPolygons.length === 0) {
                return {
                    success: false,
                    polygons,
                    message: 'Please select a polygon first before selecting vertices to split'
                };
            }

            sourcePolyIndex = commonPolygons[0];
            console.log(`Using polygon ${sourcePolyIndex} as source`);
        }

        // Verify that all selected vertices exist in the source polygon
        const sourcePolygon = polygons[sourcePolyIndex];
        const verifiedVertices = this.verifyVerticesInPolygon(selectedVertices, sourcePolygon, sourcePolyIndex);

        if (verifiedVertices.length === 0) {
            return {
                success: false,
                polygons,
                message: 'None of the selected vertices belong to the selected polygon. Please select a polygon first, then select vertices from that polygon.'
            };
        }

        if (verifiedVertices.length !== selectedVertices.length) {
            return {
                success: false,
                polygons,
                message: `Only ${verifiedVertices.length} of ${selectedVertices.length} selected vertices belong to the selected polygon. All vertices must be from the same polygon.`
            };
        }

        console.log(`✓ All ${verifiedVertices.length} vertices verified in polygon ${sourcePolyIndex} (${sourcePolygon.id})`);

        // Perform the split using the source polygon
        return this.splitSinglePolygon(polygons, verifiedVertices, county, sourcePolyIndex);
    }

    /**
     * Verify that selected vertices belong to a specific polygon
     * @param {Array<Object>} selectedVertices - Selected vertices
     * @param {Object} polygon - Polygon to check
     * @param {number} polygonIndex - Polygon index
     * @returns {Array<Object>} - Verified vertices with updated polygonIndex
     */
    verifyVerticesInPolygon(selectedVertices, polygon, polygonIndex) {
        const verified = [];

        selectedVertices.forEach(sv => {
            // Check if this vertex exists in the polygon
            for (let ringIdx = 0; ringIdx < polygon.rings.length; ringIdx++) {
                const ring = polygon.rings[ringIdx];
                for (let vertexIdx = 0; vertexIdx < ring.length; vertexIdx++) {
                    const vertex = ring[vertexIdx];
                    if (this.verticesMatch(vertex, sv)) {
                        // Found the vertex in this polygon
                        verified.push({
                            ...sv,
                            polygonIndex: polygonIndex,
                            ringIndex: ringIdx,
                            vertexIndex: vertexIdx
                        });
                        return; // Found it, move to next selected vertex
                    }
                }
            }
        });

        return verified;
    }

    /**
     * Split a single polygon using selected vertices
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<Object>} selectedVertices - Selected vertices
     * @param {string} county - County name
     * @param {number} sourcePolyIndex - Index of the source polygon
     * @returns {Object} - Result
     */
    splitSinglePolygon(polygons, selectedVertices, county, sourcePolyIndex) {
        console.log('Splitting single polygon...');

        // Use the provided source polygon index
        const sourcePolygon = polygons[sourcePolyIndex];
        const sourceRing = sourcePolygon.rings[0]; // Assume exterior ring

        // Sort selected vertices by their order in the ring
        const sortedSelection = this.sortVerticesByRingOrder(selectedVertices, sourceRing);

        console.log(`Source polygon: ${sourcePolygon.id}, vertices in ring: ${sourceRing.length}`);
        console.log(`Selected vertex indices: ${sortedSelection.map(v => v.vertexIndex).join(', ')}`);

        // Build the new polygons
        const newPolygons = this.buildPolygonsFromSelection(sourceRing, sortedSelection, sourcePolygon, county);

        if (newPolygons.length === 0) {
            return {
                success: false,
                polygons,
                message: 'Failed to create valid polygons from selection'
            };
        }

        // Belt-and-suspenders: confirm every FIXED vertex in the source ring is present
        // in at least one output polygon. Guarantees the county boundary is intact.
        if (!this.verifyFixedVerticesPreserved(sourceRing, newPolygons, polygons)) {
            return {
                success: false,
                polygons,
                message: 'Split would discard a fixed county boundary vertex — aborted'
            };
        }

        console.log(`Created ${newPolygons.length} new polygons`);

        // Remove original polygon and add new ones
        const updatedPolygons = [...polygons];
        updatedPolygons.splice(sourcePolyIndex, 1); // Remove original

        // Add new polygons
        newPolygons.forEach(newPoly => {
            updatedPolygons.push(newPoly);
        });

        return {
            success: true,
            polygons: updatedPolygons,
            message: `Split polygon into ${newPolygons.length} new polygons`,
            newPolygons: newPolygons
        };
    }

    /**
     * Build new polygons from selected vertices
     * @param {Array<Object>} sourceRing - Original ring
     * @param {Array<Object>} sortedSelection - Selected vertices sorted by ring order
     * @param {Object} sourcePolygon - Source polygon object
     * @param {string} county - County name
     * @returns {Array<Object>} - New polygons
     */
    buildPolygonsFromSelection(sourceRing, sortedSelection, sourcePolygon, county) {
        const newPolygons = [];

        // Create polygon from selected vertices only
        // Simply use the sorted vertices and close by adding first vertex at end
        const selectedRing = [];

        // Add each selected vertex, ensuring no duplicates
        for (let i = 0; i < sortedSelection.length; i++) {
            const current = sortedSelection[i];

            // Check if this vertex is different from the previous one
            if (selectedRing.length === 0 ||
                !this.verticesMatch(selectedRing[selectedRing.length - 1], current)) {
                selectedRing.push({ x: current.x, y: current.y });
            }
        }

        // Close the ring by adding first vertex at the end (if not already closed)
        if (selectedRing.length > 0 &&
            !this.verticesMatch(selectedRing[0], selectedRing[selectedRing.length - 1])) {
            selectedRing.push({ x: selectedRing[0].x, y: selectedRing[0].y });
        }

        // Validate ring (need at least 4 vertices: 3 unique + closing)
        if (selectedRing.length >= 4) {
            let area = this.calculatePolygonArea(selectedRing);

            // If area is negative, reverse the ring to fix winding order
            if (area < 0) {
                console.log(`Selected vertices polygon: Reversing ring due to negative area (${area})`);
                const firstVertex = selectedRing[0];
                selectedRing.reverse();
                // Ensure first vertex stays first after reversal (move closing vertex)
                if (this.verticesMatch(selectedRing[selectedRing.length - 1], firstVertex)) {
                    const last = selectedRing.pop();
                    selectedRing.unshift(last);
                }
                area = -area;
            }

            console.log(`Selected vertices polygon: vertices=${selectedRing.length}, area=${area}`);

            if (Math.abs(area) > 0.000001) { // Has meaningful area
                newPolygons.push({
                    id: `${sourcePolygon.id}_split_${Date.now()}_0`,
                    county: county,
                    parent: sourcePolygon.parent || county,
                    rings: [selectedRing],
                    originalWKT: '',
                    layerType: sourcePolygon.layerType || 'subCounty',
                    isSplit: true,
                    splitMetadata: {
                        createdBy: 'vertex_split',
                        timestamp: Date.now(),
                        sourcePolygon: sourcePolygon.id
                    }
                });
            }
        }

        // Now create polygons from the boundary segments between consecutive selected vertices
        const selectedIndices = sortedSelection.map(v => v.vertexIndex);

        // For each consecutive pair of selected vertices
        for (let i = 0; i < selectedIndices.length; i++) {
            const startIdx = selectedIndices[i];
            const endIdx = selectedIndices[(i + 1) % selectedIndices.length];

            // Build ring by walking from startIdx to endIdx along the boundary
            const remainingRing = [];

            let currentIdx = startIdx;
            let iterations = 0;
            const maxIterations = sourceRing.length;

            // Walk from startIdx to endIdx, collecting ALL boundary vertices
            while (iterations < maxIterations) {
                remainingRing.push({ x: sourceRing[currentIdx].x, y: sourceRing[currentIdx].y });

                if (currentIdx === endIdx) {
                    break;
                }

                currentIdx = (currentIdx + 1) % sourceRing.length;
                iterations++;
            }

            // Now close the polygon by going back through selected vertices in reverse
            // We need to add selected vertices from endIdx back to startIdx (exclusive of both)
            // Walk backwards through the selected vertices array
            for (let j = selectedIndices.length - 1; j >= 0; j--) {
                const idx = (i + 1 + j) % selectedIndices.length;
                const selIdx = selectedIndices[idx];

                // Stop when we reach startIdx (we've completed the loop)
                if (selIdx === startIdx) break;

                // Skip endIdx (already added in forward walk)
                if (selIdx === endIdx) continue;

                remainingRing.push({ x: sourceRing[selIdx].x, y: sourceRing[selIdx].y });
            }

            // CRITICAL: Remove duplicate consecutive vertices before closing
            const cleanedRing = [];
            for (let k = 0; k < remainingRing.length; k++) {
                const current = remainingRing[k];

                // Only add if different from previous vertex
                if (cleanedRing.length === 0 ||
                    !this.verticesMatch(cleanedRing[cleanedRing.length - 1], current)) {
                    cleanedRing.push(current);
                }
            }

            // Close the ring (only if not already closed)
            if (cleanedRing.length > 0 &&
                !this.verticesMatch(cleanedRing[0], cleanedRing[cleanedRing.length - 1])) {
                cleanedRing.push({ x: cleanedRing[0].x, y: cleanedRing[0].y });
            }

            // Validate ring (need at least 4 vertices: 3 unique + closing)
            if (cleanedRing.length >= 4) {
                // Check if this ring is not just a line (has area)
                let area = this.calculatePolygonArea(cleanedRing);

                // If area is negative, reverse the ring to fix winding order
                if (area < 0) {
                    console.log(`Segment ${i}: Reversing ring due to negative area (${area})`);
                    const firstVertex = cleanedRing[0];
                    cleanedRing.reverse();
                    // Ensure first vertex stays first after reversal (move closing vertex)
                    if (this.verticesMatch(cleanedRing[cleanedRing.length - 1], firstVertex)) {
                        const last = cleanedRing.pop();
                        cleanedRing.unshift(last);
                    }
                    area = -area; // Update area to positive value
                }

                console.log(`Segment ${i}: startIdx=${startIdx}, endIdx=${endIdx}, vertices=${cleanedRing.length}, area=${area}`);

                if (Math.abs(area) > 0.000001) { // Has meaningful area
                    newPolygons.push({
                        id: `${sourcePolygon.id}_split_${Date.now()}_${i + 1}`,
                        county: county,
                        parent: sourcePolygon.parent || county,
                        rings: [cleanedRing],
                        originalWKT: '',
                        layerType: sourcePolygon.layerType || 'subCounty',
                        isSplit: true,
                        splitMetadata: {
                            createdBy: 'vertex_split',
                            timestamp: Date.now(),
                            sourcePolygon: sourcePolygon.id,
                            segmentIndex: i
                        }
                    });
                } else {
                    console.log(`Skipping segment ${i}: area too small (${area})`);
                }
            } else {
                console.log(`Skipping segment ${i}: too few vertices (${cleanedRing.length})`);
            }
        }

        return newPolygons;
    }

    /**
     * Split multiple polygons (when vertices span multiple polygons)
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<Object>} selectedVertices - Selected vertices
     * @param {string} county - County name
     * @returns {Object} - Result
     */
    splitMultiplePolygons(polygons, selectedVertices, county) {
        console.log('Splitting across multiple polygons...');

        // For now, return not implemented
        // This is a complex case that requires connecting vertices across polygon boundaries
        return {
            success: false,
            polygons,
            message: 'Splitting across multiple polygons not yet implemented - select vertices from one polygon'
        };
    }

    /**
     * Check if ALL selected vertices are collinear (lie on a single straight line).
     * Tests every vertex against the line defined by the first two — checking only
     * the first 3 was wrong: [A,B,C,D,E,F] where A/B/C are collinear but D breaks
     * the line would be falsely rejected.
     * @param {Array<Object>} vertices - Array of vertex objects with x, y
     * @returns {boolean} - True only if every vertex lies on the same line
     */
    areCollinear(vertices) {
        if (vertices.length < 3) return false;

        const v1 = vertices[0];
        const v2 = vertices[1];
        const dx = v2.x - v1.x;
        const dy = v2.y - v1.y;

        for (let i = 2; i < vertices.length; i++) {
            const crossProduct = dx * (vertices[i].y - v1.y) - dy * (vertices[i].x - v1.x);
            if (Math.abs(crossProduct) >= this.tolerance) return false;
        }

        return true;
    }

    /**
     * Group vertices by polygon
     * @param {Array<Object>} vertices - Vertices with polygonIndex
     * @returns {Map} - Map of polygonIndex -> vertices
     */
    groupByPolygon(vertices) {
        const groups = new Map();

        vertices.forEach(v => {
            if (!groups.has(v.polygonIndex)) {
                groups.set(v.polygonIndex, []);
            }
            groups.get(v.polygonIndex).push(v);
        });

        return groups;
    }

    /**
     * Find polygons that contain all selected vertices
     * @param {Array<Object>} selectedVertices - Selected vertices
     * @param {Array<Object>} polygons - All polygons
     * @returns {Array<number>} - Array of polygon indices that contain all vertices
     */
    findCommonPolygons(selectedVertices, polygons) {
        const commonPolygons = [];

        for (let polyIdx = 0; polyIdx < polygons.length; polyIdx++) {
            const polygon = polygons[polyIdx];
            let allVerticesFound = true;

            // Check if all selected vertices exist in this polygon
            for (const sv of selectedVertices) {
                let foundInPolygon = false;

                for (const ring of polygon.rings) {
                    for (const vertex of ring) {
                        if (this.verticesMatch(vertex, sv)) {
                            foundInPolygon = true;
                            break;
                        }
                    }
                    if (foundInPolygon) break;
                }

                if (!foundInPolygon) {
                    allVerticesFound = false;
                    break;
                }
            }

            if (allVerticesFound) {
                commonPolygons.push(polyIdx);
            }
        }

        return commonPolygons;
    }

    /**
     * Sort selected vertices by their order in the ring
     * @param {Array<Object>} selectedVertices - Selected vertices
     * @param {Array<Object>} ring - The ring they belong to
     * @returns {Array<Object>} - Sorted vertices
     */
    sortVerticesByRingOrder(selectedVertices, ring) {
        // Create a copy and sort by vertexIndex
        const sorted = [...selectedVertices].sort((a, b) => a.vertexIndex - b.vertexIndex);

        // CRITICAL: Remove duplicate vertices based on coordinates
        // This handles cases where user might select both vertex 0 and the closing vertex
        // which have the same coordinates
        const deduplicated = [];
        for (let i = 0; i < sorted.length; i++) {
            const current = sorted[i];

            // Check if this coordinate already exists in deduplicated
            const isDuplicate = deduplicated.some(v => this.verticesMatch(v, current));

            if (!isDuplicate) {
                deduplicated.push(current);
            } else {
                console.log(`Removed duplicate selected vertex at (${current.x}, ${current.y})`);
            }
        }

        return deduplicated;
    }

    /**
     * Calculate polygon area using shoelace formula
     * @param {Array<Object>} ring - Ring vertices
     * @returns {number} - Signed area
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

    /**
     * Verify that every FIXED vertex in the source ring appears in at least one
     * output polygon. Guards against any edge case where the split algorithm could
     * inadvertently drop a county boundary vertex.
     * @param {Array<Object>} sourceRing - Original ring vertices
     * @param {Array<Object>} newPolygons - Output polygons produced by the split
     * @param {Array<Object>} polygons - Full polygon list (used for classification)
     * @returns {boolean} True if all FIXED vertices are preserved
     */
    verifyFixedVerticesPreserved(sourceRing, newPolygons, polygons) {
        for (const vertex of sourceRing) {
            if (this.classifier.classify(vertex.x, vertex.y, polygons) !== VertexClassifier.FIXED) continue;
            const preserved = newPolygons.some(poly =>
                poly.rings.some(ring =>
                    ring.some(v => this.verticesMatch(v, vertex))
                )
            );
            if (!preserved) {
                console.error(`FIXED vertex (${vertex.x}, ${vertex.y}) missing from split output — aborting`);
                return false;
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
}
