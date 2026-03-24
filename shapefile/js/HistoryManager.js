/**
 * HistoryManager - Handles undo/redo functionality with state management
 */
class HistoryManager {
    constructor(maxHistorySize = 10) {
        this.history = [];
        this.historyIndex = -1;
        this.maxHistorySize = maxHistorySize;
    }

    /**
     * Save current state to history
     * @param {Array<Object>} polygons - Current polygon data to save
     * @param {string} action - Description of the action being saved
     */
    saveToHistory(polygons, action = 'Unknown action') {
        const currentState = {
            polygons: JSON.parse(JSON.stringify(polygons)),
            action: action,
            timestamp: Date.now()
        };
        
        // Remove any history after current index (when doing new actions after undo)
        this.history = this.history.slice(0, this.historyIndex + 1);
        
        // Add new state
        this.history.push(currentState);
        
        // Maintain maximum history size
        if (this.history.length > this.maxHistorySize) {
            this.history.shift();
        } else {
            this.historyIndex++;
        }
        
        console.log(`Saved to history: ${action} (${this.history.length} states, index ${this.historyIndex})`);
    }

    /**
     * Undo the last action
     * @returns {Object|null} - Previous state or null if can't undo
     */
    undo() {
        if (!this.canUndo()) {
            return null;
        }
        
        this.historyIndex--;
        const previousState = this.history[this.historyIndex];
        
        console.log(`Undoing: ${previousState.action}`);
        return {
            polygons: JSON.parse(JSON.stringify(previousState.polygons)),
            action: previousState.action,
            timestamp: previousState.timestamp
        };
    }

    /**
     * Redo the next action
     * @returns {Object|null} - Next state or null if can't redo
     */
    redo() {
        if (!this.canRedo()) {
            return null;
        }
        
        this.historyIndex++;
        const nextState = this.history[this.historyIndex];
        
        console.log(`Redoing: ${nextState.action}`);
        return {
            polygons: JSON.parse(JSON.stringify(nextState.polygons)),
            action: nextState.action,
            timestamp: nextState.timestamp
        };
    }

    /**
     * Check if undo is possible
     * @returns {boolean} - True if can undo
     */
    canUndo() {
        return this.historyIndex > 0;
    }

    /**
     * Check if redo is possible
     * @returns {boolean} - True if can redo
     */
    canRedo() {
        return this.historyIndex < this.history.length - 1;
    }

    /**
     * Get the current state without changing history position
     * @returns {Object|null} - Current state or null if no history
     */
    getCurrentState() {
        if (this.historyIndex >= 0 && this.historyIndex < this.history.length) {
            const currentState = this.history[this.historyIndex];
            return {
                polygons: JSON.parse(JSON.stringify(currentState.polygons)),
                action: currentState.action,
                timestamp: currentState.timestamp
            };
        }
        return null;
    }

    /**
     * Get information about available undo actions
     * @returns {Array<Object>} - Array of undo-able actions
     */
    getUndoActions() {
        const actions = [];
        for (let i = this.historyIndex - 1; i >= 0; i--) {
            actions.push({
                index: i,
                action: this.history[i].action,
                timestamp: this.history[i].timestamp,
                stepsBack: this.historyIndex - i
            });
        }
        return actions;
    }

    /**
     * Get information about available redo actions
     * @returns {Array<Object>} - Array of redo-able actions
     */
    getRedoActions() {
        const actions = [];
        for (let i = this.historyIndex + 1; i < this.history.length; i++) {
            actions.push({
                index: i,
                action: this.history[i].action,
                timestamp: this.history[i].timestamp,
                stepsForward: i - this.historyIndex
            });
        }
        return actions;
    }

    /**
     * Jump to a specific point in history
     * @param {number} targetIndex - Index to jump to
     * @returns {Object|null} - State at target index or null if invalid
     */
    jumpToHistoryIndex(targetIndex) {
        if (targetIndex >= 0 && targetIndex < this.history.length) {
            this.historyIndex = targetIndex;
            const targetState = this.history[targetIndex];
            
            console.log(`Jumped to history index ${targetIndex}: ${targetState.action}`);
            return {
                polygons: JSON.parse(JSON.stringify(targetState.polygons)),
                action: targetState.action,
                timestamp: targetState.timestamp
            };
        }
        return null;
    }

