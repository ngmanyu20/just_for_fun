/**
 * OverlapDetection - Handles polygon overlap detection and prevention
 */
class OverlapDetection {
    constructor() {
        this.enabled = true;
        this.tolerance = 0.001;
        this.lastValidStates = new Map(); // Store valid states for each polygon
    }

    /**
     * Check if a modified polygon overlaps with any other polygons
     * @param {number} modifiedPolygonIndex - Index of the polygon that was modified
     * @param {Array<Object>} polygons - Array of all polygons
     * @returns {Object} - Overlap detection result
     */
    checkForOverlaps(modifiedPolygonIndex, polygons) {
        const modifiedPolygon = polygons[modifiedPolygonIndex];
        
        for (let i = 0; i < polygons.length; i++) {
            if (i === modifiedPolygonIndex) continue;
            
            const otherPolygon = polygons[i];
            
            // Check if polygons overlap
            if (this.doPolygonsOverlap(modifiedPolygon.rings[0], otherPolygon.rings[0])) {
                return {
                    hasOverlap: true,
                    overlappingWith: i,
                    overlappingPolygonId: otherPolygon.id,
                    modifiedPolygonId: modifiedPolygon.id
                };
            }
        }
        
        return { hasOverlap: false };
    }

    /**
     * Check if two polygon rings overlap using multiple methods
     * Only detects TRUE overlap (interior penetration), not shared boundaries
     * @param {Array<Object>} ring1 - First polygon ring
     * @param {Array<Object>} ring2 - Second polygon ring  
     * @returns {boolean} - True if polygons have overlapping interiors
     */
    doPolygonsOverlap(ring1, ring2) {
        // First, count how many vertices of each polygon are inside the other
        let ring1InsideRing2 = 0;
        let ring2InsideRing1 = 0;
        
        for (const point of ring1) {
            if (this.isPointInPolygon(point.x, point.y, ring2)) {
                ring1InsideRing2++;
            }
        }
        
        for (const point of ring2) {
            if (this.isPointInPolygon(point.x, point.y, ring1)) {
                ring2InsideRing1++;
            }
        }
        
        // Only consider it an overlap if MULTIPLE vertices are inside
        // Single vertices touching is just a shared boundary
        if (ring1InsideRing2 > 2 || ring2InsideRing1 > 2) {
            return true;
        }
        
        // Check for edge crossings (but be lenient about shared edges)
        let crossingCount = 0;
        
        for (let i = 0; i < ring1.length; i++) {
            const edge1Start = ring1[i];
            const edge1End = ring1[(i + 1) % ring1.length];
            
            for (let j = 0; j < ring2.length; j++) {
                const edge2Start = ring2[j];
                const edge2End = ring2[(j + 1) % ring2.length];
                
                // Skip if edges share endpoints (likely shared boundary)
                if (this.areEdgesShared(edge1Start, edge1End, edge2Start, edge2End)) {
                    continue;
                }
                
                // Check for proper intersection (edges crossing)
                if (this.doEdgesCross(edge1Start, edge1End, edge2Start, edge2End)) {
                    crossingCount++;
                }
            }
        }
        
        // Only flag overlap if there are multiple edge crossings
        return crossingCount > 2;
    }

    /**
     * Check if two edges actually cross each other (not just touch at endpoints)
     * @param {Object} e1Start - First edge start
     * @param {Object} e1End - First edge end
     * @param {Object} e2Start - Second edge start
     * @param {Object} e2End - Second edge end
     * @returns {boolean} - True if edges cross
     */
    doEdgesCross(e1Start, e1End, e2Start, e2End) {
        // Skip if edges share any endpoints
        if (this.pointsEqual(e1Start, e2Start) || this.pointsEqual(e1Start, e2End) ||
            this.pointsEqual(e1End, e2Start) || this.pointsEqual(e1End, e2End)) {
            return false;
        }
        
        return this.doLinesIntersect(e1Start, e1End, e2Start, e2End);
    }

