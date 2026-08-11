/**
 * CampaignTool - Local Campaign data model (Individual/polygon layer only).
 *
 * Six point sets — one per {spectrum} x {type} combo (Left/MR/Right x Canvass/Service) —
 * each an array of {x, y} in data coordinates, placed freehand on the map (not tied to any
 * particular polygon). A hotkey 1-6 "arms" a combo; clicking the map then drops a dot of
 * that combo at the cursor (App.js owns the actual mouse/keyboard wiring — this class is
 * just the model: budgets, costs, hit-testing, and JSON round-trip for campaign.json).
 */
class CampaignTool {
    static SPECTRA = ['Left', 'MR', 'Right'];
    static TYPES = ['Canvass', 'Service'];
    static COST = { Canvass: 5, Service: 10 };

    // Guide-circle radii (km) shown at the cursor while a combo is armed.
    static RADII_KM = {
        Canvass: [{ km: 0.5, color: '#ff9800' }, { km: 1, color: '#ffeb3b' }, { km: 1.5, color: '#4caf50' }],
        Service: [{ km: 1, color: '#ff9800' }, { km: 2, color: '#ffeb3b' }, { km: 3, color: '#4caf50' }]
    };

    static SPECTRUM_COLOR = { Left: '#3b82f6', MR: '#eab308', Right: '#ef4444' };
    // Legible text colour against each spectrum's marker/legend swatch background above.
    static SPECTRUM_TEXT_COLOR = { Left: '#fff', MR: '#000', Right: '#fff' };

    // Digit 1-6 -> combo, in Left/MR/Right x Canvass/Service order.
    static COMBOS = [
        { key: '1', spectrum: 'Left', type: 'Canvass' },
        { key: '2', spectrum: 'Left', type: 'Service' },
        { key: '3', spectrum: 'MR', type: 'Canvass' },
        { key: '4', spectrum: 'MR', type: 'Service' },
        { key: '5', spectrum: 'Right', type: 'Canvass' },
        { key: '6', spectrum: 'Right', type: 'Service' }
    ];

    static comboForHotkey(key) {
        return CampaignTool.COMBOS.find(c => c.key === key) || null;
    }

    static setName(spectrum, type) {
        return `${spectrum}_${type}`;
    }

    constructor() {
        this.active = false;
        this.armed = null; // { spectrum, type } | null
        this.budgets = { Left: 100, MR: 100, Right: 100 }; // total points per spectrum, set via the Rule dialog

        this.points = {};
        CampaignTool.SPECTRA.forEach(s => {
            CampaignTool.TYPES.forEach(t => { this.points[CampaignTool.setName(s, t)] = []; });
        });
    }

    /** Points already spent in a spectrum, summed across both Canvass and Service. */
    usedPoints(spectrum) {
        return CampaignTool.TYPES.reduce((sum, t) => {
            return sum + this.points[CampaignTool.setName(spectrum, t)].length * CampaignTool.COST[t];
        }, 0);
    }

    remainingPoints(spectrum) {
        return this.budgets[spectrum] - this.usedPoints(spectrum);
    }

    canAfford(spectrum, type) {
        return this.remainingPoints(spectrum) >= CampaignTool.COST[type];
    }

    /** @returns {boolean} true if the dot was placed (false = not enough remaining points). */
    addPoint(spectrum, type, x, y) {
        if (!this.canAfford(spectrum, type)) return false;
        this.points[CampaignTool.setName(spectrum, type)].push({ x, y });
        return true;
    }

    /** @returns {{key:string, index:number}|null} the nearest placed dot (any set) within hit range. */
    findPointAt(dataX, dataY, scale) {
        const HIT_RADIUS_PX = 10;
        const hitRadius = HIT_RADIUS_PX / scale;
        for (const key of Object.keys(this.points)) {
            const arr = this.points[key];
            for (let i = 0; i < arr.length; i++) {
                const dx = arr[i].x - dataX, dy = arr[i].y - dataY;
                if (Math.sqrt(dx * dx + dy * dy) <= hitRadius) return { key, index: i };
            }
        }
        return null;
    }

    removePointAt(key, index) {
        if (this.points[key]) this.points[key].splice(index, 1);
    }

    /** campaign.json shape: flat { Left_Canvass: [{x,y},...], Left_Service: [...], ...,
     *  budgets: { Left, MR, Right } } — the point-set arrays plus each spectrum's (political
     *  party's) total point allocation, set via the Rule dialog. */
    toJSON() {
        const out = {};
        Object.keys(this.points).forEach(k => { out[k] = this.points[k].map(p => ({ x: p.x, y: p.y })); });
        out.budgets = { ...this.budgets };
        return out;
    }

    /** Resets all six sets (and budgets back to default), then repopulates whichever ones are
     *  present in obj — so a partial or missing campaign.json (e.g. a fresh folder) still
     *  leaves a clean, editable state. */
    loadFromJSON(obj) {
        CampaignTool.SPECTRA.forEach(s => {
            CampaignTool.TYPES.forEach(t => { this.points[CampaignTool.setName(s, t)] = []; });
            this.budgets[s] = 100;
        });
        if (!obj) return;

        if (obj.budgets && typeof obj.budgets === 'object') {
            CampaignTool.SPECTRA.forEach(s => {
                const v = obj.budgets[s];
                if (typeof v === 'number' && !isNaN(v)) this.budgets[s] = Math.max(0, v);
            });
        }

        Object.keys(this.points).forEach(key => {
            const arr = obj[key];
            if (!Array.isArray(arr)) return;
            this.points[key] = arr
                .filter(p => p && typeof p.x === 'number' && typeof p.y === 'number')
                .map(p => ({ x: p.x, y: p.y }));
        });
    }
}
