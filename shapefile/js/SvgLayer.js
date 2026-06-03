/**
 * SvgLayer — loads an SVG file and draws it as a background layer
 * on the canvas with an independently adjustable transform
 * (position + scale in data-coordinate space) so it can be lined
 * up with loaded polygons before tracing zone boundaries.
 *
 * Transform model
 * ───────────────
 * The SVG top-left corner sits at (anchorX, anchorY) in DATA coordinates.
 * The SVG width in data units is dataWidth; height is derived from the
 * SVG's own aspect ratio.  Changing anchorX/Y shifts the image;
 * changing dataWidth zooms it.
 *
 * When the canvas pans or zooms, geometryOps.dataToScreen() converts
 * these data-space values to screen pixels automatically — the SVG
 * always moves and scales with the polygon layer.
 */
class SvgLayer {
    constructor() {
        this._image     = null;     // HTMLImageElement (rasterised SVG)
        this._objectUrl = null;     // Blob URL — revoked on reload

        // Natural SVG dimensions (from viewBox or width/height attributes)
        this._svgW = 0;
        this._svgH = 0;

        // ── Transform in DATA-coordinate space ──────────────────────────
        this.anchorX   = 0;    // data-x of SVG top-left corner
        this.anchorY   = 0;    // data-y of SVG top-left corner
        this.dataWidth = 100;  // how many data units wide the SVG spans
                               // (height derived from aspect ratio)
        this.opacity   = 0.35;
        this.rotation  = 0;    // clockwise rotation in degrees (0–359)

        this._visible  = false;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Loading
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Load from a File object (from <input type="file"> or drag-drop).
     * Returns Promise<{ width, height }> with the SVG's natural dimensions.
     */
    loadFile(file) {
        return new Promise((resolve, reject) => {
            if (!file) { reject(new Error('No file provided.')); return; }
            if (!file.name.toLowerCase().endsWith('.svg')) {
                reject(new Error('File must be an .svg')); return;
            }

            if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);

            const reader = new FileReader();
            reader.onload = (e) => {
                let svgText = e.target.result;

                // Parse natural dimensions from viewBox or width/height
                const parser = new DOMParser();
                const doc    = parser.parseFromString(svgText, 'image/svg+xml');
                const el     = doc.documentElement;

                // Detect malformed SVG (DOMParser surfaces errors as a <parsererror> element)
                if (el.tagName === 'parsererror' || doc.querySelector('parsererror')) {
                    reject(new Error('SVG file is malformed — check it opens correctly in a browser.'));
                    return;
                }

                const vb     = el.getAttribute('viewBox');
                let w = parseFloat(el.getAttribute('width')  || 0);
                let h = parseFloat(el.getAttribute('height') || 0);
                if (vb) {
                    const p = vb.trim().split(/[\s,]+/).map(Number);
                    if (p.length === 4) { w = p[2]; h = p[3]; }
                }

                // Many SVGs only have a viewBox and no explicit width/height.
                // Browsers load such files as <img> at 0×0 via Blob URL, so the
                // image renders blank.  Inject the dimensions before creating the blob.
                if (w && h) {
                    if (!el.getAttribute('width'))  svgText = svgText.replace(/<svg(\s)/i, `<svg width="${w}"$1`);
                    if (!el.getAttribute('height')) svgText = svgText.replace(/<svg(\s)/i, `<svg height="${h}"$1`);
                }

                const blob = new Blob([svgText], { type: 'image/svg+xml' });
                this._objectUrl = URL.createObjectURL(blob);

                const img = new Image();
                img.onload = () => {
                    this._image  = img;
                    this._svgW   = w || img.naturalWidth  || 500;
                    this._svgH   = h || img.naturalHeight || 500;
                    this._visible = true;
                    resolve({ width: this._svgW, height: this._svgH });
                };
                img.onerror = () => reject(new Error('SVG could not be rendered as image.'));
                img.src = this._objectUrl;
            };
            reader.onerror = () => reject(new Error('File read failed.'));
            reader.readAsText(file);
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Transform helpers
    // ─────────────────────────────────────────────────────────────────────

    /** Aspect ratio of the loaded SVG (width / height). */
    get aspectRatio() {
        return this._svgH > 0 ? this._svgW / this._svgH : 1;
    }

    /** Height in data units derived from dataWidth and the SVG aspect ratio. */
    get dataHeight() {
        return this.aspectRatio > 0 ? this.dataWidth / this.aspectRatio : this.dataWidth;
    }

    /**
     * Auto-fit the SVG to fill a given data-space bounding box.
     * Typically called with the polygon bounds or the current canvas view.
     * @param {{ minX, minY, maxX, maxY }} bounds
     */
    fitToBounds(bounds) {
        if (!bounds) return;
        this.anchorX   = bounds.minX;
        this.anchorY   = bounds.minY;
        this.dataWidth = bounds.maxX - bounds.minX;
    }

    /**
     * Fit to the currently visible canvas area (data coordinates).
     * Call after loading when no polygons are present.
     * @param {GeometryOps} geometryOps
     * @param {HTMLCanvasElement} canvas
     */
    fitToView(geometryOps, canvas) {
        const tl = geometryOps.screenToData(0, 0);
        const br = geometryOps.screenToData(canvas.width, canvas.height);
        // The coordinate system is Y-up, so screen top-left has the MAX data Y
        // and screen bottom-right has the MIN data Y — use Math.min/max to
        // correctly label them regardless of Y direction.
        this.fitToBounds({
            minX: Math.min(tl.x, br.x),
            minY: Math.min(tl.y, br.y),   // was tl.y (HIGH data Y), which placed SVG above canvas
            maxX: Math.max(tl.x, br.x),
            maxY: Math.max(tl.y, br.y),
        });
    }

    /**
     * Convert a screen-pixel point to a fractional position within the SVG image.
     * Used to check whether a screen click is inside the SVG.
     */
    screenHitTest(screenX, screenY, geometryOps) {
        if (!this._image || !this._visible) return false;
        const d = geometryOps.screenToData(screenX, screenY);
        return d.x >= this.anchorX &&
               d.x <= this.anchorX + this.dataWidth &&
               d.y >= this.anchorY &&
               d.y <= this.anchorY + this.dataHeight;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Drawing
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Rotate the SVG by `delta` degrees (positive = clockwise).
     * Keeps the value in [0, 360).
     */
    rotate(delta) {
        this.rotation = ((this.rotation + delta) % 360 + 360) % 360;
    }

    /**
     * Called by Renderer.draw() as the very first layer (below everything).
     * Rotation is applied around the visual centre of the SVG so the image
     * spins in place rather than orbiting the canvas origin.
     * @param {CanvasRenderingContext2D} ctx
     * @param {GeometryOps} geometryOps
     */
    draw(ctx, geometryOps) {
        if (!this._visible || !this._image) return;

        // Screen-pixel rectangle that the unrotated SVG would occupy
        const tl = geometryOps.dataToScreen(this.anchorX,
                                             this.anchorY + this.dataHeight);
        const br = geometryOps.dataToScreen(this.anchorX + this.dataWidth,
                                             this.anchorY);

        const sw = br.x - tl.x;
        const sh = br.y - tl.y;
        if (sw <= 0 || sh <= 0) return;

        // Centre of the SVG in screen space — rotation pivot
        const cx = tl.x + sw / 2;
        const cy = tl.y + sh / 2;

        ctx.save();
        ctx.globalAlpha = this.opacity;

        // Translate to centre → rotate → draw image centred at origin
        ctx.translate(cx, cy);
        ctx.rotate(this.rotation * Math.PI / 180);
        ctx.drawImage(this._image, -sw / 2, -sh / 2, sw, sh);

        ctx.restore();
    }

    // ─────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────

    toggle()         { this._visible = !this._visible; return this._visible; }
    setVisible(v)    { this._visible = !!v; }
    isVisible()      { return this._visible; }
    isLoaded()       { return this._image !== null; }

    clear() {
        this._image    = null;
        this._visible  = false;
        this.rotation  = 0;
        if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
    }
}
