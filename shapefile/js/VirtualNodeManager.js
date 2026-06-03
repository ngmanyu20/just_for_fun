/**
 * VirtualNodeManager — temporary "virtual nodes" for drawing a free-form cut
 * line through a polygon before executing a split.
 *
 * Virtual nodes exist only in memory and are NEVER saved to any CSV or
 * inserted into a polygon ring directly.  They are cleared when the split
 * executes or when the user exits virtual-node mode.
 *
 * Placement order is preserved so consecutive nodes form a directed polyline
 * that defines the intended cut direction.
 *
 * Selection order is tracked separately: getSelected() returns nodes in the
 * order they were shift-clicked, so alignX/Y use the first-clicked node as
 * the reference — not the first-placed node.
 */
class VirtualNodeManager {
    constructor() {
        this._nodes        = [];   // [{id, x, y, selected}]  — in placement order
        this._nextId       = 0;
        this._selectionOrder = []; // node IDs in the order they were selected
    }

    // ─────────────────────────────────────────────────────────────────────
    // Accessors
    // ─────────────────────────────────────────────────────────────────────

    /** All nodes in placement order (read-only array reference — do not mutate). */
    get nodes() { return this._nodes; }

    /** Total node count. */
    get count() { return this._nodes.length; }

    // ─────────────────────────────────────────────────────────────────────
    // Placement
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Append a new node at (x, y) in data coordinates.
     * @returns {Object} the newly created node
     */
    add(x, y) {
        const node = { id: this._nextId++, x, y, selected: false };
        this._nodes.push(node);
        return node;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Selection
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Toggle selection of the node with the given id.
     * Maintains _selectionOrder so getSelected() reflects click order.
     * @returns {boolean} new selected state
     */
    toggleSelect(id) {
        const node = this._nodes.find(n => n.id === id);
        if (!node) return false;
        node.selected = !node.selected;
        if (node.selected) {
            if (!this._selectionOrder.includes(id)) {
                this._selectionOrder.push(id);
            }
        } else {
            this._selectionOrder = this._selectionOrder.filter(x => x !== id);
        }
        return node.selected;
    }

    /** Deselect all nodes. */
    clearSelection() {
        this._nodes.forEach(n => { n.selected = false; });
        this._selectionOrder = [];
    }

    /** Return all currently selected nodes in SELECTION order (click order, not placement order). */
    getSelected() {
        return this._selectionOrder
            .map(id => this._nodes.find(n => n.id === id))
            .filter(Boolean);
    }

    /** Number of currently selected nodes. */
    getSelectedCount() { return this._selectionOrder.length; }

    // ─────────────────────────────────────────────────────────────────────
    // Hit testing
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Find the nearest node within `toleranceData` data-coordinate units of (dataX, dataY).
     * @returns {Object|null} the nearest node or null if none within tolerance
     */
    findNearest(dataX, dataY, toleranceData) {
        let best = null, bestDist = Infinity;
        for (const node of this._nodes) {
            const dx = node.x - dataX, dy = node.y - dataY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < toleranceData && dist < bestDist) {
                bestDist = dist;
                best = node;
            }
        }
        return best;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Editing operations (mirror the real-vertex keyboard shortcuts)
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Delete all currently selected nodes.
     * @returns {number} count of removed nodes
     */
    removeSelected() {
        const before = this._nodes.length;
        this._nodes = this._nodes.filter(n => !n.selected);
        this._selectionOrder = []; // deleted nodes are gone; clear the order
        return before - this._nodes.length;
    }

    /**
     * Create a midpoint node between the two selected nodes and insert it
     * between them in the placement order.
     * @returns {Object|null} the new midpoint node, or null if exactly 2 are not selected
     */
    createMidpointBetweenSelected() {
        const sel = this.getSelected();
        if (sel.length !== 2) return null;

        const [a, b] = sel;
        const mid = { id: this._nextId++, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, selected: false };

        // Insert between the two source nodes in placement order
        const iA = this._nodes.indexOf(a);
        const iB = this._nodes.indexOf(b);
        this._nodes.splice(Math.min(iA, iB) + 1, 0, mid);
        return mid;
    }

    /**
     * Align all selected nodes to the X-coordinate of the FIRST selected node
     * (first in click/selection order, not placement order).
     * @returns {boolean} true if any node was moved
     */
    alignX() {
        const sel = this.getSelected();
        if (sel.length < 2) return false;
        const targetX = sel[0].x;
        let moved = false;
        sel.slice(1).forEach(n => {
            if (Math.abs(n.x - targetX) > 1e-9) { n.x = targetX; moved = true; }
        });
        return moved;
    }

    /**
     * Align all selected nodes to the Y-coordinate of the FIRST selected node
     * (first in click/selection order, not placement order).
     * @returns {boolean} true if any node was moved
     */
    alignY() {
        const sel = this.getSelected();
        if (sel.length < 2) return false;
        const targetY = sel[0].y;
        let moved = false;
        sel.slice(1).forEach(n => {
            if (Math.abs(n.y - targetY) > 1e-9) { n.y = targetY; moved = true; }
        });
        return moved;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────

    /** Remove all nodes and reset state. */
    clear() {
        this._nodes = [];
        this._selectionOrder = [];
    }

    // ─────────────────────────────────────────────────────────────────────
    // Snapshot support for undo/redo
    // ─────────────────────────────────────────────────────────────────────

    /** Return a deep-cloneable snapshot of the current VN state. */
    getSnapshot() {
        return {
            nodes: this._nodes.map(n => ({ ...n })),
            nextId: this._nextId,
            selectionOrder: this._selectionOrder.slice()
        };
    }

    /** Restore VN state from a snapshot produced by getSnapshot(). */
    loadSnapshot(snapshot) {
        this._nodes = snapshot.nodes.map(n => ({ ...n }));
        this._nextId = snapshot.nextId;
        this._selectionOrder = snapshot.selectionOrder.slice();
    }
}
