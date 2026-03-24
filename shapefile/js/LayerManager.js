/**
 * LayerManager - Manages different visualization layers (County and Sub-County)
 * Generates county layer on-the-fly from sub-county data (in-memory only)
 */
class LayerManager {
    constructor(serviceUrl = (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8000')) {
        this.serviceUrl = serviceUrl.replace(/\/+$/, '');
        this.layers = {
            county: {
                visible: false,  // County layer hidden by default
                polygons: [] // Generated on-the-fly from sub-county data
            },
            subCounty: {
                visible: true,  // Sub-County layer shown by default
                polygons: [] // Original polygons from CSV
            }
        };
        this.sourcePolygons = []; // Store original sub-county data
    }

    /**
     * Load sub-county polygons and automatically generate county layer
     * @param {Array<Object>} polygons - Sub-county polygons from CSV
     * @param {Object} dataManager - DataManager instance for WKT conversion
     */
    async loadSubCountyData(polygons, dataManager) {
        console.log(`Loading ${polygons.length} sub-county polygons...`);

        // Store original data
        this.sourcePolygons = polygons.map(p => ({
            ...p,
            layerType: 'subCounty'
        }));

        // Set sub-county layer
        this.layers.subCounty.polygons = this.sourcePolygons;

        // Generate county layer using Python backend (robust merging)
        await this.generateCountyLayerRobust(dataManager);

        console.log(`Sub-county layer: ${this.layers.subCounty.polygons.length} polygons`);
        console.log(`County layer: ${this.layers.county.polygons.length} polygons (auto-generated)`);
    }

    /**
     * Generate county layer using Python/Shapely backend (robust GEOS merging)
     * @param {Object} dataManager - DataManager instance for WKT conversion
     */
    async generateCountyLayerRobust(dataManager) {
        const countyGroups = {};

        // Group polygons by county name
        this.sourcePolygons.forEach(polygon => {
            const countyName = polygon.county;
            if (!countyName) return;

            if (!countyGroups[countyName]) {
                countyGroups[countyName] = {
                    subPolygons: [],
                    shape: polygon.shape
                };
            }
            countyGroups[countyName].subPolygons.push(polygon);
        });

        const countyPolygons = [];
        const requestedMergeUrls = [
            `${this.serviceUrl}/merge-county`,
            'http://localhost:8000/merge-county'
        ];

        // Process each county
        for (const [countyName, data] of Object.entries(countyGroups)) {
            try {
                // Convert polygons to WKT
                const polygonWKTs = data.subPolygons.map(p => ({
                    geometry: dataManager.ringsToWKT(p.rings)
                }));

                // Call Python backend
                let response = null;
                let lastError = null;

                for (const mergeUrl of requestedMergeUrls) {
                    try {
                        response = await fetch(mergeUrl, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({
                                county: countyName,
                                polygons: polygonWKTs
                            })
                        });

                        if (!response.ok) {
                            const errorText = await response.text();
                            lastError = new Error(`Server error ${response.status} ${response.statusText} at ${mergeUrl}: ${errorText}`);
                            console.warn(`Merge attempt failed at ${mergeUrl}`, lastError);
                            response = null;
                            continue;
                        }

                        break; // success
                    } catch (err) {
                        lastError = err;
                        console.warn(`Network/Fetch failed for ${mergeUrl}`, err);
                        response = null;
                    }
                }

                if (!response) {
                    throw lastError || new Error('Merge failed: no response');
                }

                const merged = await response.json();

                // Convert exterior coordinates back to polygon format
                const exteriorRing = merged.exterior.map(([x, y]) => ({x, y}));

                countyPolygons.push({
                    id: countyName,
                    county: countyName,
                    shape: data.shape,
                    layerType: 'county',
                    isCountyView: true,
                    subPolygons: data.subPolygons,
                    rings: [exteriorRing],
                    holes: merged.holes || [],
                    vertexCount: merged.vertex_count
                });

                console.log(`Merged ${countyName}: ${merged.vertex_count} vertices`);

            } catch (error) {
                console.error(`Failed to merge ${countyName}, using fallback:`, error);

                // Fallback to JS method
                const outerBoundary = this.extractOuterBoundary(data.subPolygons);
                const simplifiedBoundary = outerBoundary.length > 0
                    ? this.simplifyVertices(outerBoundary)
                    : data.subPolygons[0].rings[0];

                countyPolygons.push({
                    id: countyName,
                    county: countyName,
                    shape: data.shape,
                    layerType: 'county',
                    isCountyView: true,
                    subPolygons: data.subPolygons,
                    rings: [simplifiedBoundary]
                });
            }
        }

        this.layers.county.polygons = countyPolygons;
    }

