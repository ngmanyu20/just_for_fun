/**
 * GeometryOps - coordinate transforms, bounds, pan/zoom, point-in-polygon hit testing.
 * Convention matches the shapefile-editor project: screenY = offsetY - dataY * scale
 * (data Y grows upward, screen Y grows downward).
 */
class GeometryOps {
    constructor(canvas) {
        this.canvas = canvas;
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this.bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }

    dataToScreen(dataX, dataY) {
        return {
            x: dataX * this.scale + this.offsetX,
            y: this.offsetY - dataY * this.scale
        };
    }

    screenToData(screenX, screenY) {
        return {
            x: (screenX - this.offsetX) / this.scale,
            y: (this.offsetY - screenY) / this.scale
        };
    }

    calculateBounds(polygons) {
        if (polygons.length === 0) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        polygons.forEach(polygon => {
            polygon.rings.forEach(ring => {
                ring.forEach(point => {
                    if (point.x < minX) minX = point.x;
                    if (point.y < minY) minY = point.y;
                    if (point.x > maxX) maxX = point.x;
                    if (point.y > maxY) maxY = point.y;
                });
            });
        });
        this.bounds = { minX, minY, maxX, maxY };
    }

    fitToView() {
        const { minX, minY, maxX, maxY } = this.bounds;
        const dataWidth = maxX - minX || 1;
        const dataHeight = maxY - minY || 1;
        const padding = 40;

        const availableWidth = this.canvas.width - padding * 2;
        const availableHeight = this.canvas.height - padding * 2;

        const scaleX = availableWidth / dataWidth;
        const scaleY = availableHeight / dataHeight;
        this.scale = Math.min(scaleX, scaleY);

        this.offsetX = padding + (availableWidth - dataWidth * this.scale) / 2 - minX * this.scale;
        this.offsetY = padding + (availableHeight - dataHeight * this.scale) / 2 + maxY * this.scale;
    }

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

    applyZoom(mouseX, mouseY, scaleFactor) {
        const newScale = this.scale * scaleFactor;
        if (newScale > 0.05 && newScale < 2000) {
            this.offsetX = mouseX - (mouseX - this.offsetX) * scaleFactor;
            this.offsetY = mouseY - (mouseY - this.offsetY) * scaleFactor;
            this.scale = newScale;
            return true;
        }
        return false;
    }

    applyPan(deltaX, deltaY) {
        this.offsetX += deltaX;
        this.offsetY += deltaY;
    }

    resetTransformation() {
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
    }
}
