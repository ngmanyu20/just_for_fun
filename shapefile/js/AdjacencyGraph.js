/**
 * AdjacencyGraph - Builds and maintains adjacency relationships between polygons
 * Based on shared boundary segments
 */
class AdjacencyGraph {
    constructor() {
        this.adjacencyList = {}; // Maps polygon ID to array of neighbor IDs
        this.tolerance = 1e-6; // Tolerance for point matching
        this.lengthTolerance = 1e-4; // Minimum shared boundary length to count as adjacency
    }

    /**
     * Set tolerance for adjacency detection
     * @param {number} tol - Point matching tolerance
     * @param {number} lengthTol - Minimum shared boundary length
     */
    setTolerance(tol, lengthTol) {
        this.tolerance = tol;
        this.lengthTolerance = lengthTol;
    }

    /**
     * Build adjacency list for all polygons
     * @param {Array<Object>} polygons - Array of polygon objects with rings
     * @returns {Object} - Adjacency list mapping polygon IDs to neighbor IDs
     */
    buildAdjacencyList(polygons) {
        this.adjacencyList = {};

        // Initialize empty adjacency sets for all polygons
        polygons.forEach(polygon => {
            this.adjacencyList[polygon.id] = new Set();
        });

        // Compare each pair of polygons
        for (let i = 0; i < polygons.length; i++) {
            for (let j = i + 1; j < polygons.length; j++) {
                const poly1 = polygons[i];
                const poly2 = polygons[j];

                // Check if these polygons share a boundary
                const sharedLength = this.calculateSharedBoundaryLength(poly1, poly2);

                if (sharedLength > this.lengthTolerance) {
                    // They are adjacent
                    this.adjacencyList[poly1.id].add(poly2.id);
                    this.adjacencyList[poly2.id].add(poly1.id);
                }
            }
        }

        // Convert sets to sorted arrays for stable output
        const result = {};
        for (const [id, neighbors] of Object.entries(this.adjacencyList)) {
            result[id] = Array.from(neighbors).sort();
        }

        this.adjacencyList = result;
        return this.adjacencyList;
    }

    /**
     * Calculate the total length of shared boundary between two polygons
     * @param {Object} poly1 - First polygon
     * @param {Object} poly2 - Second polygon
     * @returns {number} - Total length of shared boundaries
     */
    calculateSharedBoundaryLength(poly1, poly2) {
        let totalSharedLength = 0;

        // Get all edges from both polygons
        const edges1 = this.getAllEdges(poly1);
        const edges2 = this.getAllEdges(poly2);

        // Compare each edge pair
        for (const edge1 of edges1) {
            for (const edge2 of edges2) {
                const sharedLength = this.getSharedEdgeLength(edge1, edge2);
                totalSharedLength += sharedLength;
            }
        }

        return totalSharedLength;
    }

    /**
     * Get all edges from a polygon's rings
     * @param {Object} polygon - Polygon object with rings
     * @returns {Array<Object>} - Array of edge objects {p1: {x, y}, p2: {x, y}}
     */
    getAllEdges(polygon) {
        const edges = [];

        polygon.rings.forEach(ring => {
            for (let i = 0; i < ring.length - 1; i++) {
                edges.push({
                    p1: ring[i],
                    p2: ring[i + 1]
                });
            }
        });

        return edges;
    }

    /**
     * Calculate shared length between two edges (segments)
     * @param {Object} edge1 - First edge {p1, p2}
     * @param {Object} edge2 - Second edge {p1, p2}
     * @returns {number} - Length of overlap between edges
     */
    getSharedEdgeLength(edge1, edge2) {
        // Check if edges are collinear and overlapping
        // Two edges share a boundary if they are on the same line and overlap

        // First check if any endpoints match
        const p1Match = this.pointsEqual(edge1.p1, edge2.p1) || this.pointsEqual(edge1.p1, edge2.p2);
        const p2Match = this.pointsEqual(edge1.p2, edge2.p1) || this.pointsEqual(edge1.p2, edge2.p2);

        // If both endpoints match, they share the entire edge
        if (p1Match && p2Match) {
            return this.distance(edge1.p1, edge1.p2);
        }

        // Check for partial overlap on collinear segments
        if (this.areCollinear(edge1.p1, edge1.p2, edge2.p1, edge2.p2)) {
            return this.calculateCollinearOverlap(edge1, edge2);
        }

        return 0;
    }

