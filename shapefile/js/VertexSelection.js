/**
 * VertexSelection - Manages vertex selection and highlighting of neighboring vertices
 */
class VertexSelection {
    constructor() {
        // Set of selected vertices: "polygonIndex:ringIndex:vertexIndex"
        this.selectedVertices = new Set();

        // Map of neighboring vertices to highlight
        // Key: "x,y" -> { x, y, polygons: [{ polygonIndex, ringIndex, vertexIndex }] }
        this.neighboringVertices = new Map();
    }

    /**
     * Toggle vertex selection
     * @param {number} polygonIndex - Polygon index
     * @param {number} ringIndex - Ring index
     * @param {number} vertexIndex - Vertex index
     * @param {Array<Object>} polygons - All polygons
     * @returns {boolean} - True if vertex is now selected
     */
    toggleVertex(polygonIndex, ringIndex, vertexIndex, polygons) {
        const key = this.getVertexKey(polygonIndex, ringIndex, vertexIndex);

        if (this.selectedVertices.has(key)) {
            // Deselect
            this.selectedVertices.delete(key);
            this.updateNeighboringVertices(polygons);
            return false;
        } else {
            // Select
            this.selectedVertices.add(key);
            this.updateNeighboringVertices(polygons);
            return true;
        }
    }

    /**
     * Get unique key for a vertex
     * @param {number} polygonIndex - Polygon index
     * @param {number} ringIndex - Ring index
     * @param {number} vertexIndex - Vertex index
     * @returns {string} - Unique key
     */
    getVertexKey(polygonIndex, ringIndex, vertexIndex) {
        return `${polygonIndex}:${ringIndex}:${vertexIndex}`;
    }

    /**
     * Get coordinate key for a vertex position
     * @param {number} x - X coordinate
     * @param {number} y - Y coordinate
     * @returns {string} - Coordinate key
     */
    getCoordinateKey(x, y) {
        return `${x.toFixed(6)},${y.toFixed(6)}`;
    }

    /**
     * Check if a vertex is selected
     * @param {number} polygonIndex - Polygon index
     * @param {number} ringIndex - Ring index
     * @param {number} vertexIndex - Vertex index
     * @returns {boolean} - True if selected
     */
    isVertexSelected(polygonIndex, ringIndex, vertexIndex) {
        const key = this.getVertexKey(polygonIndex, ringIndex, vertexIndex);
        return this.selectedVertices.has(key);
    }

    /**
     * Check if a vertex is a neighboring vertex (should be highlighted in red)
     * @param {number} polygonIndex - Polygon index
     * @param {number} ringIndex - Ring index
     * @param {number} vertexIndex - Vertex index
     * @param {Array<Object>} polygons - All polygons
     * @returns {boolean} - True if neighboring
     */
    isNeighboringVertex(polygonIndex, ringIndex, vertexIndex, polygons) {
        const polygon = polygons[polygonIndex];
        if (!polygon || !polygon.rings[ringIndex]) return false;

        const vertex = polygon.rings[ringIndex][vertexIndex];
        const coordKey = this.getCoordinateKey(vertex.x, vertex.y);

        return this.neighboringVertices.has(coordKey);
    }

    /**
     * Update neighboring vertices based on current selection
     * @param {Array<Object>} polygons - All polygons
     */
    updateNeighboringVertices(polygons) {
        this.neighboringVertices.clear();

        if (this.selectedVertices.size === 0) {
            return;
        }

        // Get coordinates of all selected vertices
        const selectedCoords = new Set();
        for (const vertexKey of this.selectedVertices) {
            const [polygonIndex, ringIndex, vertexIndex] = vertexKey.split(':').map(Number);
            const polygon = polygons[polygonIndex];
            if (!polygon || !polygon.rings[ringIndex]) continue;

            const vertex = polygon.rings[ringIndex][vertexIndex];
            const coordKey = this.getCoordinateKey(vertex.x, vertex.y);
            selectedCoords.add(coordKey);
        }

        // Find all vertices that share the same coordinates (neighboring polygons)
        polygons.forEach((polygon, polygonIndex) => {
            polygon.rings.forEach((ring, ringIndex) => {
                ring.forEach((vertex, vertexIndex) => {
                    const coordKey = this.getCoordinateKey(vertex.x, vertex.y);

                    // If this coordinate matches a selected vertex
                    if (selectedCoords.has(coordKey)) {
                        // Check if this is NOT the originally selected vertex
                        const currentKey = this.getVertexKey(polygonIndex, ringIndex, vertexIndex);
                        if (!this.selectedVertices.has(currentKey)) {
                            // This is a neighboring vertex - add to highlighting map
                            if (!this.neighboringVertices.has(coordKey)) {
                                this.neighboringVertices.set(coordKey, {
                                    x: vertex.x,
                                    y: vertex.y,
                                    polygons: []
                                });
                            }
                            this.neighboringVertices.get(coordKey).polygons.push({
                                polygonIndex,
                                ringIndex,
                                vertexIndex
                            });
                        }
                    }
                });
            });
        });

        console.log(`Updated neighboring vertices: ${this.neighboringVertices.size} coordinates shared`);
    }

    /**
     * Clear all vertex selections
     */
    clearSelection() {
        this.selectedVertices.clear();
        this.neighboringVertices.clear();
    }

    /**
     * Get selection count
     * @returns {number} - Number of selected vertices
     */
    getSelectionCount() {
        return this.selectedVertices.size;
    }

    /**
     * Get neighboring vertex count
     * @returns {number} - Number of neighboring vertices
     */
    getNeighboringCount() {
        return this.neighboringVertices.size;
    }

    /**
     * Get selected vertex info for display
     * @param {Array<Object>} polygons - All polygons
     * @returns {Array<Object>} - Array of selected vertex information
     */
    getSelectedVertexInfo(polygons) {
        const info = [];

        for (const vertexKey of this.selectedVertices) {
            const [polygonIndex, ringIndex, vertexIndex] = vertexKey.split(':').map(Number);
            const polygon = polygons[polygonIndex];
            if (!polygon || !polygon.rings[ringIndex]) continue;

            const vertex = polygon.rings[ringIndex][vertexIndex];
            info.push({
                polygonIndex,
                ringIndex,
                vertexIndex,
                polygonId: polygon.id,
                x: vertex.x,
                y: vertex.y,
                coordKey: this.getCoordinateKey(vertex.x, vertex.y)
            });
        }

        return info;
    }

    /**
     * Get statistics about selection
     * @returns {Object} - Statistics object
     */
    getStatistics() {
        return {
            selectedCount: this.selectedVertices.size,
            neighboringCount: this.neighboringVertices.size,
            uniqueCoordinates: this.neighboringVertices.size
        };
    }
}
