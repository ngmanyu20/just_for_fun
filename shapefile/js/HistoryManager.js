/**
 * HistoryManager - Handles undo/redo with diff-based snapshots.
 *
 * Instead of deep-cloning the entire polygon array on every save, each entry
 * stores only the polygons whose fingerprint changed since the previous save.
 * Full snapshots are kept only at the base of each diff chain (first entry, or
 * after the oldest entry is evicted).  Reconstruction walks the chain forward
 * from the nearest full snapshot.
 *
 * Memory impact at P=10,000 polygons:
 *   Old: every save ≈ 25 MB  →  10 saves = 250 MB
 *   New: split saves ~12 changed polys ≈ 300 KB  →  10 saves ≈ 3 MB + 1 full
 */
class HistoryManager {
    constructor(maxHistorySize = 10) {
        this.history      = [];
        this.historyIndex = -1;
        this.maxHistorySize = maxHistorySize;
        this._prevFps = null; // Map<id, fingerprint> reflecting the last saved state
    }

    // ── Fingerprint ────────────────────────────────────────────────────────

    /**
     * Per-polygon fingerprint — rolling hash over EVERY vertex so any change
     * (including middle-vertex moves from vertex sync/snap) is detected.
     *
     * Previous version only sampled the first and last vertex of the first
     * ring, which missed interior vertex changes and caused undo/redo to
     * restore stale geometry for polygons whose middle vertices had changed.
     */
    _fp(poly) {
        let n = 0, h = 0;
        const rings = poly.rings || [];
        for (const ring of rings) {
            n += ring.length;
            for (let i = 0; i < ring.length; i++) {
                const xi = Math.round(ring[i].x * 1e4);
                const yi = Math.round(ring[i].y * 1e4);
                // Polynomial rolling hash — position-sensitive, fast integer ops
                h = (Math.imul(h, 31) + xi) | 0;
                h = (Math.imul(h, 31) + yi) | 0;
            }
            // Ring-length separator so [A,B]+[C] ≠ [A]+[B,C]
            h = (Math.imul(h, 31) + ring.length) | 0;
        }
        return `${n}|${h >>> 0}|${poly.populationDensity || 0}|${poly.countyType || ''}`;
    }

    // ── Save ───────────────────────────────────────────────────────────────

    saveToHistory(polygons, action = 'Unknown action', vnSnapshot = null) {
        // Discard any forward redo history
        this.history = this.history.slice(0, this.historyIndex + 1);

        const currFps = new Map(polygons.map(p => [p.id, this._fp(p)]));
        const vnClone = vnSnapshot ? JSON.parse(JSON.stringify(vnSnapshot)) : null;

        let entry;
        if (!this._prevFps) {
            // First entry after load/clear → full snapshot
            entry = {
                type:      'full',
                polygons:  JSON.parse(JSON.stringify(polygons)),
                order:     polygons.map(p => p.id),
                action,
                timestamp: Date.now(),
                vnSnapshot: vnClone,
            };
        } else {
            // Subsequent entries → diff (only changed/added polygons)
            const currIds  = new Set(polygons.map(p => p.id));
            const changed  = [];
            for (const p of polygons) {
                if (this._prevFps.get(p.id) !== currFps.get(p.id)) {
                    changed.push(JSON.parse(JSON.stringify(p)));
                }
            }
            const removedIds = [...this._prevFps.keys()].filter(id => !currIds.has(id));

            entry = {
                type:       'diff',
                changed,
                removedIds,
                order:      polygons.map(p => p.id),
                action,
                timestamp:  Date.now(),
                vnSnapshot: vnClone,
            };
        }

        this.history.push(entry);
        this._prevFps = currFps;

        if (this.history.length > this.maxHistorySize) {
            // Promote entry[1] to a full snapshot before evicting entry[0],
            // so the diff chain never loses its base.
            this._promoteToFull(1);
            this.history.shift();
            // historyIndex stays unchanged: it now points to the new entry
            // (which shifted from history.length-1 to history.length-2 then
            //  back to length-1 after shift — net effect: same index, correct entry).
        } else {
            this.historyIndex++;
        }

        console.log(`Saved to history: ${action} (${this.history.length} states, index ${this.historyIndex})`);
    }

