/**
 * StreetLayer — Procedural UK-city street map (Bristol / London style)
 *
 * Scale: 8.01 data units = 1 km  (DATA_UNITS_PER_KM)
 *
 * Algorithm:
 *   - Three overlapping irregular grids at independent orientations
 *   - Variable block sizes (tiny / normal / large mixed distribution)
 *   - Hierarchical node snapping: secondary streets snap to main road nodes,
 *     local streets snap to main+secondary nodes — creates T-junctions
 *   - Catmull-Rom splines with bend controlled per layer:
 *       main roads  → nearly straight (bend_km=0.018)
 *       secondary   → gentle curves   (bend_km=0.038)
 *       local       → moderate bends  (bend_km=0.060)
 *   - Road hierarchy: main (near-black bold) → secondary → local (light)
 */
class StreetLayer {
    /** 8.01 data-coordinate units = 1 real-world km. */
    static DATA_UNITS_PER_KM = 8.01;

    constructor() {
        this.visible    = false;
        this.polylines  = null;  // { main:[], secondary:[], local:[] }
        this.bounds     = null;
        this.seed       = 0;
    }

    // ─── Public API ────────────────────────────────────────────────────────

    generate(bounds, seed) {
        this.bounds = { ...bounds };
        this.seed   = (seed !== undefined) ? (seed >>> 0) : this._hashBounds(bounds);

        const rng   = this._makeRng(this.seed);
        const noise = this._makeValueNoise(rng, 256);

        const { minX, minY, maxX, maxY } = bounds;
        const boundsArr = [minX, minY, maxX, maxY];

        // Random base rotation so map never looks axis-aligned
        const ang0 = (rng() - 0.5) * 20;
        const ang1 = ang0 + 28 + rng() * 22;
        const ang2 = ang1 + 22 + rng() * 18;

        // ── Layer 1: Main roads — nearly straight, bold dark ──────────────
        const [main, mainNodes] = this._irregularGrid(boundsArr, noise, rng, {
            meanSpacingKm : 0.28,
            jitterKm      : 0.025,
            angleDeg      : ang0,
            removeProb    : 0.12,
            bendKm        : 0.018,   // nearly straight
            noiseOffset   : 0.0,
            nCtrl         : 3,
            nSamples      : 14,
            snapTo        : null,
            snapDistKm    : 0.0,
        });

        // ── Layer 2: Secondary streets — gentle curves, snap to main nodes ─
        const [secondary, secondaryNodes] = this._irregularGrid(boundsArr, noise, rng, {
            meanSpacingKm : 0.20,
            jitterKm      : 0.045,
            angleDeg      : ang1,
            removeProb    : 0.25,
            bendKm        : 0.038,   // gentle
            noiseOffset   : 800.0,
            nCtrl         : 3,
            nSamples      : 12,
            snapTo        : mainNodes,
            snapDistKm    : 0.045,
        });

        // ── Layer 3: Local streets — moderate bends, snap to main+secondary ─
        const [local] = this._irregularGrid(boundsArr, noise, rng, {
            meanSpacingKm : 0.15,
            jitterKm      : 0.065,
            angleDeg      : ang2,
            removeProb    : 0.38,
            bendKm        : 0.060,   // most organic
            noiseOffset   : 1600.0,
            nCtrl         : 4,
            nSamples      : 14,
            snapTo        : [...mainNodes, ...secondaryNodes],
            snapDistKm    : 0.035,
        });

        this.polylines = { main, secondary, local };
    }

    draw(ctx, geometryOps) {
        if (!this.visible || !this.polylines) return;

        ctx.save();
        ctx.lineCap  = 'round';
        ctx.lineJoin = 'round';

        // Draw light → dark so main roads appear on top
        this._drawPolylines(ctx, geometryOps, this.polylines.local,
            'rgba(192, 184, 168, 0.70)', 0.7);
        this._drawPolylines(ctx, geometryOps, this.polylines.secondary,
            'rgba(136, 128, 112, 0.80)', 1.3);
        this._drawPolylines(ctx, geometryOps, this.polylines.main,
            'rgba(26, 20, 16, 0.95)', 2.4);

        ctx.restore();
    }

    toggle()    { this.visible = !this.visible; return this.visible; }
    isVisible() { return this.visible; }

    // ─── Variable block spacing ─────────────────────────────────────────────

    _randSpacing(meanKm, rng) {
        const K    = StreetLayer.DATA_UNITS_PER_KM;
        const mean = meanKm * K;
        const r    = rng();
        if (r < 0.15) return mean * (0.20 + rng() * 0.30);   // tiny
        if (r < 0.70) return mean * (0.65 + rng() * 0.70);   // normal
        return             mean * (1.30 + rng() * 1.30);      // large
    }

