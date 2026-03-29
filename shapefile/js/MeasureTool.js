/**
 * MeasureTool - Google-Maps-style distance measurement
 * Scale: 8.01 coordinate units = 1000 m (1 km)
 */
class MeasureTool {
    constructor() {
        this.active  = false;
        this.points  = [];   // [{x, y}] in data coordinates
        this.METERS_PER_UNIT = 1000 / 8.01;
        this.HIT_RADIUS_PX   = 10; // pixel radius to detect a circle click/drag
    }

    /** Toggle measure mode. Clears points when deactivating. */
    toggle() {
        this.active = !this.active;
        if (!this.active) this.clear();
        return this.active;
    }

    clear() { this.points = []; }

    addPoint(x, y) { this.points.push({ x, y }); }

    movePoint(index, x, y) {
        if (index >= 0 && index < this.points.length) {
            this.points[index] = { x, y };
        }
    }

    removePoint(index) {
        if (index >= 0 && index < this.points.length) {
            this.points.splice(index, 1);
        }
    }

    /**
     * Return the index of the point nearest to (dataX, dataY), or -1 if none
     * within HIT_RADIUS_PX pixels of screen space.
     * @param {number} dataX
     * @param {number} dataY
     * @param {number} scale  - current geometryOps.scale (canvas units per data unit)
     */
    findPointAt(dataX, dataY, scale) {
        const hitRadius = this.HIT_RADIUS_PX / scale;
        for (let i = 0; i < this.points.length; i++) {
            const dx = this.points[i].x - dataX;
            const dy = this.points[i].y - dataY;
            if (Math.sqrt(dx * dx + dy * dy) <= hitRadius) return i;
        }
        return -1;
    }

    /** Distance in metres for segment ending at index i */
    segmentDistanceM(i) {
        if (i < 1 || i >= this.points.length) return 0;
        const dx = this.points[i].x - this.points[i - 1].x;
        const dy = this.points[i].y - this.points[i - 1].y;
        return Math.sqrt(dx * dx + dy * dy) * this.METERS_PER_UNIT;
    }

    /** Accumulated total distance in metres across all segments */
    totalDistanceM() {
        let total = 0;
        for (let i = 1; i < this.points.length; i++) total += this.segmentDistanceM(i);
        return total;
    }

    /** Format metres as a human-readable string */
    formatDistance(metres) {
        if (metres >= 1000) return `${(metres / 1000).toFixed(2)} km`;
        return `${Math.round(metres)} m`;
    }
}
