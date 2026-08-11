/**
 * App - main controller: wires up canvas interaction (pan/zoom/click/lasso-select/measure),
 * the toolbar (load/save the 4-file folder, layer FAB, Display Region, Display Mode,
 * measure), and the per-shape custom parameter editor.
 *
 * Each of the 4 modelling layers is backed by its OWN shapefile (its own CSV,
 * loaded from a single folder): df_constituency.csv, df_county.csv,
 * df_districts.csv (ward), df_polygon.csv (individual). The layer FAB switches
 * which of these four is currently rendered — see DataManager.js for the load/
 * export side and config/config.json's "datasets" block for the per-layer schema.
 *
 * The Display Region modal, the Display Mode colour-map/label buttons, and the
 * lasso drag-select are ported from shapefile/js/app.js + Renderer.js + MouseHandler.js
 * with no mechanism changes — see _setupDisplayRegionModal(), _setLabelMode() and
 * _handleLassoSelect() below.
 *
 * Exposes `window.ElectoralApp` so display.html (opened via window.open) can
 * poll live state the same way the shapefile project's display.html does.
 */
class ElectoralModellingApp {
    constructor(config) {
        this.config = config;

        this.canvas = document.getElementById('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.canvasContainer = document.getElementById('canvasContainer');

        this.dataManager = new DataManager(config);
        this.geo = new GeometryOps(this.canvas);
        this.renderer = new Renderer(this.canvas, this.ctx, this.geo, config, this.dataManager);
        this.measureTool = new MeasureTool(1000 / config.scale.dataUnitsPerKm);
        this.campaignTool = new CampaignTool();
        this._campaignMouseData = null; // {x,y} data coords of the cursor, while campaign mode is active — drives the guide-circle preview
        this._campaignHoverHit = null;  // {key,index}|null — nearest existing dot under the cursor, for Delete/Backspace removal
        this.campaignHoverEntity = null; // individual-layer entity under the cursor while Local Campaign mode is active — display.html polls this for instant hover-follow (see _onMouseMove)

        this.charismaTool = new CharismaTool();

        this.activeLayer = config.layers.default;
        this.selectedRowIndex = null;       // rowIndex within the active layer's dataset
        this.selectedEntity = null;         // cached entity object for the current single selection
        this.multiSelectedRowIndices = new Set(); // rowIndices highlighted via lasso drag-select or Ctrl+Click

        // Ward-only Edit Immigrant/Edit Localist mode — see _toggleWardEdit()/_applyWardEditHotkey().
        this.activeWardEditAttr = null; // 'immigrant' | 'localist' | null
        this._wardEditVersion = 0;      // bumped on every hotkey edit so display.html can detect dataset-wide changes

        // Winning Perspectives — Constituency AND Ward layers (whichever is active). Select
        // shape(s) the normal way, then press 0-4 to write a value into the Winning_Perspective
        // column on that layer's own CSV. See _toggleWinningPerspective()/_applyWinningPerspectiveHotkey().
        this.winningPerspectiveActive = false;

        // Border Layer — an extra layer (any of the 4, independent of activeLayer) outlined with
        // a thick black border on top of whatever is currently rendered, e.g. show County
        // boundaries while browsing the Individual layer. See _setupBorderLayerControls().
        this.borderLayer = null;        // 'constituency' | 'county' | 'ward' | 'individual' | null
        this.borderOverlayAttr = null;  // 'immigrant' | 'localist' | null — only used when borderLayer === 'ward'

        // Display-only groupings for the Location/Type Breakdown panel — display.html reads AND
        // writes this directly (it's the same live object via window.opener), under its collapsible
        // "Default Setting" section. E.g. a "D1+E2" group combines those two Type codes into one
        // summed row. Never touches any data or the exported CSVs.
        this.categoryGroups = { location: [], type: [] };

        // Region -> Zone visibility filter, kept per layer (each has its own zone vocabulary).
        // Value is a Set of zone values (or region values when the layer has no zoneColumn), or null = all visible.
        this.zoneFilters = {};
        config.layers.options.forEach(k => { this.zoneFilters[k] = null; });

        this._panState = null;
        this._measureDrag = null;
        this._pendingOrigin = null; // {clientX, clientY, screenX, screenY, offsetX, offsetY} while a click/pan/lasso gesture is unresolved
        this._pendingTimer = null;
        this._lasso = null;         // { path: [{x,y}, ...] } screen coords, while actively lasso-dragging

        this._bindUI();
        this._bindCanvasEvents();
        this._resizeCanvas();
        window.addEventListener('resize', () => { this._resizeCanvas(); this.redraw(); });

        window.ElectoralApp = this; // for display.html polling

        this._tryLoadDefault();
    }

    // ── Bootstrapping ───────────────────────────────────────────────────────

    async _tryLoadDefault() {
        const dir = this.config.defaultDataDir;
        if (!dir) return;
        try {
            const sourceMap = {};
            for (const key of this.config.layers.options) {
                sourceMap[key] = `${dir}/${this.config.datasets[key].file}`;
            }
            const result = await this.dataManager.loadAll(sourceMap);
            await this._tryLoadDefaultCampaign(dir);
            await this._tryLoadDefaultCharisma(dir);
            this._afterLoad();
            const total = Object.values(result).reduce((s, r) => s + r.count, 0);
            this._setStatus(`Loaded default dataset · ${total.toLocaleString()} shapes across 4 layers`);
        } catch (err) {
            this._setStatus('Load a folder to begin (Load Folder button).', false);
            console.warn('Default directory auto-load skipped:', err.message);
        }
    }

    /** Best-effort load of campaign.json alongside the default dataset — missing file is fine (fresh start). */
    async _tryLoadDefaultCampaign(dir) {
        try {
            const res = await fetch(`${dir}/campaign.json`);
            this.campaignTool.loadFromJSON(res.ok ? await res.json() : null);
        } catch (err) {
            this.campaignTool.loadFromJSON(null);
        }
    }

    /** Best-effort load of charisma.json alongside the default dataset — missing file is fine (fresh start). */
    async _tryLoadDefaultCharisma(dir) {
        try {
            const res = await fetch(`${dir}/charisma.json`);
            this.charismaTool.loadFromJSON(res.ok ? await res.json() : null);
        } catch (err) {
            this.charismaTool.loadFromJSON(null);
        }
    }

    /** @param {File[]} files - every file the browser found under the picked folder. */
    async _loadDirectory(files) {
        const byName = new Map(files.map(f => [f.name.toLowerCase(), f]));
        const sourceMap = {};
        const missing = [];
        for (const key of this.config.layers.options) {
            const fname = this.config.datasets[key].file.toLowerCase();
            const f = byName.get(fname);
            if (!f) missing.push(this.config.datasets[key].file);
            else sourceMap[key] = f;
        }
        if (missing.length) {
            throw new Error(`Selected folder is missing: ${missing.join(', ')}`);
        }
        const result = await this.dataManager.loadAll(sourceMap);

        const campaignFile = byName.get('campaign.json');
        if (campaignFile) {
            try {
                this.campaignTool.loadFromJSON(JSON.parse(await campaignFile.text()));
            } catch (err) {
                console.warn('Failed to parse campaign.json — starting Local Campaign fresh:', err.message);
                this.campaignTool.loadFromJSON(null);
            }
        } else {
            this.campaignTool.loadFromJSON(null);
        }

        const charismaFile = byName.get('charisma.json');
        if (charismaFile) {
            try {
                this.charismaTool.loadFromJSON(JSON.parse(await charismaFile.text()));
            } catch (err) {
                console.warn('Failed to parse charisma.json — starting Charisma fresh:', err.message);
                this.charismaTool.loadFromJSON(null);
            }
        } else {
            this.charismaTool.loadFromJSON(null);
        }

        this._afterLoad();
        return result;
    }

    _afterLoad() {
        // Union bounds across all 4 layers so switching layers doesn't jump the view.
        const allEntities = this.config.layers.options.flatMap(k => this.dataManager.entities(k));
        this.geo.calculateBounds(allEntities);
        this.geo.fitToView();

        this.config.layers.options.forEach(k => { this.zoneFilters[k] = null; });
        this.selectedRowIndex = null;
        this.selectedEntity = null;
        this.multiSelectedRowIndices.clear();
        this.renderer.labelZoomThreshold = this.config.datasets[this.activeLayer].labelZoomThreshold;
        this._resetRegionButtonLabel();
        this._updatePopulationBtnLabel();
        this._updateDisplayModeAvailability();
        this._updateWardEditAvailability();
        this._updateCampaignAvailability();
        this._updateCampaignPointsTable();
        this._updateCharismaAvailability();
        this._updateCharismaPanel();
        this._updateWinningPerspectiveAvailability();
        this.redraw();
    }

    _resizeCanvas() {
        const rect = this.canvasContainer.getBoundingClientRect();
        this.canvas.width = Math.max(200, Math.floor(rect.width));
        this.canvas.height = Math.max(200, Math.floor(rect.height));
    }

    /** True if the active layer's dataset has a real Zone column (drives the region-modal shape). */
    _hasZoneColumn() {
        return !!this.config.datasets[this.activeLayer].zoneColumn;
    }

    /** Entities of any layer, filtered by that layer's own Display Region selection. */
    _visibleEntitiesFor(layerKey) {
        const all = this.dataManager.entities(layerKey);
        const filter = this.zoneFilters[layerKey];
        if (!filter) return all;
        const field = this.config.datasets[layerKey].zoneColumn ? 'zone' : 'region';
        return all.filter(p => filter.has(p[field]));
    }

    /** Entities of the active layer, filtered by that layer's Display Region selection. */
    visiblePolygons() {
        return this._visibleEntitiesFor(this.activeLayer);
    }

    /** Border Layer overlay descriptor for the renderer, or null when none is selected. */
    _borderOverlayState() {
        if (!this.borderLayer) return null;
        return {
            entities: this._visibleEntitiesFor(this.borderLayer),
            layerKey: this.borderLayer,
            overlayCfg: (this.borderLayer === 'ward' && this.borderOverlayAttr)
                ? this.config.wardEdit[this.borderOverlayAttr] : null
        };
    }

    /** Local Campaign overlay descriptor for the renderer, or null while the mode is off. */
    _campaignOverlayState() {
        if (!this.campaignTool.active) return null;
        return {
            points: this.campaignTool.points,
            armed: this.campaignTool.armed,
            cursorData: this._campaignMouseData,
            hoverHit: this._campaignHoverHit,
            dataUnitsPerKm: this.config.scale.dataUnitsPerKm
        };
    }

    /** Charisma overlay descriptor for the renderer (Constituency layer only), or null while the mode is off. */
    _charismaOverlayState() {
        if (!this.charismaTool.active) return null;
        const spectrum = this.charismaTool.spectrum;
        return {
            getValue: (rowIndex) => {
                const row = this.dataManager.row('constituency', rowIndex);
                return row ? this.charismaTool.valueFor(spectrum, row.Constituency_Code) : null;
            },
            getCode: (rowIndex) => {
                const row = this.dataManager.row('constituency', rowIndex);
                return row ? row.Constituency_Code : '';
            }
        };
    }

    /** Shape highlight set: the Charisma 2-slot selection while that mode is active, else the normal lasso/Ctrl+Click multi-selection. */
    _currentMultiSelected() {
        return this.charismaTool.active ? this.charismaTool.selectedSet() : this.multiSelectedRowIndices;
    }

    redraw() {
        const lassoPath = this._lasso ? this._lasso.path : null;
        this.renderer.draw(
            this.visiblePolygons(), this.selectedRowIndex, this.measureTool, this._currentMultiSelected(),
            lassoPath, this._borderOverlayState(), this._campaignOverlayState(), this._charismaOverlayState()
        );
    }

    _setStatus(text, isError) {
        const el = document.getElementById('status');
        el.textContent = text;
        el.style.background = isError ? '#dc3545' : '#28a745';
        el.style.display = 'block';
        clearTimeout(this._statusTimer);
        this._statusTimer = setTimeout(() => { el.style.display = 'none'; }, 4500);
    }

    // ── UI wiring ────────────────────────────────────────────────────────────

    _bindUI() {
        document.getElementById('csvDirInput').addEventListener('change', async (e) => {
            const files = Array.from(e.target.files || []);
            if (!files.length) return;
            try {
                const result = await this._loadDirectory(files);
                const total = Object.values(result).reduce((s, r) => s + r.count, 0);
                this._setStatus(`Loaded folder · ${total.toLocaleString()} shapes across 4 layers`);
            } catch (err) {
                this._setStatus(err.message, true);
            }
            e.target.value = '';
        });
        document.getElementById('loadCsvBtn').addEventListener('click', () => {
            document.getElementById('csvDirInput').click();
        });

        document.getElementById('saveCsvBtn').addEventListener('click', () => this._openSaveFilesModal());

        this._setupLayerFab();
        this._setupSaveFilesModal();
        this._setupDisplayRegionModal();
        this._setupDisplayModeCollapse();
        this._setupDisplayModeButtons();
        this._setupBorderLayerControls();

        // Measure tool
        document.getElementById('measureBtn').addEventListener('click', () => this._toggleMeasure());

        this._setupCampaignTool();
        this._setupCharismaTool();

        // Companion display window
        document.getElementById('displayBtn').addEventListener('click', () => {
            window.open('display.html', 'electoralDisplayWindow', 'width=360,height=760,left=100,top=100');
        });

        this._setupWardEditButtons();
        this._setupWinningPerspectiveButton();

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.measureTool.active) { this._toggleMeasure(false); return; }
            if (e.key === 'Escape' && this.campaignTool.active) { this._toggleCampaignMode(false); return; }
            if (e.key === 'Escape' && this.charismaTool.active) { this._toggleCharismaMode(false); return; }
            if (e.key === 'Escape' && this.winningPerspectiveActive) { this._toggleWinningPerspective(false); return; }

            if (this.charismaTool.active) {
                const tag = e.target.tagName;
                if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && (e.key === 's' || e.key === 'S')) {
                    e.preventDefault();
                    this._performCharismaSwap();
                    return;
                }
            }