    /**
     * Combine multiple polygons - just returns all sub-polygons grouped under county name
     * Actual geometric merging should be done in Python, not JavaScript
     * @param {Array<Object>} polygons - Polygons to combine
     * @param {string} countyName - Name of the county
     * @returns {Array<Object>} - Array of polygons with county layer type
     */
    combinePolygons(polygons, countyName) {
        if (polygons.length === 0) return null;

        // For county view, just return all the sub-polygons marked as county layer
        // They will all be rendered with blue color
        return polygons.map(p => ({
            ...p,
            layerType: 'county',
            displayCounty: countyName
        }));
    }

    /**
     * Extract outer boundary from multiple polygons
     * @param {Array<Object>} polygons - Polygons to process
     * @returns {Array<Object>} - Outer boundary edges
     */
    extractOuterBoundary(polygons) {
        // Build edge map (edge -> count)
        const edgeMap = new Map();

        polygons.forEach(polygon => {
            polygon.rings.forEach(ring => {
                for (let i = 0; i < ring.length - 1; i++) {
                    const p1 = ring[i];
                    const p2 = ring[i + 1];

                    // Create edge key (sorted to handle both directions)
                    const edgeKey = this.getEdgeKey(p1, p2);

                    // Count occurrences
                    edgeMap.set(edgeKey, (edgeMap.get(edgeKey) || 0) + 1);
                }
            });
        });

        // Outer boundary edges appear only once (internal edges appear twice)
        const outerEdges = [];

        for (const [edgeKey, count] of edgeMap.entries()) {
            if (count === 1) {
                const [p1, p2] = this.parseEdgeKey(edgeKey);
                outerEdges.push({ p1, p2 });
            }
        }

        // Connect edges into a ring
        return this.connectEdges(outerEdges);
    }

    /**
     * Create unique key for an edge
     * @param {Object} p1 - First point
     * @param {Object} p2 - Second point
     * @returns {string} - Edge key
     */
    getEdgeKey(p1, p2) {
        const x1 = p1.x.toFixed(4);
        const y1 = p1.y.toFixed(4);
        const x2 = p2.x.toFixed(4);
        const y2 = p2.y.toFixed(4);

        // Sort to make undirected
        if (x1 < x2 || (x1 === x2 && y1 < y2)) {
            return `${x1},${y1}-${x2},${y2}`;
        } else {
            return `${x2},${y2}-${x1},${y1}`;
        }
    }

    /**
     * Parse edge key back to points
     * @param {string} edgeKey - Edge key
     * @returns {Array<Object>} - [p1, p2]
     */
    parseEdgeKey(edgeKey) {
        const [pt1, pt2] = edgeKey.split('-');
        const [x1, y1] = pt1.split(',').map(Number);
        const [x2, y2] = pt2.split(',').map(Number);

        return [
            { x: x1, y: y1 },
            { x: x2, y: y2 }
        ];
    }

    /**
     * Connect disconnected edges into a closed ring
     * @param {Array<Object>} edges - Array of edge objects {p1, p2}
     * @returns {Array<Object>} - Connected ring of vertices
     */
    connectEdges(edges) {
        if (edges.length === 0) return [];

        const vertices = [];
        const remainingEdges = [...edges];

        // Start with first edge
        let currentEdge = remainingEdges.shift();
        vertices.push({ ...currentEdge.p1 });
        vertices.push({ ...currentEdge.p2 });

        // Connect edges
        while (remainingEdges.length > 0) {
            const lastVertex = vertices[vertices.length - 1];

            // Find edge that connects to last vertex
            const nextEdgeIndex = remainingEdges.findIndex(edge =>
                this.pointsEqual(edge.p1, lastVertex) || this.pointsEqual(edge.p2, lastVertex)
            );

            if (nextEdgeIndex === -1) {
                // No more connected edges, break
                break;
            }

            const nextEdge = remainingEdges.splice(nextEdgeIndex, 1)[0];

            // Add the other vertex
            if (this.pointsEqual(nextEdge.p1, lastVertex)) {
                vertices.push({ ...nextEdge.p2 });
            } else {
                vertices.push({ ...nextEdge.p1 });
            }
        }

        // Close the ring
        if (vertices.length > 0 && !this.pointsEqual(vertices[0], vertices[vertices.length - 1])) {
            vertices.push({ ...vertices[0] });
        }

        return vertices;
    }

