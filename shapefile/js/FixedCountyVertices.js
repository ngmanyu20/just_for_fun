/**
 * FixedCountyVertices - Manages the set of fixed vertices from simplified county polygons
 * These vertices are marked as immutable and cannot be edited
 */
class FixedCountyVertices {
    constructor() {
        // Map: "x,y" -> { x, y, counties: Set<string> }
        this.fixedVertices = new Map();

        // Map: countyName -> Array of fixed vertices
        this.verticesByCounty = new Map();
    }

    /**
     * Initialize fixed vertices from county layer polygons
     * @param {Array<Object>} countyPolygons - County layer polygons with simplified boundaries
     */
    initialize(countyPolygons) {
        // CRITICAL: Prevent re-initialization - fixed vertices should NEVER change
        if (this.isInitialized()) {
            console.error('⚠️  CRITICAL WARNING: Attempted to re-initialize fixed county vertices!');
            console.error('Fixed county vertices are immutable and cannot be changed after initialization.');
            console.error('This operation has been blocked to prevent data corruption.');
            return;
        }

        console.log(`Initializing fixed county vertices for ${countyPolygons.length} counties...`);

        // Clear existing data (should be empty on first init)
        this.fixedVertices.clear();
        this.verticesByCounty.clear();

        countyPolygons.forEach(polygon => {
            const countyName = polygon.county;
            const countyVertices = [];

            // Process all rings (exterior and holes)
            polygon.rings.forEach(ring => {
                ring.forEach(vertex => {
                    const key = this.getVertexKey(vertex.x, vertex.y);

                    // Add to fixed vertices map
                    if (!this.fixedVertices.has(key)) {
                        this.fixedVertices.set(key, {
                            x: vertex.x,
                            y: vertex.y,
                            counties: new Set()
                        });
                    }

                    // Add county to this vertex's county set
                    const fixedVertex = this.fixedVertices.get(key);
                    fixedVertex.counties.add(countyName);

                    // Add to county's vertex list
                    countyVertices.push({
                        x: vertex.x,
                        y: vertex.y,
                        key: key
                    });
                });
            });

            this.verticesByCounty.set(countyName, countyVertices);
        });

        console.log(`Fixed vertices initialized: ${this.fixedVertices.size} unique vertices`);
        this.logStatistics();
    }

    /**
     * Get unique key for a vertex coordinate
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @returns {string} - Unique key
     */
    getVertexKey(x, y) {
        // Round to 6 decimal places to handle floating point precision
        return `${x.toFixed(6)},${y.toFixed(6)}`;
    }

    /**
     * Check if a vertex is a fixed county vertex
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @returns {boolean} - True if vertex is fixed
     */
    isFixedVertex(x, y) {
        const key = this.getVertexKey(x, y);
        return this.fixedVertices.has(key);
    }

    /**
     * Get information about a fixed vertex
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @returns {Object|null} - Vertex info or null if not fixed
     */
    getFixedVertexInfo(x, y) {
        const key = this.getVertexKey(x, y);
        const vertex = this.fixedVertices.get(key);

        if (!vertex) {
            return null;
        }

        return {
            x: vertex.x,
            y: vertex.y,
            counties: Array.from(vertex.counties),
            countyCount: vertex.counties.size,
            isShared: vertex.counties.size > 1
        };
    }

    /**
     * Get all fixed vertices for a specific county
     * @param {string} countyName - County name
     * @returns {Array<Object>} - Array of vertex objects
     */
    getCountyVertices(countyName) {
        return this.verticesByCounty.get(countyName) || [];
    }

    /**
     * Check if a vertex is shared between multiple counties
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @returns {boolean} - True if vertex is on county boundary
     */
    isSharedCountyVertex(x, y) {
        const info = this.getFixedVertexInfo(x, y);
        return info ? info.isShared : false;
    }

    /**
     * Get all counties that share a vertex
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @returns {Array<string>} - Array of county names
     */
    getVertexCounties(x, y) {
        const info = this.getFixedVertexInfo(x, y);
        return info ? info.counties : [];
    }

    /**
     * Get statistics about fixed vertices
     * @returns {Object} - Statistics object
     */
    getStatistics() {
        let sharedCount = 0;
        let totalCounties = 0;

        for (const vertex of this.fixedVertices.values()) {
            if (vertex.counties.size > 1) {
                sharedCount++;
            }
            totalCounties += vertex.counties.size;
        }

        return {
            totalVertices: this.fixedVertices.size,
            sharedVertices: sharedCount,
            uniqueVertices: this.fixedVertices.size - sharedCount,
            averageCountiesPerVertex: totalCounties / this.fixedVertices.size,
            countiesTracked: this.verticesByCounty.size
        };
    }

    /**
     * Log statistics to console
     */
    logStatistics() {
        const stats = this.getStatistics();
        console.log('Fixed County Vertices Statistics:');
        console.log(`  Total vertices: ${stats.totalVertices}`);
        console.log(`  Shared vertices (county boundaries): ${stats.sharedVertices}`);
        console.log(`  Unique vertices (interior): ${stats.uniqueVertices}`);
        console.log(`  Average counties per vertex: ${stats.averageCountiesPerVertex.toFixed(2)}`);
        console.log(`  Counties tracked: ${stats.countiesTracked}`);
    }

    /**
     * Register a single new fixed vertex (e.g. a midpoint inserted between two fixed vertices).
     * Unlike initialize(), this adds one entry without triggering the re-initialization guard.
     * @param {number} x
     * @param {number} y
     * @param {Iterable<string>} counties - county names this vertex belongs to
     */
    addFixedVertex(x, y, counties) {
        const key = this.getVertexKey(x, y);
        if (!this.fixedVertices.has(key)) {
            this.fixedVertices.set(key, { x, y, counties: new Set() });
        }
        const entry = this.fixedVertices.get(key);
        for (const c of counties) {
            entry.counties.add(c);
            const list = this.verticesByCounty.get(c);
            if (list) list.push({ x, y, key });
        }
        console.log(`Fixed vertex registered: (${x}, ${y}) for counties [${[...entry.counties].join(', ')}]`);
    }

    /**
     * Clear all fixed vertex data
     */
    clear() {
        this.fixedVertices.clear();
        this.verticesByCounty.clear();
        console.log('Fixed county vertices cleared');
    }

    /**
     * Check if fixed vertices are initialized
     * @returns {boolean} - True if initialized
     */
    isInitialized() {
        return this.fixedVertices.size > 0;
    }

    /**
     * Find fixed vertices near a point (for selection/snapping)
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {number} tolerance - Search tolerance
     * @returns {Array<Object>} - Array of nearby fixed vertices
     */
    findNearbyVertices(x, y, tolerance) {
        const nearby = [];

        for (const [key, vertex] of this.fixedVertices) {
            const dx = vertex.x - x;
            const dy = vertex.y - y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance <= tolerance) {
                nearby.push({
                    x: vertex.x,
                    y: vertex.y,
                    distance: distance,
                    counties: Array.from(vertex.counties),
                    key: key
                });
            }
        }

        // Sort by distance
        nearby.sort((a, b) => a.distance - b.distance);

        return nearby;
    }
}