            if (this.activeWardEditAttr && ['0', '1', '2', '3'].includes(e.key)) {
                const tag = e.target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
                e.preventDefault();
                this._applyWardEditHotkey(e.key);
            }

            if (this.winningPerspectiveActive && Object.prototype.hasOwnProperty.call(this.config.winningPerspective.values, e.key)) {
                const tag = e.target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
                e.preventDefault();
                this._applyWinningPerspectiveHotkey(e.key);
            }

            if (this.campaignTool.active) {
                const tag = e.target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

                const combo = CampaignTool.comboForHotkey(e.key);
                if (combo) { e.preventDefault(); this._armCampaignCombo(combo.spectrum, combo.type); return; }

                if ((e.key === 'Delete' || e.key === 'Backspace') && this._campaignHoverHit) {
                    e.preventDefault();
                    this.campaignTool.removePointAt(this._campaignHoverHit.key, this._campaignHoverHit.index);
                    this._campaignHoverHit = null;
                    this._updateCampaignPointsTable();
                    this.redraw();
                }
            }
        });
    }

    // ── Layer switcher — a "+" FAB over the canvas (top-left), ported from shapefile's
    // canvas-fab pattern, replacing four always-visible layer buttons. ──────────────────

    _setupLayerFab() {
        const toggleBtn = document.getElementById('layerFabToggle');
        const menu = document.getElementById('layerFabMenu');

        toggleBtn.addEventListener('click', () => {
            const open = menu.classList.toggle('open');
            toggleBtn.textContent = open ? '−' : '+';
        });

        document.querySelectorAll('.layer-fab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.layer-fab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._switchLayer(btn.dataset.layer);
                menu.classList.remove('open');
                toggleBtn.textContent = '+';
            });
        });
    }

    _switchLayer(layer) {
        if (!this.config.layers.options.includes(layer)) return;
        this.activeLayer = layer;
        this.selectedRowIndex = null;
        this.selectedEntity = null;
        this.multiSelectedRowIndices.clear();
        this.renderer.labelZoomThreshold = this.config.datasets[layer].labelZoomThreshold;
        this._resetRegionButtonLabel();
        this._updatePopulationBtnLabel();
        this._updateDisplayModeAvailability();
        this._updateWardEditAvailability();
        this._updateCampaignAvailability();
        this._updateCharismaAvailability();
        this._updateWinningPerspectiveAvailability();
        this.redraw();
    }

    _toggleMeasure(forceState) {
        const nowActive = forceState !== undefined ? forceState : !this.measureTool.active;
        if (nowActive && this.campaignTool.active) this._toggleCampaignMode(false);
        if (this.measureTool.active !== nowActive) this.measureTool.toggle();
        else if (!nowActive) this.measureTool.clear();

        const btn = document.getElementById('measureBtn');
        const info = document.getElementById('measureInfo');
        btn.classList.toggle('active', this.measureTool.active);
        info.style.display = this.measureTool.active ? '' : 'none';
        this._updateMeasureInfo();
        this.redraw();
    }

    _updateMeasureInfo() {
        const total = document.getElementById('measureTotal');
        if (!this.measureTool.points.length) {
            total.textContent = 'Click the map to start measuring';
        } else {
            total.textContent = `Total: ${this.measureTool.formatDistance(this.measureTool.totalDistanceM())} (${this.measureTool.points.length} points)`;
        }
    }

    // ── Local Campaign — Individual (polygon) layer only. Free-floating dot labels: one of
    // 3 spectrums (Left/MR/Right) x 2 types (Canvass/Service), placed by clicking the map while
    // a combo is "armed" (via its button or 1-6 hotkey). Canvass costs 5 pts, Service costs 10,
    // drawn from that spectrum's total (set via the Rule dialog). See js/CampaignTool.js for the
    // model and _onMouseDown/_onMouseMove for the click-to-place/hover-to-delete mechanics. ────

    _setupCampaignTool() {
        const btn = document.getElementById('localCampaignBtn');
        const controls = document.getElementById('campaignControls');
        this._campaignBtn = btn;
        this._campaignControls = controls;
        this._campaignComboBtns = Array.from(document.querySelectorAll('.campaign-combo-btn'));

        btn.addEventListener('click', () => this._toggleCampaignMode());

        this._campaignComboBtns.forEach(b => {
            b.addEventListener('click', () => this._armCampaignCombo(b.dataset.spectrum, b.dataset.type));
        });

        document.getElementById('campaignRuleBtn').addEventListener('click', () => this._openCampaignRuleModal());
        this._setupCampaignRuleModal();
    }

    _toggleCampaignMode(forceState) {
        const nowActive = forceState !== undefined ? forceState : !this.campaignTool.active;
        if (nowActive && this.measureTool.active) this._toggleMeasure(false);

        this.campaignTool.active = nowActive;
        this.campaignTool.armed = null;
        this._campaignMouseData = null;
        this._campaignHoverHit = null;
        this.campaignHoverEntity = null;

        this._campaignBtn.classList.toggle('active', nowActive);
        this._campaignControls.style.display = nowActive ? '' : 'none';
        this._campaignComboBtns.forEach(b => b.classList.remove('active'));
        this.canvas.style.cursor = nowActive ? 'crosshair' : 'grab';

        this._updateCampaignPointsTable();
        this._updateLegend();
        this.redraw();
    }

    _armCampaignCombo(spectrum, type) {
        const already = this.campaignTool.armed && this.campaignTool.armed.spectrum === spectrum && this.campaignTool.armed.type === type;
        this.campaignTool.armed = already ? null : { spectrum, type };
        this._campaignComboBtns.forEach(b => {
            b.classList.toggle('active', !already && b.dataset.spectrum === spectrum && b.dataset.type === type);
        });
        this.redraw();
    }

    /** Show/hide the whole Local Campaign section — Individual (polygon) layer only. */
    _updateCampaignAvailability() {
        const show = this.activeLayer === 'individual';
        document.getElementById('campaignSection').style.display = show ? '' : 'none';
        if (!show && this.campaignTool.active) this._toggleCampaignMode(false);
    }

    _updateCampaignPointsTable() {
        const table = document.getElementById('campaignPointsTable');
        if (!table) return;
        table.innerHTML = CampaignTool.SPECTRA.map(s => {
            const remaining = this.campaignTool.remainingPoints(s);
            const color = remaining < 0 ? '#dc3545' : '#495057';
            return `<tr><td>${s}</td><td style="color:${color};">${remaining} / ${this.campaignTool.budgets[s]} pts</td></tr>`;
        }).join('');
    }

    _setupCampaignRuleModal() {
        const backdrop = document.getElementById('campaignRuleModalBackdrop');
        const close = () => backdrop.classList.remove('open');

        document.getElementById('campaignRuleModalClose').addEventListener('click', close);
        document.getElementById('campaignRuleModalCancel').addEventListener('click', close);
        document.getElementById('campaignRuleModalSave').addEventListener('click', () => {
            const read = (id) => {
                const v = parseInt(document.getElementById(id).value, 10);
                return isNaN(v) ? 0 : Math.max(0, v);
            };
            this.campaignTool.budgets.Left = read('campaignBudgetLeft');
            this.campaignTool.budgets.MR = read('campaignBudgetMR');
            this.campaignTool.budgets.Right = read('campaignBudgetRight');
            this._updateCampaignPointsTable();
            close();
        });
    }

    _openCampaignRuleModal() {
        document.getElementById('campaignBudgetLeft').value = this.campaignTool.budgets.Left;
        document.getElementById('campaignBudgetMR').value = this.campaignTool.budgets.MR;
        document.getElementById('campaignBudgetRight').value = this.campaignTool.budgets.Right;
        document.getElementById('campaignRuleModalBackdrop').classList.add('open');
    }

    /** Click while Local Campaign is active: on an existing dot -> remove it; else place the armed combo. */
    _handleCampaignClick(sx, sy) {
        const data = this.geo.screenToData(sx, sy);
        const hit = this.campaignTool.findPointAt(data.x, data.y, this.geo.scale);
        if (hit) {
            this.campaignTool.removePointAt(hit.key, hit.index);
            this._campaignHoverHit = null;
            this._updateCampaignPointsTable();
            this.redraw();
            return;
        }

        const armed = this.campaignTool.armed;
        if (!armed) { this._setStatus('Pick a label type (1-6, or a button) before clicking the map.', true); return; }

        const placed = this.campaignTool.addPoint(armed.spectrum, armed.type, data.x, data.y);
        if (!placed) { this._setStatus(`Not enough ${armed.spectrum} points left for a ${armed.type} label.`, true); return; }
        this._updateCampaignPointsTable();
        this.redraw();
    }

    // ── Charisma — Constituency layer only. Pick a spectrum, click exactly 2 constituencies
    // (a 3rd click evicts the oldest), press "S" (or the Swap button) to swap their charisma
    // values within that spectrum. Each spectrum has its own swap budget (from charisma.json);
    // every swap is pushed onto an undo stack any prior step can be reverted to. See
    // js/CharismaTool.js for the model and _handleCharismaClick/_performCharismaSwap below. ────

    _setupCharismaTool() {
        const btn = document.getElementById('charismaBtn');
        const controls = document.getElementById('charismaControls');
        this._charismaBtn = btn;
        this._charismaControls = controls;
        this._charismaSpectrumBtns = Array.from(document.querySelectorAll('.charisma-spectrum-btn'));

        btn.addEventListener('click', () => this._toggleCharismaMode());

        this._charismaSpectrumBtns.forEach(b => {
            b.addEventListener('click', () => this._setCharismaSpectrum(b.dataset.spectrum));
        });

        document.getElementById('charismaSwapBtn').addEventListener('click', () => this._performCharismaSwap());
        document.getElementById('charismaUndoBtn').addEventListener('click', () => this._performCharismaUndo());
    }

    _toggleCharismaMode(forceState) {
        const nowActive = forceState !== undefined ? forceState : !this.charismaTool.active;
        if (nowActive && this.measureTool.active) this._toggleMeasure(false);
        if (nowActive && this.campaignTool.active) this._toggleCampaignMode(false);

        this.charismaTool.active = nowActive;
        this.charismaTool.clearSelection();

        this._charismaBtn.classList.toggle('active', nowActive);
        this._charismaControls.style.display = nowActive ? '' : 'none';
        this.canvas.style.cursor = nowActive ? 'crosshair' : 'grab';

        this._updateCharismaPanel();
        this._updateLegend();
        this.redraw();
    }

    _setCharismaSpectrum(spectrum) {
        if (!CharismaTool.SPECTRA.includes(spectrum) || spectrum === this.charismaTool.spectrum) return;
        this.charismaTool.spectrum = spectrum;
        this.charismaTool.clearSelection();
        this._updateCharismaPanel();
        this._updateLegend();
        this.redraw();
    }

    /** Click while Charisma is active: toggle the constituency under the cursor in/out of the 2-slot selection. */
    _handleCharismaClick(sx, sy) {
        const data = this.geo.screenToData(sx, sy);
        let found = null;
        for (const polygon of this.visiblePolygons()) {
            if (this.geo.isPointInPolygon(data.x, data.y, polygon.rings[0])) { found = polygon; break; }
        }
        if (!found) return;
        this.charismaTool.toggleSelectRow(found.rowIndex);
        this._updateCharismaPanel();
        this.redraw();
    }

    _performCharismaSwap() {
        if (!this.charismaTool.active) return;
        if (!this.charismaTool.canSwap()) {
            const remaining = this.charismaTool.swapsRemaining[this.charismaTool.spectrum];
            this._setStatus(
                this.charismaTool.selectedRowIndices.length !== 2
                    ? 'Select exactly 2 constituencies first.'
                    : `No swaps left for ${CharismaTool.SPECTRUM_LABEL[this.charismaTool.spectrum]} (${remaining}/${CharismaTool.DEFAULT_SWAPS}).`,
                true
            );
            return;
        }

        const [rowA, rowB] = this.charismaTool.selectedRowIndices;
        const codeA = this.dataManager.row('constituency', rowA).Constituency_Code;
        const codeB = this.dataManager.row('constituency', rowB).Constituency_Code;
        const ok = this.charismaTool.swap(codeA, codeB);
        if (!ok) { this._setStatus('Swap failed — missing charisma value for one of the selected constituencies.', true); return; }

        this._setStatus(`Swapped ${codeA} ↔ ${codeB} (${CharismaTool.SPECTRUM_LABEL[this.charismaTool.spectrum]})`);
        this.charismaTool.clearSelection();
        this._updateCharismaPanel();
        this.redraw();
    }

    _performCharismaUndo() {
        if (!this.charismaTool.canUndo()) return;
        this._revertCharismaToStep(this.charismaTool.history.length - 1);
    }

    _revertCharismaToStep(index) {
        const count = this.charismaTool.revertToStep(index);
        if (count <= 0) return;
        this._setStatus(`Reverted ${count} swap${count > 1 ? 's' : ''}.`);
        this._updateCharismaPanel();
        this.redraw();
    }

    /** Show/hide the whole Charisma section — Constituency layer only. */
    _updateCharismaAvailability() {
        const show = this.activeLayer === 'constituency';
        document.getElementById('charismaSection').style.display = show ? '' : 'none';
        if (!show && this.charismaTool.active) this._toggleCharismaMode(false);
    }

    /** Refresh the spectrum buttons, swaps-left label, selection status, Swap/Undo buttons, and history list. */
    _updateCharismaPanel() {
        if (!this._charismaSpectrumBtns) return;
        const spectrum = this.charismaTool.spectrum;

        this._charismaSpectrumBtns.forEach(b => b.classList.toggle('active', b.dataset.spectrum === spectrum));

        const remaining = this.charismaTool.swapsRemaining[spectrum];
        document.getElementById('charismaSwapsLabel').textContent =
            `Swaps left (${CharismaTool.SPECTRUM_LABEL[spectrum]}): ${remaining} / ${CharismaTool.DEFAULT_SWAPS}`;

        const selLabel = document.getElementById('charismaSelectionLabel');
        const sel = this.charismaTool.selectedRowIndices;
        if (!sel.length) {
            selLabel.textContent = 'Click 2 constituencies on the map to select them.';
        } else {
            const codes = sel.map(idx => {
                const row = this.dataManager.row('constituency', idx);
                return row ? row.Constituency_Code : '?';
            });
            selLabel.textContent = `Selected: ${codes.join(', ')}${codes.length < 2 ? ' (pick 1 more)' : ''}`;
        }

        const swapBtn = document.getElementById('charismaSwapBtn');
        const canSwap = this.charismaTool.canSwap();
        swapBtn.disabled = !canSwap;
        swapBtn.style.opacity = canSwap ? '1' : '0.5';

        const undoBtn = document.getElementById('charismaUndoBtn');
        const canUndo = this.charismaTool.canUndo();
        undoBtn.disabled = !canUndo;
        undoBtn.style.opacity = canUndo ? '1' : '0.5';

        const list = document.getElementById('charismaHistoryList');
        const history = this.charismaTool.history;
        if (!history.length) {
            list.innerHTML = '<div class="placeholder">No swaps yet.</div>';
            return;
        }
        list.innerHTML = history.map((entry, i) => {
            const isLast = i === history.length - 1;
            const label = CharismaTool.SPECTRUM_LABEL[entry.spectrum];
            return `<div style="padding:4px 0; border-bottom:1px solid #f0f0f0;">
                <div style="color:#495057;">${i + 1}. ${label}: ${entry.codeA} ${entry.valA}→${entry.valB} &nbsp;·&nbsp; ${entry.codeB} ${entry.valB}→${entry.valA}</div>
                <button type="button" class="btn-secondary small charisma-revert-btn" data-step="${i}" style="font-size:9px; padding:2px 6px; margin-top:3px; width:100%;">${isLast ? 'Undo' : 'Revert to here'}</button>
            </div>`;
        }).reverse().join('');

        list.querySelectorAll('.charisma-revert-btn').forEach(b => {
            b.addEventListener('click', () => this._revertCharismaToStep(parseInt(b.dataset.step, 10)));
        });
    }

    // ── Display Region modal — ported from shapefile/js/app.js setupDisplayRegionModal() ──
    // Region rows expand ("+") to reveal Zone checkboxes (multi-select); checking a Region
    // checkbox cascades to all its Zones; the filter that's actually applied always operates
    // at Zone granularity. Operates on whichever layer is currently active — County uses its
    // real Zone column, Ward/Individual substitute District (verified 1:1 under Region), and
    // Constituency (no sub-level below Region) falls back to flat Region-only checkboxes.

    _setupDisplayRegionModal() {
        const openBtn = document.getElementById('displayRegionBtn');
        const backdrop = document.getElementById('regionModalBackdrop');
        const list = document.getElementById('regionModalList');
        const closeBtn = document.getElementById('regionModalClose');
        const cancelBtn = document.getElementById('regionModalCancel');
        const applyBtn = document.getElementById('regionModalApply');
        const selectAllBtn = document.getElementById('regionSelectAllBtn');
        const clearAllBtn = document.getElementById('regionClearAllBtn');

        const closeModal = () => backdrop.classList.remove('open');

        const populateList = () => {
            const polygons = this.dataManager.entities(this.activeLayer);
            const hasZone = this._hasZoneColumn();
            const activeFilter = this.zoneFilters[this.activeLayer] || null;

            list.innerHTML = '';

            if (!hasZone) {
                // Flat Region-only checkboxes — this layer has no sub-Region grouping.
                const regions = [...new Set(polygons.map(p => p.region).filter(v => v !== undefined))].sort();
                if (regions.length === 0) {
                    list.innerHTML = '<li style="font-size:12px;color:#888;">No Region data loaded</li>';
                    return;
                }
                regions.forEach(region => {
                    const li = document.createElement('li');
                    const label = document.createElement('label');
                    label.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; padding:4px 2px;';
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.className = 'zone-checkbox';
                    cb.value = region;
                    cb.checked = activeFilter ? activeFilter.has(region) : true;
                    label.appendChild(cb);
                    label.appendChild(document.createTextNode(region || '(blank)'));
                    li.appendChild(label);
                    list.appendChild(li);
                });
                return;
            }

            // Region -> Set of Zone values found under it
            const regionZones = new Map();
            polygons.forEach(p => {
                const region = p.region || '';
                const zone = p.zone || '';
                if (!regionZones.has(region)) regionZones.set(region, new Set());
                regionZones.get(region).add(zone);
            });

            const regions = Array.from(regionZones.keys()).sort();
            if (regions.length === 0) {
                list.innerHTML = '<li style="font-size:12px;color:#888;">No Region data loaded</li>';
                return;
            }

            regions.forEach(region => {
                const zones = Array.from(regionZones.get(region)).sort();

                const li = document.createElement('li');
                li.style.marginBottom = '4px';

                const row = document.createElement('div');
                row.style.cssText = 'display:flex; align-items:center; gap:6px;';

                const expandBtn = document.createElement('button');
                expandBtn.type = 'button';
                expandBtn.textContent = '+';
                expandBtn.title = 'Show zones';
                expandBtn.style.cssText = 'width:20px; height:20px; min-width:20px; padding:0; ' +
                    'font-size:13px; line-height:1; border:1px solid #ccc; border-radius:4px; ' +
                    'background:#fff; cursor:pointer; flex-shrink:0;';

                const label = document.createElement('label');
                label.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; flex:1;';

                const regionCheckbox = document.createElement('input');
                regionCheckbox.type = 'checkbox';

                label.appendChild(regionCheckbox);
                label.appendChild(document.createTextNode(region || '(blank)'));

                row.appendChild(expandBtn);
                row.appendChild(label);
                li.appendChild(row);

                const zoneList = document.createElement('ul');
                zoneList.style.cssText = 'list-style:none; margin:4px 0 0 26px; padding:0; display:none;';

                zones.forEach(zone => {
                    const zli = document.createElement('li');
                    zli.style.marginBottom = '3px';

                    const zlabel = document.createElement('label');
                    zlabel.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:11px; cursor:pointer; color:#555;';

                    const zoneCheckbox = document.createElement('input');
                    zoneCheckbox.type = 'checkbox';
                    zoneCheckbox.className = 'zone-checkbox';
                    zoneCheckbox.value = zone;
                    zoneCheckbox.checked = activeFilter ? activeFilter.has(zone) : true;

                    zlabel.appendChild(zoneCheckbox);
                    zlabel.appendChild(document.createTextNode(zone || '(blank)'));
                    zli.appendChild(zlabel);
                    zoneList.appendChild(zli);
                });

                li.appendChild(zoneList);
                list.appendChild(li);

                const syncRegionCheckbox = () => {
                    const zoneCbs = Array.from(zoneList.querySelectorAll('.zone-checkbox'));
                    const checkedCount = zoneCbs.filter(cb => cb.checked).length;
                    regionCheckbox.checked = zoneCbs.length > 0 && checkedCount === zoneCbs.length;
                    regionCheckbox.indeterminate = checkedCount > 0 && checkedCount < zoneCbs.length;
                };
                syncRegionCheckbox();

                expandBtn.addEventListener('click', () => {
                    const isOpen = zoneList.style.display !== 'none';
                    zoneList.style.display = isOpen ? 'none' : 'block';
                    expandBtn.textContent = isOpen ? '+' : '−';
                });

                regionCheckbox.addEventListener('change', () => {
                    zoneList.querySelectorAll('.zone-checkbox').forEach(cb => { cb.checked = regionCheckbox.checked; });
                    regionCheckbox.indeterminate = false;
                });

                zoneList.addEventListener('change', (e) => {
                    if (e.target.classList.contains('zone-checkbox')) syncRegionCheckbox();
                });
            });
        };

        openBtn.addEventListener('click', () => {
            populateList();
            backdrop.classList.add('open');
        });

        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);

        selectAllBtn.addEventListener('click', () => {
            list.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true; cb.indeterminate = false; });
        });
        clearAllBtn.addEventListener('click', () => {
            list.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; cb.indeterminate = false; });
        });

        applyBtn.addEventListener('click', () => {
            const checkboxes = Array.from(list.querySelectorAll('.zone-checkbox'));
            const checked = checkboxes.filter(cb => cb.checked).map(cb => cb.value);

            this.zoneFilters[this.activeLayer] = (checked.length === checkboxes.length) ? null : new Set(checked);

            const filter = this.zoneFilters[this.activeLayer];
            openBtn.classList.toggle('active', filter !== null);
            openBtn.textContent = filter
                ? `🗺️ Display Region (${checked.length}/${checkboxes.length})`
                : '🗺️ Display Region';

            this.redraw();
            closeModal();
        });
    }

    _resetRegionButtonLabel() {
        const openBtn = document.getElementById('displayRegionBtn');
        const filter = this.zoneFilters[this.activeLayer];
        openBtn.classList.toggle('active', !!filter);
        openBtn.textContent = '🗺️ Display Region';
    }

    // ── Display Mode: expand/collapse ───────────────────────────────────────────────────

    _setupDisplayModeCollapse() {
        const header = document.getElementById('displayModeHeader');
        const body = document.getElementById('displayModeBody');
        const toggle = document.getElementById('displayModeToggle');
        header.addEventListener('click', () => {
            const open = body.classList.toggle('open');
            toggle.textContent = open ? '−' : '+';
        });
    }

    // ── Display Mode: colour-map + label buttons — ported from shapefile/js/app.js ─────────

    _setupDisplayModeButtons() {
        const renderer = this.renderer;

        const densityColorMapBtn = document.getElementById('densityColorMapBtn');
        const locationMapBtn = document.getElementById('locationMapBtn');
        const typeMapBtn = document.getElementById('typeMapBtn');
        const displayDataBtn = document.getElementById('displayDataBtn');
        const densityModeBtn = document.getElementById('densityModeBtn');
        const estPopModeBtn = document.getElementById('estPopModeBtn');
        const typeLabelBtn = document.getElementById('typeLabelBtn');

        this._displayModeBtns = { densityColorMapBtn, locationMapBtn, typeMapBtn, displayDataBtn, densityModeBtn, estPopModeBtn, typeLabelBtn };

        // Density Color Map — mutually exclusive with Location Map / Type Map
        densityColorMapBtn.addEventListener('click', () => {
            const active = renderer.toggleDensityColorMap();
            densityColorMapBtn.classList.toggle('active', active);
            if (active) {
                if (renderer.options.showLocationColorMap) {
                    renderer.options.showLocationColorMap = false;
                    locationMapBtn.classList.remove('active');
                }
                if (renderer.options.showTypeColorMap) {
                    renderer.options.showTypeColorMap = false;
                    typeMapBtn.classList.remove('active');
                }
            }
            this._updateLegend();
            this.redraw();
        });

        // Location Map — colour polygons by Location field (individual layer only; hidden elsewhere)
        locationMapBtn.addEventListener('click', () => {
            const next = !renderer.options.showLocationColorMap;
            renderer.options.showLocationColorMap = next;
            locationMapBtn.classList.toggle('active', next);
            if (next) {
                if (renderer.options.showDensityColorMap) {
                    renderer.options.showDensityColorMap = false;
                    densityColorMapBtn.classList.remove('active');
                }
                if (renderer.options.showTypeColorMap) {
                    renderer.options.showTypeColorMap = false;
                    typeMapBtn.classList.remove('active');
                }
                if (!renderer.options.showDensityLabel) this._setLabelMode('density');
            }
            this._updateLegend();
            this.redraw();
        });

        // Type Map — colour polygons by County_Type code (individual layer only; hidden elsewhere)
        typeMapBtn.addEventListener('click', () => {
            const next = !renderer.options.showTypeColorMap;
            renderer.options.showTypeColorMap = next;
            typeMapBtn.classList.toggle('active', next);
            if (next) {
                if (renderer.options.showDensityColorMap) {
                    renderer.options.showDensityColorMap = false;
                    densityColorMapBtn.classList.remove('active');
                }
                if (renderer.options.showLocationColorMap) {
                    renderer.options.showLocationColorMap = false;
                    locationMapBtn.classList.remove('active');
                }
                if (!renderer.options.showDensityLabel) this._setLabelMode('density');
            }
            this._updateLegend();
            this.redraw();
        });

        // Master toggle — turns on with density as default sub-mode
        displayDataBtn.addEventListener('click', () => {
            const isOn = renderer.options.showDensityLabel;
            this._setLabelMode(isOn ? null : 'density');
        });

        densityModeBtn.addEventListener('click', () => this._setLabelMode('density'));
        estPopModeBtn.addEventListener('click', () => this._setLabelMode('estPopulation'));
        typeLabelBtn.addEventListener('click', () => this._setLabelMode('locationType'));
    }

    /**
     * mode: null | 'density' | 'estPopulation' | 'locationType'
     *   displayDataBtn = master ON/OFF, always lit when any label is showing.
     *   densityModeBtn / estPopModeBtn / typeLabelBtn = mutually exclusive sub-modes.
     *     'density'       -> density numbers, Location-Type overlay off
     *     'estPopulation' -> est-population numbers, Location-Type overlay off
     *     'locationType'  -> population numbers + Location-Type overlay
     *     null            -> all labels off
     */
    _setLabelMode(mode) {
        const renderer = this.renderer;
        const { displayDataBtn, densityModeBtn, estPopModeBtn, typeLabelBtn } = this._displayModeBtns;

        if (mode === null) {
            renderer.options.showDensityLabel = false;
            renderer.options.showLocationTypeLabel = false;
            displayDataBtn.classList.remove('active');
            densityModeBtn.classList.remove('active');
            estPopModeBtn.classList.remove('active');
            typeLabelBtn.classList.remove('active');
        } else {
            renderer.options.showDensityLabel = true;
            displayDataBtn.classList.add('active');
            densityModeBtn.classList.toggle('active', mode === 'density');
            estPopModeBtn.classList.toggle('active', mode === 'estPopulation');
            typeLabelBtn.classList.toggle('active', mode === 'locationType');

            renderer.options.showLocationTypeLabel = (mode === 'locationType');
            renderer.setDensityMode((mode === 'estPopulation' || mode === 'locationType') ? 'estPopulation' : 'density');
        }
        this.redraw();
    }

    /** Rename "Est Population" -> "Population" once the active layer's data has real population figures. */
    _updatePopulationBtnLabel() {
        const btn = this._displayModeBtns && this._displayModeBtns.estPopModeBtn;
        if (!btn) return;
        const hasActual = this.dataManager.entities(this.activeLayer).some(p => !isNaN(p.population) && p.population > 0);
        btn.textContent = hasActual ? 'Population' : 'Est Population';
    }

    /**
     * Location Map / Type Map / Location-Type only make sense on the individual layer (only
     * its CSV carries Location/County_Type columns) — hide them on the other three layers,
     * and fall back cleanly if one was left active when the layer switched away from Individual.
     */
    _updateDisplayModeAvailability() {
        const { locationMapBtn, typeMapBtn, typeLabelBtn } = this._displayModeBtns;
        const show = this.config.datasets[this.activeLayer].hasLocationType;

        [locationMapBtn, typeMapBtn, typeLabelBtn].forEach(btn => { btn.style.display = show ? '' : 'none'; });

        if (!show) {
            const renderer = this.renderer;
            if (renderer.options.showLocationColorMap) {
                renderer.options.showLocationColorMap = false;
                locationMapBtn.classList.remove('active');
            }
            if (renderer.options.showTypeColorMap) {
                renderer.options.showTypeColorMap = false;
                typeMapBtn.classList.remove('active');
            }
            if (renderer.options.showLocationTypeLabel) {
                this._setLabelMode(renderer.options.showDensityLabel ? 'density' : null);
            }
            this._updateLegend();
        }
    }

    // ── Border Layer — outline any one of the 4 layers (independent of activeLayer) with a
    // thick black border on top of the render, e.g. show County boundaries while the Individual
    // layer is active. Clicking the already-active layer turns the overlay back off. When Ward
    // is picked, two extra buttons let the user tint the border shapes by ward_immigrant/
    // ward_localists — the layer's one-hot category columns — same colours as Edit Immigrant/
    // Edit Localist but purely for viewing (no selection or hotkey editing involved). ─────────

    _setupBorderLayerControls() {
        const attrRow = document.getElementById('borderOverlayAttrRow');
        const immigrantBtn = document.getElementById('borderOverlayImmigrantBtn');
        const localistBtn = document.getElementById('borderOverlayLocalistBtn');
        this._borderOverlayBtns = { immigrant: immigrantBtn, localist: localistBtn };
        const layerBtns = Array.from(document.querySelectorAll('.border-layer-btn'));

        layerBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const layer = btn.dataset.layer;
                const turningOff = this.borderLayer === layer;

                this.borderLayer = turningOff ? null : layer;
                this.borderOverlayAttr = null;
                layerBtns.forEach(b => b.classList.toggle('active', !turningOff && b === btn));
                immigrantBtn.classList.remove('active');
                localistBtn.classList.remove('active');
                attrRow.style.display = (this.borderLayer === 'ward') ? '' : 'none';

                this._updateLegend();
                this.redraw();
            });
        });

        immigrantBtn.addEventListener('click', () => this._toggleBorderOverlayAttr('immigrant'));
        localistBtn.addEventListener('click', () => this._toggleBorderOverlayAttr('localist'));
    }

    _toggleBorderOverlayAttr(attr) {
        this.borderOverlayAttr = this.borderOverlayAttr === attr ? null : attr;
        this._borderOverlayBtns.immigrant.classList.toggle('active', this.borderOverlayAttr === 'immigrant');
        this._borderOverlayBtns.localist.classList.toggle('active', this.borderOverlayAttr === 'localist');
        this._updateLegend();
        this.redraw();
    }

    // ── Ward-only Edit Immigrant / Edit Localist ────────────────────────────────────────
    // Toggle one of these on, select ward shape(s) (click / Ctrl+Click / lasso drag), then
    // press 0-3 to write a density category into that ward's ward_immigrant/ward_localists
    // column. While a mode is active, ward fill colour reflects the category (see Renderer).

    _setupWardEditButtons() {
        const editImmigrantBtn = document.getElementById('editImmigrantBtn');
        const editLocalistBtn = document.getElementById('editLocalistBtn');
        this._wardEditBtns = { immigrant: editImmigrantBtn, localist: editLocalistBtn };

        editImmigrantBtn.addEventListener('click', () => this._toggleWardEdit('immigrant'));
        editLocalistBtn.addEventListener('click', () => this._toggleWardEdit('localist'));
    }

    _toggleWardEdit(attr) {
        const next = this.activeWardEditAttr === attr ? null : attr;
        if (next && this.winningPerspectiveActive) this._toggleWinningPerspective(false);
        this.activeWardEditAttr = next;
        this.renderer.options.wardEditAttr = next;

        this._wardEditBtns.immigrant.classList.toggle('active', next === 'immigrant');
        this._wardEditBtns.localist.classList.toggle('active', next === 'localist');

        const hint = document.getElementById('wardEditHint');
        if (next) {
            hint.textContent = `Select ward(s), then press 0 (none) / 1 (low) / 2 (medium) / 3 (high) for ${this.config.wardEdit[next].label}.`;
            hint.style.display = '';

            // A ward-edit colour map replaces the other colour maps while active, same
            // mutual-exclusivity convention as Density/Location/Type Map.
            const renderer = this.renderer;
            const { densityColorMapBtn, locationMapBtn, typeMapBtn } = this._displayModeBtns;
            if (renderer.options.showDensityColorMap) { renderer.options.showDensityColorMap = false; densityColorMapBtn.classList.remove('active'); }
            if (renderer.options.showLocationColorMap) { renderer.options.showLocationColorMap = false; locationMapBtn.classList.remove('active'); }
            if (renderer.options.showTypeColorMap) { renderer.options.showTypeColorMap = false; typeMapBtn.classList.remove('active'); }
        } else {
            hint.style.display = 'none';
        }
        this._updateLegend();
        this._updateWardEditSummary();
        this.redraw();
    }

    /** Hide/disable Edit Immigrant/Localist outside the Ward layer, and turn the mode off when leaving it. */
    _updateWardEditAvailability() {
        const show = this.activeLayer === 'ward';
        this._wardEditBtns.immigrant.style.display = show ? '' : 'none';
        this._wardEditBtns.localist.style.display = show ? '' : 'none';
        if (!show && this.activeWardEditAttr) this._toggleWardEdit(this.activeWardEditAttr); // toggles it off
    }

    /** rowIndex(es) the hotkey should apply to: the multi-selection if any, else the single selection. */
    _currentSelectionIndices() {
        if (this.multiSelectedRowIndices.size > 0) return this.multiSelectedRowIndices;
        if (this.selectedRowIndex !== null) return new Set([this.selectedRowIndex]);
        return new Set();
    }

    _applyWardEditHotkey(key) {
        const cfg = this.config.wardEdit[this.activeWardEditAttr];
        const value = cfg.values[key];
        if (value === undefined) return;

        const targets = this._currentSelectionIndices();
        if (!targets.size) { this._setStatus('Select one or more wards first.', true); return; }

        targets.forEach(idx => {
            if (value === '') this.dataManager.clearParam('ward', idx, cfg.column);
            else this.dataManager.setParam('ward', idx, cfg.column, value);
        });
        this._wardEditVersion++;

        this._setStatus(`${cfg.label}: set ${targets.size} ward(s) to "${value || 'none'}"`);
        this._updateWardEditSummary();
        this.redraw();
    }

    /** Dataset-wide population tally by category, shown in the sidebar while an edit mode is active. */
    _updateWardEditSummary() {
        const panel = document.getElementById('wardEditSummaryPanel');
        const attr = this.activeWardEditAttr;
        if (!attr) { panel.style.display = 'none'; return; }

        const cfg = this.config.wardEdit[attr];
        const summary = this.dataManager.wardEditSummary(attr);
        if (!summary) { panel.style.display = 'none'; return; }

        const levelNames = { '0': 'Unassigned', '1': 'Low', '2': 'Medium', '3': 'High' };
        document.getElementById('wardEditSummaryTitle').textContent = `${cfg.label} Density — Population`;
        document.getElementById('wardEditSummaryTable').innerHTML = ['0', '1', '2', '3'].map(k => {
            const val = cfg.values[k];
            const stat = summary[val] || { count: 0, population: 0 };
            return `<tr><td>${levelNames[k]}</td><td>${Math.round(stat.population).toLocaleString()}</td><td style="color:#999;">${stat.count} wards</td></tr>`;
        }).join('');
        panel.style.display = '';
    }

    // ── Winning Perspectives — Constituency AND Ward layers, whichever is currently active.
    // Toggle on, select shape(s) the normal way (Ctrl+Click / lasso / plain click), then press
    // 0-4 to cycle through that key's values (config.winningPerspective.values[key] is an array)
    // and write the resulting "who's the race between" value into that layer's Winning_Perspective
    // column. Unlike Edit Immigrant/Localist (ward-only), this follows the active layer — switch
    // from Constituency to Ward (or back) while the mode is on and it just retargets. ──────────

    _setupWinningPerspectiveButton() {
        const btn = document.getElementById('winningPerspectiveBtn');
        this._winningPerspectiveBtn = btn;
        btn.addEventListener('click', () => this._toggleWinningPerspective());
    }

    _toggleWinningPerspective(forceState) {
        const cfg = this.config.winningPerspective;
        const nowActive = forceState !== undefined ? forceState : !this.winningPerspectiveActive;
        if (nowActive && this.measureTool.active) this._toggleMeasure(false);
        if (nowActive && this.campaignTool.active) this._toggleCampaignMode(false);
        if (nowActive && this.charismaTool.active) this._toggleCharismaMode(false);
        if (nowActive && this.activeWardEditAttr) this._toggleWardEdit(this.activeWardEditAttr); // toggles it off

        this.winningPerspectiveActive = nowActive;
        this.renderer.options.winningPerspective = nowActive
            ? { layerKey: this.activeLayer, column: cfg.column, colors: cfg.colors }
            : null;

        this._winningPerspectiveBtn.classList.toggle('active', nowActive);

        const hint = document.getElementById('winningPerspectiveHint');
        if (nowActive) {
            hint.textContent = this._winningPerspectiveHintText();
            hint.style.display = '';

            // A Winning Perspective fill replaces the other colour maps while active, same
            // mutual-exclusivity convention as Density/Location/Type Map / Edit Immigrant-Localist.
            const renderer = this.renderer;
            const { densityColorMapBtn, locationMapBtn, typeMapBtn } = this._displayModeBtns;
            if (renderer.options.showDensityColorMap) { renderer.options.showDensityColorMap = false; densityColorMapBtn.classList.remove('active'); }
            if (renderer.options.showLocationColorMap) { renderer.options.showLocationColorMap = false; locationMapBtn.classList.remove('active'); }
            if (renderer.options.showTypeColorMap) { renderer.options.showTypeColorMap = false; typeMapBtn.classList.remove('active'); }
        } else {
            hint.style.display = 'none';
        }

        this._updateLegend();
        this._updateWinningPerspectiveSummary();
        this.redraw();
    }

    /** Show/hide the Winning Perspectives section — Constituency and Ward layers only, and
     *  retarget the active overlay/summary to whichever of the two is now active. */
    _updateWinningPerspectiveAvailability() {
        const cfg = this.config.winningPerspective;
        const show = !!cfg && cfg.layers.includes(this.activeLayer);
        document.getElementById('winningPerspectiveSection').style.display = show ? '' : 'none';

        if (!show) {
            if (this.winningPerspectiveActive) this._toggleWinningPerspective(false);
            return;
        }
        if (this.winningPerspectiveActive) {
            this.renderer.options.winningPerspective.layerKey = this.activeLayer;
            document.getElementById('winningPerspectiveHint').textContent = this._winningPerspectiveHintText();
            this._updateWinningPerspectiveSummary();
        }
    }

    /** "Select Constituency(s)/Ward(s), then press 0 (clear) / 1 (cycles: ...) / ... ." — built
     *  from config.winningPerspective.values so adding another hotkey/cycle step needs no code
     *  change. Each key's array is a cycle: pressing it repeatedly on the same selection steps
     *  through its values in order. */
    _winningPerspectiveHintText() {
        const cfg = this.config.winningPerspective;
        const keys = Object.keys(cfg.values).sort((a, b) => Number(a) - Number(b)).filter(k => k !== '0');
        const options = keys.map(k => {
            const cycle = cfg.values[k];
            return cycle.length > 1 ? `${k} (cycles: ${cycle.join(' → ')})` : `${k} (${cycle[0]})`;
        }).join(' / ');
        return `Select ${this.config.layers.labels[this.activeLayer]}(s), then press 0 (clear) / ${options}. Pressing the same key again on the same selection advances to the next step.`;
    }

    /** Each hotkey's array in config.winningPerspective.values is a cycle: for every selected
     *  shape, find its own current column value inside that key's array and advance it to the
     *  next entry (wrapping around), rather than stamping one fixed value on every shape. This
     *  is what lets repeated presses of the same key toggle through e.g. Vote_L / Vote: Left_MR
     *  / Vote: Left_R independently per shape. */
    _applyWinningPerspectiveHotkey(key) {
        const cfg = this.config.winningPerspective;
        const cycle = cfg.values[key];
        if (!cycle) return;

        const targets = this._currentSelectionIndices();
        if (!targets.size) { this._setStatus(`Select one or more ${this.config.layers.labels[this.activeLayer]}(s) first.`, true); return; }

        const layerKey = this.activeLayer;
        const resultCounts = {};
        targets.forEach(idx => {
            const row = this.dataManager.row(layerKey, idx);
            const current = (row && row[cfg.column]) || '';
            const pos = cycle.indexOf(current);
            const next = cycle[(pos + 1) % cycle.length];
            resultCounts[next] = (resultCounts[next] || 0) + 1;
            if (next === '') this.dataManager.clearParam(layerKey, idx, cfg.column);
            else this.dataManager.setParam(layerKey, idx, cfg.column, next);
        });

        const summary = Object.entries(resultCounts).map(([v, n]) => `${n} → "${v || 'none'}"`).join(', ');
        this._setStatus(`Winning Perspective: ${summary}`);
        this._updateWinningPerspectiveSummary();
        this.redraw();
    }

    /** Dataset-wide category tally for whichever layer (Constituency/Ward) is currently active. */
    _updateWinningPerspectiveSummary() {
        const panel = document.getElementById('winningPerspectiveSummaryPanel');
        if (!this.winningPerspectiveActive) { panel.style.display = 'none'; return; }

        const cfg = this.config.winningPerspective;
        const summary = this.dataManager.winningPerspectiveSummary(this.activeLayer);
        if (!summary) { panel.style.display = 'none'; return; }

        document.getElementById('winningPerspectiveSummaryTitle').textContent =
            `Winning Perspective — ${this.config.layers.labels[this.activeLayer]}`;
        const values = this.dataManager.winningPerspectiveValueList();
        document.getElementById('winningPerspectiveSummaryTable').innerHTML = values.map(val => {
            const label = val === '' ? 'No Values' : val;
            const stat = summary[val] || { count: 0, population: 0 };
            return `<tr><td>${label}</td><td>${stat.count}</td><td style="color:#999;">${Math.round(stat.population).toLocaleString()} pop</td></tr>`;
        }).join('');
        panel.style.display = '';
    }

    // ── Legend (not part of the ported shapefile mechanism — a small helper reflecting
    // whichever colour map, if any, is currently active) ────────────────────────────────

    _updateLegend() {
        const el = document.getElementById('legendPanel');
        const opts = this.renderer.options;
        const blocks = [];

        if (this.charismaTool.active) {
            blocks.push(`
                <div class="legend-title">Charisma — ${CharismaTool.SPECTRUM_LABEL[this.charismaTool.spectrum]}</div>
                <div class="legend-gradient-charisma"></div>
                <div class="legend-range"><span>1</span><span>10</span></div>`);
        } else if (opts.wardEditAttr) {
            const cfg = this.config.wardEdit[opts.wardEditAttr];
            const levelNames = { '0': 'None', '1': 'Low', '2': 'Medium', '3': 'High' };
            const entries = ['0', '1', '2', '3'].map(k => [levelNames[k], cfg.colors[cfg.values[k]]]);
            blocks.push(`<div class="legend-title">${cfg.label} Density</div><div class="legend-swatches">` +
                entries.map(([name, color]) => `<span class="legend-swatch" style="background:${color}; border-color:#ccc;">${name}</span>`).join('') +
                `</div>`);
        } else if (this.winningPerspectiveActive) {
            const cfg = this.config.winningPerspective;
            const values = this.dataManager.winningPerspectiveValueList();
            const entries = values.map(v => [v === '' ? 'No Values' : v, cfg.colors[v]]);
            blocks.push(`<div class="legend-title">Winning Perspective</div><div class="legend-swatches">` +
                entries.map(([name, color]) => `<span class="legend-swatch" style="background:${color}; border-color:#ccc;">${name}</span>`).join('') +
                `</div>`);
        } else if (opts.showTypeColorMap) {
            const entries = Object.entries(this.config.typeColors).filter(([k]) => !k.startsWith('_'));
            blocks.push(`<div class="legend-title">Location - Type</div><div class="legend-swatches">` +
                entries.map(([code, color]) => `<span class="legend-swatch" style="background:${color}">${code}</span>`).join('') +
                `</div>`);
        } else if (opts.showLocationColorMap) {
            const entries = Object.entries(this.config.locationColors).filter(([k]) => !k.startsWith('_'));
            blocks.push(`<div class="legend-title">Location</div><div class="legend-swatches">` +
                entries.map(([name, color]) => `<span class="legend-swatch" style="background:${color}">${name}</span>`).join('') +
                `</div>`);
        } else if (opts.showDensityColorMap) {
            blocks.push(`
                <div class="legend-title">Population Density (/km²)</div>
                <div class="legend-gradient"></div>
                <div class="legend-range"><span>${opts.densityMin.toLocaleString()}</span><span>${opts.densityMax.toLocaleString()}</span></div>`);
        }

        // Border Layer — additive to whichever main colour map (if any) is shown above.
        if (this.borderLayer) {
            const layerLabel = this.config.layers.labels[this.borderLayer] || this.borderLayer;
            const marginTop = blocks.length ? '8px' : '0';
            if (this.borderLayer === 'ward' && this.borderOverlayAttr) {
                const cfg = this.config.wardEdit[this.borderOverlayAttr];
                const levelNames = { '0': 'None', '1': 'Low', '2': 'Medium', '3': 'High' };
                const entries = ['0', '1', '2', '3'].map(k => [levelNames[k], cfg.colors[cfg.values[k]]]);
                blocks.push(`<div class="legend-title" style="margin-top:${marginTop};">Border: ${layerLabel} — ${cfg.label}</div><div class="legend-swatches">` +
                    entries.map(([name, color]) => `<span class="legend-swatch" style="background:${color}; border-color:#ccc;">${name}</span>`).join('') +
                    `</div>`);
            } else {
                blocks.push(`<div class="legend-title" style="margin-top:${marginTop};">Border: ${layerLabel}</div>`);
            }
        }

        // Local Campaign — spectrum colour key (dot shape: ● Canvass, ■ Service).
        if (this.campaignTool.active) {
            const marginTop = blocks.length ? '8px' : '0';
            const entries = CampaignTool.SPECTRA.map(s => [s, CampaignTool.SPECTRUM_COLOR[s], CampaignTool.SPECTRUM_TEXT_COLOR[s]]);
            blocks.push(`<div class="legend-title" style="margin-top:${marginTop};">Local Campaign</div><div class="legend-swatches">` +
                entries.map(([name, color, textColor]) => `<span class="legend-swatch" style="background:${color}; color:${textColor}; border-color:#ccc;">${name}</span>`).join('') +
                `</div><div style="font-size:9px; color:#888; margin-top:3px;">● Canvass &nbsp; ■ Service</div>`);
        }

        el.innerHTML = blocks.join('');
    }

    // ── Canvas interaction ───────────────────────────────────────────────────
    // Gesture resolution ported from shapefile/js/MouseHandler.js: mousedown starts a
    // short (100ms) pending timer. Movement before it fires => pan. The timer firing
    // first (mouse held still) => lasso drag-select starts. A release before either
    // condition => a plain click (single select).

    _bindCanvasEvents() {
        const canvas = this.canvas;

        canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
        canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
        window.addEventListener('mouseup', (e) => this._onMouseUp(e));
        canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    }

    _clientToCanvas(e) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    _onMouseDown(e) {
        const { x: sx, y: sy } = this._clientToCanvas(e);

        // Ctrl/Cmd+Click toggles one shape in/out of the multi-selection (see _handleClickSelect).
        if (e.ctrlKey || e.metaKey) e.preventDefault();

        if (this.campaignTool.active) {
            this._handleCampaignClick(sx, sy);
            return;
        }

        if (this.charismaTool.active) {
            this._handleCharismaClick(sx, sy);
            return;
        }

        if (this.measureTool.active) {
            const data = this.geo.screenToData(sx, sy);
            const idx = this.measureTool.findPointAt(data.x, data.y, this.geo.scale);
            if (idx !== -1) {
                this._measureDrag = { index: idx, moved: false, startClientX: e.clientX, startClientY: e.clientY };
            } else {
                this.measureTool.addPoint(data.x, data.y);
                this._updateMeasureInfo();
                this.redraw();
            }
            return;
        }

        this._pendingOrigin = {
            clientX: e.clientX, clientY: e.clientY,
            screenX: sx, screenY: sy,
            offsetX: this.geo.offsetX, offsetY: this.geo.offsetY
        };
        this._pendingTimer = setTimeout(() => {
            this._pendingTimer = null;
            this._lasso = { path: [{ x: sx, y: sy }] };
            this.canvas.style.cursor = 'crosshair';
            this.redraw();
        }, 100);
    }

    _onMouseMove(e) {
        if (this._measureDrag) {
            const dx = e.clientX - this._measureDrag.startClientX;
            const dy = e.clientY - this._measureDrag.startClientY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this._measureDrag.moved = true;
            if (this._measureDrag.moved) {
                const { x: sx, y: sy } = this._clientToCanvas(e);
                const data = this.geo.screenToData(sx, sy);
                this.measureTool.movePoint(this._measureDrag.index, data.x, data.y);
                this._updateMeasureInfo();
                this.redraw();
            }
            return;
        }

        // Waiting for the pending-gesture decision — movement before the timer fires means pan.
        if (this._pendingTimer !== null) {
            const dx = e.clientX - this._pendingOrigin.clientX;
            const dy = e.clientY - this._pendingOrigin.clientY;
            if (dx * dx + dy * dy > 25) { // > 5px
                clearTimeout(this._pendingTimer);
                this._pendingTimer = null;
                this._panState = {
                    startClientX: this._pendingOrigin.clientX,
                    startClientY: this._pendingOrigin.clientY,
                    startOffsetX: this._pendingOrigin.offsetX,
                    startOffsetY: this._pendingOrigin.offsetY
                };
                this.canvas.style.cursor = 'grabbing';
            }
            return;
        }

        if (this._lasso) {
            const { x: sx, y: sy } = this._clientToCanvas(e);
            const last = this._lasso.path[this._lasso.path.length - 1];
            const dx = sx - last.x, dy = sy - last.y;
            if (dx * dx + dy * dy > 9) this._lasso.path.push({ x: sx, y: sy }); // > 3px
            this.redraw();
            return;
        }

        if (this._panState) {
            const dx = e.clientX - this._panState.startClientX;
            const dy = e.clientY - this._panState.startClientY;
            this.geo.offsetX = this._panState.startOffsetX + dx;
            this.geo.offsetY = this._panState.startOffsetY + dy;
            this.redraw();
            return;
        }

        // Idle hover: cheap coordinate readout only (no per-frame hit-testing — dataset is large).
        const { x: sx, y: sy } = this._clientToCanvas(e);
        const data = this.geo.screenToData(sx, sy);
        const coordEl = document.getElementById('cursorCoords');
        if (coordEl) coordEl.textContent = `${data.x.toFixed(1)}, ${data.y.toFixed(1)}`;

        // Local Campaign: track the cursor for the guide-circle preview, and which existing dot
        // (if any) is under it, so Delete/Backspace can remove it without a click. Also hit-test
        // the polygon under the cursor (individual layer only, since Campaign mode is unavailable
        // elsewhere) so display.html can hover-follow instead of needing a click to select —
        // the per-frame polygon scan is only paid while this opt-in mode is on.
        if (this.campaignTool.active) {
            this._campaignMouseData = data;
            this._campaignHoverHit = this.campaignTool.findPointAt(data.x, data.y, this.geo.scale);

            let hovered = null;
            for (const polygon of this.visiblePolygons()) {
                if (this.geo.isPointInPolygon(data.x, data.y, polygon.rings[0])) { hovered = polygon; break; }
            }
            this.campaignHoverEntity = hovered;

            this.redraw();
        }
    }

    _onMouseUp(e) {
        if (this._measureDrag) {
            if (!this._measureDrag.moved) {
                this.measureTool.removePoint(this._measureDrag.index);
                this._updateMeasureInfo();
                this.redraw();
            }
            this._measureDrag = null;
            return;
        }

        // Released before the pending timer fired or the pan threshold was crossed => plain click.
        if (this._pendingTimer !== null) {
            clearTimeout(this._pendingTimer);
            this._pendingTimer = null;
            this.canvas.style.cursor = 'grab';
            this._handleClickSelect(e);
            return;
        }

        if (this._lasso) {
            const path = this._lasso.path;
            this._lasso = null;
            this.canvas.style.cursor = 'grab';
            this._handleLassoSelect(path);
            return;
        }

        if (this._panState) {
            this.canvas.style.cursor = 'grab';
            this._panState = null;
        }
    }

    _onWheel(e) {
        e.preventDefault();
        const { x: sx, y: sy } = this._clientToCanvas(e);
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        if (this.geo.applyZoom(sx, sy, factor)) this.redraw();
    }

    _handleClickSelect(e) {
        const { x: sx, y: sy } = this._clientToCanvas(e);
        const data = this.geo.screenToData(sx, sy);

        let found = null;
        for (const polygon of this.visiblePolygons()) {
            if (this.geo.isPointInPolygon(data.x, data.y, polygon.rings[0])) { found = polygon; break; }
        }

        if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd+Click toggles one shape into/out of the persistent multi-selection,
            // same modifier shapefile uses for togglePolygonSelection() — additive to lasso drag-select.
            if (found) {
                if (this.multiSelectedRowIndices.has(found.rowIndex)) this.multiSelectedRowIndices.delete(found.rowIndex);
                else this.multiSelectedRowIndices.add(found.rowIndex);
            }
            this._syncSingleSelectionFromMulti();
        } else {
            this.multiSelectedRowIndices.clear();
            this.selectedEntity = found;
            this.selectedRowIndex = found ? found.rowIndex : null;
        }
        this.redraw();
    }

    /** Keep selectedEntity/selectedRowIndex mirroring the multi-selection when exactly one shape remains in it. */
    _syncSingleSelectionFromMulti() {
        if (this.multiSelectedRowIndices.size === 1) {
            const onlyIdx = [...this.multiSelectedRowIndices][0];
            this.selectedEntity = this.visiblePolygons().find(p => p.rowIndex === onlyIdx) || null;
            this.selectedRowIndex = this.selectedEntity ? this.selectedEntity.rowIndex : null;
        } else {
            this.selectedEntity = null;
            this.selectedRowIndex = null;
        }
    }

    /**
     * Freehand drag-select — ported from shapefile/js/PolygonEditor.js handleLassoSelect().
     * A polygon matches if any lasso point lands inside it, OR any of its vertices lands
     * inside the (closed) lasso shape — catches both "lasso drawn around a big shape" and
     * "lasso drawn through/across several small shapes". Each match toggles membership in
     * the persistent multi-selection, so repeated drags can add to or subtract from it.
     */
    _handleLassoSelect(screenPath) {
        if (!screenPath || screenPath.length < 4) { this.redraw(); return; } // too short — treat as a no-op

        const lassoData = screenPath.map(p => this.geo.screenToData(p.x, p.y));
        const candidates = this.visiblePolygons();

        let found = 0;
        candidates.forEach(polygon => {
            const ring = polygon.rings[0];
            if (!ring || ring.length < 3) return;

            let hit = false;
            for (let i = 0; i < lassoData.length; i += 2) {
                if (this.geo.isPointInPolygon(lassoData[i].x, lassoData[i].y, ring)) { hit = true; break; }
            }
            if (!hit) {
                for (const v of ring) {
                    if (this.geo.isPointInPolygon(v.x, v.y, lassoData)) { hit = true; break; }
                }
            }
            if (hit) {
                found++;
                if (this.multiSelectedRowIndices.has(polygon.rowIndex)) this.multiSelectedRowIndices.delete(polygon.rowIndex);
                else this.multiSelectedRowIndices.add(polygon.rowIndex);
            }
        });

        if (found > 0) {
            this._syncSingleSelectionFromMulti();
        }
        this.redraw();
    }

    // ── Save ─────────────────────────────────────────────────────────────────

    /** Full list of files "Save All" can produce — the 4 layer CSVs plus the 2 tool JSONs. */
    _saveFileDefs() {
        const defs = this.config.layers.options.map(key => ({
            key,
            label: this.config.layers.labels[key] || key,
            filename: this.config.datasets[key].file,
            type: 'csv'
        }));
        defs.push({ key: 'campaign', label: 'Campaign', filename: 'campaign.json', type: 'json' });
        defs.push({ key: 'charisma', label: 'Charisma', filename: 'charisma.json', type: 'json' });
        return defs;
    }

    // Tickbox modal so the user can save just the 1-2 files they changed instead of triggering
    // a browser save dialog for all 6 every time.
    _setupSaveFilesModal() {
        const backdrop = document.getElementById('saveFilesModalBackdrop');
        const list = document.getElementById('saveFilesModalList');
        const closeBtn = document.getElementById('saveFilesModalClose');
        const cancelBtn = document.getElementById('saveFilesModalCancel');
        const applyBtn = document.getElementById('saveFilesModalApply');
        const selectAllBtn = document.getElementById('saveFilesSelectAllBtn');
        const clearAllBtn = document.getElementById('saveFilesClearAllBtn');

        // Remembered across opens so re-opening the modal keeps the user's last choice.
        if (!this._saveFilesSelected) {
            this._saveFilesSelected = new Set(this._saveFileDefs().map(d => d.key));
        }

        const closeModal = () => backdrop.classList.remove('open');

        const populateList = () => {
            list.innerHTML = '';
            this._saveFileDefs().forEach(def => {
                const li = document.createElement('li');
                li.style.marginBottom = '2px';
                const label = document.createElement('label');
                label.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; padding:4px 2px;';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'save-file-checkbox';
                cb.value = def.key;
                cb.checked = this._saveFilesSelected.has(def.key);
                label.appendChild(cb);
                label.appendChild(document.createTextNode(`${def.label} (${def.filename})`));
                li.appendChild(label);
                list.appendChild(li);
            });
        };

        selectAllBtn.addEventListener('click', () => {
            list.querySelectorAll('.save-file-checkbox').forEach(cb => { cb.checked = true; });
        });
        clearAllBtn.addEventListener('click', () => {
            list.querySelectorAll('.save-file-checkbox').forEach(cb => { cb.checked = false; });
        });

        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

        applyBtn.addEventListener('click', () => {
            const selected = Array.from(list.querySelectorAll('.save-file-checkbox'))
                .filter(cb => cb.checked)
                .map(cb => cb.value);
            this._saveFilesSelected = new Set(selected);
            closeModal();
            this._saveSelected(selected);
        });

        this._populateSaveFilesModal = populateList;
    }

    _openSaveFilesModal() {
        this._populateSaveFilesModal();
        document.getElementById('saveFilesModalBackdrop').classList.add('open');
    }

    _saveSelected(keys) {
        if (!keys.length) {
            this._setStatus('No files selected to save.', true);
            return;
        }
        try {
            const defs = this._saveFileDefs().filter(d => keys.includes(d.key));
            defs.forEach((def, i) => {
                setTimeout(() => {
                    if (def.type === 'csv') {
                        this._downloadCsv(this.dataManager.exportLayerCSV(def.key), def.filename);
                    } else if (def.key === 'campaign') {
                        this._downloadJson(this.campaignTool.toJSON(), def.filename);
                    } else if (def.key === 'charisma') {
                        this._downloadJson(this.charismaTool.toJSON(), def.filename);
                    }
                }, i * 150);
            });
            const names = defs.map(d => d.label).join(', ');
            this._setStatus(`Saving ${defs.length} file${defs.length === 1 ? '' : 's'} (${names})…`);
        } catch (err) {
            this._setStatus(err.message, true);
        }
    }

    _downloadCsv(csvText, filename) {
        const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    _downloadJson(obj, filename) {
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    let config;
    try {
        const res = await fetch('config/config.json');
        config = await res.json();
    } catch (err) {
        alert('Failed to load config/config.json — the app cannot start.\n' + err.message);
        return;
    }
    new ElectoralModellingApp(config);
});
