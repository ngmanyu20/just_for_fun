/**
 * CharismaTool - Constituency layer only. Per-spectrum (Left/MR/Right) charisma value
 * (1-10) for every constituency, loaded from charisma.json. The user picks a spectrum,
 * selects exactly 2 constituencies on the map, then presses "S" to swap their charisma
 * values within that spectrum — each spectrum has its own swap budget (Left_swap/MR_swap/
 * Right_swap in the JSON, default 5). Every swap is pushed onto a history stack so any
 * step can be reverted (reverting step i undoes it and everything after it, LIFO) —
 * budgets 5+5+5 cap the stack at 15 entries by construction (undo restores the spent swap).
 */
class CharismaTool {
    static SPECTRA = ['Left', 'MR', 'Right'];
    static SPECTRUM_LABEL = { Left: 'Left', MR: 'Middle Right', Right: 'Right' };
    static SPECTRUM_COLOR = { Left: '#3b82f6', MR: '#eab308', Right: '#ef4444' };
    static DEFAULT_SWAPS = 5;

    constructor() {
        this.active = false;
        this.spectrum = 'Left'; // spectrum currently being viewed/edited

        this.values = { Left: {}, MR: {}, Right: {} };       // code -> 1-10
        this.swapsRemaining = { Left: 5, MR: 5, Right: 5 };
        this.selectedRowIndices = [];                         // up to 2 constituency rowIndex, FIFO once full
        this.history = [];                                    // [{spectrum, codeA, codeB, valA, valB}], oldest first
    }

    /** charisma.json shape: { Left_Charisma: {code: value}, MR_Charisma: {...}, Right_Charisma: {...},
     *  Left_swap: n, MR_swap: n, Right_swap: n }. Resets everything, then repopulates whichever
     *  parts are present — a partial or missing file still leaves a clean, usable state. */
    loadFromJSON(obj) {
        this.values = { Left: {}, MR: {}, Right: {} };
        this.swapsRemaining = { Left: CharismaTool.DEFAULT_SWAPS, MR: CharismaTool.DEFAULT_SWAPS, Right: CharismaTool.DEFAULT_SWAPS };
        this.selectedRowIndices = [];
        this.history = [];
        if (!obj) return;

        CharismaTool.SPECTRA.forEach(s => {
            const values = obj[`${s}_Charisma`];
            if (values && typeof values === 'object') {
                Object.entries(values).forEach(([code, v]) => {
                    const n = Number(v);
                    if (!isNaN(n)) this.values[s][code] = n;
                });
            }
            const swaps = obj[`${s}_swap`];
            if (typeof swaps === 'number' && !isNaN(swaps)) this.swapsRemaining[s] = Math.max(0, swaps);
        });
    }

    toJSON() {
        const out = {};
        CharismaTool.SPECTRA.forEach(s => { out[`${s}_Charisma`] = { ...this.values[s] }; });
        CharismaTool.SPECTRA.forEach(s => { out[`${s}_swap`] = this.swapsRemaining[s]; });
        return out;
    }

    valueFor(spectrum, code) {
        const v = this.values[spectrum] && this.values[spectrum][code];
        return typeof v === 'number' ? v : null;
    }

    selectedSet() {
        return new Set(this.selectedRowIndices);
    }

    /** Click-to-select, capped at 2 — a 3rd click evicts the oldest (FIFO), matching the "pick exactly 2" workflow. */
    toggleSelectRow(rowIndex) {
        const idx = this.selectedRowIndices.indexOf(rowIndex);
        if (idx !== -1) { this.selectedRowIndices.splice(idx, 1); return; }
        if (this.selectedRowIndices.length >= 2) this.selectedRowIndices.shift();
        this.selectedRowIndices.push(rowIndex);
    }

    clearSelection() { this.selectedRowIndices = []; }

    canSwap() {
        return this.selectedRowIndices.length === 2 && this.swapsRemaining[this.spectrum] > 0;
    }

    /** Swaps codeA/codeB's values within the active spectrum. @returns {boolean} success. */
    swap(codeA, codeB) {
        const spectrum = this.spectrum;
        if (this.swapsRemaining[spectrum] <= 0) return false;
        const valA = this.values[spectrum][codeA];
        const valB = this.values[spectrum][codeB];
        if (typeof valA !== 'number' || typeof valB !== 'number') return false;

        this.values[spectrum][codeA] = valB;
        this.values[spectrum][codeB] = valA;
        this.swapsRemaining[spectrum]--;
        this.history.push({ spectrum, codeA, codeB, valA, valB });
        return true;
    }

    canUndo() { return this.history.length > 0; }

    /** Revert history entries from the end down to (and including) index i, newest first (LIFO). @returns {number} entries reverted. */
    revertToStep(i) {
        if (i < 0 || i >= this.history.length) return 0;
        let count = 0;
        while (this.history.length > i) {
            const entry = this.history.pop();
            this.values[entry.spectrum][entry.codeA] = entry.valA;
            this.values[entry.spectrum][entry.codeB] = entry.valB;
            this.swapsRemaining[entry.spectrum]++;
            count++;
        }
        return count;
    }

    undoLast() { return this.revertToStep(this.history.length - 1); }
}
