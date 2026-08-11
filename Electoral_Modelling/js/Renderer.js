/**
 * Renderer - draws polygons on the canvas. The colour-map / label mechanism below
 * (options, toggle methods, label line-stacking) is ported from shapefile/js/Renderer.js
 * unchanged, minus the Cluster Map / Cluster Label pair (no Clusters column in this CSV)
 * and the Location field (no Location column — the Location Map / Location-Type line
 * are wired up and will start working the moment a Location column exists upstream).
 * District/Zone visibility filtering is done by the caller (App) before draw() is called,
 * same as shapefile's PolygonEditor pre-filtering `visiblePolygons`.
 */
class Renderer {
    constructor(canvas, ctx, geometryOps, config, dataManager) {
        this.canvas = canvas;
        this.ctx = ctx;
        this.geo = geometryOps;
        this.config = config;
        this.dataManager = dataManager; // needed only for the ward Edit Immigrant/Localist colour map

        this.options = {
            showDensityColorMap: false,
            showLocationColorMap: false,   // colour polygons by Location field
            showTypeColorMap: false,       // colour polygons by County_Type code
            showDensityLabel: false,       // master label on/off
            showLocationTypeLabel: false,  // prepend "{Location}: {Type}" line above the value
            densityDisplayMode: 'density', // 'density' | 'estPopulation'
            densityMin: config.renderer.densityMin,
            densityMax: config.renderer.densityMax,
            estPopMin: config.renderer.estPopMin,
            estPopMax: config.renderer.estPopMax,
            wardEditAttr: null, // 'immigrant' | 'localist' | null — takes over the fill colour when set
            winningPerspective: null // { layerKey, column, colors } | null — Constituency/Ward categorical fill, whichever layer is active
        };

        this.defaultFillColor = 'rgba(102, 126, 234, 0.2)';
        this.labelZoomThreshold = 10; // only draw text labels once zoomed in this far
    }

    // ── Colour maps ──────────────────────────────────────────────────────────

    /** Toggle density colour map on/off. Returns new state. (parity with shapefile's Renderer) */
    toggleDensityColorMap() {
        this.options.showDensityColorMap = !this.options.showDensityColorMap;
        return this.options.showDensityColorMap;
    }

    /** Set which value drives the colour map / label: 'density' or 'estPopulation'. */
    setDensityMode(mode) {
        this.options.densityDisplayMode = mode;
    }

    _densityToColor(polygon) {
        const { densityMin: min, densityMax: max } = this.options;
        const val = polygon.populationDensity || 0;
        const t = Math.max(0, Math.min(1, (val - min) / (max - min)));
        const hue = Math.round(210 * (1 - t));
        const sat = Math.round(60 + t * 25);
        const lit = Math.round(78 - t * 32);
        return `hsla(${hue}, ${sat}%, ${lit}%, 0.82)`;
    }

    /** Resolve a fill colour for the polygon's Location field (Inner City/Outer City/...). */
    _locationToColor(polygon) {
        return this.config.locationColors[polygon.location] || null; // null = no override (NA / empty)
    }

    /** Resolve a fill colour for the polygon's County_Type code (A1, F2, UNI, ...). */
    _typeToColor(polygon) {
        const code = (polygon.countyType || '').trim();
        return code ? (this.config.typeColors[code] || null) : null;
    }

    /** Resolve a fill colour for the ward's Edit Immigrant/Localist category (white = unset). */
    _wardEditColor(polygon) {
        const attr = this.options.wardEditAttr;
        const cfg = attr && this.config.wardEdit && this.config.wardEdit[attr];
        if (!cfg || !this.dataManager) return this.defaultFillColor;
        const row = this.dataManager.row('ward', polygon.rowIndex);
        const val = (row && row[cfg.column]) || '';
        return cfg.colors[val] || cfg.colors[''] || this.defaultFillColor;
    }

    /** 1 (red) -> 10 (green) gradient for the Charisma overlay. */
    _charismaToColor(value) {
        const t = Math.max(0, Math.min(1, (value - 1) / 9));
        const hue = Math.round(120 * t);
        return `hsla(${hue}, 70%, 60%, 0.85)`;
    }

    /** Resolve a fill colour for the Winning Perspective category — Constituency or Ward,
     *  whichever layer is active (layerKey travels with the option, set by App). */
    _winningPerspectiveColor(polygon) {
        const wp = this.options.winningPerspective;
        if (!wp || !this.dataManager) return this.defaultFillColor;
        const row = this.dataManager.row(wp.layerKey, polygon.rowIndex);
        const val = (row && row[wp.column]) || '';
        return wp.colors[val] || wp.colors[''] || this.defaultFillColor;
    }

