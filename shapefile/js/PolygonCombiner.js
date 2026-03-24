/**
 * PolygonCombiner - Handles polygon combination via Python backend
 * NO client-side geometry operations - all merging uses Shapely
 */
class PolygonCombiner {
    constructor(adjacencyGraph, serviceUrl = (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8000')) {
        this.adjacencyGraph = adjacencyGraph;
        this.serviceUrl = serviceUrl;
        this.timeout = 30000; // 30 seconds
    }

    /**
     * Check if a set of polygons are all connected
     * @param {Array<string>} polygonIds - Array of polygon IDs to check
     * @returns {Object} - {connected: boolean, message: string}
     */
    arePolygonsConnected(polygonIds) {
        if (polygonIds.length < 2) {
            return { connected: false, message: 'Need at least 2 polygons to combine' };
        }

        // Build a connectivity graph using BFS
        const visited = new Set();
        const queue = [polygonIds[0]];
        visited.add(polygonIds[0]);

        while (queue.length > 0) {
            const currentId = queue.shift();
            const neighbors = this.adjacencyGraph.getNeighbors(currentId);

            for (const neighborId of neighbors) {
                if (polygonIds.includes(neighborId) && !visited.has(neighborId)) {
                    visited.add(neighborId);
                    queue.push(neighborId);
                }
            }
        }

        // Check if all polygons were visited
        const allConnected = polygonIds.every(id => visited.has(id));

        if (!allConnected) {
            const disconnected = polygonIds.filter(id => !visited.has(id));
            return {
                connected: false,
                message: `Polygons are not all connected. Disconnected: ${disconnected.join(', ')}`
            };
        }

        return { connected: true, message: 'All polygons are connected' };
    }

    /**
     * Convert internal polygon format to GeoJSON Feature
     * @param {Object} polygon - Polygon with rings: [{x, y}, ...]
     * @returns {Object} - GeoJSON Feature object
     */
    convertToGeoJSONFeature(polygon) {
        if (!polygon || !polygon.rings || polygon.rings.length === 0) {
            throw new Error('Invalid polygon: missing rings');
        }

        const ring = polygon.rings[0]; // Outer ring only for now

        // Convert [{x, y}, ...] to [[x, y], ...]
        const coordinates = ring.map(point => [point.x, point.y]);

        // Ensure the ring is closed (first point === last point)
        const first = coordinates[0];
        const last = coordinates[coordinates.length - 1];

        if (first[0] !== last[0] || first[1] !== last[1]) {
            coordinates.push([first[0], first[1]]);
        }

        return {
            type: 'Feature',
            properties: {
                id: polygon.id,
                county: polygon.county
            },
            geometry: {
                type: 'Polygon',
                coordinates: [coordinates]
            }
        };
    }

    /**
     * Convert GeoJSON Feature back to internal polygon format
     * @param {Object} feature - GeoJSON Feature
     * @param {Array<Object>} sourcePolygons - Original polygons for metadata
     * @returns {Object} - Polygon in internal format
     */
    convertFromGeoJSONFeature(feature, sourcePolygons) {
        const coords = feature.geometry.coordinates[0];

        // Convert [[x, y], ...] to [{x, y}, ...] and round to 4 decimal places
        const ring = coords.map(coord => ({
            x: this.roundCoordinate(coord[0]),
            y: this.roundCoordinate(coord[1])
        }));

        // Create combined IDs
        const combinedIds = sourcePolygons.map(p => p.id).join('+');
        const combinedCounties = [...new Set(sourcePolygons.map(p => p.county).filter(c => c))].join('+');
        const basePolygon = sourcePolygons[0];

        return {
            id: combinedIds,
            county: combinedCounties || combinedIds,
            parent: basePolygon.parent || '',
            rings: [ring],
            originalWKT: '',
            isCombined: true,
            sourcePolygons: sourcePolygons.map(p => p.id)
        };
    }

    /**
     * Round coordinate to 4 decimal places
     * @param {number} value - Coordinate value
     * @returns {number} - Rounded value
     */
    roundCoordinate(value) {
        return Math.round(value * 10000) / 10000;
    }

    /**
     * Combine multiple polygons into a single polygon using Python backend
     * @param {Array<Object>} polygons - Array of all polygons
     * @param {Array<number>} indices - Indices of polygons to combine
     * @returns {Promise<Object>} - {success: boolean, message: string, newPolygon: Object, removedIndices: Array}
     */
    async combinePolygons(polygons, indices) {
        if (indices.length < 2) {
            return {
                success: false,
                message: 'Need at least 2 polygons to combine',
                newPolygon: null,
                removedIndices: []
            };
        }

        // Get polygons to combine
        const polysToMerge = indices.map(i => polygons[i]);

        // Check if all polygons have the same county
        const counties = polysToMerge.map(p => p.county).filter(c => c);
        const uniqueCounties = [...new Set(counties)];

        if (uniqueCounties.length > 1) {
            return {
                success: false,
                message: `Cannot combine polygons from different counties: ${uniqueCounties.join(', ')}`,
                newPolygon: null,
                removedIndices: []
            };
        }

        if (counties.length === 0) {
            return {
                success: false,
                message: 'Selected polygons have no county information',
                newPolygon: null,
                removedIndices: []
            };
        }

        // Get the polygon IDs
        const polygonIds = indices.map(i => polygons[i].id);

        // Check connectivity
        const connectivityCheck = this.arePolygonsConnected(polygonIds);
        if (!connectivityCheck.connected) {
            return {
                success: false,
                message: connectivityCheck.message,
                newPolygon: null,
                removedIndices: []
            };
        }

        // Convert polygons to GeoJSON Features
        const features = polysToMerge.map(poly => this.convertToGeoJSONFeature(poly));

        console.log(`Sending ${features.length} polygons to Python backend for merging...`);

        try {
            // Call Python backend /merge endpoint
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(`${this.serviceUrl}/merge`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    features: features,
                    snap_tol: 1e-6,
                    require_single: true
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || `HTTP ${response.status}`);
            }

            const result = await response.json();

            console.log('Merge result received from Python backend');

            // Convert result back to internal format
            const mergedPolygon = this.convertFromGeoJSONFeature(result, polysToMerge);

            return {
                success: true,
                message: `Successfully combined ${indices.length} polygons from ${uniqueCounties[0]}`,
                newPolygon: mergedPolygon,
                removedIndices: indices.slice(1) // Keep first polygon, remove others
            };

        } catch (error) {
            console.error('Merge failed:', error);

            if (error.name === 'AbortError') {
                return {
                    success: false,
                    message: 'Merge request timed out',
                    newPolygon: null,
                    removedIndices: []
                };
            }

            return {
                success: false,
                message: `Merge failed: ${error.message}`,
                newPolygon: null,
                removedIndices: []
            };
        }
    }

    /**
     * Validate that polygons can be combined
     * @param {Array<Object>} polygons - All polygons
     * @param {Array<number>} indices - Indices to combine
     * @returns {Object} - Validation result
     */
    validateCombination(polygons, indices) {
        if (indices.length < 2) {
            return {
                valid: false,
                message: 'Select at least 2 polygons to combine'
            };
        }

        // Check if all polygons have the same county
        const polysToCheck = indices.map(i => polygons[i]);
        const counties = polysToCheck.map(p => p.county).filter(c => c);
        const uniqueCounties = [...new Set(counties)];

        if (uniqueCounties.length > 1) {
            return {
                valid: false,
                message: `Cannot combine polygons from different counties: ${uniqueCounties.join(', ')}`
            };
        }

        if (counties.length === 0) {
            return {
                valid: false,
                message: 'Selected polygons have no county information'
            };
        }

        const polygonIds = indices.map(i => polygons[i].id);
        const connectivityCheck = this.arePolygonsConnected(polygonIds);

        if (!connectivityCheck.connected) {
            return {
                valid: false,
                message: connectivityCheck.message
            };
        }

        return {
            valid: true,
            message: `Ready to combine ${indices.length} connected polygons from ${uniqueCounties[0]}`
        };
    }
}
