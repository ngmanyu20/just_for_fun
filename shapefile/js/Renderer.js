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
            showDensityColorMap: false,
            showLocationColorMap: false,      // colour polygons by Location field
            showTypeColorMap: false,          // colour polygons by Type/Code field
            showDensityLabel: false,
            showLocationTypeLabel: false,     // prepend "{Location}: {Type}" line above the value
            densityDisplayMode: 'density',   // 'density' | 'estPopulation'
            densityMin: 50,
            densityMax: 15000,
            estPopMin: 0,
            estPopMax: 50000,
            gridColor: '#f0f0f0',
            polygonFillColor: 'rgba(102, 126, 234, 0.2)',
            selectedPolygonFillColor: 'rgba(40, 167, 69, 0.3)',
            polygonStrokeColor: '#495057',
            selectedPolygonStrokeColor: '#111111',
            vertexColor: '#dc3545',
            holeVertexColor: '#ffc107',
            sharedVertexColor: '#ff6b35',
            vertexSize: 6,
            strokeWidth: 2,
            selectedStrokeWidth: 4
        };

        // Street layer reference (set via setStreetLayer after generation)
        this.streetLayer = null;

        // SVG background layer reference (set via setSvgLayer)
        this.svgLayer = null;
    }

    /** Attach a StreetLayer instance to be drawn as background. */
    setStreetLayer(streetLayer) {
        this.streetLayer = streetLayer;
    }

    /** Attach an SvgLayer instance to be drawn as the lowest background layer. */
    setSvgLayer(svgLayer) {
        this.svgLayer = svgLayer;
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

        // Draw SVG background layer (lowest — below street layer and polygons)
        if (this.svgLayer) {
            this.svgLayer.draw(this.ctx, this.geometryOps);
        }

        // Draw street layer (background, below grid and polygons)
        if (this.streetLayer) {
            this.streetLayer.draw(this.ctx, this.geometryOps);
        }

        // Draw grid if enabled
        if (this.options.showGrid) {
            this.drawGrid();
        }

        // Draw all non-selected polygons first
        polygons.forEach((polygon, index) => {
            if (index === selectedPolygonIndex) return;
            const isMultiSelected = selectedPolygonIndices && selectedPolygonIndices.has(index);
            this.drawPolygon(polygon, false, isEditMode, sharedVerticesManager, isMultiSelected, index, vertexSelection);
        });

        // Draw selected polygon last so its border/vertices render on top
        if (selectedPolygonIndex !== null && polygons[selectedPolygonIndex]) {
            const isMultiSelected = selectedPolygonIndices && selectedPolygonIndices.has(selectedPolygonIndex);
            this.drawPolygon(polygons[selectedPolygonIndex], true, isEditMode, sharedVerticesManager, isMultiSelected, selectedPolygonIndex, vertexSelection);
        }
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

            // 2. Draw interior sub-polygon boundaries when selected (very subtle)
            if (isSelected || isMultiSelected) {
                polygon.subPolygons.forEach(subPolygon => {
                    subPolygon.rings.forEach((ring) => {
                        if (ring.length < 3) return;
                        this.ctx.strokeStyle = 'rgba(80, 80, 80, 0.12)';
                        this.ctx.lineWidth = 0.5;
                        this.ctx.beginPath();
                        this.drawRingPath(ring);
                        this.ctx.closePath();
                        this.ctx.stroke();
                    });
                });

                // 3. Draw outer boundary vertices (red dots) - shown in both edit and view mode
                polygon.rings.forEach((ring) => {
                    ring.forEach((vertex, vertexIndex) => {
                        // Skip the closing duplicate (last entry repeats vertex 0)
                        if (vertexIndex === ring.length - 1) return;

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

            // Draw density label whenever label display is active (any colour map or none)
            if (this.options.showDensityLabel && polygon.layerType !== 'county') {
                this._drawDensityLabel(polygon);
            }
        }
    }

    /**
     * Area-weighted (shoelace) centroid of the exterior ring.
     * Returns {x, y} in data coordinates.
     */
    _ringCentroid(ring) {
        let area = 0, cx = 0, cy = 0;
        const n = ring.length - 1; // last point == first for closed rings
        for (let i = 0; i < n; i++) {
            const cross = ring[i].x * ring[i + 1].y - ring[i + 1].x * ring[i].y;
            area += cross;
            cx   += (ring[i].x + ring[i + 1].x) * cross;
            cy   += (ring[i].y + ring[i + 1].y) * cross;
        }
        area /= 2;
        if (Math.abs(area) < 1e-12) {
            // Degenerate — fall back to simple average
            let sx = 0, sy = 0;
            for (const p of ring) { sx += p.x; sy += p.y; }
            return { x: sx / ring.length, y: sy / ring.length };
        }
        return { x: cx / (6 * area), y: cy / (6 * area) };
    }

    /** Ray-casting point-in-ring test. */
    _pointInRing(px, py, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i].x, yi = ring[i].y;
            const xj = ring[j].x, yj = ring[j].y;
            if (((yi > py) !== (yj > py)) &&
                (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    /**
     * Horizontal-scan fallback: find the midpoint of the widest interior
     * chord at the vertical centre of the bounding box.
     */
    _interiorPoint(ring) {
        let minY = Infinity, maxY = -Infinity;
        for (const p of ring) {
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
        // Try several horizontal scan lines and pick the widest chord
        const steps = 9;
        let bestX = 0, bestY = (minY + maxY) / 2, bestWidth = -1;
        for (let s = 1; s <= steps; s++) {
            const scanY = minY + (maxY - minY) * s / (steps + 1);
            const xs = [];
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const yi = ring[i].y, yj = ring[j].y;
                if ((yi <= scanY && yj > scanY) || (yj <= scanY && yi > scanY)) {
                    xs.push(ring[i].x + (scanY - yi) / (yj - yi) * (ring[j].x - ring[i].x));
                }
            }
            xs.sort((a, b) => a - b);
            for (let k = 0; k + 1 < xs.length; k += 2) {
                const w = xs[k + 1] - xs[k];
                if (w > bestWidth) {
                    bestWidth = w;
                    bestX = (xs[k] + xs[k + 1]) / 2;
                    bestY = scanY;
                }
            }
        }
        return { x: bestX, y: bestY };
    }

    /**
     * Return a point guaranteed to be inside the exterior ring.
     * Uses area-weighted centroid; falls back to horizontal scan if outside.
     */
    _labelPoint(ring) {
        const c = this._ringCentroid(ring);
        if (this._pointInRing(c.x, c.y, ring)) return c;
        return this._interiorPoint(ring);
    }

    /**
     * Draw a small density number at a point guaranteed inside the polygon.
     */
    _drawDensityLabel(polygon) {
        const ring = polygon.rings[0];
        if (!ring || ring.length < 3) return;

        const pt     = this._labelPoint(ring);
        const screen = this.geometryOps.dataToScreen(pt.x, pt.y);

        const valueLine = Math.round(this._densityValue(polygon)).toLocaleString();

        this.ctx.save();
        this.ctx.textAlign    = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.lineJoin     = 'round';

        if (this.options.showLocationTypeLabel) {
            const loc  = polygon.location    || '';
            const type = polygon.polygonType || '';
            const topLine = (loc && type) ? `${loc}: ${type}` : (loc || type || '—');

            const LINE_H = 14;
            const yTop   = screen.y - LINE_H / 2;
            const yBot   = screen.y + LINE_H / 2;

            // Top line: location & type (smaller)
            this.ctx.font        = 'bold 10px Arial';
            this.ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            this.ctx.lineWidth   = 2.5;
            this.ctx.strokeText(topLine, screen.x, yTop);
            this.ctx.fillStyle   = 'rgba(0,0,0,0.82)';
            this.ctx.fillText(topLine, screen.x, yTop);

            // Bottom line: density / est-pop value
            this.ctx.font        = 'bold 11px Arial';
            this.ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            this.ctx.lineWidth   = 2.5;
            this.ctx.strokeText(valueLine, screen.x, yBot);
            this.ctx.fillStyle   = 'rgba(0,0,0,0.82)';
            this.ctx.fillText(valueLine, screen.x, yBot);
        } else {
            this.ctx.font        = 'bold 12px Arial';
            this.ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            this.ctx.lineWidth   = 2.5;
            this.ctx.strokeText(valueLine, screen.x, screen.y);
            this.ctx.fillStyle   = 'rgba(0,0,0,0.82)';
            this.ctx.fillText(valueLine, screen.x, screen.y);
        }

        this.ctx.restore();
    }

    /** Toggle density colour map on/off. Returns new state. */
    toggleDensityColorMap() {
        this.options.showDensityColorMap = !this.options.showDensityColorMap;
        return this.options.showDensityColorMap;
    }

    /** Set which value drives the colour map: 'density' or 'estPopulation'. */
    setDensityMode(mode) {
        this.options.densityDisplayMode = mode;
    }

    /**
     * Draw polygon fill with holes cut out
     * @param {Object} polygon - Polygon object
     * @param {boolean} isSelected - Whether polygon is primary selected
     * @param {boolean} isMultiSelected - Whether polygon is in multi-selection
     */
    /** Shoelace area in km² for a polygon object. */
    _calcAreaKm2(polygon) {
        const MPU = 1000 / 8.01;
        let areaUnits = 0;
        polygon.rings.forEach((ring, ri) => {
            let a = 0;
            for (let i = 0; i < ring.length - 1; i++)
                a += ring[i].x * ring[i + 1].y - ring[i + 1].x * ring[i].y;
            areaUnits += ri === 0 ? Math.abs(a) / 2 : -Math.abs(a) / 2;
        });
        return areaUnits * MPU * MPU / 1_000_000;
    }

    /** Return the raw value (density or population) used for colouring/labelling. */
    _densityValue(polygon) {
        const density = polygon.populationDensity || 0;
        if (this.options.densityDisplayMode === 'estPopulation') {
            // Prefer actual population from CSV; fall back to area × density estimate
            const actual = polygon.actualPopulation;
            if (!isNaN(actual) && actual > 0) return actual;
            return this._calcAreaKm2(polygon) * density;
        }
        return density;
    }

    /**
     * Map population density to an HSLA colour string.
     * Always uses density (50 light-blue → 15000 red) regardless of sub-mode.
     */
    _densityToColor(polygon) {
        const val = polygon.populationDensity || 0;
        const MIN = this.options.densityMin;
        const MAX = this.options.densityMax;
        const t   = Math.max(0, Math.min(1, (val - MIN) / (MAX - MIN)));
        const hue = Math.round(210 * (1 - t));
        const sat = Math.round(60 + t * 25);
        const lit = Math.round(78 - t * 32);
        return `hsla(${hue}, ${sat}%, ${lit}%, 0.82)`;
    }

    /** Return a fill colour based on the polygon's Location field. */
    _locationToColor(polygon) {
        const LOCATION_COLORS = {
            'Inner City':  'rgba(135, 206, 235, 0.75)',  // shallow blue
            'Outer City':  'rgba(25,  80,  170, 0.72)',  // dark blue
            'Suburb':      'rgba(255, 220,  50, 0.75)',  // yellow
            'Rural':       'rgba(60,  170,  60, 0.72)',  // green
            'Town':        'rgba(255, 120, 110, 0.72)',  // shallow red
        };
        return LOCATION_COLORS[polygon.location] || null; // null = no override (NA / empty)
    }

    _typeToColor(polygon) {
        const code = (polygon.polygonType || '').trim();
        if (!code) return null;  // NA — no colour override

        // Special single codes
        if (code === 'S')    return 'rgba(192, 192, 192, 0.78)'; // Silver
        if (code === 'UNI')  return 'rgba(150, 100, 220, 0.75)'; // Purple
        if (code === 'TECH') return 'rgba(255, 105, 180, 0.75)'; // Pink

        // Letter-group codes (A1/A2, B1/B2, …, F1/F2)
        // _1 = lighter shade, _2 = darker shade, smooth progression across groups
        const TYPE_COLORS = {
            A1: 'rgba(147, 179, 255, 0.72)', A2: 'rgba( 65, 105, 225, 0.80)', // Royal Blue
            B1: 'rgba(100, 160, 255, 0.72)', B2: 'rgba( 25, 100, 200, 0.80)', // Blue
            C1: 'rgba(120, 210, 120, 0.72)', C2: 'rgba( 40, 150,  40, 0.80)', // Green
            D1: 'rgba(255, 235, 100, 0.75)', D2: 'rgba(200, 165,   0, 0.80)', // Yellow
            E1: 'rgba(255, 175,  80, 0.75)', E2: 'rgba(210, 100,  10, 0.80)', // Orange
            F1: 'rgba(195, 145,  95, 0.75)', F2: 'rgba(130,  70,  20, 0.80)', // Brown
        };
        return TYPE_COLORS[code] || null;
    }

    drawPolygonFill(polygon, isSelected, isMultiSelected = false) {
        // Choose fill color: primary selected > multi-selected > density map > layer-specific > normal
        let fillColor = this.options.polygonFillColor;

        // Colour maps: density > type > location (all skip county layer, all skip multi-selected)
        if (this.options.showDensityColorMap && !isMultiSelected
                && polygon.layerType !== 'county') {
            fillColor = this._densityToColor(polygon);
        } else if (this.options.showTypeColorMap && !isMultiSelected
                && polygon.layerType !== 'county') {
            fillColor = this._typeToColor(polygon) || fillColor;
        } else if (this.options.showLocationColorMap && !isMultiSelected
                && polygon.layerType !== 'county') {
            fillColor = this._locationToColor(polygon) || fillColor;
        } else if (polygon.layerType === 'county') {
            fillColor = 'rgba(100, 150, 250, 0.15)';
        } else if (polygon.layerType === 'subCounty') {
            fillColor = 'rgba(102, 126, 234, 0.05)';
        }

        if (isMultiSelected && !isSelected) {
            fillColor = 'rgba(255, 200, 100, 0.3)';
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
            // Skip the closing duplicate (last entry = same coords as index 0).
            // Show vertex 0 explicitly so all 12 unique vertices are labelled 0–11.
            if (i === ring.length - 1) return;

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
