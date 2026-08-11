/**
 * MeasureTool - Google-Maps-style click-to-click distance measurement.
 */
class MeasureTool {
    constructor(metersPerUnit) {
        this.active = false;
        this.points = [];   // [{x, y}] in data coordinates
        this.METERS_PER_UNIT = metersPerUnit || (1000 / 8.01);
        this.HIT_RADIUS_PX = 10; // pixel radius to detect a circle click/drag
    }

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

    findPointAt(dataX, dataY, scale) {
        const hitRadius = this.HIT_RADIUS_PX / scale;
        for (let i = 0; i < this.points.length; i++) {
            const dx = this.points[i].x - dataX;
            const dy = this.points[i].y - dataY;
            if (Math.sqrt(dx * dx + dy * dy) <= hitRadius) return i;
        }
        return -1;
    }

    segmentDistanceM(i) {
        if (i < 1 || i >= this.points.length) return 0;
        const dx = this.points[i].x - this.points[i - 1].x;
        const dy = this.points[i].y - this.points[i - 1].y;
        return Math.sqrt(dx * dx + dy * dy) * this.METERS_PER_UNIT;
    }

    totalDistanceM() {
        let total = 0;
        for (let i = 1; i < this.points.length; i++) total += this.segmentDistanceM(i);
        return total;
    }

    formatDistance(metres) {
        if (metres >= 1000) return `${(metres / 1000).toFixed(2)} km`;
        return `${Math.round(metres)} m`;
    }
}