    _makeAxisPositions(span, meanKm, rng) {
        const K     = StreetLayer.DATA_UNITS_PER_KM;
        const extra = meanKm * K * 3;
        const pos   = [0.0];
        while (pos[pos.length - 1] < span + extra) {
            pos.push(pos[pos.length - 1] + this._randSpacing(meanKm, rng));
        }
        return pos;
    }

    // ─── Catmull-Rom road curve ─────────────────────────────────────────────

    _roadCurve(x1, y1, x2, y2, noise, noff, bendKm, nCtrl, nSamples) {
        const K      = StreetLayer.DATA_UNITS_PER_KM;
        const length = Math.hypot(x2 - x1, y2 - y1) || 1e-9;
        const ux = (x2 - x1) / length;
        const uy = (y2 - y1) / length;
        const px = -uy, py = ux;

        const ctrl = [[x1, y1]];
        for (let k = 1; k <= nCtrl; k++) {
            const t  = k / (nCtrl + 1);
            const mx = x1 + t * (x2 - x1);
            const my = y1 + t * (y2 - y1);
            const nx = mx * 5 + noff + k * 47;
            const ny = my * 5 + noff + k * 83 + 100;
            // Single dominant octave + subtle fine detail
            const disp = (noise(nx, ny) * 0.80 + noise(nx * 2.5 + 20, ny * 2.5 + 20) * 0.20)
                         * bendKm * K;
            ctrl.push([mx + px * disp, my + py * disp]);
        }
        ctrl.push([x2, y2]);

        const pts = [];
        const n   = ctrl.length;
        for (let seg = 0; seg < n - 1; seg++) {
            const p0 = ctrl[Math.max(0, seg - 1)];
            const p1 = ctrl[seg];
            const p2 = ctrl[seg + 1];
            const p3 = ctrl[Math.min(n - 1, seg + 2)];
            const steps = Math.max(3, Math.floor(nSamples / (n - 1)));
            const extra = (seg === n - 2) ? 1 : 0;
            for (let i = 0; i <= steps - 1 + extra; i++) {
                const t  = i / steps;
                const t2 = t * t, t3 = t2 * t;
                const bx = 0.5 * ((-p0[0] + 3*p1[0] - 3*p2[0] + p3[0]) * t3
                                + ( 2*p0[0] - 5*p1[0] + 4*p2[0] - p3[0]) * t2
                                + (-p0[0]              + p2[0]           ) * t
                                +   2*p1[0]);
                const by = 0.5 * ((-p0[1] + 3*p1[1] - 3*p2[1] + p3[1]) * t3
                                + ( 2*p0[1] - 5*p1[1] + 4*p2[1] - p3[1]) * t2
                                + (-p0[1]              + p2[1]           ) * t
                                +   2*p1[1]);
                pts.push([bx, by]);
            }
        }
        return pts;
    }

    // ─── Liang-Barsky clipping ───────────────────────────────────────────────

    _clipSeg(x1, y1, x2, y2, xmn, ymn, xmx, ymx) {
        const dx = x2 - x1, dy = y2 - y1;
        let t0 = 0, t1 = 1;
        const tests = [[-dx, x1-xmn], [dx, xmx-x1], [-dy, y1-ymn], [dy, ymx-y1]];
        for (const [p, q] of tests) {
            if (p === 0) { if (q < 0) return null; continue; }
            const t = q / p;
            if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
            else        { if (t < t0) return null; if (t < t1) t1 = t; }
        }
        return [x1 + t0*dx, y1 + t0*dy, x1 + t1*dx, y1 + t1*dy];
    }

