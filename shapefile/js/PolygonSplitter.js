/**
 * PolygonSplitter - Client for Python geometry service
 * Sends polygons to the backend for splitting via Voronoi subdivision
 * NO client-side geometry computation - all splitting happens in Python
 */
class PolygonSplitter {
    constructor(serviceUrl = (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8000')) {
        this.serviceUrl = serviceUrl;
        this.timeout = 30000; // 30 seconds
    }

    /**
     * Convert internal polygon format to GeoJSON Polygon geometry
     * @param {Object} polygon - Polygon with rings: [{x, y}, ...]
     * @returns {Object} - GeoJSON geometry object
     */
    convertToGeoJSON(polygon) {
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
            type: 'Polygon',
            coordinates: [coordinates]
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
     * Convert GeoJSON Feature or FeatureCollection back to internal polygon format
     * @param {Object} geojson - GeoJSON Feature or FeatureCollection
     * @param {Object} sourcePolygon - Original polygon for metadata
     * @returns {Array<Object>} - Array of polygon objects in internal format
     */
    convertFromGeoJSON(geojson, sourcePolygon) {
        const features = geojson.type === 'FeatureCollection'
            ? geojson.features
            : [geojson];

        // Extract base county from source polygon
        // Examples: "NC8_05" -> "NC8", "AC12_04" -> "AC12", "NC8_05+NC8_06" -> "NC8"
        const extractCounty = (id) => {
            // Handle combined polygons (e.g., "NC8_05+NC8_06")
            const firstPart = id.split('+')[0];

            // Extract prefix before underscore (e.g., "NC8_05" -> "NC8")
            const match = firstPart.match(/^([A-Z]+\d+)/);
            return match ? match[1] : firstPart;
        };

        const baseCounty = extractCounty(sourcePolygon.id);

        return features.map((feature, index) => {
            const coords = feature.geometry.coordinates[0];

            // Convert [[x, y], ...] to [{x, y}, ...] and round to 4 decimal places
            const ring = coords.map(coord => ({
                x: this.roundCoordinate(coord[0]),
                y: this.roundCoordinate(coord[1])
            }));

            const props = feature.properties || {};
            const isGap = props.kind === 'gap';
            const subdivisionId = props.subdivision_id || (index + 1);

            return {
                id: `${sourcePolygon.id}_sub${subdivisionId}`,
                county: baseCounty,  // Use extracted base county (e.g., "NC8" or "AC12")
                parent: sourcePolygon.parent || '',
                rings: [ring],
                originalWKT: '',
                layerType: 'subCounty',  // Mark as sub-county layer for proper rendering
                isSplit: true,
                sourcePolygon: sourcePolygon.id,
                subdivision_id: subdivisionId,
                kind: props.kind || 'district',
                isGap: isGap,
                gap_id: props.gap_id
            };
        });
    }

    /**
     * Split a polygon into multiple sub-polygons using the Python service
     * @param {Object} polygon - Polygon to split (internal format)
     * @param {number} numDistricts - Number of districts to create (>= 2)
     * @param {number} [seed=42] - Random seed for reproducibility
     * @returns {Promise<Object>} - Result with success status and sub-polygons
     */
    async splitPolygon(polygon, numDistricts, seed = 42) {
        try {
            // Validate input
            if (numDistricts < 2) {
                return {
                    success: false,
                    message: 'Number of districts must be >= 2',
                    subPolygons: []
                };
            }

            // Convert polygon to GeoJSON
            const geometry = this.convertToGeoJSON(polygon);

            // Prepare request payload with gap filling enabled
            const requestPayload = {
                geometry: geometry,
                num_districts: numDistricts,
                seed: seed,
                include_gaps: true,  // Enable gap filling to eliminate white areas
                gap_area_tol: 0.0,
                min_cell_area: 0.0
            };

            console.log('Sending split request to Python service:', requestPayload);

            // Send request to Python service
            const featureCollection = await this.callSplitAPI(requestPayload);

            console.log('Received split result:', featureCollection);

            // Convert back to internal format
            const subPolygons = this.convertFromGeoJSON(featureCollection, polygon);

            // Count districts vs gaps
            const districts = subPolygons.filter(p => !p.isGap);
            const gaps = subPolygons.filter(p => p.isGap);

            let message = `Successfully split polygon into ${districts.length} districts`;
            if (gaps.length > 0) {
                message += ` (+ ${gaps.length} gap polygon${gaps.length > 1 ? 's' : ''} filled)`;
            }

            return {
                success: true,
                message: message,
                subPolygons: subPolygons
            };

        } catch (error) {
            console.error('Split polygon error:', error);
            return {
                success: false,
                message: error.message || 'Failed to split polygon',
                subPolygons: []
            };
        }
    }

    /**
     * Call the Python /split API endpoint
     * @param {Object} payload - Request payload matching SplitRequest schema
     * @returns {Promise<Object>} - GeoJSON FeatureCollection
     */
    async callSplitAPI(payload) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await fetch(`${this.serviceUrl}/split`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const responseText = await response.text().catch(() => '');
                let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
                try {
                    const errorData = JSON.parse(responseText);
                    errorMessage = errorData.detail || errorData.message || errorMessage;
                } catch (parseError) {
                    // If non-JSON response (e.g. HTML fallback) use first 200 chars
                    if (responseText) {
                        errorMessage = `HTTP ${response.status}: ${response.statusText} - ${responseText.slice(0, 180)}`;
                    }
                }
                throw new Error(errorMessage);
            }

            const result = await response.json();

            // Validate response structure
            if (!result || result.type !== 'FeatureCollection' || !Array.isArray(result.features)) {
                throw new Error('Invalid response format from server');
            }

            return result;

        } catch (error) {
            clearTimeout(timeoutId);

            if (error.name === 'AbortError') {
                throw new Error(`Request timeout after ${this.timeout / 1000} seconds`);
            }

            if (error.message.includes('fetch')) {
                throw new Error(`Cannot connect to Python service at ${this.serviceUrl}. Is the server running?`);
            }

            throw error;
        }
    }

    /**
     * Check if the Python service is available
     * @returns {Promise<boolean>}
     */
    async checkServiceHealth() {
        try {
            const response = await fetch(`${this.serviceUrl}/docs`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000)
            });
            return response.ok;
        } catch (error) {
            console.warn('Python service health check failed:', error.message);
            return false;
        }
    }

    /**
     * Calculate suggested number of districts based on area
     * This is a simple heuristic and doesn't require the Python service
     * @param {Object} polygon - Polygon object
     * @param {string} mode - 'urban' or 'rural'
     * @returns {number} - Suggested number of districts
     */
    calculateSuggestedDistricts(polygon, mode = 'rural') {
        const area = this.calculatePolygonArea(polygon.rings[0]);
        const areaPerDistrict = mode === 'urban' ? area / 15 : area / 8;
        return Math.max(2, Math.min(20, Math.ceil(area / areaPerDistrict)));
    }

    /**
     * Calculate area of a polygon ring using shoelace formula
     * @param {Array<Object>} ring - Array of {x, y} points
     * @returns {number} - Area
     */
    calculatePolygonArea(ring) {
        let area = 0;
        for (let i = 0; i < ring.length - 1; i++) {
            area += ring[i].x * ring[i + 1].y;
            area -= ring[i + 1].x * ring[i].y;
        }
        return Math.abs(area / 2);
    }
}
