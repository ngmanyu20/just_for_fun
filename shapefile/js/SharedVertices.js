/**
 * SharedVertices - Manages vertices that are shared between multiple polygons
 */
class SharedVertices {
    constructor() {
        this.enabled = true;
        this.tolerance = 0.001; // Distance tolerance for considering vertices as shared
    }

    /**
     * Find all vertices that share the same position as the target coordinates
     * @param {number} targetX - Target X coordinate
     * @param {number} targetY - Target Y coordinate
     * @param {Array<Object>} polygons - Array of polygon objects
     * @returns {Array<Object>} - Array of shared vertex references
     */
    findSharedVertices(targetX, targetY, polygons) {
        const sharedVertices = [];
        
        polygons.forEach((polygon, polygonIndex) => {
            polygon.rings.forEach((ring, ringIndex) => {
                ring.forEach((vertex, vertexIndex) => {
                    if (Math.abs(vertex.x - targetX) < this.tolerance && 
                        Math.abs(vertex.y - targetY) < this.tolerance) {
                        sharedVertices.push({
                            polygonIndex,
                            ringIndex,
                            vertexIndex,
                            vertex: vertex,
                            polygonId: polygon.id
                        });
                    }
                });
            });
        });
        
        return sharedVertices;
    }

    /**
     * Update all vertices that share the old position to the new position
     * @param {number} oldX - Original X coordinate
     * @param {number} oldY - Original Y coordinate
     * @param {number} newX - New X coordinate
     * @param {number} newY - New Y coordinate
     * @param {Array<Object>} polygons - Array of polygon objects
     * @returns {Array<number>} - Array of affected polygon indices
     */
    updateSharedVertices(oldX, oldY, newX, newY, polygons) {
        if (!this.enabled) return [];

        const sharedVertices = this.findSharedVertices(oldX, oldY, polygons);
        const affectedPolygons = new Set();
        
        sharedVertices.forEach(shared => {
            shared.vertex.x = newX;
            shared.vertex.y = newY;
            affectedPolygons.add(shared.polygonIndex);
        });
        
        // Log information about shared vertex updates
        if (sharedVertices.length > 1) {
            const polygonNames = Array.from(affectedPolygons).map(index => polygons[index].id);
            console.log(`Updated ${sharedVertices.length} shared vertices across polygons: ${polygonNames.join(', ')}`);
        }
        
        return Array.from(affectedPolygons);
    }

    /**
     * Get information about vertices shared at a specific location
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {Array<Object>} polygons - Array of polygon objects
     * @returns {Object} - Information about shared vertices at this location
     */
    getSharedVertexInfo(x, y, polygons) {
        const shared = this.findSharedVertices(x, y, polygons);
        
        if (shared.length <= 1) {
            return {
                isShared: false,
                count: shared.length,
                polygons: []
            };
        }

        return {
            isShared: true,
            count: shared.length,
            polygons: shared.map(s => ({
                index: s.polygonIndex,
                id: s.polygonId,
                ring: s.ringIndex,
                vertex: s.vertexIndex
            }))
        };
    }

    /**
     * Find all shared vertex pairs in the polygon set
     * @param {Array<Object>} polygons - Array of polygon objects
     * @returns {Array<Object>} - Array of shared vertex groups
     */
    findAllSharedVertices(polygons) {
        const sharedGroups = [];
        const processed = new Set();

        polygons.forEach((polygon, polygonIndex) => {
            polygon.rings.forEach((ring, ringIndex) => {
                ring.forEach((vertex, vertexIndex) => {
                    const key = `${vertex.x.toFixed(6)},${vertex.y.toFixed(6)}`;
                    
                    if (!processed.has(key)) {
                        const shared = this.findSharedVertices(vertex.x, vertex.y, polygons);
                        
                        if (shared.length > 1) {
                            sharedGroups.push({
                                position: { x: vertex.x, y: vertex.y },
                                vertices: shared,
                                count: shared.length
                            });
                        }
                        
                        processed.add(key);
                    }
                });
            });
        });

        return sharedGroups;
    }

