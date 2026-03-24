/**
 * GeometryOps - Handles coordinate transformations and spatial calculations
 */
class GeometryOps {
    constructor(canvas) {
        this.canvas = canvas;
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this.bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }

    /**
     * Convert data coordinates to screen coordinates
     * @param {number} dataX - X coordinate in data space
     * @param {number} dataY - Y coordinate in data space
     * @returns {Object} - Screen coordinates {x, y}
     */
    dataToScreen(dataX, dataY) {
        return {
            x: dataX * this.scale + this.offsetX,
            y: this.offsetY - dataY * this.scale
        };
    }

    /**
     * Convert screen coordinates to data coordinates
     * @param {number} screenX - X coordinate in screen space
     * @param {number} screenY - Y coordinate in screen space
     * @returns {Object} - Data coordinates {x, y}
     */
    screenToData(screenX, screenY) {
        return {
            x: (screenX - this.offsetX) / this.scale,
            y: (this.offsetY - screenY) / this.scale
        };
    }

    /**
     * Calculate bounding box for all polygons
     * @param {Array<Object>} polygons - Array of polygon objects
     */
    calculateBounds(polygons) {
        if (polygons.length === 0) return;
        
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        polygons.forEach(polygon => {
            polygon.rings.forEach(ring => {
                ring.forEach(point => {
                    minX = Math.min(minX, point.x);
                    minY = Math.min(minY, point.y);
                    maxX = Math.max(maxX, point.x);
                    maxY = Math.max(maxY, point.y);
                });
            });
        });
        
        this.bounds = { minX, minY, maxX, maxY };
    }

    /**
     * Fit all polygons to the current canvas view
     */
    fitToView() {
        const { minX, minY, maxX, maxY } = this.bounds;
        const dataWidth = maxX - minX;
        const dataHeight = maxY - minY;
        const padding = 50;
        
        const availableWidth = this.canvas.width - padding * 2;
        const availableHeight = this.canvas.height - padding * 2;
        
        const scaleX = availableWidth / dataWidth;
        const scaleY = availableHeight / dataHeight;
        this.scale = Math.min(scaleX, scaleY);
        
        this.offsetX = padding + (availableWidth - dataWidth * this.scale) / 2 - minX * this.scale;
        this.offsetY = padding + (availableHeight - dataHeight * this.scale) / 2 + maxY * this.scale;
    }

    /**
     * Point-in-polygon test using ray casting algorithm
     * @param {number} x - X coordinate to test
     * @param {number} y - Y coordinate to test  
     * @param {Array<Object>} ring - Polygon ring as array of {x, y} points
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
     * Find which polygon contains a given point
     * @param {number} dataX - X coordinate in data space
     * @param {number} dataY - Y coordinate in data space
     * @param {Array<Object>} polygons - Array of polygon objects
     * @returns {number|null} - Index of containing polygon or null
     */
    findPolygonAtPosition(dataX, dataY, polygons) {
        for (let i = 0; i < polygons.length; i++) {
            const polygon = polygons[i];

            // For county polygons, check if point is in any sub-polygon
            if (polygon.layerType === 'county' && polygon.subPolygons) {
                for (const subPolygon of polygon.subPolygons) {
                    if (this.isPointInPolygon(dataX, dataY, subPolygon.rings[0])) {
                        let inHole = false;
                        for (let j = 1; j < subPolygon.rings.length; j++) {
                            if (this.isPointInPolygon(dataX, dataY, subPolygon.rings[j])) {
                                inHole = true;
                                break;
                            }
                        }
                        if (!inHole) {
                            return i; // Return county polygon index
                        }
                    }
                }
            } else {
                // Regular polygon
                if (this.isPointInPolygon(dataX, dataY, polygon.rings[0])) {
                    let inHole = false;
                    for (let j = 1; j < polygon.rings.length; j++) {
                        if (this.isPointInPolygon(dataX, dataY, polygon.rings[j])) {
                            inHole = true;
                            break;
                        }
                    }
                    if (!inHole) {
                        return i;
                    }
                }
            }
        }
        return null;
    }

