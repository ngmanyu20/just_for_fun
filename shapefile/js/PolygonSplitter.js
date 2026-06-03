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
     * Split a polygon using shapes extracted from an SVG street network.
     * Blank areas (parts of the polygon not covered by any SVG block) are
     * also returned as sub-polygons so no area is silently dropped.
     *
     * @param {Object} polygon - Polygon to split (internal format)
     * @param {string} svgContent - SVG file text content
     * @param {number} targetCount - Target number of SVG-derived sub-polygons
     * @param {Object|null} svgAlignment - Optional SvgLayer alignment
     *   { anchorX, anchorY, dataWidth, svgW, svgH }
     * @returns {Promise<Object>} - { success, message, subPolygons }
     */
    async splitBySvg(polygon, svgContent, targetCount, svgAlignment = null) {
        try {
            if (targetCount < 1) {
                return { success: false, message: 'Target count must be >= 1', subPolygons: [] };
            }

            const geometry = this.convertToGeoJSON(polygon);

            const payload = {
                geometry,
                svg_content: svgContent,
                target_count: targetCount,
            };

            if (svgAlignment) {
                payload.anchor_x   = svgAlignment.anchorX;
                payload.anchor_y   = svgAlignment.anchorY;
                payload.data_width = svgAlignment.dataWidth;
                payload.svg_w      = svgAlignment.svgW;
                payload.svg_h      = svgAlignment.svgH;
            }

            const controller = new AbortController();
            const timeoutId  = setTimeout(() => controller.abort(), 120000); // 2 min for large SVGs

            let response;
            try {
                response = await fetch(`${this.serviceUrl}/split-svg`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify(payload),
                    signal:  controller.signal,
                });
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                let msg = `HTTP ${response.status}: ${response.statusText}`;
                try { msg = JSON.parse(text).detail || msg; } catch (_) {
                    if (text) msg += ` — ${text.slice(0, 200)}`;
                }
                return { success: false, message: msg, subPolygons: [] };
            }

            const featureCollection = await response.json();

            if (!featureCollection || featureCollection.type !== 'FeatureCollection' || !Array.isArray(featureCollection.features)) {
                return { success: false, message: 'Invalid response from server', subPolygons: [] };
            }

            const subPolygons = this.convertFromGeoJSON(featureCollection, polygon);
            const svgBlocks   = subPolygons.filter(p => p.kind === 'svg_block');
            const blanks      = subPolygons.filter(p => p.kind === 'blank');

            let message = `Split into ${svgBlocks.length} SVG block${svgBlocks.length !== 1 ? 's' : ''}`;
            if (blanks.length > 0) {
                message += ` + ${blanks.length} uncovered area${blanks.length !== 1 ? 's' : ''}`;
            }

            return { success: true, message, subPolygons };

        } catch (error) {
            if (error.name === 'AbortError') {
                return { success: false, message: 'Request timed out — SVG processing took too long', subPolygons: [] };
            }
            return { success: false, message: error.message || 'SVG split failed', subPolygons: [] };
        }
    }

    /**
     * Split a polygon using OSM-derived enclosures downloaded for a WGS84 bbox.
     * All gaps are absorbed — no blank polygons in the output.
     *
     * @param {Object} polygon - Polygon to split (internal format)
     * @param {number} north - Bounding box north latitude
     * @param {number} south - Bounding box south latitude
     * @param {number} east  - Bounding box east longitude
     * @param {number} west  - Bounding box west longitude
     * @param {boolean} useSecondary - Also use tertiary roads for subdivision
     * @returns {Promise<Object>} - { success, message, subPolygons }
     */
    async splitByOsm(polygon, north, south, east, west, useSecondary = false) {
        try {
            const geometry = this.convertToGeoJSON(polygon);

            const payload = { geometry, north, south, east, west, use_secondary: useSecondary };

            const controller = new AbortController();
            const timeoutId  = setTimeout(() => controller.abort(), 300000); // 5 min for OSM download

            let response;
            try {
                response = await fetch(`${this.serviceUrl}/split-osm`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify(payload),
                    signal:  controller.signal,
                });
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                let msg = `HTTP ${response.status}: ${response.statusText}`;
                try { msg = JSON.parse(text).detail || msg; } catch (_) {
                    if (text) msg += ` — ${text.slice(0, 200)}`;
                }
                return { success: false, message: msg, subPolygons: [] };
            }

            const featureCollection = await response.json();

            if (!featureCollection || featureCollection.type !== 'FeatureCollection' || !Array.isArray(featureCollection.features)) {
                return { success: false, message: 'Invalid response from server', subPolygons: [] };
            }

            const subPolygons = this.convertFromGeoJSON(featureCollection, polygon);
            if (featureCollection.simplify_stats) {
                const s = featureCollection.simplify_stats;
                if (s.error) {
                    console.warn('[OSM simplify] FAILED on server:', s.error);
                } else {
                    console.log(`[OSM simplify] before=${s.vertices_before} after=${s.vertices_after} removed=${s.removed} epsilon=${s.epsilon}`);
                }
            }
            const message = `Split into ${subPolygons.length} OSM district${subPolygons.length !== 1 ? 's' : ''}`;
            return { success: true, message, subPolygons };

        } catch (error) {
            if (error.name === 'AbortError') {
                return { success: false, message: 'Request timed out — OSM download took too long', subPolygons: [] };
            }
            return { success: false, message: error.message || 'OSM split failed', subPolygons: [] };
        }
    }

    /**
     * OSM-split multiple adjacent polygons while preserving their shared boundaries.
     *
     * Calls /split-osm-multi, which runs the OSM pipeline on the union of all input
     * polygons and then clips each resulting OSM district against each original polygon.
     * The output is grouped by source polygon so each original is replaced only by the
     * sub-districts that fall within its own area.
     *
     * @param {Array<Object>} polygons - Adjacent polygons to split (internal format)
     * @param {number} north - Bounding box north latitude
     * @param {number} south - Bounding box south latitude
     * @param {number} east  - Bounding box east longitude
     * @param {number} west  - Bounding box west longitude
     * @param {boolean} useSecondary - Also use tertiary roads
     * @returns {Promise<Object>} - { success, message, resultsByIndex }
     *   resultsByIndex: [{ sourceIndex, subPolygons }] sorted DESCENDING by sourceIndex
     *   so PolygonEditor can safely splice from the end of the array.
     */
    async splitMultipleByOsm(polygons, north, south, east, west, useSecondary = false) {
        try {
            const geometries = polygons.map(p => this.convertToGeoJSON(p));
            const payload = { geometries, north, south, east, west, use_secondary: useSecondary };

            const controller = new AbortController();
            const timeoutId  = setTimeout(() => controller.abort(), 300000); // 5 min

            let response;
            try {
                response = await fetch(`${this.serviceUrl}/split-osm-multi`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify(payload),
                    signal:  controller.signal,
                });
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                let msg = `HTTP ${response.status}: ${response.statusText}`;
                try { msg = JSON.parse(text).detail || msg; } catch (_) {
                    if (text) msg += ` — ${text.slice(0, 200)}`;
                }
                return { success: false, message: msg, resultsByIndex: [] };
            }

            const featureCollection = await response.json();

            if (!featureCollection || featureCollection.type !== 'FeatureCollection' || !Array.isArray(featureCollection.features)) {
                return { success: false, message: 'Invalid response from server', resultsByIndex: [] };
            }

            // Group features by source_index, then convert each group using its
            // corresponding source polygon (for county and ID extraction).
            const groups = new Map();
            for (const feature of featureCollection.features) {
                const si = feature.properties?.source_index ?? 0;
                if (!groups.has(si)) groups.set(si, []);
                groups.get(si).push(feature);
            }

            const resultsByIndex = [];
            for (const [sourceIndex, features] of groups) {
                const miniFC    = { type: 'FeatureCollection', features };
                const subPolys  = this.convertFromGeoJSON(miniFC, polygons[sourceIndex]);
                resultsByIndex.push({ sourceIndex, subPolygons: subPolys });
            }
            // Sort descending so PolygonEditor can splice highest index first
            resultsByIndex.sort((a, b) => b.sourceIndex - a.sourceIndex);

            const totalDistricts = resultsByIndex.reduce((s, r) => s + r.subPolygons.length, 0);
            const message = `Split ${polygons.length} polygons into ${totalDistricts} OSM district${totalDistricts !== 1 ? 's' : ''} (boundaries preserved)`;
            return { success: true, message, resultsByIndex };

        } catch (error) {
            if (error.name === 'AbortError') {
                return { success: false, message: 'Request timed out — OSM download took too long', resultsByIndex: [] };
            }
            return { success: false, message: error.message || 'Multi-polygon OSM split failed', resultsByIndex: [] };
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