    /** Fill colour priority: charisma > winning-perspective > ward-edit > density > type >
     *  location — mirrors shapefile/js/Renderer.js. */
    fillColorFor(polygon, charismaOverlay) {
        if (charismaOverlay) {
            const val = charismaOverlay.getValue(polygon.rowIndex);
            if (val !== null) return this._charismaToColor(val);
        }
        if (this.options.winningPerspective) return this._winningPerspectiveColor(polygon);
        if (this.options.wardEditAttr) return this._wardEditColor(polygon);
        if (this.options.showDensityColorMap) return this._densityToColor(polygon);
        if (this.options.showTypeColorMap) return this._typeToColor(polygon) || this.defaultFillColor;
        if (this.options.showLocationColorMap) return this._locationToColor(polygon) || this.defaultFillColor;
        return this.defaultFillColor;
    }

    // ── Labels ───────────────────────────────────────────────────────────────

    /** Return the raw value (density or population) used for colouring/labelling. */
    _densityValue(polygon) {
        const density = polygon.populationDensity || 0;
        if (this.options.densityDisplayMode === 'estPopulation') {
            const actual = polygon.population;
            if (!isNaN(actual) && actual > 0) return actual;
            return (polygon.area || 0) * density;
        }
        return density;
    }

    /** Area-weighted (shoelace) centroid of the exterior ring. */
    _ringCentroid(ring) {
        let area = 0, cx = 0, cy = 0;
        const n = ring.length - 1; // last point == first for closed rings
        for (let i = 0; i < n; i++) {
            const cross = ring[i].x * ring[i + 1].y - ring[i + 1].x * ring[i].y;
            area += cross;
            cx += (ring[i].x + ring[i + 1].x) * cross;
            cy += (ring[i].y + ring[i + 1].y) * cross;
        }
        area /= 2;
        if (Math.abs(area) < 1e-12) {
            let sx = 0, sy = 0;
            for (const p of ring) { sx += p.x; sy += p.y; }
            return { x: sx / ring.length, y: sy / ring.length };
        }
        return { x: cx / (6 * area), y: cy / (6 * area) };
    }

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