    _clipPolyline(pts, xmn, ymn, xmx, ymx) {
        const result = [];
        let current  = [];
        for (let i = 0; i < pts.length - 1; i++) {
            const seg = this._clipSeg(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1],
                                      xmn, ymn, xmx, ymx);
            if (seg) {
                if (!current.length) current.push([seg[0], seg[1]]);
                current.push([seg[2], seg[3]]);
            } else {
                if (current.length >= 2) result.push(current);
                current = [];
            }
        }
        if (current.length >= 2) result.push(current);
        return result;
    }

    // ─── Irregular grid with hierarchical node snapping ─────────────────────

    /**
     * Returns [polylines, nodePositions].
     * nodePositions is passed as snapTo to child layers so their nodes
     * snap onto parent intersections — creating T-junctions.
     */
    _irregularGrid(boundsArr, noise, rng, opts) {
        const K = StreetLayer.DATA_UNITS_PER_KM;
        const [minX, minY, maxX, maxY] = boundsArr;
        const W = maxX - minX, H = maxY - minY;
        const { meanSpacingKm, jitterKm, angleDeg, removeProb,
                bendKm, noiseOffset, nCtrl, nSamples, snapTo, snapDistKm } = opts;
        const jit      = jitterKm * K;
        const snapDist = snapDistKm * K;
        const angle    = angleDeg * Math.PI / 180;
        const ca = Math.cos(angle), sa = Math.sin(angle);
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const diag = Math.hypot(W, H) * 0.6 + meanSpacingKm * K * 2;

        let xPos = this._makeAxisPositions(diag * 2, meanSpacingKm, rng).map(v => v - diag);
        let yPos = this._makeAxisPositions(diag * 2, meanSpacingKm, rng).map(v => v - diag);

        const world = (lx, ly) => [
            cx + lx * ca - ly * sa,
            cy + lx * sa + ly * ca,
        ];

        const rows = yPos.length, cols = xPos.length;
        const pts  = new Array(rows * cols);

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const [wx, wy] = world(xPos[c], yPos[r]);
                const nx = (wx - minX) / W * 6 + noiseOffset;
                const ny = (wy - minY) / H * 6 + noiseOffset + 300;
                let fx = wx + (noise(nx, ny) * 0.6 + noise(nx*3+50,  ny*3+50 ) * 0.4) * jit;
                let fy = wy + (noise(nx+200, ny) * 0.6 + noise(nx*3+250, ny*3+250) * 0.4) * jit;

                // Hierarchical snap — lock to nearest parent node if close enough
                if (snapTo && snapDist > 0) {
                    let bestD = snapDist, bestX = fx, bestY = fy;
                    for (const [sx, sy] of snapTo) {
                        const d = Math.hypot(fx - sx, fy - sy);
                        if (d < bestD) { bestD = d; bestX = sx; bestY = sy; }
                    }
                    fx = bestX; fy = bestY;
                }

                pts[r * cols + c] = [fx, fy];
            }
        }

        const polylines = [];

        const addEdge = (k1, k2) => {
            if (rng() <= removeProb) return;
            const [ax, ay] = pts[k1];
            const [bx, by] = pts[k2];
            if (Math.hypot(ax - bx, ay - by) < 0.5) return; // degenerate
            const curve = this._roadCurve(ax, ay, bx, by, noise,
                                           noiseOffset + 700, bendKm, nCtrl, nSamples);
            for (const pl of this._clipPolyline(curve, minX, minY, maxX, maxY)) {
                polylines.push(pl);
            }
        };

        for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols - 1; c++)
                addEdge(r * cols + c, r * cols + c + 1);

        for (let r = 0; r < rows - 1; r++)
            for (let c = 0; c < cols; c++)
                addEdge(r * cols + c, (r + 1) * cols + c);

        return [polylines, pts];
    }

    // ─── Rendering ──────────────────────────────────────────────────────────

    _drawPolylines(ctx, geometryOps, polylines, color, lineWidth) {
        ctx.strokeStyle = color;
        ctx.lineWidth   = lineWidth;
        ctx.beginPath();
        for (const pl of polylines) {
            let first = true;
            for (const [dx, dy] of pl) {
                const s = geometryOps.dataToScreen(dx, dy);
                if (first) { ctx.moveTo(s.x, s.y); first = false; }
                else          ctx.lineTo(s.x, s.y);
            }
        }
        ctx.stroke();
    }

    // ─── Seeded PRNG (Mulberry32) ────────────────────────────────────────────

    _makeRng(seed) {
        let s = seed >>> 0;
        return () => {
            s = (s + 0x6D2B79F5) >>> 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t     = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
        };
    }

    // ─── Value noise (bilinear, smoothstep) ──────────────────────────────────

    _makeValueNoise(rng, size) {
        const grid = new Float32Array(size * size);
        for (let i = 0; i < grid.length; i++) grid[i] = rng() * 2 - 1;
        const mask   = size - 1;
        const smooth = t => t * t * (3 - 2 * t);
        return (x, y) => {
            const xi  = Math.floor(x) & mask;
            const yi  = Math.floor(y) & mask;
            const u   = smooth(x - Math.floor(x));
            const v   = smooth(y - Math.floor(y));
            const a   = grid[  yi            * size +   xi            ];
            const b   = grid[  yi            * size + ((xi+1) & mask) ];
            const c   = grid[((yi+1) & mask) * size +   xi            ];
            const d   = grid[((yi+1) & mask) * size + ((xi+1) & mask) ];
            return a + u*(b-a) + v*(c-a) + u*v*(a-b-c+d);
        };
    }

    _hashBounds(b) {
        return ((b.minX * 1000 + b.maxX * 997 + b.minY * 991 + b.maxY * 983) | 0) >>> 0;
    }
}