    /**
     * Validate shared vertices consistency
     * @param {Array<Object>} polygons - Array of polygon objects
     * @returns {Object} - Validation result
     */
    validateSharedVertices(polygons) {
        const issues = [];
        const sharedGroups = this.findAllSharedVertices(polygons);

        sharedGroups.forEach(group => {
            // Check if all vertices in the group have exactly the same coordinates
            const firstVertex = group.vertices[0].vertex;
            const inconsistent = group.vertices.some(shared => 
                Math.abs(shared.vertex.x - firstVertex.x) > this.tolerance ||
                Math.abs(shared.vertex.y - firstVertex.y) > this.tolerance
            );

            if (inconsistent) {
                issues.push({
                    type: 'inconsistent_coordinates',
                    position: group.position,
                    vertices: group.vertices,
                    message: `Shared vertices have inconsistent coordinates`
                });
            }
        });

        return {
            isValid: issues.length === 0,
            issues: issues,
            sharedGroupCount: sharedGroups.length,
            totalSharedVertices: sharedGroups.reduce((sum, group) => sum + group.count, 0)
        };
    }

    /**
     * Get statistics about shared vertices
     * @param {Array<Object>} polygons - Array of polygon objects
     * @returns {Object} - Statistics object
     */
    getStatistics(polygons) {
        const sharedGroups = this.findAllSharedVertices(polygons);
        const totalVertices = polygons.reduce((sum, polygon) => {
            return sum + polygon.rings.reduce((ringSum, ring) => ringSum + ring.length, 0);
        }, 0);

        const sharedVertexCount = sharedGroups.reduce((sum, group) => sum + group.count, 0);
        
        return {
            totalVertices,
            sharedVertexCount,
            sharedGroupCount: sharedGroups.length,
            sharingPercentage: totalVertices > 0 ? (sharedVertexCount / totalVertices * 100).toFixed(1) : 0,
            averageVerticesPerGroup: sharedGroups.length > 0 ? 
                (sharedVertexCount / sharedGroups.length).toFixed(1) : 0
        };
    }

    /**
     * Enable or disable shared vertex functionality
     * @param {boolean} enabled - Whether to enable shared vertices
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        console.log(`Shared vertices ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Set the tolerance for considering vertices as shared
     * @param {number} tolerance - Distance tolerance
     */
    setTolerance(tolerance) {
        this.tolerance = Math.max(0, tolerance);
        console.log(`Shared vertex tolerance set to ${this.tolerance}`);
    }

    /**
     * Check if shared vertices are enabled
     * @returns {boolean} - Whether shared vertices are enabled
     */
    isEnabled() {
        return this.enabled;
    }

    /**
     * Get current tolerance value
     * @returns {number} - Current tolerance
     */
    getTolerance() {
        return this.tolerance;
    }

    /**
     * Create a visual indicator for shared vertices
     * @param {Object} sharedInfo - Shared vertex information
     * @returns {string} - HTML string for display
     */
    createSharedVertexIndicator(sharedInfo) {
        if (!sharedInfo.isShared) {
            return '';
        }

        const polygonNames = sharedInfo.polygons.map(p => p.id).join(', ');
        return `<span class="shared-indicator" title="Shared with: ${polygonNames}">S${sharedInfo.count}</span>`;
    }

    /**
     * Get a human-readable description of shared vertex relationships
     * @param {Array<Object>} polygons - Array of polygon objects
     * @returns {string} - Description text
     */
    getSharedVertexDescription(polygons) {
        const stats = this.getStatistics(polygons);
        
        if (stats.sharedGroupCount === 0) {
            return "No shared vertices found between polygons.";
        }

        return `Found ${stats.sharedGroupCount} shared vertex locations affecting ${stats.sharedVertexCount} total vertices (${stats.sharingPercentage}% of all vertices). Average ${stats.averageVerticesPerGroup} vertices per shared location.`;
    }
}