    /**
     * Calculate the centroid of a polygon ring
     * @param {Array<Object>} ring - Array of {x, y} points
     * @returns {Object} - Centroid coordinates {x, y}
     */
    calculateCentroid(ring) {
        let x = 0, y = 0;
        ring.forEach(point => {
            x += point.x;
            y += point.y;
        });
        return { x: x / ring.length, y: y / ring.length };
    }

    /**
     * Calculate distance between two points
     * @param {Object} point1 - First point {x, y}
     * @param {Object} point2 - Second point {x, y}
     * @returns {number} - Distance between points
     */
    calculateDistance(point1, point2) {
        return Math.sqrt(
            Math.pow(point2.x - point1.x, 2) + 
            Math.pow(point2.y - point1.y, 2)
        );
    }

    /**
     * Find the nearest vertex to a given point
     * @param {number} dataX - X coordinate in data space
     * @param {number} dataY - Y coordinate in data space
     * @param {Array<Object>} polygons - Array of polygon objects
     * @param {number} tolerance - Maximum distance to consider (in data units)
     * @returns {Object|null} - Vertex info {polygonIndex, ringIndex, vertexIndex, vertex} or null
     */
    findNearestVertex(dataX, dataY, polygons, tolerance) {
        let nearestVertex = null;
        let minDistance = Infinity;

        polygons.forEach((polygon, polygonIndex) => {
            polygon.rings.forEach((ring, ringIndex) => {
                ring.forEach((vertex, vertexIndex) => {
                    const distance = this.calculateDistance(
                        { x: dataX, y: dataY }, 
                        vertex
                    );
                    
                    if (distance < tolerance && distance < minDistance) {
                        minDistance = distance;
                        nearestVertex = {
                            polygonIndex,
                            ringIndex,
                            vertexIndex,
                            vertex,
                            distance
                        };
                    }
                });
            });
        });

        return nearestVertex;
    }

    /**
     * Calculate area of a polygon ring
     * @param {Array<Object>} ring - Array of {x, y} points
     * @returns {number} - Area of the polygon (signed)
     */
    calculateArea(ring) {
        let area = 0;
        for (let i = 0; i < ring.length; i++) {
            const j = (i + 1) % ring.length;
            area += ring[i].x * ring[j].y;
            area -= ring[j].x * ring[i].y;
        }
        return area / 2;
    }

    /**
     * Check if a polygon ring is clockwise
     * @param {Array<Object>} ring - Array of {x, y} points
     * @returns {boolean} - True if clockwise
     */
    isClockwise(ring) {
        return this.calculateArea(ring) < 0;
    }

    /**
     * Apply zoom transformation at a specific point
     * @param {number} mouseX - Screen X coordinate of zoom center
     * @param {number} mouseY - Screen Y coordinate of zoom center
     * @param {number} scaleFactor - Zoom factor (>1 for zoom in, <1 for zoom out)
     * @returns {boolean} - True if zoom was applied
     */
    applyZoom(mouseX, mouseY, scaleFactor) {
        const newScale = this.scale * scaleFactor;

        // Maximum zoom increased to 1250 (50x larger than previous 25)
        if (newScale > 0.1 && newScale < 1250) {
            this.offsetX = mouseX - (mouseX - this.offsetX) * scaleFactor;
            this.offsetY = mouseY - (mouseY - this.offsetY) * scaleFactor;
            this.scale = newScale;
            return true;
        }
        return false;
    }

    /**
     * Apply pan transformation
     * @param {number} deltaX - Change in X (screen coordinates)
     * @param {number} deltaY - Change in Y (screen coordinates)
     */
    applyPan(deltaX, deltaY) {
        this.offsetX += deltaX;
        this.offsetY += deltaY;
    }

    /**
     * Get current transformation state
     * @returns {Object} - Current transformation {scale, offsetX, offsetY, bounds}
     */
    getTransformation() {
        return {
            scale: this.scale,
            offsetX: this.offsetX,
            offsetY: this.offsetY,
            bounds: { ...this.bounds }
        };
    }

    /**
     * Set transformation state
     * @param {Object} transform - Transformation object {scale, offsetX, offsetY}
     */
    setTransformation(transform) {
        this.scale = transform.scale;
        this.offsetX = transform.offsetX;
        this.offsetY = transform.offsetY;
    }

    /**
     * Reset transformation to default state
     */
    resetTransformation() {
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
    }
}