    /** Horizontal-scan fallback: widest interior chord at each of several scan lines. */
    _interiorPoint(ring) {
        let minY = Infinity, maxY = -Infinity;
        for (const p of ring) {
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
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
                if (w > bestWidth) { bestWidth = w; bestX = (xs[k] + xs[k + 1]) / 2; bestY = scanY; }
            }
        }
        return { x: bestX, y: bestY };
    }

    /** A point guaranteed to be inside the exterior ring (centroid, or scan-line fallback). */
    _labelPoint(ring) {
        const c = this._ringCentroid(ring);
        if (this._pointInRing(c.x, c.y, ring)) return c;
        return this._interiorPoint(ring);
    }

    /** Draw the stacked label (optional Location-Type line + value line) inside the polygon. */
    _drawDensityLabel(polygon) {
        const ring = polygon.rings[0];
        if (!ring || ring.length < 3) return;

        const pt = this._labelPoint(ring);
        const screen = this.geo.dataToScreen(pt.x, pt.y);
        const valueLine = Math.round(this._densityValue(polygon)).toLocaleString();

        const lines = [];
        if (this.options.showLocationTypeLabel) {
            const loc = polygon.location || '';
            const type = polygon.countyType || '';
            const topLine = (loc && type) ? `${loc}: ${type}` : (loc || type || '—');
            lines.push({ text: topLine, role: 'secondary' });
        }
        lines.push({ text: valueLine, role: 'value' });

        const ctx = this.ctx;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';

        const LINE_H = 14;
        const totalH = LINE_H * (lines.length - 1);
        const yStart = screen.y - totalH / 2;

        lines.forEach((line, i) => {
            const y = yStart + i * LINE_H;
            ctx.font = line.role === 'value'
                ? (lines.length > 1 ? 'bold 11px Arial' : 'bold 12px Arial')
                : 'bold 10px Arial';
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 2.5;
            ctx.strokeText(line.text, screen.x, y);
            ctx.fillStyle = 'rgba(0,0,0,0.82)';
            ctx.fillText(line.text, screen.x, y);
        });

        ctx.restore();
    }

    /** Charisma overlay label: "{Constituency_Code}: {value}" centred in the polygon. */
    _drawCharismaLabel(polygon, overlay) {
        const val = overlay.getValue(polygon.rowIndex);
        if (val === null) return;
        const ring = polygon.rings[0];
        if (!ring || ring.length < 3) return;

        const pt = this._labelPoint(ring);
        const screen = this.geo.dataToScreen(pt.x, pt.y);
        const text = `${overlay.getCode(polygon.rowIndex) || ''}: ${val}`;

        const ctx = this.ctx;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.font = 'bold 11px Arial';
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2.5;
        ctx.strokeText(text, screen.x, screen.y);
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.fillText(text, screen.x, screen.y);
        ctx.restore();
    }

    // ── Drawing ──────────────────────────────────────────────────────────────

    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    drawPolygonRing(ring) {
        const ctx = this.ctx;
        ctx.beginPath();
        ring.forEach((pt, i) => {
            const s = this.geo.dataToScreen(pt.x, pt.y);
            if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
    }

    /**
     * @param {Array} polygons - the active layer's entities, pre-filtered by the caller
     *   (Display Region / zone visibility).
     * @param {number|null} selectedRowIndex - rowIndex of the currently selected shape
     *   (within the active layer), or null for no selection.
     * @param {MeasureTool} measureTool
     * @param {Set<number>|null} multiSelected - rowIndices highlighted via lasso drag-select.
     * @param {Array<{x,y}>|null} lassoPath - live lasso outline (screen coords) while dragging.
     * @param {{entities:Array, layerKey:string, overlayCfg:Object|null}|null} borderOverlay -
     *   an extra layer (independent of the active layer) outlined with a thick black border on
     *   top of everything else, e.g. County boundaries shown while Individual is active. When
     *   overlayCfg is set (Ward's ward_immigrant/ward_localists one-hot columns), each border
     *   shape is also tinted by its category value — see _drawBorderOverlay().
     * @param {{points:Object, armed:Object|null, cursorData:Object|null, hoverHit:Object|null,
     *   dataUnitsPerKm:number}|null} campaignOverlay - Local Campaign dots (Individual layer
     *   only) plus the live guide-circle preview at the cursor while a combo is armed — see
     *   _drawCampaignOverlay().
     * @param {{getValue:Function, getCode:Function}|null} charismaOverlay - Constituency layer
     *   only. getValue(rowIndex)/getCode(rowIndex) resolve the active spectrum's charisma value
     *   / Constituency_Code for a shape — drives both fill colour (top priority, see
     *   fillColorFor()) and the "{code}: {value}" label drawn on every shape.
     */
    draw(polygons, selectedRowIndex, measureTool, multiSelected, lassoPath, borderOverlay, campaignOverlay, charismaOverlay) {
        this.clear();
        const ctx = this.ctx;

        for (const polygon of polygons) {
            const isSelected = selectedRowIndex !== null && polygon.rowIndex === selectedRowIndex;
            const isMultiSelected = multiSelected && multiSelected.has(polygon.rowIndex);
            const isHighlighted = isSelected || isMultiSelected;

            ctx.fillStyle = this.fillColorFor(polygon, charismaOverlay);
            ctx.strokeStyle = isHighlighted ? '#333' : 'rgba(60,60,60,0.35)';
            ctx.lineWidth = isHighlighted ? 1.6 : 0.6;

            polygon.rings.forEach((ring, ri) => {
                this.drawPolygonRing(ring);
                if (ri === 0) ctx.fill();
                ctx.stroke();
            });

            if (isHighlighted) {
                ctx.save();
                ctx.fillStyle = this.config.layers.highlightColor;
                polygon.rings.forEach((ring, ri) => { this.drawPolygonRing(ring); if (ri === 0) ctx.fill(); });
                ctx.restore();
            }
        }

        if (borderOverlay && borderOverlay.entities && borderOverlay.entities.length) {
            this._drawBorderOverlay(borderOverlay);
        }

        if (this.options.showDensityLabel && this.geo.scale >= this.labelZoomThreshold) {
            for (const polygon of polygons) this._drawDensityLabel(polygon);
        }

        if (charismaOverlay) {
            for (const polygon of polygons) this._drawCharismaLabel(polygon, charismaOverlay);
        }

        if (campaignOverlay) this._drawCampaignOverlay(campaignOverlay);

        if (measureTool && measureTool.active) this.drawMeasureTool(measureTool);

        if (lassoPath && lassoPath.length > 1) this.drawLasso(lassoPath);
    }

    /** Local Campaign: every placed dot (circle = Canvass, square = Service, coloured by
     *  spectrum), the dot under the cursor highlighted (Delete/Backspace target), and — while a
     *  combo is armed — dashed guide-circles at the cursor showing that type's radii. */
    _drawCampaignOverlay(overlay) {
        const ctx = this.ctx;
        ctx.save();

        const MARKER_HALF = 10; // 2x the original 5px half-size
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 11px Arial';

        Object.keys(overlay.points).forEach(key => {
            const [spectrum, type] = key.split('_');
            const color = CampaignTool.SPECTRUM_COLOR[spectrum] || '#333';
            const letterColor = CampaignTool.SPECTRUM_TEXT_COLOR[spectrum] || '#fff';
            const letter = type === 'Service' ? 'S' : 'C';
            overlay.points[key].forEach((p, idx) => {
                const s = this.geo.dataToScreen(p.x, p.y);
                const isHovered = !!(overlay.hoverHit && overlay.hoverHit.key === key && overlay.hoverHit.index === idx);

                ctx.beginPath();
                if (type === 'Service') {
                    ctx.rect(s.x - MARKER_HALF, s.y - MARKER_HALF, MARKER_HALF * 2, MARKER_HALF * 2);
                } else {
                    ctx.arc(s.x, s.y, MARKER_HALF, 0, Math.PI * 2);
                }
                ctx.fillStyle = color;
                ctx.fill();
                ctx.strokeStyle = isHovered ? '#000' : '#fff';
                ctx.lineWidth = isHovered ? 2.5 : 1.5;
                ctx.stroke();

                ctx.fillStyle = letterColor;
                ctx.fillText(letter, s.x, s.y + 1);
            });
        });

        if (overlay.armed && overlay.cursorData) {
            const rings = CampaignTool.RADII_KM[overlay.armed.type] || [];
            const s = this.geo.dataToScreen(overlay.cursorData.x, overlay.cursorData.y);
            ctx.setLineDash([4, 3]);
            rings.forEach(({ km, color }) => {
                const r = km * overlay.dataUnitsPerKm * this.geo.scale;
                ctx.beginPath();
                ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.stroke();
            });
            ctx.setLineDash([]);
        }

        ctx.restore();
    }

    /** Draws the Border Layer overlay: thick black outline for every shape, optionally tinted
     *  by a one-hot category column (Ward's Edit Immigrant/Localist colours, read-only here). */
    _drawBorderOverlay({ entities, layerKey, overlayCfg }) {
        const ctx = this.ctx;
        ctx.save();
        for (const polygon of entities) {
            polygon.rings.forEach((ring, ri) => {
                this.drawPolygonRing(ring);
                if (ri === 0 && overlayCfg && this.dataManager) {
                    const row = this.dataManager.row(layerKey, polygon.rowIndex);
                    const val = (row && row[overlayCfg.column]) || '';
                    const color = overlayCfg.colors[val] || overlayCfg.colors[''];
                    if (color) {
                        ctx.globalAlpha = 0.5;
                        ctx.fillStyle = color;
                        ctx.fill();
                        ctx.globalAlpha = 1;
                    }
                }
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 3;
                ctx.stroke();
            });
        }
        ctx.restore();
    }

    /** Freehand drag-select overlay — screen-space path, ported from shapefile/js/PolygonEditor.js. */
    drawLasso(lassoPath) {
        const ctx = this.ctx;
        ctx.save();
        ctx.fillStyle = 'rgba(0, 100, 255, 0.08)';
        ctx.strokeStyle = 'rgba(0, 100, 255, 0.85)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(lassoPath[0].x, lassoPath[0].y);
        for (let i = 1; i < lassoPath.length; i++) ctx.lineTo(lassoPath[i].x, lassoPath[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    drawMeasureTool(measureTool) {
        const ctx = this.ctx;
        const pts = measureTool.points.map(p => this.geo.dataToScreen(p.x, p.y));
        if (pts.length === 0) return;

        ctx.save();
        ctx.strokeStyle = '#667eea';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.stroke();
        ctx.setLineDash([]);

        pts.forEach((p, i) => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
            ctx.fillStyle = '#667eea';
            ctx.fill();
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            if (i > 0) {
                const prev = pts[i - 1];
                const mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 };
                const label = measureTool.formatDistance(measureTool.segmentDistanceM(i));
                ctx.font = 'bold 11px Segoe UI, sans-serif';
                const w = ctx.measureText(label).width;
                ctx.fillStyle = 'rgba(255,255,255,0.9)';
                ctx.fillRect(mid.x - w / 2 - 4, mid.y - 9, w + 8, 18);
                ctx.fillStyle = '#333';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, mid.x, mid.y);
            }
        });
        ctx.restore();
    }
}