    /**
     * Clear all history
     */
    clearHistory() {
        this.history = [];
        this.historyIndex = -1;
        console.log('History cleared');
    }

    /**
     * Get statistics about the current history
     * @returns {Object} - History statistics
     */
    getHistoryStats() {
        return {
            totalStates: this.history.length,
            currentIndex: this.historyIndex,
            undoableActions: this.historyIndex,
            redoableActions: this.history.length - 1 - this.historyIndex,
            maxHistorySize: this.maxHistorySize,
            oldestTimestamp: this.history.length > 0 ? this.history[0].timestamp : null,
            newestTimestamp: this.history.length > 0 ? this.history[this.history.length - 1].timestamp : null
        };
    }

    /**
     * Get a summary of all actions in history
     * @returns {Array<Object>} - Summary of all historical actions
     */
    getHistorySummary() {
        return this.history.map((state, index) => ({
            index: index,
            action: state.action,
            timestamp: state.timestamp,
            isCurrent: index === this.historyIndex,
            timeAgo: this.getTimeAgo(state.timestamp)
        }));
    }

    /**
     * Get human-readable time difference
     * @param {number} timestamp - Timestamp to compare
     * @returns {string} - Human-readable time difference
     */
    getTimeAgo(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;
        
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
        if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
        if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        return `${seconds} second${seconds > 1 ? 's' : ''} ago`;
    }

    /**
     * Create a checkpoint with a custom name
     * @param {Array<Object>} polygons - Current polygon data
     * @param {string} checkpointName - Name for this checkpoint
     */
    createCheckpoint(polygons, checkpointName) {
        this.saveToHistory(polygons, `Checkpoint: ${checkpointName}`);
    }

    /**
     * Find the most recent checkpoint
     * @returns {Object|null} - Most recent checkpoint state or null
     */
    findMostRecentCheckpoint() {
        for (let i = this.historyIndex; i >= 0; i--) {
            const state = this.history[i];
            if (state.action.startsWith('Checkpoint:')) {
                return {
                    index: i,
                    polygons: JSON.parse(JSON.stringify(state.polygons)),
                    action: state.action,
                    timestamp: state.timestamp
                };
            }
        }
        return null;
    }

    /**
     * Restore to the most recent checkpoint
     * @returns {Object|null} - Checkpoint state or null if no checkpoint found
     */
    restoreToCheckpoint() {
        const checkpoint = this.findMostRecentCheckpoint();
        if (checkpoint) {
            this.historyIndex = checkpoint.index;
            console.log(`Restored to checkpoint: ${checkpoint.action}`);
            return {
                polygons: checkpoint.polygons,
                action: checkpoint.action,
                timestamp: checkpoint.timestamp
            };
        }
        return null;
    }

    /**
     * Set maximum history size
     * @param {number} maxSize - Maximum number of states to keep
     */
    setMaxHistorySize(maxSize) {
        this.maxHistorySize = Math.max(1, maxSize);
        
        // Trim history if it's now too large
        if (this.history.length > this.maxHistorySize) {
            const trimCount = this.history.length - this.maxHistorySize;
            this.history.splice(0, trimCount);
            this.historyIndex = Math.max(0, this.historyIndex - trimCount);
        }
        
        console.log(`History size limit set to ${this.maxHistorySize}`);
    }

    /**
     * Export history data for analysis or backup
     * @returns {Object} - Complete history export
     */
    exportHistory() {
        return {
            history: this.history.map(state => ({
                action: state.action,
                timestamp: state.timestamp,
                polygonCount: state.polygons.length,
                totalVertices: state.polygons.reduce((sum, p) => 
                    sum + p.rings.reduce((rSum, ring) => rSum + ring.length, 0), 0)
            })),
            currentIndex: this.historyIndex,
            maxHistorySize: this.maxHistorySize,
            exportTimestamp: Date.now()
        };
    }
}