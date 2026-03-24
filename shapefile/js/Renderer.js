/**
 * Renderer - Handles all canvas drawing and visualization
 */
class Renderer {
    constructor(canvas, geometryOps) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.geometryOps = geometryOps;
        
        // Rendering options
        this.options = {
            showGrid: true,
            showVertices: true,
            showVertexNumbers: true,
            showSharedVertexIndicators: true,
            showPolygonLabels: true,
            gridColor: '#f0f0f0',
            polygonFillColor: 'rgba(102, 126, 234, 0.2)',
            selectedPolygonFillColor: 'rgba(40, 167, 69, 0.3)',
            polygonStrokeColor: '#495057',
            selectedPolygonStrokeColor: '#28a745',
            vertexColor: '#dc3545',
            holeVertexColor: '#ffc107',
            sharedVertexColor: '#ff6b35',
            vertexSize: 6,
            strokeWidth: 2,
            selectedStrokeWidth: 3
        };
    }

    /**
     * Main drawing method - renders the entire scene
     * @param {Array<Object>} polygons - Array of polygon objects
     * @param {number|null} selectedPolygonIndex - Index of selected polygon
     * @param {boolean} isEditMode - Whether in edit mode
     * @param {Object} sharedVerticesManager - Shared vertices manager for indicators
     * @param {Set<number>} selectedPolygonIndices - Set of all selected polygon indices for multi-selection
     * @param {Object} vertexSelection - Vertex selection manager for highlighting
     * @param {Object} fixedCountyVertices - Fixed county vertices manager for protection
     */
    draw(polygons, selectedPolygonIndex = null, isEditMode = false, sharedVerticesManager = null, selectedPolygonIndices = null, vertexSelection = null, fixedCountyVertices = null) {
        // Store polygons reference for vertex selection
        this.polygons = polygons;
        this.fixedCountyVertices = fixedCountyVertices;

        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw grid if enabled
        if (this.options.showGrid) {
            this.drawGrid();
        }

        // Draw all polygons
        polygons.forEach((polygon, index) => {
            const isSelected = index === selectedPolygonIndex;
            const isMultiSelected = selectedPolygonIndices && selectedPolygonIndices.has(index);
            this.drawPolygon(polygon, isSelected, isEditMode, sharedVerticesManager, isMultiSelected, index, vertexSelection);
        });
    }

    /**
     * Draw background grid
     */
    drawGrid() {
        this.ctx.strokeStyle = this.options.gridColor;
        this.ctx.lineWidth = 1;
        
        const gridSize = 100 * this.geometryOps.scale;
        const startX = this.geometryOps.offsetX % gridSize;
        const startY = this.geometryOps.offsetY % gridSize;
        
        // Vertical lines
        for (let x = startX; x < this.canvas.width; x += gridSize) {
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, this.canvas.height);
            this.ctx.stroke();
        }
        
        // Horizontal lines
        for (let y = startY; y < this.canvas.height; y += gridSize) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(this.canvas.width, y);
            this.ctx.stroke();
        }
    }

    /**
     * Draw a single polygon with all its rings
     * @param {Object} polygon - Polygon object to draw
     * @param {boolean} isSelected - Whether polygon is the primary selected
     * @param {boolean} isEditMode - Whether in edit mode
     * @param {Object} sharedVerticesManager - Shared vertices manager
     * @param {boolean} isMultiSelected - Whether polygon is in multi-selection set
     * @param {number} polygonIndex - Index of this polygon
     * @param {Object} vertexSelection - Vertex selection manager
     */
    drawPolygon(polygon, isSelected, isEditMode, sharedVerticesManager, isMultiSelected = false, polygonIndex = -1, vertexSelection = null) {
        if (polygon.rings.length === 0) return;

        const exteriorRing = polygon.rings[0];
        if (exteriorRing.length < 3) return;

        // Draw filled polygon
        this.drawPolygonFill(polygon, isSelected, isMultiSelected);

        // Draw polygon outlines and vertices
        if (polygon.layerType === 'county' && polygon.subPolygons) {
            // For county polygons:
            // 1. Draw outer boundary (thick blue)
            polygon.rings.forEach((ring) => {
                if (ring.length < 3) return;
                this.drawRingOutline(ring, isSelected, isMultiSelected, polygon);
            });

            // 2. Draw interior boundaries when selected
            if (isSelected || isMultiSelected) {
                polygon.subPolygons.forEach(subPolygon => {
                    subPolygon.rings.forEach((ring) => {
                        if (ring.length < 3) return;
                        // Draw thin interior lines
                        this.ctx.strokeStyle = 'rgba(100, 100, 100, 0.3)';
                        this.ctx.lineWidth = 1;
                        this.ctx.beginPath();
                        this.drawRingPath(ring);
                        this.ctx.closePath();
                        this.ctx.stroke();
                    });
                });

                // 3. Draw outer boundary vertices (red dots) - shown in both edit and view mode
                polygon.rings.forEach((ring) => {
                    ring.forEach((vertex, vertexIndex) => {
                        // Skip vertex 0 to avoid redundant display (closing vertex = vertex 0)
                        if (vertexIndex === 0) return;

                        const screenPos = this.geometryOps.dataToScreen(vertex.x, vertex.y);

                        // Draw vertex circle
                        this.ctx.fillStyle = '#FF0000';
                        this.ctx.beginPath();
                        this.ctx.arc(screenPos.x, screenPos.y, 4, 0, Math.PI * 2);
                        this.ctx.fill();

                        // Draw white border for visibility
                        this.ctx.strokeStyle = 'white';
                        this.ctx.lineWidth = 2;
                        this.ctx.stroke();

                        // Draw vertex index number if enabled
                        if (this.options.showVertexNumbers) {
                            this.ctx.fillStyle = 'black';
                            this.ctx.font = 'bold 10px Arial';
                            this.ctx.textAlign = 'center';
                            this.ctx.fillText(vertexIndex.toString(), screenPos.x, screenPos.y - 12);
                        }
                    });
                });
            }
        } else {
            // Regular polygon
            polygon.rings.forEach((ring, ringIndex) => {
                if (ring.length < 3) return;

                // Draw ring outline
                this.drawRingOutline(ring, isSelected, isMultiSelected, polygon);

                // Draw vertices in edit mode
                if (isEditMode && isSelected && this.options.showVertices) {
                    this.drawRingVertices(ring, ringIndex, sharedVerticesManager, polygon, polygonIndex, vertexSelection);
                }
            });
        }
    }

    /**
     * Draw polygon fill with holes cut out
     * @param {Object} polygon - Polygon object
     * @param {boolean} isSelected - Whether polygon is primary selected
     * @param {boolean} isMultiSelected - Whether polygon is in multi-selection
     */
    drawPolygonFill(polygon, isSelected, isMultiSelected = false) {
        // Choose fill color: primary selected > multi-selected > layer-specific > normal
        let fillColor = this.options.polygonFillColor;

        // Different colors for different layer types
        if (polygon.layerType === 'county') {
            fillColor = 'rgba(100, 150, 250, 0.15)'; // Blue tint for county layer
        } else if (polygon.layerType === 'subCounty') {
            fillColor = 'rgba(102, 126, 234, 0.05)'; // Very light blue tint for sub-county layer (almost transparent)
        }

        if (isSelected) {
            fillColor = this.options.selectedPolygonFillColor;
        } else if (isMultiSelected) {
            fillColor = 'rgba(255, 200, 100, 0.3)'; // Orange tint for multi-selection
        }

        this.ctx.fillStyle = fillColor;

        // If this is a county polygon with sub-polygons, draw all of them
        if (polygon.layerType === 'county' && polygon.subPolygons) {
            // Draw all sub-polygons that make up this county
            polygon.subPolygons.forEach(subPolygon => {
                subPolygon.rings.forEach((ring, ringIndex) => {
                    if (ringIndex === 0) {
                        // Exterior ring - fill
                        this.ctx.beginPath();
                        this.drawRingPath(ring);
                        this.ctx.closePath();
                        this.ctx.fill();
                    }
                });
            });

            // Cut out holes from all sub-polygons
            this.ctx.globalCompositeOperation = 'destination-out';
            polygon.subPolygons.forEach(subPolygon => {
                for (let ringIndex = 1; ringIndex < subPolygon.rings.length; ringIndex++) {
                    const hole = subPolygon.rings[ringIndex];
                    if (hole.length >= 3) {
                        this.ctx.beginPath();
                        this.drawRingPath(hole);
                        this.ctx.closePath();
                        this.ctx.fill();
                    }
                }
            });
            this.ctx.globalCompositeOperation = 'source-over';
        } else {
            // Regular polygon - draw normally
            const exteriorRing = polygon.rings[0];

            this.ctx.beginPath();
            this.drawRingPath(exteriorRing);
            this.ctx.closePath();
            this.ctx.fill();

            // Cut out holes
            if (polygon.rings.length > 1) {
                this.ctx.globalCompositeOperation = 'destination-out';

                for (let ringIndex = 1; ringIndex < polygon.rings.length; ringIndex++) {
                    const hole = polygon.rings[ringIndex];
                    if (hole.length >= 3) {
                        this.ctx.beginPath();
                        this.drawRingPath(hole);
                        this.ctx.closePath();
                        this.ctx.fill();
                    }
                }

                this.ctx.globalCompositeOperation = 'source-over';
            }
        }
    }

    /**
     * Draw outline of a polygon ring
     * @param {Array<Object>} ring - Ring to draw
     * @param {boolean} isSelected - Whether polygon is primary selected
     * @param {boolean} isMultiSelected - Whether polygon is in multi-selection
     * @param {Object} polygon - Parent polygon object (for layer type)
     */
    drawRingOutline(ring, isSelected, isMultiSelected = false, polygon = null) {
        // Choose stroke color and width
        let strokeColor = this.options.polygonStrokeColor;
        let strokeWidth = this.options.strokeWidth;

        // County layer has thicker borders
        if (polygon && polygon.layerType === 'county') {
            strokeColor = '#4488FF'; // Blue for county borders
            strokeWidth = 3;
        }

        if (isSelected) {
            strokeColor = this.options.selectedPolygonStrokeColor;
            strokeWidth = this.options.selectedStrokeWidth;
        } else if (isMultiSelected) {
            strokeColor = '#FF8C00'; // Dark orange for multi-selection
            strokeWidth = 2.5;
        }

        this.ctx.strokeStyle = strokeColor;
        this.ctx.lineWidth = strokeWidth;

        this.ctx.beginPath();
        this.drawRingPath(ring);
        this.ctx.closePath();
        this.ctx.stroke();
    }

    /**
     * Draw path for a ring (used by fill and stroke operations)
     * @param {Array<Object>} ring - Ring points
     */
    drawRingPath(ring) {
        ring.forEach((point, i) => {
            const screen = this.geometryOps.dataToScreen(point.x, point.y);
            if (i === 0) {
                this.ctx.moveTo(screen.x, screen.y);
            } else {
                this.ctx.lineTo(screen.x, screen.y);
            }
        });
    }

    /**
     * Draw vertices for a ring
     * @param {Array<Object>} ring - Ring points
     * @param {number} ringIndex - Index of the ring (0 = exterior, >0 = holes)
     * @param {Object} sharedVerticesManager - Shared vertices manager
     * @param {Object} polygon - Parent polygon object
     * @param {number} polygonIndex - Index of parent polygon
     * @param {Object} vertexSelection - Vertex selection manager
     */
    drawRingVertices(ring, ringIndex, sharedVerticesManager, polygon, polygonIndex = -1, vertexSelection = null) {
        ring.forEach((point, i) => {
            // Skip vertex 0 to avoid redundant display (closing vertex = vertex 0)
            if (i === 0) return;

            const screen = this.geometryOps.dataToScreen(point.x, point.y);

            // Check if this is a fixed county vertex
            const isFixedVertex = this.fixedCountyVertices && this.fixedCountyVertices.isFixedVertex(point.x, point.y);

            // Determine vertex color based on selection state and fixed status
            let vertexColor;
            const isHole = ringIndex > 0;

            if (isFixedVertex) {
                // Fixed county vertices: Always blue
                vertexColor = '#0066FF'; // Blue for immutable county vertices
            } else if (vertexSelection && polygonIndex >= 0) {
                const isSelected = vertexSelection.isVertexSelected(polygonIndex, ringIndex, i);
                const isNeighboring = vertexSelection.isNeighboringVertex(polygonIndex, ringIndex, i, this.polygons || [polygon]);

                if (isSelected) {
                    // Shift+Click selected vertices: Purple
                    vertexColor = '#800080'; // Purple
                } else if (isNeighboring) {
                    // Neighboring vertices (same coordinates in different polygons): Red
                    vertexColor = '#FF0000'; // Red
                } else {
                    // Normal vertices
                    vertexColor = isHole ? this.options.holeVertexColor : this.options.vertexColor;
                }
            } else {
                vertexColor = isHole ? this.options.holeVertexColor : this.options.vertexColor;
            }

            // Draw vertex circle
            this.ctx.fillStyle = vertexColor;

            this.ctx.beginPath();
            this.ctx.arc(screen.x, screen.y, this.options.vertexSize, 0, Math.PI * 2);
            this.ctx.fill();

            // Draw vertex border (thicker for fixed vertices)
            this.ctx.strokeStyle = 'white';
            this.ctx.lineWidth = isFixedVertex ? 3 : 2;
            this.ctx.stroke();

            // Draw vertex index number
            if (this.options.showVertexNumbers) {
                this.ctx.fillStyle = 'black';
                this.ctx.font = 'bold 10px Arial';
                this.ctx.textAlign = 'center';
                this.ctx.fillText(i.toString(), screen.x, screen.y - 12);
            }

            // Draw fixed vertex indicator
            if (isFixedVertex) {
                this.ctx.fillStyle = '#0066FF';
                this.ctx.font = 'bold 8px Arial';
                this.ctx.fillText('F', screen.x + 10, screen.y - 8);
            }
            // Draw shared vertex indicator (if not fixed)
            else if (this.options.showSharedVertexIndicators && sharedVerticesManager && sharedVerticesManager.isEnabled()) {
                const sharedInfo = sharedVerticesManager.getSharedVertexInfo(point.x, point.y, [polygon]);
                if (sharedInfo.isShared) {
                    this.ctx.fillStyle = this.options.sharedVertexColor;
                    this.ctx.font = 'bold 8px Arial';
                    this.ctx.fillText(`S${sharedInfo.count}`, screen.x + 10, screen.y - 8);
                }
            }
        });
    }


    /**
     * Set rendering options
     * @param {Object} newOptions - Options to update
     */
    setOptions(newOptions) {
        this.options = { ...this.options, ...newOptions };
    }

    /**
     * Get current rendering options
     * @returns {Object} - Current options
     */
    getOptions() {
        return { ...this.options };
    }

    /**
     * Toggle grid visibility
     */
    toggleGrid() {
        this.options.showGrid = !this.options.showGrid;
    }

    /**
     * Toggle vertex visibility
     */
    toggleVertices() {
        this.options.showVertices = !this.options.showVertices;
    }

    /**
     * Toggle vertex numbers
     */
    toggleVertexNumbers() {
        this.options.showVertexNumbers = !this.options.showVertexNumbers;
    }

    /**
     * Toggle polygon labels
     */
    togglePolygonLabels() {
        this.options.showPolygonLabels = !this.options.showPolygonLabels;
    }

    /**
     * Toggle midpoint handles
     */
    toggleMidpointHandles() {
        this.options.showMidpointHandles = !this.options.showMidpointHandles;
    }

    /**
     * Set canvas size and update internal state
     * @param {number} width - New canvas width
     * @param {number} height - New canvas height
     */
    setCanvasSize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
    }

    /**
     * Get canvas dimensions
     * @returns {Object} - Canvas dimensions {width, height}
     */
    getCanvasSize() {
        return {
            width: this.canvas.width,
            height: this.canvas.height
        };
    }
}