    /**
     * Check if two points are equal (within tolerance)
     * @param {Object} p1 - First point
     * @param {Object} p2 - Second point
     * @returns {boolean} - True if equal
     */
    pointsEqual(p1, p2) {
        const tolerance = 0.0001;
        return Math.abs(p1.x - p2.x) < tolerance && Math.abs(p1.y - p2.y) < tolerance;
    }

    /**
     * Simplify vertices by removing collinear midpoints
     * @param {Array<Object>} vertices - Vertices to simplify
     * @returns {Array<Object>} - Simplified vertices
     */
    simplifyVertices(vertices) {
        if (vertices.length < 3) return vertices;

        const simplified = [];

        for (let i = 0; i < vertices.length; i++) {
            const prev = vertices[(i - 1 + vertices.length) % vertices.length];
            const curr = vertices[i];
            const next = vertices[(i + 1) % vertices.length];

            // Check if current point is on the line between prev and next
            if (!this.isCollinear(prev, curr, next)) {
                simplified.push({ ...curr });
            }
        }

        // Ensure closed ring
        if (simplified.length > 0 && !this.pointsEqual(simplified[0], simplified[simplified.length - 1])) {
            simplified.push({ ...simplified[0] });
        }

        return simplified;
    }

    /**
     * Check if three points are collinear (point is on line between other two)
     * @param {Object} p1 - First point
     * @param {Object} p2 - Middle point
     * @param {Object} p3 - Third point
     * @returns {boolean} - True if collinear
     */
    isCollinear(p1, p2, p3) {
        const tolerance = 0.0001; // Very strict - only remove truly collinear points

        // Calculate cross product
        const crossProduct = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);

        // If cross product is near zero, points are collinear
        return Math.abs(crossProduct) < tolerance;
    }

    /**
     * Toggle layer visibility
     * @param {string} layerName - 'county' or 'subCounty'
     */
    toggleLayer(layerName) {
        if (this.layers[layerName]) {
            this.layers[layerName].visible = !this.layers[layerName].visible;
            console.log(`${layerName} layer: ${this.layers[layerName].visible ? 'visible' : 'hidden'}`);
        }
    }

    /**
     * Check if a layer is visible
     * @param {string} layerName - 'county' or 'subCounty'
     * @returns {boolean} - True if visible
     */
    isLayerVisible(layerName) {
        return this.layers[layerName] && this.layers[layerName].visible;
    }

    /**
     * Get polygons for a specific layer
     * @param {string} layerName - 'county' or 'subCounty'
     * @returns {Array<Object>} - Polygons for the layer
     */
    getLayerPolygons(layerName) {
        return this.layers[layerName] ? this.layers[layerName].polygons : [];
    }

    /**
     * Get all visible polygons (combined from all visible layers)
     * @returns {Array<Object>} - All visible polygons
     */
    getVisiblePolygons() {
        const visible = [];

        if (this.layers.county.visible) {
            visible.push(...this.layers.county.polygons);
        }

        if (this.layers.subCounty.visible) {
            visible.push(...this.layers.subCounty.polygons);
        }

        return visible;
    }

    /**
     * Get statistics about layers
     * @returns {Object} - Layer statistics
     */
    getStatistics() {
        return {
            county: {
                count: this.layers.county.polygons.length,
                visible: this.layers.county.visible
            },
            subCounty: {
                count: this.layers.subCounty.polygons.length,
                visible: this.layers.subCounty.visible
            }
        };
    }
}