    /**
     * Check if a point lies on the boundary of a polygon
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {Array<Object>} ring - Polygon ring
     * @returns {boolean} - True if point is on the polygon boundary
     */
    isPointOnPolygonBoundary(x, y, ring) {
        for (let i = 0; i < ring.length; i++) {
            const p1 = ring[i];
            const p2 = ring[(i + 1) % ring.length];
            
            if (this.isPointOnLineSegment(x, y, p1, p2)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if a point lies on a line segment
     * @param {number} x - Point X coordinate
     * @param {number} y - Point Y coordinate
     * @param {Object} p1 - Line segment start {x, y}
     * @param {Object} p2 - Line segment end {x, y}
     * @returns {boolean} - True if point is on the line segment
     */
    isPointOnLineSegment(x, y, p1, p2) {
        // Check if point is collinear with the line segment
        const crossProduct = (y - p1.y) * (p2.x - p1.x) - (x - p1.x) * (p2.y - p1.y);
        
        if (Math.abs(crossProduct) > this.tolerance) {
            return false; // Not collinear
        }
        
        // Check if point is within the bounds of the line segment
        const dotProduct = (x - p1.x) * (p2.x - p1.x) + (y - p1.y) * (p2.y - p1.y);
        const squaredLength = (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y);
        
        if (dotProduct < -this.tolerance || dotProduct > squaredLength + this.tolerance) {
            return false; // Point is outside the segment
        }
        
        return true;
    }

    /**
     * Check if two edges are shared (same endpoints, possibly in reverse order)
     * @param {Object} e1Start - First edge start point
     * @param {Object} e1End - First edge end point
     * @param {Object} e2Start - Second edge start point
     * @param {Object} e2End - Second edge end point
     * @returns {boolean} - True if edges are shared
     */
    areEdgesShared(e1Start, e1End, e2Start, e2End) {
        // Check if edges have the same endpoints (in either direction)
        const sameDirection = 
            this.pointsEqual(e1Start, e2Start) && this.pointsEqual(e1End, e2End);
        
        const reverseDirection = 
            this.pointsEqual(e1Start, e2End) && this.pointsEqual(e1End, e2Start);
        
        return sameDirection || reverseDirection;
    }

    /**
     * Check if two points are equal within tolerance
     * @param {Object} p1 - First point {x, y}
     * @param {Object} p2 - Second point {x, y}
     * @returns {boolean} - True if points are equal
     */
    pointsEqual(p1, p2) {
        return Math.abs(p1.x - p2.x) < this.tolerance && 
               Math.abs(p1.y - p2.y) < this.tolerance;
    }

    /**
     * Check if two line segments intersect
     * @param {Object} p1 - First line start point {x, y}
     * @param {Object} q1 - First line end point {x, y}
     * @param {Object} p2 - Second line start point {x, y}
     * @param {Object} q2 - Second line end point {x, y}
     * @returns {boolean} - True if lines intersect
     */
    doLinesIntersect(p1, q1, p2, q2) {
        const orientation = (p, q, r) => {
            const val = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
            if (Math.abs(val) < this.tolerance) return 0; // collinear
            return (val > 0) ? 1 : 2; // clockwise or counterclockwise
        };
        
        const onSegment = (p, q, r) => {
            return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) &&
                   q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
        };
        
        const o1 = orientation(p1, q1, p2);
        const o2 = orientation(p1, q1, q2);
        const o3 = orientation(p2, q2, p1);
        const o4 = orientation(p2, q2, q1);
        
        // General case
        if (o1 !== o2 && o3 !== o4) return true;
        
        // Special cases
        if (o1 === 0 && onSegment(p1, p2, q1)) return true;
        if (o2 === 0 && onSegment(p1, q2, q1)) return true;
        if (o3 === 0 && onSegment(p2, p1, q2)) return true;
        if (o4 === 0 && onSegment(p2, q1, q2)) return true;
        
        return false;
    }

    /**
     * Point-in-polygon test using ray casting
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @param {Array<Object>} ring - Polygon ring as array of points
     * @returns {boolean} - True if point is inside polygon
     */
    isPointInPolygon(x, y, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            if (((ring[i].y > y) !== (ring[j].y > y)) &&
                (x < (ring[j].x - ring[i].x) * (y - ring[i].y) / (ring[j].y - ring[i].y) + ring[i].x)) {
                inside = !inside;
            }
        }
        return inside;
    }

    /**
     * Store the current valid state of a polygon before modifications
     * @param {number} polygonIndex - Index of the polygon
     * @param {Array<Object>} polygons - Array of all polygons
     */
    storeValidState(polygonIndex, polygons) {
        if (polygonIndex >= 0 && polygonIndex < polygons.length) {
            this.lastValidStates.set(polygonIndex, {
                rings: JSON.parse(JSON.stringify(polygons[polygonIndex].rings)),
                timestamp: Date.now()
            });
        }
    }

    /**
     * Restore a polygon to its last valid state
     * @param {number} polygonIndex - Index of the polygon to restore
     * @param {Array<Object>} polygons - Array of all polygons
     * @returns {boolean} - True if restoration was successful
     */
    restoreValidState(polygonIndex, polygons) {
        const validState = this.lastValidStates.get(polygonIndex);
        if (validState && polygonIndex >= 0 && polygonIndex < polygons.length) {
            polygons[polygonIndex].rings = JSON.parse(JSON.stringify(validState.rings));
            return true;
        }
        return false;
    }

    /**
     * Check if a polygon modification would cause overlaps
     * @param {number} polygonIndex - Index of polygon to modify
     * @param {Array<Array<Object>>} newRings - New ring geometry
     * @param {Array<Object>} polygons - Array of all polygons
     * @returns {Object} - Validation result
     */
    validateModification(polygonIndex, newRings, polygons) {
        // Store current state
        const originalRings = polygons[polygonIndex].rings;
        
        // Temporarily apply the modification
        polygons[polygonIndex].rings = newRings;
        
        // Check for overlaps
        const overlapResult = this.checkForOverlaps(polygonIndex, polygons);
        
        // Restore original state
        polygons[polygonIndex].rings = originalRings;
        
        return {
            isValid: !overlapResult.hasOverlap,
            overlapInfo: overlapResult
        };
    }

    /**
     * Get detailed overlap information between two specific polygons
     * @param {Array<Object>} ring1 - First polygon ring
     * @param {Array<Object>} ring2 - Second polygon ring
     * @returns {Object} - Detailed overlap information
     */
    getDetailedOverlapInfo(ring1, ring2) {
        const info = {
            hasOverlap: false,
            verticesInside: { ring1InRing2: [], ring2InRing1: [] },
            edgeIntersections: [],
            overlapType: 'none'
        };

        // Check vertices inside other polygon
        ring1.forEach((point, index) => {
            if (this.isPointInPolygon(point.x, point.y, ring2)) {
                info.verticesInside.ring1InRing2.push(index);
            }
        });

        ring2.forEach((point, index) => {
            if (this.isPointInPolygon(point.x, point.y, ring1)) {
                info.verticesInside.ring2InRing1.push(index);
            }
        });

        // Check edge intersections
        for (let i = 0; i < ring1.length; i++) {
            const edge1Start = ring1[i];
            const edge1End = ring1[(i + 1) % ring1.length];
            
            for (let j = 0; j < ring2.length; j++) {
                const edge2Start = ring2[j];
                const edge2End = ring2[(j + 1) % ring2.length];
                
                if (this.doLinesIntersect(edge1Start, edge1End, edge2Start, edge2End)) {
                    info.edgeIntersections.push({
                        ring1Edge: i,
                        ring2Edge: j,
                        edge1: [edge1Start, edge1End],
                        edge2: [edge2Start, edge2End]
                    });
                }
            }
        }

        // Determine overlap type and status
        info.hasOverlap = info.verticesInside.ring1InRing2.length > 0 || 
                         info.verticesInside.ring2InRing1.length > 0 || 
                         info.edgeIntersections.length > 0;

        if (info.hasOverlap) {
            if (info.edgeIntersections.length > 0) {
                info.overlapType = 'intersection';
            } else if (info.verticesInside.ring1InRing2.length === ring1.length) {
                info.overlapType = 'ring1_inside_ring2';
            } else if (info.verticesInside.ring2InRing1.length === ring2.length) {
                info.overlapType = 'ring2_inside_ring1';
            } else {
                info.overlapType = 'partial_overlap';
            }
        }

        return info;
    }

    /**
     * Find all overlapping polygon pairs
     * @param {Array<Object>} polygons - Array of all polygons
     * @returns {Array<Object>} - Array of overlapping pairs
     */
    findAllOverlaps(polygons) {
        const overlaps = [];
        
        for (let i = 0; i < polygons.length; i++) {
            for (let j = i + 1; j < polygons.length; j++) {
                if (this.doPolygonsOverlap(polygons[i].rings[0], polygons[j].rings[0])) {
                    const detailedInfo = this.getDetailedOverlapInfo(
                        polygons[i].rings[0], 
                        polygons[j].rings[0]
                    );
                    
                    overlaps.push({
                        polygon1Index: i,
                        polygon2Index: j,
                        polygon1Id: polygons[i].id,
                        polygon2Id: polygons[j].id,
                        overlapInfo: detailedInfo
                    });
                }
            }
        }
        
        return overlaps;
    }

    /**
     * Enable or disable overlap detection
     * @param {boolean} enabled - Whether to enable overlap detection
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        console.log(`Overlap detection ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Set tolerance for geometric calculations
     * @param {number} tolerance - Tolerance value
     */
    setTolerance(tolerance) {
        this.tolerance = Math.max(0, tolerance);
        console.log(`Overlap detection tolerance set to ${this.tolerance}`);
    }

    /**
     * Clear all stored valid states
     */
    clearValidStates() {
        this.lastValidStates.clear();
        console.log('All stored valid states cleared');
    }

    /**
     * Get statistics about stored valid states
     * @returns {Object} - Statistics about stored states
     */
    getValidStateStats() {
        return {
            storedStatesCount: this.lastValidStates.size,
            oldestTimestamp: Math.min(...Array.from(this.lastValidStates.values()).map(s => s.timestamp)),
            newestTimestamp: Math.max(...Array.from(this.lastValidStates.values()).map(s => s.timestamp))
        };
    }

    /**
     * Check if overlap detection is enabled
     * @returns {boolean} - Whether overlap detection is enabled
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
}