    /**
     * Check if two points are equal within tolerance
     * @param {Object} p1 - First point {x, y}
     * @param {Object} p2 - Second point {x, y}
     * @returns {boolean} - True if points are equal
     */
    pointsEqual(p1, p2) {
        return Math.abs(p1.x - p2.x) <= this.tolerance &&
               Math.abs(p1.y - p2.y) <= this.tolerance;
    }

    /**
     * Calculate distance between two points
     * @param {Object} p1 - First point {x, y}
     * @param {Object} p2 - Second point {x, y}
     * @returns {number} - Distance
     */
    distance(p1, p2) {
        return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
    }

    /**
     * Check if four points define collinear segments
     * @param {Object} a1 - First point of first segment
     * @param {Object} a2 - Second point of first segment
     * @param {Object} b1 - First point of second segment
     * @param {Object} b2 - Second point of second segment
     * @returns {boolean} - True if segments are collinear
     */
    areCollinear(a1, a2, b1, b2) {
        // Check if all four points lie on the same line
        // Using cross product approach
        const cross1 = this.crossProduct(a1, a2, b1);
        const cross2 = this.crossProduct(a1, a2, b2);

        return Math.abs(cross1) <= this.tolerance && Math.abs(cross2) <= this.tolerance;
    }

    /**
     * Calculate cross product for collinearity test
     * @param {Object} p1 - First point
     * @param {Object} p2 - Second point
     * @param {Object} p3 - Third point
     * @returns {number} - Cross product value
     */
    crossProduct(p1, p2, p3) {
        return (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
    }

    /**
     * Calculate overlap length of two collinear segments
     * @param {Object} edge1 - First edge {p1, p2}
     * @param {Object} edge2 - Second edge {p1, p2}
     * @returns {number} - Overlap length
     */
    calculateCollinearOverlap(edge1, edge2) {
        // Project points onto a 1D axis
        // Use the direction of edge1 as the axis
        const dx = edge1.p2.x - edge1.p1.x;
        const dy = edge1.p2.y - edge1.p1.y;
        const length = Math.sqrt(dx * dx + dy * dy);

        if (length < this.tolerance) return 0;

        // Unit direction vector
        const ux = dx / length;
        const uy = dy / length;

        // Project all points onto this axis
        const t1_1 = 0; // edge1.p1 is the origin
        const t1_2 = length; // edge1.p2
        const t2_1 = (edge2.p1.x - edge1.p1.x) * ux + (edge2.p1.y - edge1.p1.y) * uy;
        const t2_2 = (edge2.p2.x - edge1.p1.x) * ux + (edge2.p2.y - edge1.p1.y) * uy;

        // Sort the projections of edge2
        const t2_min = Math.min(t2_1, t2_2);
        const t2_max = Math.max(t2_1, t2_2);

        // Find overlap interval
        const overlapStart = Math.max(t1_1, t2_min);
        const overlapEnd = Math.min(t1_2, t2_max);

        if (overlapEnd > overlapStart) {
            return overlapEnd - overlapStart;
        }

        return 0;
    }

    /**
     * Get neighbors of a specific polygon
     * @param {string} polygonId - ID of the polygon
     * @returns {Array<string>} - Array of neighbor IDs
     */
    getNeighbors(polygonId) {
        return this.adjacencyList[polygonId] || [];
    }

    /**
     * Check if two polygons are adjacent
     * @param {string} id1 - First polygon ID
     * @param {string} id2 - Second polygon ID
     * @returns {boolean} - True if polygons are adjacent
     */
    areAdjacent(id1, id2) {
        const neighbors = this.adjacencyList[id1] || [];
        return neighbors.includes(id2);
    }

    /**
     * Get the full adjacency list
     * @returns {Object} - Complete adjacency list
     */
    getAdjacencyList() {
        return { ...this.adjacencyList };
    }

    /**
     * Update adjacency for specific polygons after vertex modification
     * This is more efficient than rebuilding the entire graph
     * @param {Array<Object>} polygons - All polygons
     * @param {Set<string>} affectedPolygonIds - IDs of polygons that changed
     */
    updateAdjacency(polygons, affectedPolygonIds) {
        const affectedIds = Array.from(affectedPolygonIds);

        // Clear adjacency for affected polygons
        affectedIds.forEach(id => {
            const oldNeighbors = this.adjacencyList[id] || [];

            // Remove this polygon from its old neighbors' lists
            oldNeighbors.forEach(neighborId => {
                if (this.adjacencyList[neighborId]) {
                    const idx = this.adjacencyList[neighborId].indexOf(id);
                    if (idx !== -1) {
                        this.adjacencyList[neighborId].splice(idx, 1);
                    }
                }
            });

            // Clear this polygon's neighbor list
            this.adjacencyList[id] = [];
        });

        // Recalculate adjacency for affected polygons
        const affectedPolygons = polygons.filter(p => affectedIds.includes(p.id));

        affectedPolygons.forEach(poly1 => {
            polygons.forEach(poly2 => {
                if (poly1.id === poly2.id) return;

                const sharedLength = this.calculateSharedBoundaryLength(poly1, poly2);

                if (sharedLength > this.lengthTolerance) {
                    // Add to adjacency list (avoiding duplicates)
                    if (!this.adjacencyList[poly1.id].includes(poly2.id)) {
                        this.adjacencyList[poly1.id].push(poly2.id);
                    }
                    if (!this.adjacencyList[poly2.id].includes(poly1.id)) {
                        this.adjacencyList[poly2.id].push(poly1.id);
                    }
                }
            });

            // Sort for consistency
            this.adjacencyList[poly1.id].sort();
        });
    }

    /**
     * Get statistics about the adjacency graph
     * @returns {Object} - Statistics
     */
    getStatistics() {
        const polygonCount = Object.keys(this.adjacencyList).length;

        if (polygonCount === 0) {
            return {
                polygonCount: 0,
                totalEdges: 0,
                averageNeighbors: 0,
                maxNeighbors: 0,
                isolatedPolygons: 0
            };
        }

        let totalEdges = 0;
        let maxNeighbors = 0;
        let isolatedPolygons = 0;

        Object.values(this.adjacencyList).forEach(neighbors => {
            const count = neighbors.length;
            totalEdges += count;
            maxNeighbors = Math.max(maxNeighbors, count);
            if (count === 0) isolatedPolygons++;
        });

        // Each edge is counted twice (once for each polygon)
        totalEdges = totalEdges / 2;

        return {
            polygonCount,
            totalEdges,
            averageNeighbors: (totalEdges * 2 / polygonCount).toFixed(2),
            maxNeighbors,
            isolatedPolygons
        };
    }

    /**
     * Clear the adjacency graph
     */
    clear() {
        this.adjacencyList = {};
    }

    /**
     * Export adjacency graph as JSON
     * @returns {string} - JSON representation
     */
    exportToJSON() {
        return JSON.stringify(this.adjacencyList, null, 2);
    }

    /**
     * Import adjacency graph from JSON
     * @param {string} json - JSON string
     * @returns {boolean} - Success status
     */
    importFromJSON(json) {
        try {
            this.adjacencyList = JSON.parse(json);
            return true;
        } catch (error) {
            console.error('Failed to import adjacency graph:', error);
            return false;
        }
    }
}