    // ── Internal helpers ───────────────────────────────────────────────────

    /** Convert a diff entry at `idx` into a full snapshot in-place. */
    _promoteToFull(idx) {
        if (!this.history[idx] || this.history[idx].type === 'full') return;
        const polygons = this._resolve(idx); // already deep-cloned
        const old = this.history[idx];
        this.history[idx] = {
            type:      'full',
            polygons,
            order:     old.order,
            action:    old.action,
            timestamp: old.timestamp,
            vnSnapshot: old.vnSnapshot,
        };
    }

    /**
     * Reconstruct the full polygon array at history[index].
     * Walks backwards to the nearest full entry, then applies diffs forward.
     * Returns a deep-cloned array safe to hand to callers.
     */
    _resolve(index) {
        const entry = this.history[index];
        if (entry.type === 'full') {
            return entry.polygons.map(p => JSON.parse(JSON.stringify(p)));
        }

        // Find nearest full base
        let base = index - 1;
        while (base >= 0 && this.history[base].type === 'diff') base--;

        if (base < 0) {
            console.warn('HistoryManager._resolve: no full base found');
            return [];
        }

        // Deep-clone base polygons into polyMap so history objects are never
        // reachable from live code — prevents in-place mutations (vertex moves,
        // snap operations) from corrupting stored history during undo/redo.
        const polyMap = new Map(
            this.history[base].polygons.map(p => [p.id, JSON.parse(JSON.stringify(p))])
        );

        // Apply each diff forward
        for (let i = base + 1; i <= index; i++) {
            const d = this.history[i];
            for (const id of d.removedIds)  polyMap.delete(id);
            for (const p  of d.changed)     polyMap.set(p.id, p);
        }

        // Return in the correct order, deep-cloned so callers can mutate freely
        return this.history[index].order
            .map(id => polyMap.get(id))
            .filter(Boolean)
            .map(p => JSON.parse(JSON.stringify(p)));
    }

    /** Resolve + package into the standard return shape. */
    _getEntry(index) {
        const entry    = this.history[index];
        const polygons = this._resolve(index);
        return {
            polygons,
            vnSnapshot: entry.vnSnapshot ? JSON.parse(JSON.stringify(entry.vnSnapshot)) : null,
            action:     entry.action,
            timestamp:  entry.timestamp,
        };
    }

    // ── Public API ─────────────────────────────────────────────────────────

    undo() {
        if (!this.canUndo()) return null;
        this.historyIndex--;
        const result = this._getEntry(this.historyIndex);
        // Keep _prevFps aligned with the restored state so the next save diffs correctly
        this._prevFps = new Map(result.polygons.map(p => [p.id, this._fp(p)]));
        console.log(`Undoing: ${result.action}`);
        return result;
    }

    redo() {
        if (!this.canRedo()) return null;
        this.historyIndex++;
        const result = this._getEntry(this.historyIndex);
        this._prevFps = new Map(result.polygons.map(p => [p.id, this._fp(p)]));
        console.log(`Redoing: ${result.action}`);
        return result;
    }

    canUndo() { return this.historyIndex > 0; }
    canRedo() { return this.historyIndex < this.history.length - 1; }

    getCurrentState() {
        if (this.historyIndex < 0) return null;
        const entry = this.history[this.historyIndex];
        return {
            polygons:  this._resolve(this.historyIndex),
            action:    entry.action,
            timestamp: entry.timestamp,
        };
    }

    getUndoActions() {
        const actions = [];
        for (let i = this.historyIndex - 1; i >= 0; i--) {
            actions.push({
                index:     i,
                action:    this.history[i].action,
                timestamp: this.history[i].timestamp,
                stepsBack: this.historyIndex - i,
            });
        }
        return actions;
    }

    getRedoActions() {
        const actions = [];
        for (let i = this.historyIndex + 1; i < this.history.length; i++) {
            actions.push({
                index:        i,
                action:       this.history[i].action,
                timestamp:    this.history[i].timestamp,
                stepsForward: i - this.historyIndex,
            });
        }
        return actions;
    }

    jumpToHistoryIndex(targetIndex) {
        if (targetIndex < 0 || targetIndex >= this.history.length) return null;
        this.historyIndex = targetIndex;
        const result = this._getEntry(targetIndex);
        this._prevFps = new Map(result.polygons.map(p => [p.id, this._fp(p)]));
        console.log(`Jumped to history index ${targetIndex}: ${result.action}`);
        return result;
    }

    clearHistory() {
        this.history      = [];
        this.historyIndex = -1;
        this._prevFps     = null;
        console.log('History cleared');
    }

    getHistoryStats() {
        return {
            totalStates:      this.history.length,
            currentIndex:     this.historyIndex,
            undoableActions:  this.historyIndex,
            redoableActions:  this.history.length - 1 - this.historyIndex,
            maxHistorySize:   this.maxHistorySize,
            oldestTimestamp:  this.history.length > 0 ? this.history[0].timestamp : null,
            newestTimestamp:  this.history.length > 0 ? this.history[this.history.length - 1].timestamp : null,
        };
    }

    getHistorySummary() {
        return this.history.map((state, index) => ({
            index,
            action:    state.action,
            timestamp: state.timestamp,
            isCurrent: index === this.historyIndex,
            timeAgo:   this.getTimeAgo(state.timestamp),
        }));
    }

    getTimeAgo(timestamp) {
        const diff    = Date.now() - timestamp;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours   = Math.floor(minutes / 60);
        const days    = Math.floor(hours / 24);
        if (days    > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
        if (hours   > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        return `${seconds} second${seconds > 1 ? 's' : ''} ago`;
    }

    createCheckpoint(polygons, checkpointName) {
        this.saveToHistory(polygons, `Checkpoint: ${checkpointName}`);
    }

    findMostRecentCheckpoint() {
        for (let i = this.historyIndex; i >= 0; i--) {
            if (this.history[i].action.startsWith('Checkpoint:')) {
                const polygons = this._resolve(i);
                return {
                    index:     i,
                    polygons,
                    action:    this.history[i].action,
                    timestamp: this.history[i].timestamp,
                };
            }
        }
        return null;
    }

    restoreToCheckpoint() {
        const cp = this.findMostRecentCheckpoint();
        if (cp) {
            this.historyIndex = cp.index;
            this._prevFps = new Map(cp.polygons.map(p => [p.id, this._fp(p)]));
            console.log(`Restored to checkpoint: ${cp.action}`);
            return { polygons: cp.polygons, action: cp.action, timestamp: cp.timestamp };
        }
        return null;
    }

    setMaxHistorySize(maxSize) {
        this.maxHistorySize = Math.max(1, maxSize);
        // Trim oldest entries, promoting any diff that would lose its base
        while (this.history.length > this.maxHistorySize) {
            if (this.history.length >= 2 && this.history[1].type === 'diff') {
                this._promoteToFull(1);
            }
            this.history.splice(0, 1);
            this.historyIndex = Math.max(0, this.historyIndex - 1);
        }
        console.log(`History size limit set to ${this.maxHistorySize}`);
    }

    exportHistory() {
        return {
            history: this.history.map(state => ({
                action:       state.action,
                timestamp:    state.timestamp,
                type:         state.type,
                changedCount: state.type === 'full' ? state.polygons.length : state.changed.length,
            })),
            currentIndex:    this.historyIndex,
            maxHistorySize:  this.maxHistorySize,
            exportTimestamp: Date.now(),
        };
    }
}
