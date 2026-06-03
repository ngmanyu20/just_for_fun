/**
 * PolygonEditor - Main application class that coordinates all modules
 * Complete version with midpoint vertex insertion support
 */
class PolygonEditor {
    constructor() {
        // Get DOM elements
        this.canvas = document.getElementById('canvas');
        this.ctx = this.canvas.getContext('2d');

        // Initialize modules
        this.dataManager = new DataManager();
        this.geometryOps = new GeometryOps(this.canvas);
        this.sharedVertices = new SharedVertices();
        this.overlapDetection = new OverlapDetection();
        this.historyManager = new HistoryManager();
        this.uiController = new UIController();
        this.mouseHandler = new MouseHandler(this.canvas, this.geometryOps);
        this.renderer = new Renderer(this.canvas, this.geometryOps);
        this.adjacencyGraph = new AdjacencyGraph();
        const backendUrl = window.BACKEND_URL || window.location.origin;
        this.polygonCombiner = new PolygonCombiner(this.adjacencyGraph, backendUrl);
        this.polygonSplitter = new PolygonSplitter(backendUrl);
        this.vertexSync = new VertexSync(0.001);
        this.layerManager = new LayerManager(backendUrl);
        this.fixedCountyVertices = new FixedCountyVertices();
        this.vertexClassifier = new VertexClassifier(this.fixedCountyVertices);
        this.vertexSelection = new VertexSelection();
        this.vertexDeletion = new VertexDeletion(this.vertexClassifier);
        this.vertexReplacement = new VertexReplacement(this.vertexClassifier);
        this.midpointCreation = new MidpointCreation(this.vertexClassifier, this.fixedCountyVertices);
        this.vertexSplitter = new VertexSplitter(this.vertexClassifier);
        this.polygonSimplifier = new PolygonSimplifier();
        this.measureTool = new MeasureTool();
        this.streetLayer = new StreetLayer();
        this.renderer.setStreetLayer(this.streetLayer);
        this.svgLayer = new SvgLayer();
        this.renderer.setSvgLayer(this.svgLayer);
        this.virtualNodeManager = new VirtualNodeManager();
        this.virtualNodeMode = false; // true = placement mode active
        this._splitSequence  = []; // unified click-order: {type:'ring'|'virtual', ...} for corner split

        // Application state
        this.polygons = [];
        this.selectedPolygonIndex = null;
        this.selectedPolygonIndices = new Set(); // Multi-selection for combining
        this.isEditMode = false;
        this.vertexWasDragged = false;
        this.isDraggingVertex = false; // Track if dragging a shift-selected vertex
        this.draggedVertex = null; // {polygonIndex, ringIndex, vertexIndex, x, y}

        // Measure tool drag state
        this._measureDragIndex = -1;
        this._measureDragMoved = false;

        this._pendingDensityPolygonIndex = null;

        // Initialize the application
        this.initialize();
    }

    /**
     * Initialize the application
     */
    initialize() {
        this.setupEventListeners();
        this.setupMouseCallbacks();
        this.setupMeasureMouseHandlers();
        this.resizeCanvas();
        
        // Set initial UI state - Start in EDIT mode
        this.uiController.setMode(true); // true = Edit mode
        this.isEditMode = true;
        this.uiController.setExportEnabled(false);
        this.uiController.setEditingEnabled(false);
        
        console.log('Polygon Editor initialized successfully');
    }

    /**
     * Setup event listeners for UI controls
     */
    setupEventListeners() {
        // Setup UI event handlers
        this.uiController.addEventListeners({
            onFileSelect: (e) => this.handleFileSelect(e),
            onModeChange: (isEdit) => this.setEditMode(isEdit),
            onPolygonSelect: (e) => this.handlePolygonSelect(e),
            onExport: () => this.exportCSV(),
            onUndo: () => this.undo(),
            onRedo: () => this.redo(),
            onCombine: () => this.combineSelectedPolygons(),
            onSplit: () => this.showSplitDialog(),
            onRegenerate: () => this.regenerateSplit()
        });

        // Vertex operation buttons
        const clearVertexBtn = document.getElementById('clearVertexSelectionBtn');
        if (clearVertexBtn) {
            clearVertexBtn.addEventListener('click', () => this.clearVertexSelection());
        }

        const deleteVertexBtn = document.getElementById('deleteVertexBtn');
        if (deleteVertexBtn) {
            deleteVertexBtn.addEventListener('click', () => this.handleVertexDelete());
        }

        const replaceVertexBtn = document.getElementById('replaceVertexBtn');
        if (replaceVertexBtn) {
            replaceVertexBtn.addEventListener('click', () => {
                this.uiController.showStatus('Press 1 to replace with previous vertex, or 2 to replace with next vertex');
            });
        }

        const midpointBtn = document.getElementById('midpointBtn');
        if (midpointBtn) {
            midpointBtn.addEventListener('click', () => this.handleMidpointCreate());
        }

        const splitByVerticesBtn = document.getElementById('splitByVerticesBtn');
        if (splitByVerticesBtn) {
            splitByVerticesBtn.addEventListener('click', () => this.handleSplitByVertices());
        }

        const splitByOsmBtn = document.getElementById('splitByOsmBtn');
        if (splitByOsmBtn) {
            splitByOsmBtn.addEventListener('click', () => this.showOsmSplitDialog());
        }

        const deletePolygonBtn = document.getElementById('deletePolygonBtn');
        if (deletePolygonBtn) {
            deletePolygonBtn.addEventListener('click', () => this.deleteSelectedPolygon());
        }

        const osmSplitCancelBtn = document.getElementById('osmSplitCancelBtn');
        if (osmSplitCancelBtn) {
            osmSplitCancelBtn.addEventListener('click', () => {
                document.getElementById('osmSplitModal').style.display = 'none';
            });
        }

        const osmSplitConfirmBtn = document.getElementById('osmSplitConfirmBtn');
        if (osmSplitConfirmBtn) {
            osmSplitConfirmBtn.addEventListener('click', () => this.handleOsmSplitConfirm());
        }

        const virtualNodeModeBtn = document.getElementById('virtualNodeModeBtn');
        if (virtualNodeModeBtn) {
            virtualNodeModeBtn.addEventListener('click', () => this.toggleVirtualNodeMode());
        }

        // Window resize handler
        window.addEventListener('resize', () => this.resizeCanvas());

        // Keyboard state tracking for Ctrl+Space combination
        this.keysPressed = new Set();

        // Use BOTH keydown and keyup to track keys
        // This works around browser interception of Ctrl+Space
        window.addEventListener('keydown', (e) => this.handleKeyDown(e), true);
        window.addEventListener('keyup', (e) => this.handleKeyUp(e), true);
    }

    /**
     * Handle keyboard shortcuts - keydown
     * @param {KeyboardEvent} e - Keyboard event
     */
    handleKeyDown(e) {
        // Do not intercept shortcuts while the user is typing in a form field
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

        // Track which keys are currently pressed
        const isCtrl = e.code === 'ControlLeft' || e.code === 'ControlRight' ||
                       e.key === 'Control';
        const isMeta = e.code === 'MetaLeft' || e.code === 'MetaRight' ||
                       e.key === 'Meta';

        // Add to pressed keys set
        if (isCtrl) {
            this.keysPressed.add('Control');
        }
        if (isMeta) {
            this.keysPressed.add('Meta');
        }

        // Track Z, Y, C, S, 1, 2 keys
        if (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z') {
            this.keysPressed.add('KeyZ');
        }
        if (e.code === 'KeyY' || e.key === 'y' || e.key === 'Y') {
            this.keysPressed.add('KeyY');
        }
        if (e.code === 'KeyC' || e.key === 'c' || e.key === 'C') {
            this.keysPressed.add('KeyC');
        }
        if (e.code === 'KeyS' || e.key === 's' || e.key === 'S') {
            this.keysPressed.add('KeyS');
        }
        if (e.code === 'Digit1' || e.key === '1') {
            this.keysPressed.add('Digit1');
        }
        if (e.code === 'Digit2' || e.key === '2') {
            this.keysPressed.add('Digit2');
        }

        const hasCtrlOrMeta = this.keysPressed.has('Control') || this.keysPressed.has('Meta');
        const hasZ = this.keysPressed.has('KeyZ');
        const hasY = this.keysPressed.has('KeyY');
        const hasC = this.keysPressed.has('KeyC');
        const hasS = this.keysPressed.has('KeyS');
        const has1 = this.keysPressed.has('Digit1');
        const has2 = this.keysPressed.has('Digit2');

        // Escape: exit virtual-node mode if active
        if (e.key === 'Escape' && this.virtualNodeMode) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.toggleVirtualNodeMode();
            this.keysPressed.clear();
            return false;
        }

        // Ctrl+Z: Undo
        if (hasCtrlOrMeta && hasZ) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            console.log('>>> Ctrl+Z: Undo triggered');
            this.undo();
            this.keysPressed.clear();
            return false;
        }

        // Ctrl+Y: Redo
        if (hasCtrlOrMeta && hasY) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            console.log('>>> Ctrl+Y: Redo triggered');
            this.redo();
            this.keysPressed.clear();
            return false;
        }

        // Ctrl+C: Combine polygons
        if (hasCtrlOrMeta && hasC) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            console.log('>>> Ctrl+C: Combine triggered. Selected polygons:', this.selectedPolygonIndices.size);

            if (this.selectedPolygonIndices.size >= 2) {
                console.log('>>> Activating combine operation');
                this.combineSelectedPolygons();
                this.keysPressed.clear();
            } else {
                console.log('>>> Need at least 2 polygons selected');
                this.uiController.showError('Select at least 2 polygons to combine (use Ctrl+Click)');
            }

            return false;
        }

        // Ctrl+S: Regenerate split
        if (hasCtrlOrMeta && hasS) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            console.log('>>> Ctrl+S: Regenerate split triggered');

            // Check if regenerate button is enabled
            const regenerateBtn = document.getElementById('regenerateBtn');
            if (regenerateBtn && !regenerateBtn.disabled) {
                this.regenerateSplit();
            } else {
                console.log('>>> Regenerate not available (button disabled)');
                this.uiController.showError('Split a polygon first to enable regenerate');
            }

            this.keysPressed.clear();
            return false;
        }

        const inPolygonMode = !window.AppMode || window.AppMode.current === 'polygon';

        // S key: Split polygon (polygon mode only)
        if (hasS && !hasCtrlOrMeta && inPolygonMode) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            console.log('>>> S: Split polygon triggered');

            const splitBtn = document.getElementById('splitBtn');
            if (splitBtn && !splitBtn.disabled) {
                this.showSplitDialog();
            } else {
                this.uiController.showError('Select exactly 1 polygon to split');
            }

            this.keysPressed.clear();
            return false;
        }

        // C key: redistricting ward actions, density input, or split by vertices
        if (hasC && !hasCtrlOrMeta) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            // Redistricting mode: C manages ward create/confirm/edit
            if (window.AppMode && window.AppMode.current === 'redistricting' && window.WardManager) {
                if (!window.WardManager.isCreateMode()) {
                    // C pressed outside create mode: open create panel (or edit selected ward)
                    window.WardManager.activateCKey();
                } else {
                    // C pressed in create mode: confirm the current ward
                    document.getElementById('wardConfirmBtn')?.click();
                }
                this.keysPressed.clear();
                return false;
            }

            // Density input only in population mode
            const inPopulationMode = window.AppMode && window.AppMode.current === 'population';
            if (inPopulationMode && this.selectedPolygonIndex !== null) {
                this.showDensityInput(this.selectedPolygonIndex);
                this.keysPressed.clear();
                return false;
            }

            if (inPolygonMode) {
                // Only count VNs that are STILL selected in the manager right now.
                // Stale entries (deselected after X/Y align, midpoint, etc.) are excluded.
                const effectiveSeq = this._getEffectiveSplitSequence();
                const seqVNCount   = effectiveSeq.filter(s => s.type === 'virtual').length;
                const seqRingCount = effectiveSeq.filter(s => s.type === 'ring').length;

                if (seqVNCount > 0 && seqRingCount >= 2) {
                    // Corner-based split: unified click-order sequence defines polygon shape.
                    console.log('>>> C: Corner-based split triggered');
                    this.handleCornerBasedSplit();
                } else {
                    console.log('>>> C: Split by vertices triggered');
                    const splitByVerticesBtn = document.getElementById('splitByVerticesBtn');
                    if (splitByVerticesBtn && !splitByVerticesBtn.disabled) {
                        this.handleSplitByVertices();
                    } else {
                        this.uiController.showError('Select at least 3 vertices in the same county to split');
                    }
                }
            }

            this.keysPressed.clear();
            return false;
        }

        // 1 key: Replace vertex with previous (polygon mode only)
        if (has1 && !hasCtrlOrMeta && inPolygonMode) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const replaceBtn = document.getElementById('replaceVertexBtn');
            if (replaceBtn && !replaceBtn.disabled) {
                this.handleVertexReplaceWithKey('previous');
            } else {
                this.uiController.showError('Select exactly 1 non-fixed vertex to replace');
            }

            this.keysPressed.clear();
            return false;
        }

        // 2 key: Replace vertex with next (polygon mode only)
        if (has2 && !hasCtrlOrMeta && inPolygonMode) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const replaceBtn = document.getElementById('replaceVertexBtn');
            if (replaceBtn && !replaceBtn.disabled) {
                this.handleVertexReplaceWithKey('next');
            } else {
                this.uiController.showError('Select exactly 1 non-fixed vertex to replace');
            }

            this.keysPressed.clear();
            return false;
        }

        // 0–5 keys: Quick location assignment in Edit Location mode
        const inDistrictTypeMode = window.AppMode && window.AppMode.current === 'districtType';
        const editLocationActive = document.getElementById('editLocationBtn')?.classList.contains('active');
        if (inDistrictTypeMode && editLocationActive && !hasCtrlOrMeta && this.selectedPolygonIndex !== null) {
            const LOCATION_KEY_MAP = {
                '1': 'Inner City',
                '2': 'Outer City',
                '3': 'Suburb',
                '4': 'Town',
                '5': 'Rural',
                '0': '',
            };
            if (e.key in LOCATION_KEY_MAP) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                const chosenValue = LOCATION_KEY_MAP[e.key];
                const indices = this.selectedPolygonIndices.size > 0
                    ? Array.from(this.selectedPolygonIndices)
                    : [this.selectedPolygonIndex];

                indices.forEach(idx => {
                    const polygon = this.polygons[idx];
                    if (!polygon) return;
                    polygon.location = chosenValue;
                    if (this.dataManager.originalData &&
                            this.dataManager.originalData[polygon.rowIndex] !== undefined) {
                        this.dataManager.originalData[polygon.rowIndex].Location = chosenValue;
                    }
                });

                const label = indices.length > 1
                    ? `Location changed: ${indices.length} polygons`
                    : `Location changed: ${this.polygons[indices[0]]?.id}`;
                this.historyManager.saveToHistory(this.polygons, label);
                this.updateUndoRedoButtons();
                this.draw();
                this.updatePolygonInfo();

                this.keysPressed.clear();
                return false;
            }
        }

        // Type shortcuts — only when Edit Type button is active AND in districtType mode
        const editTypeActive = document.getElementById('editTypeBtn')?.classList.contains('active');
        if (inDistrictTypeMode && editTypeActive && !hasCtrlOrMeta && this.selectedPolygonIndex !== null) {
            // Valid codes per Location — must match exactly what the cluster allows
            const TYPE_CLUSTER = {
                'Inner City': { S:1, A1:1, A2:1, B1:1, C1:1, C2:1, D1:1, D2:1, E1:1, E2:1, F1:1, F2:1, TECH:1, UNI:1 },
                'Outer City': { A1:1, A2:1, B1:1, C1:1, C2:1, D1:1, D2:1, E1:1, E2:1, F1:1, F2:1, UNI:1 },
                'Rural':      { A1:1, C1:1, D1:1, D2:1, F1:1 },
                'Suburb':     { A1:1, B1:1, C1:1, C2:1, E2:1, F1:1, UNI:1 },
                'Town':       { B2:1, C1:1, C2:1, D2:1, E1:1, F1:1 },
            };

            // Returns true if the code is valid for the polygon's location (empty = NA, always valid)
            const isValidForLocation = (code, location) => {
                if (code === '') return true;
                return !!(TYPE_CLUSTER[location] && TYPE_CLUSTER[location][code]);
            };

            // Digit 1–6 map to letters A–F with per-polygon cycling:
            //   not starting with letter → {Letter}1
            //   {Letter}1               → {Letter}2
            //   {Letter}2 (or other)    → {Letter}1
            const DIGIT_TO_LETTER = { '1':'A', '2':'B', '3':'C', '4':'D', '5':'E', '6':'F' };

            const cycleLetterCode = (currentType, letter) => {
                if (!currentType || !currentType.toUpperCase().startsWith(letter)) return letter + '1';
                if (currentType.toUpperCase() === letter + '1') return letter + '2';
                return letter + '1';
            };

            const k = e.key;
            let simpleCode  = null;   // same code for all selected polygons
            let cycleLetter = null;   // per-polygon cycle

            if      (k === 's' || k === 'S') simpleCode  = 'S';
            else if (k === 'u' || k === 'U') simpleCode  = 'UNI';
            else if (k === 't' || k === 'T') simpleCode  = 'TECH';
            else if (k === '0')              simpleCode  = '';
            else if (k in DIGIT_TO_LETTER)   cycleLetter = DIGIT_TO_LETTER[k];

            if (simpleCode !== null || cycleLetter !== null) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                const indices = this.selectedPolygonIndices.size > 0
                    ? Array.from(this.selectedPolygonIndices)
                    : [this.selectedPolygonIndex];

                let changed = 0;
                indices.forEach(idx => {
                    const polygon = this.polygons[idx];
                    if (!polygon) return;
                    const code = cycleLetter !== null
                        ? cycleLetterCode(polygon.polygonType || '', cycleLetter)
                        : simpleCode;
                    // Skip if this code is not valid for the polygon's location
                    if (!isValidForLocation(code, polygon.location)) return;
                    polygon.polygonType = code;
                    if (this.dataManager.originalData &&
                            this.dataManager.originalData[polygon.rowIndex] !== undefined) {
                        this.dataManager.originalData[polygon.rowIndex].County_Type = code;
                    }
                    changed++;
                });

                if (changed > 0) {
                    const label = changed > 1
                        ? `Type changed: ${changed} polygons`
                        : `Type changed: ${this.polygons[indices.find(i => this.polygons[i])]?.id}`;
                    this.historyManager.saveToHistory(this.polygons, label);
                    this.updateUndoRedoButtons();
                    this.draw();
                    this.updatePolygonInfo();
                }

                this.keysPressed.clear();
                return false;
            }
        }

        // O key: Snap third vertex to be orthogonal to first two (polygon mode only)
        if ((e.key === 'o' || e.key === 'O') && !hasCtrlOrMeta && inPolygonMode) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.handleOrthogonalSnap();
            this.keysPressed.clear();
            return false;
        }

        // V key: Toggle virtual-node mode (polygon mode only)
        if ((e.key === 'v' || e.key === 'V') && !hasCtrlOrMeta && inPolygonMode) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.toggleVirtualNodeMode();
            this.keysPressed.clear();
            return false;
        }

        // X key: Align selected virtual nodes (if any selected) OR real vertices
        if ((e.key === 'x' || e.key === 'X') && !hasCtrlOrMeta && inPolygonMode) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (this.virtualNodeManager.getSelectedCount() >= 2) {
                this.handleVirtualNodeAlignX();
            } else {
                this.handleAlignX();
            }
            this.keysPressed.clear();
            return false;
        }

        // Y key: Align selected virtual nodes (if any selected) OR real vertices
        if ((e.key === 'y' || e.key === 'Y') && !hasCtrlOrMeta && inPolygonMode) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (this.virtualNodeManager.getSelectedCount() >= 2) {
                this.handleVirtualNodeAlignY();
            } else {
                this.handleAlignY();
            }
            this.keysPressed.clear();
            return false;
        }

        // + / - keys: Nudge density of selected polygon(s)
        const isPlus  = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd';
        const isMinus = e.key === '-' || e.code === 'NumpadSubtract' || e.code === 'Minus';
        if ((isPlus || isMinus) && !hasCtrlOrMeta) {
            const targets = this.selectedPolygonIndices.size > 0
                ? [...this.selectedPolygonIndices]
                : (this.selectedPolygonIndex !== null ? [this.selectedPolygonIndex] : []);
            if (targets.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                this.nudgeDensity(targets, isPlus ? 1 : -1);
                this.keysPressed.clear();
                return false;
            }
        }
    }

    /**
     * Handle keyboard shortcuts - keyup
     * @param {KeyboardEvent} e - Keyboard event
     */
    handleKeyUp(e) {
        // Remove keys from pressed set when released
        const isCtrl = e.code === 'ControlLeft' || e.code === 'ControlRight' ||
                       e.key === 'Control';
        const isMeta = e.code === 'MetaLeft' || e.code === 'MetaRight' ||
                       e.key === 'Meta';

        if (isCtrl) {
            this.keysPressed.delete('Control');
        }
        if (isMeta) {
            this.keysPressed.delete('Meta');
        }
        if (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z') {
            this.keysPressed.delete('KeyZ');
        }
        if (e.code === 'KeyY' || e.key === 'y' || e.key === 'Y') {
            this.keysPressed.delete('KeyY');
        }
        if (e.code === 'KeyC' || e.key === 'c' || e.key === 'C') {
            this.keysPressed.delete('KeyC');
        }
        if (e.code === 'Digit1' || e.key === '1') {
            this.keysPressed.delete('Digit1');
        }
        if (e.code === 'Digit2' || e.key === '2') {
            this.keysPressed.delete('Digit2');
        }
    }

    /**
     * Setup mouse interaction callbacks
     */
    setupMouseCallbacks() {
        const isVertexEditAllowed = () =>
            !window.AppMode || window.AppMode.current === 'polygon';

        this.mouseHandler.setCallbacks({
            onVertexSelect: (dataX, dataY, cursorCheckOnly = false) => {
                if (!isVertexEditAllowed()) return { vertexFound: false };
                return this.handleVertexSelection(dataX, dataY, cursorCheckOnly);
            },
            onVertexClick: (dataX, dataY) => {
                // Shift+click always checks virtual nodes first (mode-independent)
                if (this.virtualNodeManager.count > 0) {
                    const tol = 14 / this.geometryOps.scale;
                    const hit = this.virtualNodeManager.findNearest(dataX, dataY, tol);
                    if (hit) {
                        const wasSelected = hit.selected;
                        this.virtualNodeManager.toggleSelect(hit.id);
                        if (wasSelected) {
                            this._splitSequence = this._splitSequence.filter(
                                s => !(s.type === 'virtual' && s.id === hit.id)
                            );
                        } else {
                            this._splitSequence.push({ type: 'virtual', id: hit.id, x: hit.x, y: hit.y });
                        }
                        this.draw();
                        return { vertexFound: true };
                    }
                }
                if (!isVertexEditAllowed()) return false;
                return this.handleVertexClick(dataX, dataY);
            },
            onVertexDrag: (vertex, newX, newY) => {
                if (!isVertexEditAllowed()) return;
                this.handleVertexDrag(vertex, newX, newY);
            },
            onPolygonSelect: (dataX, dataY, cursorCheckOnly = false, isCtrlKey = false) => {
                // Virtual-node mode: intercept real clicks to place/select nodes
                if (this.virtualNodeMode && !cursorCheckOnly) {
                    return this.handleVirtualNodeCanvasClick(dataX, dataY);
                }
                return this.handlePolygonSelection(dataX, dataY, cursorCheckOnly, isCtrlKey);
            },
            onDeselectPolygon: () => {
                this.selectPolygon(null);
                this.draw();
            },
            onViewUpdate: () => {
                this.draw();
            },
            onVertexDelete: () => {
                // Selected virtual nodes always take priority regardless of mode flag
                if (this.virtualNodeManager.getSelectedCount() > 0) {
                    this.handleVirtualNodeDelete();
                    return;
                }
                if (!isVertexEditAllowed()) return;
                // If no vertex is selected but a polygon is selected, delete the polygon.
                if (this.vertexSelection.getSelectionCount() === 0 && this.selectedPolygonIndex !== null) {
                    this.deleteSelectedPolygon();
                    return;
                }
                this.handleVertexDelete();
            },
            onDragEnd: () => {
                if (this.vertexWasDragged && isVertexEditAllowed()) {
                    this.historyManager.saveToHistory(this.polygons, 'Vertex moved');
                    this.updateUndoRedoButtons();
                    this.updateAdjacencyAfterEdit();
                    this.vertexWasDragged = false;
                } else {
                    this.vertexWasDragged = false;
                }
                this.draw();
            },
            onReplacementDragEnd: (sourceVertex, targetX, targetY) => {
                if (!isVertexEditAllowed()) return;
                this.handleVertexReplacement(sourceVertex, targetX, targetY);
            },
            onMidpointCreate: () => {
                // If exactly 2 virtual nodes are selected, midpoint them (mode-independent)
                if (this.virtualNodeManager.getSelectedCount() === 2) {
                    this.handleVirtualNodeMidpoint();
                    return;
                }
                if (!isVertexEditAllowed()) return;
                this.handleMidpointCreate();
            }
        });
    }

    /**
     * Handle file selection and loading
     * @param {Event} e - Select change event
     */
    async handleFileSelect(e) {
        let source = e.target.value;

        // Support file upload through Add Files mode by providing a File object
        if (!source && e.target.files && e.target.files.length > 0) {
            source = e.target.files[0];
        }

        if (!source) {
            console.warn('handleFileSelect: empty selection');
            return;
        }

        this.uiController.setLoadingState(true);

        const sourceLabel = source instanceof File ? source.name : source;
        console.log(`handleFileSelect: loading ${sourceLabel}`);

        try {
            const result = await this.dataManager.loadCSV(source);

            // Load sub-county data and automatically generate county layer in memory
            console.log(`Loaded ${result.count} sub-county polygons`);

            // Load data into layer manager (generates county layer automatically)
            await this.layerManager.loadSubCountyData(result.polygons, this.dataManager);

            // CRITICAL: Initialize fixed county vertices from generated county layer
            // These vertices are IMMUTABLE and protect county boundaries from editing
            console.log('Initializing fixed county vertices (IMMUTABLE)...');
            this.fixedCountyVertices.initialize(this.layerManager.layers.county.polygons);

            // Start with sub-county layer visible
            this.layerManager.layers.subCounty.visible = true;
            this.layerManager.layers.county.visible = false;

            // Switch to sub-county layer
            this.switchToSubCountyLayer();

            // Update button states
            const layerCountyBtn = document.getElementById('layerCounty');
            const layerSubCountyBtn = document.getElementById('layerSubCounty');
            if (layerCountyBtn) layerCountyBtn.classList.remove('active');
            if (layerSubCountyBtn) layerSubCountyBtn.classList.add('active');

            this.geometryOps.calculateBounds(this.polygons);
            this.geometryOps.fitToView();

            // Generate street layer for the loaded data's bounding box
            // this.streetLayer.generate(this.geometryOps.bounds);  // deferred: generated on first toggle-on

            // Build adjacency graph
            console.log('Building adjacency graph...');
            this.adjacencyGraph.buildAdjacencyList(this.polygons);
            const stats = this.adjacencyGraph.getStatistics();
            console.log('Adjacency graph built:', stats);

            // Synchronize T-junction vertices on load.
            // When a vertex of polygon A lies on an edge of polygon B (but B doesn't
            // have that vertex in its ring), gaps appear at shared boundaries.
            // syncVertices() inserts those missing vertices into each ring so every
            // polygon has all shared boundary vertices explicitly listed.
            console.log('Synchronizing shared T-junction vertices on load...');
            this.polygons = this.vertexSync.syncVertices(this.polygons, this.adjacencyGraph);
            // syncVertices returns a new array — keep layer manager in sync so draw()
            // reads from the same objects that all mutation operations write to.
            this.layerManager.layers.subCounty.polygons = this.polygons;
            // Rebuild adjacency after sync — new vertices can change shared-edge detection
            this.adjacencyGraph.buildAdjacencyList(this.polygons);
            console.log('Load-time vertex sync complete');

            // Update UI
            this.uiController.setExportEnabled(true);
            this.uiController.setEditingEnabled(true);

            // Initialize history
            this.historyManager.clearHistory();
            this.historyManager.saveToHistory(this.polygons, 'Initial load');
            this.updateUndoRedoButtons();

            // Draw the scene
            this.draw();

            this.uiController.showSuccess(`Sub-County layer loaded successfully! Found ${result.count} polygons.`);

            // Update Est Population button label based on actual vs estimated data
            if (window._updatePopulationBtnLabel) {
                window._updatePopulationBtnLabel(this.polygons);
            }

            // Populate council dropdown for Redistricting mode
            if (window._updateCouncilSelect) {
                window._updateCouncilSelect(this.polygons);
            }

            // Reload ward assignments from CSV data
            if (window.WardManager && window.WardManager.loadFromPolygons) {
                window.WardManager.loadFromPolygons(this.polygons);
            }

            // Reset any active district filter from a previous load
            this.districtFilter = null;

        } catch (error) {
            console.error('Failed to load CSV:', error);
            this.uiController.showError(`Failed to load CSV: ${error.message}`);
        } finally {
            this.uiController.setLoadingState(false);
        }
    }


    /**
     * Handle vertex selection for editing
     * @param {number} dataX - X coordinate in data space
     * @param {number} dataY - Y coordinate in data space
     * @param {boolean} cursorCheckOnly - True if only checking for cursor update
     * @returns {Object} - Selection result
     */
    handleVertexSelection(dataX, dataY, cursorCheckOnly = false) {
        if (!this.isEditMode || this.selectedPolygonIndex === null) {
            return { vertexFound: false };
        }

        const polygon = this.polygons[this.selectedPolygonIndex];

        // Guard: index may be stale if polygons were reloaded without resetting selection
        if (!polygon) {
            this.selectedPolygonIndex = null;
            return { vertexFound: false };
        }

        // Prevent editing county layer polygons
        if (polygon.layerType === 'county') {
            return { vertexFound: false };
        }
        const tolerance = 20 / this.geometryOps.scale; // 20 pixels in data units

        // Check each ring for vertices
        for (let ringIndex = 0; ringIndex < polygon.rings.length; ringIndex++) {
            const ring = polygon.rings[ringIndex];
            for (let vertexIndex = 0; vertexIndex < ring.length; vertexIndex++) {
                const vertex = ring[vertexIndex];
                const distance = this.geometryOps.calculateDistance(
                    { x: dataX, y: dataY },
                    vertex
                );

                if (distance < tolerance) {
                    // CRITICAL: Block protected vertices (fixed or cross-county) from dragging.
                    // For cursor-hover checks use the O(1) fixed-vertex lookup; only pay the full
                    // O(N×V) classify() cost on an actual click attempt.
                    const isProtected = cursorCheckOnly
                        ? this.fixedCountyVertices.isFixedVertex(vertex.x, vertex.y)
                        : this.vertexClassifier.isProtected(vertex.x, vertex.y, this.polygons);

                    if (isProtected) {
                        if (!cursorCheckOnly) {
                            const type = this.vertexClassifier.classify(vertex.x, vertex.y, this.polygons);
                            console.log(`Cannot select ${this.vertexClassifier.label(type)} vertex for dragging`);
                        }
                        return { vertexFound: false, isFixed: true };
                    }

                    if (!cursorCheckOnly) {
                        // Store valid state before editing (for overlap detection)
                        this.overlapDetection.storeValidState(this.selectedPolygonIndex, this.polygons);
                    }

                    return {
                        vertexFound: true,
                        vertex: {
                            polygonIndex: this.selectedPolygonIndex,
                            ringIndex,
                            vertexIndex,
                            originalPosition: { x: vertex.x, y: vertex.y }
                        }
                    };
                }
            }
        }

        return { vertexFound: false };
    }

    /**
     * Handle vertex dragging
     * @param {Object} vertex - Vertex information
     * @param {number} newX - New X coordinate
     * @param {number} newY - New Y coordinate
     */
    handleVertexDrag(vertex, newX, newY) {
        const polygon = this.polygons[vertex.polygonIndex];
        const vertexObj = polygon.rings[vertex.ringIndex][vertex.vertexIndex];

        const oldX = vertexObj.x;
        const oldY = vertexObj.y;

        // CRITICAL: Block protected vertices (fixed or cross-county) from dragging
        if (this.vertexClassifier.isProtected(oldX, oldY, this.polygons)) {
            const type = this.vertexClassifier.classify(oldX, oldY, this.polygons);
            console.log(`Cannot drag ${this.vertexClassifier.label(type)} vertex`);
            this.uiController.showError(`Cannot move ${this.vertexClassifier.label(type)} vertex`);
            return;
        }

        // Round coordinates to 4 decimal places
        newX = this.dataManager.roundCoordinate(newX);
        newY = this.dataManager.roundCoordinate(newY);

        // Mark that we're editing
        this.vertexWasDragged = true;

        // Update shared vertices
        const affectedPolygons = this.sharedVertices.updateSharedVertices(
            oldX, oldY, newX, newY, this.polygons
        );

        // Update display
        this.draw();
        this.updatePolygonInfo();

        // Show shared vertex info
        if (affectedPolygons.length > 1) {
            const polygonNames = affectedPolygons.map(index => this.polygons[index].id);
            this.uiController.showSharedVertexInfo(polygonNames);
        } else {
            this.uiController.hideSharedVertexInfo();
        }
    }

    /**
     * Handle vertex clicking for selection (Shift+Click)
     * Finds and selects the nearest vertex to the click position
     * @param {number} dataX - X coordinate in data space
     * @param {number} dataY - Y coordinate in data space
     * @returns {Object} - Selection result
     */
    handleVertexClick(dataX, dataY) {
        // Find the nearest vertex — prefer the currently selected polygon so that
        // boundary vertices (which exist in multiple polygons) are always resolved
        // to the same polygon as previously selected vertices. This prevents
        // groupVerticesByRing from splitting a pair into separate single-vertex groups,
        // which would silently produce 0 midpoints or fail the adjacency check.
        let nearestVertex = null;
        let minDistance = Infinity;

        // Already-selected vertices tell us which polygon to prefer
        const alreadySelectedInfo = this.vertexSelection.getSelectedVertexInfo(this.polygons);
        const preferredPolyIndex = alreadySelectedInfo.length > 0
            ? alreadySelectedInfo[0].polygonIndex
            : (this.selectedPolygonIndex !== null ? this.selectedPolygonIndex : -1);

        for (let polygonIndex = 0; polygonIndex < this.polygons.length; polygonIndex++) {
            const polygon = this.polygons[polygonIndex];

            for (let ringIndex = 0; ringIndex < polygon.rings.length; ringIndex++) {
                const ring = polygon.rings[ringIndex];

                // ring.length - 1: skip the closing duplicate (same coords as index 0)
                // so shift-click at the first vertex always resolves to index 0, not index N
                for (let vertexIndex = 0; vertexIndex < ring.length - 1; vertexIndex++) {
                    const vertex = ring[vertexIndex];
                    let distance = this.geometryOps.calculateDistance(
                        { x: dataX, y: dataY },
                        vertex
                    );

                    // Apply a small preference bias toward the preferred polygon so that
                    // an equally-close vertex in the preferred polygon always wins.
                    // Bias is tiny (0.001) — only breaks ties, never overrides a genuinely
                    // closer vertex in a different polygon.
                    if (polygonIndex !== preferredPolyIndex) {
                        distance += 0.001;
                    }

                    if (distance < minDistance) {
                        minDistance = distance;
                        nearestVertex = {
                            polygonIndex,
                            ringIndex,
                            vertexIndex,
                            vertex,
                            distance
                        };
                    }
                }
            }
        }

        // If we found a nearest vertex, select it
        if (nearestVertex) {
            const isSelected = this.vertexSelection.toggleVertex(
                nearestVertex.polygonIndex,
                nearestVertex.ringIndex,
                nearestVertex.vertexIndex,
                this.polygons
            );

            console.log(`Nearest vertex ${isSelected ? 'selected' : 'deselected'}: polygon=${nearestVertex.polygonIndex}, ring=${nearestVertex.ringIndex}, vertex=${nearestVertex.vertexIndex}, distance=${nearestVertex.distance.toFixed(4)}`);

            // Maintain unified split sequence in click order
            const seqKey = `${nearestVertex.polygonIndex}:${nearestVertex.ringIndex}:${nearestVertex.vertexIndex}`;
            if (isSelected) {
                this._splitSequence.push({
                    type: 'ring',
                    key: seqKey,
                    polygonIndex: nearestVertex.polygonIndex,
                    ringIndex:    nearestVertex.ringIndex,
                    vertexIndex:  nearestVertex.vertexIndex,
                    x: nearestVertex.vertex.x,
                    y: nearestVertex.vertex.y
                });
            } else {
                this._splitSequence = this._splitSequence.filter(s => s.key !== seqKey);
            }

            if (isSelected) {
                this.draggedVertex = {
                    polygonIndex: nearestVertex.polygonIndex,
                    ringIndex: nearestVertex.ringIndex,
                    vertexIndex: nearestVertex.vertexIndex,
                    x: nearestVertex.vertex.x,
                    y: nearestVertex.vertex.y
                };
            } else {
                this.draggedVertex = null;
            }

            this.updateVertexSelectionInfo();
            this.draw();

            return { vertexFound: true, isSelected };
        }

        return { vertexFound: false };
    }

    /**
     * Clear vertex selection
     */
    clearVertexSelection() {
        this.vertexSelection.clearSelection();
        this._splitSequence = [];
        this.virtualNodeManager.clearSelection();
        this.updateVertexSelectionInfo();
        this.draw();
    }

    /**
     * Handle vertex deletion (Delete/Backspace key pressed)
     */
    handleVertexDelete() {
        // Check if exactly one vertex is selected
        const selectionCount = this.vertexSelection.getSelectionCount();

        if (selectionCount === 0) {
            console.log('No vertex selected for deletion');
            return;
        }

        if (selectionCount > 1) {
            alert('Please select only one vertex to delete');
            return;
        }

        // Get the selected vertex
        const selectedInfo = this.vertexSelection.getSelectedVertexInfo(this.polygons);
        if (selectedInfo.length === 0) {
            console.log('No valid vertex found');
            return;
        }

        const vertexToDelete = selectedInfo[0];

        console.log(`Attempting to delete vertex at (${vertexToDelete.x}, ${vertexToDelete.y})`);

        // Attempt deletion using the VertexDeletion algorithm
        const result = this.vertexDeletion.deleteVertex(this.polygons, {
            polygonIndex: vertexToDelete.polygonIndex,
            ringIndex: vertexToDelete.ringIndex,
            vertexIndex: vertexToDelete.vertexIndex
        });

        if (result.success) {
            // deleteVertex mutates polygons in place and returns the same reference.
            // The adjacency graph still holds the PRE-deletion neighbor lists here,
            // which is exactly what we need to compute the zone for rebuildForAffected.
            this.polygons = result.polygons;

            // Clear vertex selection
            this.vertexSelection.clearSelection();
            this.updateVertexSelectionInfo();

            // CRITICAL: Targeted adjacency rebuild — O(Z²·V²) instead of O(P²·V²).
            // affectedIndices = polygons whose rings were mutated (shared-vertex holders
            // + the gap-absorber if one was needed).  Their OLD neighbors are read from
            // the stale adjacency graph before it is updated, forming the zone.
            console.log('Rebuilding adjacency graph after deletion...');
            const affectedIds = (result.affectedIndices || [])
                .map(i => this.polygons[i]?.id)
                .filter(Boolean);

            if (affectedIds.length > 0) {
                const zoneIds = [...new Set([
                    ...affectedIds,
                    ...affectedIds.flatMap(id => this.adjacencyGraph.getNeighbors(id))
                ])];
                this.adjacencyGraph.rebuildForAffected(this.polygons, affectedIds, zoneIds);
            } else {
                // Fallback: affectedIndices missing (shouldn't happen), do full rebuild
                this.adjacencyGraph.buildAdjacencyList(this.polygons);
            }

            const stats = this.adjacencyGraph.getStatistics();
            console.log('Adjacency graph rebuilt:', stats);

            // Save to history (after rebuilding shared vertices and adjacency)
            this.historyManager.saveToHistory(this.polygons, result.message);
            this.updateUndoRedoButtons();

            // Update UI
            this.uiController.populatePolygonSelect(this.polygons);

            // Redraw
            this.draw();

            console.log('Vertex deleted successfully:', result.message);
            this.uiController.showStatus(result.message);
        } else {
            console.log('Vertex deletion failed:', result.message);
            alert('Cannot delete vertex: ' + result.message);
        }
    }

    /**
     * Handle vertex replacement by dragging to adjacent vertex
     * @param {Object} sourceVertex - Source vertex being dragged (from MouseHandler)
     * @param {number} targetX - Target X coordinate where drag ended
     * @param {number} targetY - Target Y coordinate where drag ended
     */
    handleVertexReplacement(sourceVertex, targetX, targetY) {
        if (!sourceVertex || !this.draggedVertex) {
            console.log('No vertex selected for replacement');
            return;
        }

        console.log(`Attempting vertex replacement: source=(${sourceVertex.x}, ${sourceVertex.y}) to target=(${targetX}, ${targetY})`);

        // Find target vertex at the drop position
        const tolerance = 20 / this.geometryOps.scale; // 20 pixels in data units
        let targetVertex = null;

        // Search all polygons for vertices at target position
        for (let polygonIndex = 0; polygonIndex < this.polygons.length; polygonIndex++) {
            const polygon = this.polygons[polygonIndex];

            for (let ringIndex = 0; ringIndex < polygon.rings.length; ringIndex++) {
                const ring = polygon.rings[ringIndex];

                for (let vertexIndex = 0; vertexIndex < ring.length; vertexIndex++) {
                    const vertex = ring[vertexIndex];
                    const distance = this.geometryOps.calculateDistance(
                        { x: targetX, y: targetY },
                        vertex
                    );

                    if (distance < tolerance) {
                        targetVertex = {
                            polygonIndex,
                            ringIndex,
                            vertexIndex,
                            x: vertex.x,
                            y: vertex.y
                        };
                        break;
                    }
                }
                if (targetVertex) break;
            }
            if (targetVertex) break;
        }

        if (!targetVertex) {
            console.log('No target vertex found at drop position');
            this.uiController.showStatus('Drag to an adjacent vertex to replace');

            // Clear drag state
            this.draggedVertex = null;
            this.isDraggingVertex = false;
            this.vertexSelection.clearSelection();
            this.updateVertexSelectionInfo();
            this.draw();
            return;
        }

        // Check if source and target are the same
        if (sourceVertex.polygonIndex === targetVertex.polygonIndex &&
            sourceVertex.ringIndex === targetVertex.ringIndex &&
            sourceVertex.vertexIndex === targetVertex.vertexIndex) {
            console.log('Source and target are the same vertex');
            this.draggedVertex = null;
            this.isDraggingVertex = false;
            this.draw();
            return;
        }

        // Attempt replacement using VertexReplacement
        const result = this.vertexReplacement.replaceVertex(
            this.polygons,
            this.draggedVertex, // Use the stored draggedVertex from Shift+Click
            targetVertex
        );

        if (result.success) {
            // Update polygons with result
            this.polygons = result.polygons;

            // Clear vertex selection
            this.vertexSelection.clearSelection();
            this.updateVertexSelectionInfo();

            // CRITICAL: Validate shared vertices after replacement
            console.log('Validating shared vertices after replacement...');
            const validation = this.sharedVertices.validateSharedVertices(this.polygons);
            if (!validation.isValid) {
                console.warn('Shared vertex validation found issues:', validation.issues);
            } else {
                console.log(`✓ Shared vertices validated: ${validation.sharedGroupCount} groups, ${validation.totalSharedVertices} total vertices`);
            }

            // CRITICAL: Rebuild adjacency graph (full rebuild since replacement affects multiple polygons)
            console.log('Rebuilding adjacency graph after replacement...');
            this.adjacencyGraph.buildAdjacencyList(this.polygons);

            const stats = this.adjacencyGraph.getStatistics();
            console.log('Adjacency graph rebuilt:', stats);

            // Save to history (after rebuilding shared vertices and adjacency)
            this.historyManager.saveToHistory(this.polygons, result.message);
            this.updateUndoRedoButtons();

            // Update UI
            this.uiController.populatePolygonSelect(this.polygons);

            // Redraw
            this.draw();

            console.log('Vertex replaced successfully:', result.message);
            this.uiController.showStatus(result.message);
        } else {
            console.log('Vertex replacement failed:', result.message);
            alert('Cannot replace vertex: ' + result.message);
        }

        // Clear drag state
        this.draggedVertex = null;
        this.isDraggingVertex = false;
    }

    /**
     * Handle vertex replacement using keyboard (1 = previous, 2 = next)
     * @param {string} direction - 'previous' or 'next'
     */
    handleVertexReplaceWithKey(direction) {
        // Get selected vertices
        const selectedInfo = this.vertexSelection.getSelectedVertexInfo(this.polygons);

        if (selectedInfo.length !== 1) {
            console.log('Exactly 1 vertex must be selected for replacement');
            this.uiController.showError('Select exactly 1 vertex to replace');
            return;
        }

        const sourceInfo = selectedInfo[0];
        const polygon = this.polygons[sourceInfo.polygonIndex];
        const ring = polygon.rings[sourceInfo.ringIndex];

        // Check if source vertex is protected
        if (this.vertexClassifier.isProtected(sourceInfo.x, sourceInfo.y, this.polygons)) {
            const type = this.vertexClassifier.classify(sourceInfo.x, sourceInfo.y, this.polygons);
            console.log(`Cannot replace ${this.vertexClassifier.label(type)} vertex`);
            this.uiController.showError(`Cannot replace ${this.vertexClassifier.label(type)} vertex`);
            return;
        }

        // Calculate target vertex index (previous or next)
        let targetVertexIndex;
        if (direction === 'previous') {
            // Previous vertex (wraps around)
            targetVertexIndex = (sourceInfo.vertexIndex - 1 + ring.length) % ring.length;
        } else {
            // Next vertex (wraps around)
            targetVertexIndex = (sourceInfo.vertexIndex + 1) % ring.length;
        }

        const targetVertex = ring[targetVertexIndex];

        console.log(`Replacing vertex ${sourceInfo.vertexIndex} with ${direction} vertex ${targetVertexIndex}`);
        console.log(`Source: (${sourceInfo.x}, ${sourceInfo.y}), Target: (${targetVertex.x}, ${targetVertex.y})`);

        // Prepare source and target for VertexReplacement
        const source = {
            polygonIndex: sourceInfo.polygonIndex,
            ringIndex: sourceInfo.ringIndex,
            vertexIndex: sourceInfo.vertexIndex,
            x: sourceInfo.x,
            y: sourceInfo.y
        };

        const target = {
            polygonIndex: sourceInfo.polygonIndex,
            ringIndex: sourceInfo.ringIndex,
            vertexIndex: targetVertexIndex,
            x: targetVertex.x,
            y: targetVertex.y
        };

        // Attempt replacement using VertexReplacement
        const result = this.vertexReplacement.replaceVertex(
            this.polygons,
            source,
            target
        );

        if (result.success) {
            // Update polygons with result
            this.polygons = result.polygons;

            // Clear vertex selection
            this.vertexSelection.clearSelection();
            this.updateVertexSelectionInfo();

            // CRITICAL: Validate shared vertices after replacement
            console.log('Validating shared vertices after replacement...');
            const validation = this.sharedVertices.validateSharedVertices(this.polygons);
            if (!validation.isValid) {
                console.warn('Shared vertex validation found issues:', validation.issues);
            } else {
                console.log(`✓ Shared vertices validated: ${validation.sharedGroupCount} groups, ${validation.totalSharedVertices} total vertices`);
            }

            // CRITICAL: Rebuild adjacency graph (full rebuild since replacement affects multiple polygons)
            console.log('Rebuilding adjacency graph after replacement...');
            this.adjacencyGraph.buildAdjacencyList(this.polygons);

            const stats = this.adjacencyGraph.getStatistics();
            console.log('Adjacency graph rebuilt:', stats);

            // Save to history (after rebuilding shared vertices and adjacency)
            this.historyManager.saveToHistory(this.polygons, result.message);
            this.updateUndoRedoButtons();

            // Update UI
            this.uiController.populatePolygonSelect(this.polygons);

            // Redraw
            this.draw();

            console.log('Vertex replaced successfully:', result.message);
            this.uiController.showStatus(result.message);
        } else {
            console.log('Vertex replacement failed:', result.message);
            alert('Cannot replace vertex: ' + result.message);
        }
    }

    /**
     * Handle midpoint creation (M key pressed)
     * Creates new vertices at midpoints between selected adjacent vertices
     */
    handleMidpointCreate() {
        // Check if at least 2 vertices are selected
        const selectionCount = this.vertexSelection.getSelectionCount();

        if (selectionCount < 2) {
            console.log('At least 2 vertices must be selected for midpoint creation');
            this.uiController.showStatus('Select at least 2 adjacent vertices, then press M');
            return;
        }

        // Get selected vertices
        const selectedInfo = this.vertexSelection.getSelectedVertexInfo(this.polygons);

        console.log(`Attempting midpoint creation with ${selectedInfo.length} selected vertices`);

        // Attempt midpoint creation
        const result = this.midpointCreation.createMidpoints(this.polygons, selectedInfo);

        if (result.success) {
            // Update polygons with result
            this.polygons = result.polygons;

            // Clear vertex selection
            this.vertexSelection.clearSelection();
            this.updateVertexSelectionInfo();

            // Build ID→index map once — replaces all O(N) findIndex calls below
            const idToIndex = new Map(this.polygons.map((p, i) => [p.id, i]));

            if (result.affectedPolygonIds && result.affectedPolygonIds.length > 0) {
                // Expand to affected + their immediate neighbors
                const affectedSet = new Set(result.affectedPolygonIds);
                const affectedIds = result.affectedPolygonIds.map(idx => this.polygons[idx]?.id).filter(Boolean);

                affectedIds.forEach(id => {
                    this.adjacencyGraph.getNeighbors(id).forEach(neighborId => {
                        const nIdx = idToIndex.get(neighborId);
                        if (nIdx !== undefined) affectedSet.add(nIdx);
                    });
                });

                // Rebuild adjacency scoped to the affected zone only (not the full N² rebuild)
                const zoneIds = [...affectedSet].map(i => this.polygons[i]?.id).filter(Boolean);
                this.adjacencyGraph.rebuildForAffected(this.polygons, affectedIds, zoneIds);

                // Safety-net sync: catches residual T-junctions missed by propagateMidpointsToSharedEdges
                console.log(`Syncing ${affectedSet.size} affected + neighbor polygons after midpoint...`);
                this.polygons = this.vertexSync.syncVertices(this.polygons, this.adjacencyGraph, affectedSet, idToIndex);

                // Final scoped rebuild after sync
                this.adjacencyGraph.rebuildForAffected(this.polygons, affectedIds, zoneIds);

                // Sync layer manager — syncVertices returns a new array so the layer
                // manager's reference is now stale; draw() reads from it, not this.polygons
                this.layerManager.layers.subCounty.polygons = this.polygons;
            }

            // Save to history (after rebuilding shared vertices and adjacency)
            this.historyManager.saveToHistory(this.polygons, result.message);
            this.updateUndoRedoButtons();

            // Update UI
            this.uiController.populatePolygonSelect(this.polygons);

            // Redraw
            this.draw();

            console.log('Midpoint creation successful:', result.message);
            this.uiController.showStatus(result.message);
        } else {
            console.log('Midpoint creation failed:', result.message);
            alert('Cannot create midpoints: ' + result.message);
        }
    }

    /**
     * Snap the third shift-selected vertex to be orthogonal to the first two.
     * Selection order determines which coordinates are inherited:
     *   v1=(x1,y1), v2=(x2,y2), v3=(a,b) → v3 becomes (x1, y2)
     * All polygons sharing v3's coordinate are updated together.
     */
    handleOrthogonalSnap() {
        const selectedInfo = this.vertexSelection.getSelectedVertexInfo(this.polygons);

        if (selectedInfo.length !== 3) {
            this.uiController.showError('Select exactly 3 vertices (Shift+Click) then press O');
            return;
        }

        const [v1, v2, v3] = selectedInfo;
        const newX = v1.x;
        const newY = v2.y;

        if (Math.abs(newX - v3.x) < 1e-9 && Math.abs(newY - v3.y) < 1e-9) {
            this.uiController.showStatus('Vertex is already orthogonal — no change needed');
            return;
        }

        this.historyManager.saveToHistory(this.polygons, `Orthogonal snap: ${v3.polygonId}`);

        // Move v3 and all polygons that share its coordinate
        this.sharedVertices.updateSharedVertices(v3.x, v3.y, newX, newY, this.polygons);

        this.vertexSelection.clearSelection();
        this.updateVertexSelectionInfo();
        this.draw();

        this.uiController.showSuccess(
            `Vertex snapped to (${newX.toFixed(4)}, ${newY.toFixed(4)})`
        );
    }

    // ═════════════════════════════════════════════════════════════════════
    // Virtual-node mode
    // ═════════════════════════════════════════════════════════════════════

    /**
     * Toggle virtual-node placement mode on/off.
     * Entering the mode shows a status hint; exiting clears all virtual nodes.
     */
    toggleVirtualNodeMode() {
        this.virtualNodeMode = !this.virtualNodeMode;
        const btn = document.getElementById('virtualNodeModeBtn');

        if (this.virtualNodeMode) {
            if (btn) btn.classList.add('active');
            this.uiController.showStatus(
                '◈ Virtual-node mode ON — click inside the selected polygon to place nodes · ' +
                'Shift+click to select · Del delete · M midpoint · X/Y align · C split · V/Esc to exit (nodes stay)'
            );
        } else {
            if (btn) btn.classList.remove('active');
            // Nodes are NOT cleared — they persist until C (split) or manual Del.
            // Virtual-node mode only controls whether regular clicks place new nodes.
            const n = this.virtualNodeManager.count;
            this.uiController.showStatus(
                n > 0
                    ? `Virtual-node mode OFF — ${n} node${n > 1 ? 's' : ''} kept · press C to split or Del to remove`
                    : 'Virtual-node mode OFF'
            );
        }
        this.draw();
    }

    /**
     * Handle a regular canvas click while virtual-node mode is active.
     * Priority: (1) hit-test existing virtual node → toggle select,
     *           (2) inside selected polygon → place new node,
     *           (3) click a different polygon → switch to it & clear nodes.
     */
    handleVirtualNodeCanvasClick(dataX, dataY) {
        // (1) Hit-test existing virtual nodes (14 px tolerance in data units)
        const tol = 14 / this.geometryOps.scale;
        const hit = this.virtualNodeManager.findNearest(dataX, dataY, tol);
        if (hit) {
            this.virtualNodeManager.toggleSelect(hit.id);
            this.draw();
            // Return polygonSelected:true so MouseHandler does NOT deselect or pan
            return { polygonSelected: true };
        }

        // (2) Click inside a polygon to place a new node.
        //     If that polygon is already selected, place immediately.
        //     If no polygon is selected yet (or a different one is selected), auto-select it
        //     and place the node in the same click — no second click needed.
        const clickedIdx = this.geometryOps.findPolygonAtPosition(dataX, dataY, this.polygons);
        if (clickedIdx !== null) {
            if (clickedIdx !== this.selectedPolygonIndex) {
                this.selectPolygon(clickedIdx);
            }
            this.historyManager.saveToHistory(this.polygons, 'Virtual node placed', this.virtualNodeManager.getSnapshot());
            this.updateUndoRedoButtons();
            this.virtualNodeManager.add(dataX, dataY);
            this.virtualNodeManager.clearSelection();
            this.draw();
            return { polygonSelected: true };
        }

        // (4) Clicked empty space — let normal deselect flow run
        if (this.selectedPolygonIndex === null) {
            this.uiController.showStatus('Select a polygon first, then activate virtual-node mode (V) to place nodes');
        }
        return { polygonFound: false }; // triggers onDeselectPolygon normally
    }

    /** Del key — remove all currently selected virtual nodes. */
    handleVirtualNodeDelete() {
        if (this.virtualNodeManager.getSelectedCount() === 0) return;
        this.historyManager.saveToHistory(this.polygons, 'Virtual node deleted', this.virtualNodeManager.getSnapshot());
        this.updateUndoRedoButtons();
        const removed = this.virtualNodeManager.removeSelected();
        if (removed > 0) {
            // Prune deleted VN IDs from split sequence so stale entries don't accumulate
            const remainingIds = new Set(this.virtualNodeManager.nodes.map(n => n.id));
            this._splitSequence = this._splitSequence.filter(
                s => s.type !== 'virtual' || remainingIds.has(s.id)
            );
            this.uiController.showStatus(`Deleted ${removed} virtual node${removed > 1 ? 's' : ''}`);
            this.draw();
        }
    }

    /** M key — create a midpoint virtual node between the two selected virtual nodes. */
    handleVirtualNodeMidpoint() {
        if (this.virtualNodeManager.getSelectedCount() !== 2) {
            this.uiController.showError('Select exactly 2 virtual nodes, then press M');
            return;
        }
        this.historyManager.saveToHistory(this.polygons, 'Virtual node midpoint', this.virtualNodeManager.getSnapshot());
        this.updateUndoRedoButtons();
        const mid = this.virtualNodeManager.createMidpointBetweenSelected();
        if (mid) {
            this.virtualNodeManager.clearSelection();
            this.uiController.showStatus(`Virtual midpoint created at (${mid.x.toFixed(4)}, ${mid.y.toFixed(4)})`);
            this.draw();
        } else {
            this.uiController.showError('Select exactly 2 virtual nodes, then press M');
        }
    }

    /** X key — align selected virtual nodes to the X of the first selected. */
    handleVirtualNodeAlignX() {
        if (this.virtualNodeManager.getSelectedCount() < 2) {
            this.uiController.showError('Select at least 2 virtual nodes then press X');
            return;
        }
        this.historyManager.saveToHistory(this.polygons, 'Virtual nodes align X', this.virtualNodeManager.getSnapshot());
        this.updateUndoRedoButtons();
        if (this.virtualNodeManager.alignX()) {
            this.uiController.showStatus(`Virtual nodes aligned on X = ${this.virtualNodeManager.getSelected()[0].x.toFixed(4)}`);
            this.draw();
        }
    }

    /** Y key — align selected virtual nodes to the Y of the first selected. */
    handleVirtualNodeAlignY() {
        if (this.virtualNodeManager.getSelectedCount() < 2) {
            this.uiController.showError('Select at least 2 virtual nodes then press Y');
            return;
        }
        this.historyManager.saveToHistory(this.polygons, 'Virtual nodes align Y', this.virtualNodeManager.getSnapshot());
        this.updateUndoRedoButtons();
        if (this.virtualNodeManager.alignY()) {
            this.uiController.showStatus(`Virtual nodes aligned on Y = ${this.virtualNodeManager.getSelected()[0].y.toFixed(4)}`);
            this.draw();
        }
    }

    // ─── Split execution ──────────────────────────────────────────────────

    /**
     * C key (combined mode) — corner-based split using unified selection sequence.
     *
     * The user shift-clicks nodes in the desired polygon order (both virtual nodes and
     * ring vertices, interleaved in any order). _splitSequence preserves this click order.
     * Virtual nodes must form one contiguous group in the sequence, flanked by ring vertices.
     *
     * Result:
     *   ring1 (new polygon) = sequence points, with ring arcs inserted between consecutive
     *                         ring vertices (taking the arc that avoids the other seq ring vertices)
     *   ring2 (remainder)   = original ring with the enclosed arc replaced by the VN cut path
     */
    handleCornerBasedSplit() {
        // Resolve to currently-selected VNs with fresh coordinates (filters stale entries)
        const seq = this._getEffectiveSplitSequence();

        // ── Validate ────────────────────────────────────────────────────────
        const ringItems = seq.filter(s => s.type === 'ring');
        const vnItems   = seq.filter(s => s.type === 'virtual');

        if (ringItems.length < 2) {
            this.uiController.showError('Shift-click at least 2 ring vertices and 1 virtual node, then press C');
            return;
        }
        if (vnItems.length === 0) {
            this.uiController.showError('Shift-click at least 1 virtual node (orange +), then press C');
            return;
        }

        const polyIdx = ringItems[0].polygonIndex;
        if (!ringItems.every(v => v.polygonIndex === polyIdx && v.ringIndex === 0)) {
            this.uiController.showError('All selected vertices must be on the same polygon exterior ring');
            return;
        }

        const polygon = this.polygons[polyIdx];
        const ring    = polygon.rings[0];
        const N       = ring.length - 1; // distinct vertices (ring[0] === ring[N])

        // Virtual nodes must form ONE contiguous group in the sequence
        const vnPositions = seq.map((s, i) => s.type === 'virtual' ? i : -1).filter(i => i >= 0);
        for (let j = 0; j < vnPositions.length - 1; j++) {
            if (vnPositions[j + 1] !== vnPositions[j] + 1) {
                this.uiController.showError(
                    'Virtual nodes must be a contiguous block in the selection order ' +
                    '(e.g. ring → VN1 → VN2 → ring). Re-select in the correct sequence.'
                );
                return;
            }
        }

        const vnGroupStart = vnPositions[0];
        const vnGroupEnd   = vnPositions[vnPositions.length - 1];
        const seqLen       = seq.length;

        // Anchors: ring vertices immediately flanking the VN group (wrap-safe)
        const leftAnchorIdx  = (vnGroupStart - 1 + seqLen) % seqLen;
        const rightAnchorIdx = (vnGroupEnd   + 1         ) % seqLen;
        const leftAnchor     = seq[leftAnchorIdx];
        const rightAnchor    = seq[rightAnchorIdx];

        if (!leftAnchor || leftAnchor.type !== 'ring' ||
            !rightAnchor || rightAnchor.type !== 'ring') {
            this.uiController.showError('Virtual nodes must have ring vertices on both sides in the sequence');
            return;
        }
        const leftVtxIdx  = leftAnchor.vertexIndex;
        const rightVtxIdx = rightAnchor.vertexIndex;
        if (leftVtxIdx === rightVtxIdx) {
            this.uiController.showError('Left and right anchor vertices must be different ring vertices');
            return;
        }

        // "Enclosed" ring vertices = all ring items that are NOT the two anchors
        const anchorKeys     = new Set([leftAnchor.key, rightAnchor.key]);
        const enclosedIdxSet = new Set(
            ringItems.filter(s => !anchorKeys.has(s.key)).map(s => s.vertexIndex)
        );

        const round4 = v => Math.round(v * 10000) / 10000;
        const pt     = p => ({ x: round4(p.x), y: round4(p.y) });

        // ── Build ring1 (new polygon from the unified sequence) ─────────────
        // For consecutive ring-vertex pairs, insert the ring arc that avoids other sequence ring vertices.
        const seqRingIdxSet = new Set(ringItems.map(s => s.vertexIndex));
        const ring1 = [];

        for (let i = 0; i < seqLen; i++) {
            const curr = seq[i];
            const next = seq[(i + 1) % seqLen];
            ring1.push({ x: round4(curr.x), y: round4(curr.y) });

            if (curr.type === 'ring' && next.type === 'ring') {
                const otherIdxs = new Set(seqRingIdxSet);
                otherIdxs.delete(curr.vertexIndex);
                otherIdxs.delete(next.vertexIndex);
                const goFwd = this._arcAvoidOthers(N, curr.vertexIndex, next.vertexIndex, otherIdxs);
                const step  = goFwd ? 1 : -1;
                let ri = ((curr.vertexIndex + step) % N + N) % N;
                while (ri !== next.vertexIndex) {
                    ring1.push(pt(ring[ri]));
                    ri = ((ri + step) % N + N) % N;
                }
            }
        }
        ring1.push({ x: round4(seq[0].x), y: round4(seq[0].y) }); // close

        // ── Build ring2 (remainder) ─────────────────────────────────────────
        // Determine which direction from leftAnchor to rightAnchor contains the enclosed vertices
        let enclosedArcFwd;
        if (enclosedIdxSet.size === 0) {
            const fwdSteps = (rightVtxIdx - leftVtxIdx + N) % N;
            enclosedArcFwd = fwdSteps <= N / 2; // enclosed = shorter arc
        } else {
            enclosedArcFwd = this._arcContainsAll(N, leftVtxIdx, rightVtxIdx, enclosedIdxSet, true);
            if (!enclosedArcFwd &&
                !this._arcContainsAll(N, leftVtxIdx, rightVtxIdx, enclosedIdxSet, false)) {
                this.uiController.showError('Cannot find enclosed ring arc — selected vertices may not all lie on the same ring');
                return;
            }
        }

        // ring2: leftAnchor → complement arc → rightAnchor → VNs reversed → leftAnchor
        const step2 = enclosedArcFwd ? -1 : 1; // complement = opposite of enclosed direction
        const ring2 = [pt(ring[leftVtxIdx])];
        let ri2 = ((leftVtxIdx + step2) % N + N) % N;
        while (ri2 !== rightVtxIdx) {
            ring2.push(pt(ring[ri2]));
            ri2 = ((ri2 + step2) % N + N) % N;
        }
        ring2.push(pt(ring[rightVtxIdx]));
        for (let k = vnGroupEnd; k >= vnGroupStart; k--) {
            ring2.push({ x: round4(seq[k].x), y: round4(seq[k].y) });
        }
        ring2.push(pt(ring[leftVtxIdx])); // close

        if (ring1.length < 4 || ring2.length < 4) {
            this.uiController.showError('Split would create a degenerate polygon — adjust selection');
            return;
        }

        // ── Snapshot + population split ─────────────────────────────────────
        const parentNeighborIds = this.adjacencyGraph.getNeighbors(polygon.id);
        const sourceSnapshot    = JSON.parse(JSON.stringify(polygon));
        const splitStartIndex   = polyIdx;

        const area1    = this._vnRingArea(ring1);
        const area2    = this._vnRingArea(ring2);
        const totalPop = polygon.population || 0;
        const frac1    = (area1 + area2) > 1e-12 ? area1 / (area1 + area2) : 0.5;

        const newPoly1 = Object.assign(JSON.parse(JSON.stringify(polygon)), {
            rings:      [ring1, ...polygon.rings.slice(1)],
            population: Math.round(totalPop * frac1)
        });
        const newPoly2 = Object.assign(JSON.parse(JSON.stringify(polygon)), {
            rings:      [ring2, ...polygon.rings.slice(1)],
            population: Math.round(totalPop * (1 - frac1))
        });

        // ── Replace source polygon with the two pieces ──────────────────────
        const updatedPolygons = [...this.polygons];
        updatedPolygons.splice(splitStartIndex, 1, newPoly1, newPoly2);
        this.polygons = updatedPolygons;

        const county   = polygon.county || polygon.id || 'POLY';
        const splitIds = this.nextPolygonIds(county, 2);
        newPoly1.id = splitIds[0];
        newPoly2.id = splitIds[1];

        // ── Clear selections ────────────────────────────────────────────────
        this.selectedPolygonIndex = null;
        this.selectedPolygonIndices.clear();
        this.vertexSelection.clearSelection();
        this._splitSequence = [];
        this.updateVertexSelectionInfo();

        // ── Adjacency + vertex sync ─────────────────────────────────────────
        const splitZoneIds = [...splitIds, ...parentNeighborIds];
        this.adjacencyGraph.rebuildForAffected(this.polygons, splitIds, splitZoneIds);

        this.polygons = this.vertexSync.syncAfterSplit(
            this.polygons, this.adjacencyGraph,
            splitStartIndex, 2, sourceSnapshot, parentNeighborIds
        );

        this.adjacencyGraph.rebuildForAffected(this.polygons, splitIds, splitZoneIds);
        this.layerManager.layers.subCounty.polygons = this.polygons;

        // ── History + UI ────────────────────────────────────────────────────
        this.historyManager.saveToHistory(this.polygons, `Corner split: ${polygon.id}`);
        this.updateUndoRedoButtons();
        this.uiController.populatePolygonSelect(this.polygons);
        this.uiController.setSelectedPolygon(null);
        this.updateCombineButton();
        this.updateSplitButton();

        // Remove only the virtual nodes used in this split; unselected nodes stay
        this.virtualNodeManager.removeSelected();

        this.draw();
        this.uiController.showStatus(`Split ${polygon.id} → ${splitIds.join(' + ')}`);
    }

    /**
     * Returns _splitSequence filtered to only include VNs that are CURRENTLY selected
     * in virtualNodeManager (deselected after align/midpoint ops are excluded), with VN
     * coordinates refreshed from the manager's live state.
     */
    _getEffectiveSplitSequence() {
        const seen = new Set();
        return this._splitSequence.map(s => {
            if (s.type === 'virtual') {
                const vn = this.virtualNodeManager.nodes.find(n => n.id === s.id);
                if (!vn || !vn.selected) return null;       // deselected or deleted
                if (seen.has(`v:${s.id}`)) return null;     // deduplicate re-selected VNs
                seen.add(`v:${s.id}`);
                return { ...s, x: vn.x, y: vn.y };         // refresh live coords
            } else {
                if (seen.has(s.key)) return null;           // deduplicate ring vertices
                seen.add(s.key);
                return s;
            }
        }).filter(Boolean);
    }

    /**
     * True if the forward arc (fromIdx → … → toIdx, step +1 mod N) avoids all indices
     * in otherIdxs. Falls back to the shorter arc when otherIdxs is empty.
     */
    _arcAvoidOthers(N, fromIdx, toIdx, otherIdxs) {
        if (otherIdxs.size === 0) {
            return (toIdx - fromIdx + N) % N <= N / 2; // shorter arc
        }
        let i = (fromIdx + 1) % N;
        while (i !== toIdx) {
            if (otherIdxs.has(i)) return false; // forward arc hits another seq vertex → go backward
            i = (i + 1) % N;
        }
        return true;
    }

    /**
     * True if the arc from fromIdx to toIdx (direction = goFwd ? +1 : -1, mod N)
     * contains every index in idxSet.
     */
    _arcContainsAll(N, fromIdx, toIdx, idxSet, goFwd) {
        const step = goFwd ? 1 : -1;
        let found = 0;
        let i = ((fromIdx + step) % N + N) % N;
        while (i !== toIdx) {
            if (idxSet.has(i)) found++;
            i = ((i + step) % N + N) % N;
        }
        return found === idxSet.size;
    }


    /** Signed area of a closed ring via the shoelace formula (absolute value). */
    _vnRingArea(ring) {
        let area = 0;
        for (let i = 0; i < ring.length - 1; i++) {
            area += ring[i].x * ring[i + 1].y - ring[i + 1].x * ring[i].y;
        }
        return Math.abs(area) / 2;
    }

    // ─── Rendering ────────────────────────────────────────────────────────

    /**
     * Draw all virtual nodes and the cut-line preview on top of the canvas.
     * Called from draw() whenever virtualNodeManager.count > 0.
     */
    renderVirtualNodeOverlay() {
        const nodes = this.virtualNodeManager.nodes;
        if (nodes.length === 0) return;

        const ctx = this.renderer.ctx;
        const geo = this.geometryOps;
        ctx.save();

        // ── Sequence-based polygon preview ─────────────────────────────
        // Uses effective sequence (only currently-selected VNs, fresh coords).
        const effectiveSeq = this._getEffectiveSplitSequence();
        if (effectiveSeq.length >= 2) {
            const pts = effectiveSeq.map(s => {
                if (s.type === 'virtual') {
                    return geo.dataToScreen(s.x, s.y); // coords already resolved by _getEffectiveSplitSequence
                } else {
                    const poly = this.polygons[s.polygonIndex];
                    if (!poly || !poly.rings[s.ringIndex]) return null;
                    const vtx = poly.rings[s.ringIndex][s.vertexIndex];
                    return vtx ? geo.dataToScreen(vtx.x, vtx.y) : null;
                }
            }).filter(Boolean);

            if (pts.length >= 2) {
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
                ctx.lineTo(pts[0].x, pts[0].y); // close preview polygon
                ctx.strokeStyle = 'rgba(255, 140, 0, 0.80)';
                ctx.lineWidth   = 1.5;
                ctx.setLineDash([5, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // ── Node circles ───────────────────────────────────────────────
        for (const node of nodes) {
            const s = geo.dataToScreen(node.x, node.y);

            // Filled circle
            ctx.beginPath();
            ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
            ctx.fillStyle   = node.selected ? '#FF6600' : '#FF8C00';
            ctx.fill();
            ctx.strokeStyle = node.selected ? 'white' : 'rgba(0,0,0,0.45)';
            ctx.lineWidth   = node.selected ? 2.5 : 1.5;
            ctx.stroke();

            // White cross inside (distinguishes from red real vertices)
            ctx.strokeStyle = 'white';
            ctx.lineWidth   = 1.5;
            ctx.beginPath();
            ctx.moveTo(s.x - 3.5, s.y);  ctx.lineTo(s.x + 3.5, s.y);
            ctx.moveTo(s.x, s.y - 3.5);  ctx.lineTo(s.x, s.y + 3.5);
            ctx.stroke();
        }

        ctx.restore();
    }

    /**
     * X key — align all selected vertices to the X-coordinate of the first selected vertex.
     * v1=(x1,y1), v2=(x2,y2), v3=(a,b) → v2 becomes (x1,y2), v3 becomes (x1,b), …
     * All polygons sharing each moved vertex are updated together.
     */
    handleAlignX() {
        const selectedInfo = this.vertexSelection.getSelectedVertexInfo(this.polygons);

        if (selectedInfo.length < 2) {
            this.uiController.showError('Select at least 2 vertices (Shift+Click) then press X');
            return;
        }

        const targetX = selectedInfo[0].x;
        const toMove  = selectedInfo.slice(1).filter(v => Math.abs(v.x - targetX) > 1e-9);

        if (toMove.length === 0) {
            this.uiController.showStatus('All vertices already aligned on X — no change needed');
            return;
        }

        this.historyManager.saveToHistory(this.polygons, `Align X: ${toMove.length} vertices`);

        for (const v of toMove) {
            this.sharedVertices.updateSharedVertices(v.x, v.y, targetX, v.y, this.polygons);
        }

        this.vertexSelection.clearSelection();
        this.updateVertexSelectionInfo();
        this.draw();

        this.uiController.showSuccess(
            `${toMove.length} vertex${toMove.length > 1 ? 'es' : ''} aligned to X = ${targetX.toFixed(4)}`
        );
    }

    /**
     * Y key — align all selected vertices to the Y-coordinate of the first selected vertex.
     * v1=(x1,y1), v2=(x2,y2), v3=(a,b) → v2 becomes (x2,y1), v3 becomes (a,y1), …
     * All polygons sharing each moved vertex are updated together.
     */
    handleAlignY() {
        const selectedInfo = this.vertexSelection.getSelectedVertexInfo(this.polygons);

        if (selectedInfo.length < 2) {
            this.uiController.showError('Select at least 2 vertices (Shift+Click) then press Y');
            return;
        }

        const targetY = selectedInfo[0].y;
        const toMove  = selectedInfo.slice(1).filter(v => Math.abs(v.y - targetY) > 1e-9);

        if (toMove.length === 0) {
            this.uiController.showStatus('All vertices already aligned on Y — no change needed');
            return;
        }

        this.historyManager.saveToHistory(this.polygons, `Align Y: ${toMove.length} vertices`);

        for (const v of toMove) {
            this.sharedVertices.updateSharedVertices(v.x, v.y, v.x, targetY, this.polygons);
        }

        this.vertexSelection.clearSelection();
        this.updateVertexSelectionInfo();
        this.draw();

        this.uiController.showSuccess(
            `${toMove.length} vertex${toMove.length > 1 ? 'es' : ''} aligned to Y = ${targetY.toFixed(4)}`
        );
    }

    /**
     * Generate N unique polygon IDs for a given county using gap-filling (001–999).
     * Must be called AFTER source polygons are already removed from this.polygons
     * so their numbers are available for reuse.
     * @param {string} county - County name (e.g. "NC1")
     * @param {number} count  - How many IDs to generate
     * @returns {string[]} - Array of IDs like ["NC1_003", "NC1_005"]
     */
    nextPolygonIds(county, count) {
        const escaped = county.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`^${escaped}_(\\d+)$`);

        const used = new Set();
        for (const p of this.polygons) {
            const m = p.id.match(pattern);
            if (m) {
                const n = parseInt(m[1], 10);
                if (n >= 1 && n <= 999) used.add(n);
            }
        }

        const ids = [];
        let candidate = 1;
        while (ids.length < count && candidate <= 999) {
            if (!used.has(candidate)) {
                ids.push(`${county}_${String(candidate).padStart(3, '0')}`);
                used.add(candidate); // reserve within this batch
            }
            candidate++;
        }

        if (ids.length < count) {
            console.warn(`nextPolygonIds: could only generate ${ids.length} of ${count} IDs for county "${county}"`);
        }

        return ids;
    }

    /**
     * Handle split by vertices (placeholder for future implementation)
     * Split polygon along a path defined by selected vertices
     */
    handleSplitByVertices() {
        // Check if at least 3 vertices are selected
        const selectionCount = this.vertexSelection.getSelectionCount();

        if (selectionCount < 3) {
            console.log('At least 3 vertices must be selected for split by vertices');
            this.uiController.showError('Select at least 3 vertices to split polygon');
            return;
        }

        // Get selected vertices
        const selectedInfo = this.vertexSelection.getSelectedVertexInfo(this.polygons);

        // Verify all vertices are valid and share a county.
        // resolveVertexInfo distinguishes three distinct failure modes:
        //   not found   → vertex coordinate is not in any polygon (data integrity problem)
        //   found, no county → polygon exists but county field is null or set to its own ID
        //   found, no shared county → vertices exist but belong to different counties
        const vertexInfos = selectedInfo.map(v => ({
            v,
            info: this.vertexClassifier.resolveVertexInfo(v.x, v.y, this.polygons)
        }));

        for (const { v, info } of vertexInfos) {
            if (!info.found) {
                this.uiController.showError(`Vertex (${v.x.toFixed(4)}, ${v.y.toFixed(4)}) does not belong to any polygon`);
                return;
            }
            if (info.counties.size === 0) {
                this.uiController.showError(`Vertex (${v.x.toFixed(4)}, ${v.y.toFixed(4)}) has no county information`);
                return;
            }
        }

        let sharedCounties = new Set(vertexInfos[0].info.counties);
        for (let i = 1; i < vertexInfos.length; i++) {
            for (const c of sharedCounties) {
                if (!vertexInfos[i].info.counties.has(c)) sharedCounties.delete(c);
            }
        }
        if (sharedCounties.size === 0) {
            this.uiController.showError('Selected vertices are not all in the same county');
            return;
        }
        const recordedCounty = this.polygons[selectedInfo[0].polygonIndex].county;
        const vertexSplitCounty = sharedCounties.has(recordedCounty)
            ? recordedCounty
            : Array.from(sharedCounties)[0];

        console.log(`Split by vertices requested with ${selectedInfo.length} vertices`);
        console.log('Vertices:', selectedInfo.map(v => `(${v.x.toFixed(4)}, ${v.y.toFixed(4)})`).join(', '));
        const existingIds = new Set(this.polygons.map(p => p.id));

        // Capture source polygon and its current neighbors BEFORE the split so
        // vertexSync can propagate boundary vertices to those neighbors afterward.
        const sourcePolygonSnapshot = this.selectedPolygonIndex !== null
            ? JSON.parse(JSON.stringify(this.polygons[this.selectedPolygonIndex]))
            : null;
        const parentNeighborIds = this.selectedPolygonIndex !== null
            ? this.adjacencyGraph.getNeighbors(this.polygons[this.selectedPolygonIndex].id)
            : [];

        // Perform split using VertexSplitter
        // Pass the currently selected polygon index to resolve ambiguity with shared vertices
        const result = this.vertexSplitter.splitByVertices(
            this.polygons,
            selectedInfo,
            this.selectedPolygonIndex
        );

        if (result.success) {
            // Update polygons with result
            this.polygons = result.polygons;

            // Rename new polygons with consistent {County}_NNN IDs (gap-filling from 001).
            // Source polygon is already removed by VertexSplitter, so its number is free.
            const newPolygons = this.polygons.filter(p => !existingIds.has(p.id));
            const vertexSplitIds = this.nextPolygonIds(vertexSplitCounty, newPolygons.length);
            newPolygons.forEach((p, i) => { p.id = vertexSplitIds[i]; });

            // CRITICAL: Clear polygon selection since the original polygon was removed
            // The polygon indices have shifted after removing the source polygon
            this.selectedPolygonIndex = null;
            this.selectedPolygonIndices.clear();

            // Clear vertex selection
            this.vertexSelection.clearSelection();
            this.updateVertexSelectionInfo();

            // STEP 1: Rebuild adjacency for new polygons + their known neighbors only
            console.log('Rebuilding adjacency graph after vertex split...');
            const vertexSplitZoneIds = [...vertexSplitIds, ...parentNeighborIds];
            this.adjacencyGraph.rebuildForAffected(this.polygons, vertexSplitIds, vertexSplitZoneIds);

            // STEP 2: Sync new polygon boundary vertices into all neighboring polygons.
            // Without this, neighbors retain stale shared edges and gaps appear.
            // Use the same syncAfterSplit path as Voronoi split.
            if (sourcePolygonSnapshot && newPolygons.length > 0) {
                const startIndex = this.polygons.indexOf(newPolygons[0]);
                console.log(`Syncing vertex split polygons with neighbors (startIndex=${startIndex}, count=${newPolygons.length})...`);
                this.polygons = this.vertexSync.syncAfterSplit(
                    this.polygons,
                    this.adjacencyGraph,
                    startIndex,
                    newPolygons.length,
                    sourcePolygonSnapshot,
                    parentNeighborIds
                );
            }

            // STEP 3: Rebuild adjacency again after vertex sync (same zone)
            console.log('Rebuilding adjacency graph after vertex sync...');
            this.adjacencyGraph.rebuildForAffected(this.polygons, vertexSplitIds, vertexSplitZoneIds);

            const stats = this.adjacencyGraph.getStatistics();
            console.log('Adjacency graph rebuilt:', stats);

            // CRITICAL: Validate shared vertices after split
            console.log('Validating shared vertices after split...');
            const validation = this.sharedVertices.validateSharedVertices(this.polygons);
            if (!validation.isValid) {
                console.warn('Shared vertex validation found issues:', validation.issues);
            } else {
                console.log(`✓ Shared vertices validated: ${validation.sharedGroupCount} groups, ${validation.totalSharedVertices} total vertices`);
            }

            // CRITICAL: Sync layer manager with updated polygon state
            this.layerManager.layers.subCounty.polygons = this.polygons;

            // Save to history (after rebuilding shared vertices and adjacency)
            this.historyManager.saveToHistory(this.polygons, result.message);
            this.updateUndoRedoButtons();

            // Update UI - repopulate polygon dropdown and clear selection
            this.uiController.populatePolygonSelect(this.polygons);
            this.uiController.setSelectedPolygon(null); // Clear dropdown selection

            // Update combine and split button states
            this.updateCombineButton();
            this.updateSplitButton();

            // Redraw
            this.draw();

            console.log('Split by vertices completed:', result.message);
            this.uiController.showStatus(result.message);
        } else {
            console.log('Split by vertices failed:', result.message);
            this.uiController.showError(result.message);
        }
    }

    /**
     * Update vertex selection info in the UI
     */
    updateVertexSelectionInfo() {
        const vertexInfo = document.getElementById('vertexInfo');
        const clearBtn = document.getElementById('clearVertexSelectionBtn');
        const deleteBtn = document.getElementById('deleteVertexBtn');
        const replaceBtn = document.getElementById('replaceVertexBtn');
        const midpointBtn = document.getElementById('midpointBtn');
        const splitByVerticesBtn = document.getElementById('splitByVerticesBtn');

        const stats = this.vertexSelection.getStatistics();
        const selectedInfo = this.vertexSelection.getSelectedVertexInfo(this.polygons);

        // Check if any selected vertices are fixed/orphaned/missing-county.
        // Same-county is NOT checked here: vertices are always selected in the context
        // of the currently selected polygon, so they are guaranteed to be in the same
        // county. A cross-county check would produce false positives for boundary
        // vertices that appear in multiple counties' polygons.
        let hasFixedVertex = false;
        let hasOrphanedVertex = false;
        let hasMissingCounty = false;

        const allInSameCounty = true; // always true — enforced by polygon-first selection model

        if (selectedInfo.length > 0) {
            selectedInfo.forEach(v => {
                if (this.vertexClassifier.isProtected(v.x, v.y, this.polygons)) {
                    hasFixedVertex = true;
                }
                const info = this.vertexClassifier.resolveVertexInfo(v.x, v.y, this.polygons);
                if (!info.found) {
                    hasOrphanedVertex = true;
                }
                if (info.found && info.counties.size === 0) {
                    hasMissingCounty = true;
                }
            });
        }

        // Update vertex info display
        if (stats.selectedCount === 0) {
            vertexInfo.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 4px;">No vertex selected</div>
                <div style="font-size: 10px; color: #999;">Shift+Click on a vertex to select</div>
            `;
            vertexInfo.style.color = '#666';
        } else {
            const coordsText = selectedInfo.map(v =>
                `(${v.x.toFixed(4)}, ${v.y.toFixed(4)})`
            ).join(', ');

            const fixedText = hasFixedVertex ? '<span style="color: #0066FF; font-weight: bold;">⚠️ Contains FIXED vertex</span><br>' : '';
            const orphanText = hasOrphanedVertex ? '<span style="color: #CC0000; font-weight: bold;">⛔ Vertex not in any polygon</span><br>' : '';
            const missingCountyText = hasMissingCounty ? '<span style="color: #FF6600; font-weight: bold;">⚠️ No county data on vertex</span><br>' : '';

            vertexInfo.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 4px;">${stats.selectedCount} vertex${stats.selectedCount > 1 ? 'es' : ''} selected</div>
                <div style="font-size: 9px; color: #666; margin-bottom: 4px;">${coordsText}</div>
                ${orphanText}${missingCountyText}${fixedText}
                <div style="font-size: 9px; color: #999;">${stats.neighboringCount} neighboring vertices</div>
            `;
            vertexInfo.style.color = '#333';
        }

        // Update button states
        if (clearBtn) clearBtn.disabled = (stats.selectedCount === 0);

        // Replace button: Enable only if exactly 1 vertex selected AND not fixed
        if (replaceBtn) {
            replaceBtn.disabled = (stats.selectedCount !== 1 || hasFixedVertex);
        }

        // Delete button: Enable only if exactly 1 vertex selected AND not fixed
        if (deleteBtn) {
            deleteBtn.disabled = (stats.selectedCount !== 1 || hasFixedVertex);
        }

        // Midpoint button: Enable if exactly 2 vertices selected AND in same county
        if (midpointBtn) {
            midpointBtn.disabled = (stats.selectedCount !== 2 || !allInSameCounty);
        }

        // Split by vertices button: Enable if at least 3 vertices selected AND in same county
        if (splitByVerticesBtn) {
            splitByVerticesBtn.disabled = (stats.selectedCount < 3 || !allInSameCounty);
        }
    }

    /**
     * Handle polygon selection
     * @param {number} dataX - X coordinate in data space
     * @param {number} dataY - Y coordinate in data space
     * @param {boolean} cursorCheckOnly - True if only checking for cursor update
     * @param {boolean} isCtrlKey - True if Ctrl/Cmd key is pressed (for multi-selection)
     * @returns {Object} - Selection result
     */
    handlePolygonSelection(dataX, dataY, cursorCheckOnly = false, isCtrlKey = false) {
        // Allow polygon selection in both edit and view modes
        // (View mode needs selection to display polygon info and vertices)

        // In redistricting mode with a district filter, only hit-test visible polygons
        let candidatePolygons = this.polygons;
        let indexMap = null; // maps candidate index → this.polygons index
        if (this.districtFilter && window.AppMode && window.AppMode.current === 'redistricting') {
            const filtered = [];
            const map = [];
            this.polygons.forEach((p, i) => {
                if (p.district === this.districtFilter) { filtered.push(p); map.push(i); }
            });
            candidatePolygons = filtered;
            indexMap = map;
        }

        const hitIdx = this.geometryOps.findPolygonAtPosition(dataX, dataY, candidatePolygons);
        const clickedPolygonIndex = (hitIdx !== null && indexMap) ? indexMap[hitIdx] : hitIdx;

        if (clickedPolygonIndex !== null) {
            if (!cursorCheckOnly) {
                console.log('Polygon clicked:', clickedPolygonIndex, 'Ctrl key:', isCtrlKey);
                if (isCtrlKey) {
                    // Multi-selection mode
                    this.togglePolygonSelection(clickedPolygonIndex);
                } else {
                    // Single selection mode
                    if (clickedPolygonIndex !== this.selectedPolygonIndex) {
                        this.selectPolygon(clickedPolygonIndex);
                    }
                }
                return { polygonSelected: true, polygonIndex: clickedPolygonIndex };
            }
            return { polygonFound: true, polygonIndex: clickedPolygonIndex };
        }

        return { polygonFound: false };
    }

    /** Open the density input modal for a given polygon index. */
    showDensityInput(polygonIndex) {
        const polygon = this.polygons[polygonIndex];
        if (!polygon) return;

        this._pendingDensityPolygonIndex = polygonIndex;

        const modal  = document.getElementById('densityInputModal');
        const label  = document.getElementById('densityInputLabel');
        const input  = document.getElementById('densityInputValue');
        const errEl  = document.getElementById('densityInputError');
        if (!modal) return;

        label.textContent = `Sub-County: ${polygon.id}  ·  Current: ${Math.round(polygon.populationDensity || 0).toLocaleString()} /km²`;
        input.value = Math.round(polygon.populationDensity || 0);
        errEl.style.display = 'none';
        modal.style.display = 'flex';
        setTimeout(() => { input.focus(); input.select(); }, 50);
    }

    /** Validate and apply the new density value from the modal. Returns true on success. */
    applyDensityChange(rawValue) {
        const idx = this._pendingDensityPolygonIndex;
        if (idx === null || idx === undefined) return false;

        const num = parseFloat(rawValue);
        if (!Number.isFinite(num) || num < 0 || num > 30000) {
            document.getElementById('densityInputError').style.display = 'block';
            return false;
        }

        const polygon = this.polygons[idx];
        polygon.populationDensity = num;

        // Keep DataManager's originalData in sync for CSV export
        if (this.dataManager.originalData &&
                this.dataManager.originalData[polygon.rowIndex] !== undefined) {
            this.dataManager.originalData[polygon.rowIndex].Population_Density = String(num);
        }

        this.historyManager.saveToHistory(this.polygons, `Density changed: ${polygon.id}`);
        this.updateUndoRedoButtons();
        this.draw();

        document.getElementById('densityInputModal').style.display = 'none';
        this._pendingDensityPolygonIndex = null;
        return true;
    }

    /** Close density modal without saving. */
    closeDensityModal() {
        const modal = document.getElementById('densityInputModal');
        if (modal) modal.style.display = 'none';
        this._pendingDensityPolygonIndex = null;
    }

    /**
     * Nudge density of one or more polygons by +1 or -1 step.
     * Step size is determined by each polygon's own current density.
     * Only active in population density mode.
     * @param {number[]} indices - Polygon indices to adjust
     * @param {1|-1} direction - +1 to increase, -1 to decrease
     */
    nudgeDensity(indices, direction) {
        if (!window.AppMode || window.AppMode.current !== 'population') return;

        const stepFor = (density) => {
            if (density >= 10000) return 500;
            if (density >= 5000)  return 250;
            if (density >= 1500)  return 100;
            if (density >= 1000)  return 50;
            if (density >= 100)   return 25;
            return 5;
        };

        let changed = false;
        indices.forEach(idx => {
            const polygon = this.polygons[idx];
            if (!polygon) return;
            const step    = stepFor(polygon.populationDensity || 0);
            const newVal  = Math.min(30000, Math.max(0, (polygon.populationDensity || 0) + direction * step));
            if (newVal === polygon.populationDensity) return;

            polygon.populationDensity = newVal;
            if (this.dataManager.originalData &&
                    this.dataManager.originalData[polygon.rowIndex] !== undefined) {
                this.dataManager.originalData[polygon.rowIndex].Population_Density = String(newVal);
            }
            changed = true;
        });

        if (changed) {
            this.historyManager.saveToHistory(this.polygons, 'Density nudged');
            this.updateUndoRedoButtons();
            this.draw();
        }
    }

    /**
     * Handle polygon selection from dropdown
     * @param {Event} e - Select change event
     */
    handlePolygonSelect(e) {
        const index = e.target.value;
        if (index === '') {
            this.selectPolygon(null);
        } else {
            this.selectPolygon(parseInt(index));
        }
    }

    /**
     * Select a polygon by index
     * @param {number|null} index - Index to select or null for none
     */
    selectPolygon(index) {
        // In Redistricting mode, handle ward selection — then fall through so
        // display.html still receives the polygon info via updatePolygonInfo()
        if (window.AppMode && window.AppMode.current === 'redistricting' &&
            index !== null && window.WardManager) {
            const polygon = this.polygons[index];
            if (polygon) {
                if (window.WardManager.isCreateMode()) {
                    window.WardManager.togglePolygon(polygon.id);
                } else {
                    window.WardManager.selectWardByPolygon(polygon.id);
                }
                // fall through — do NOT return; normal selection updates display.html
            }
        }

        // CRITICAL: Clear vertex selection when switching to a different polygon
        // This ensures all selected vertices always belong to the currently selected polygon
        if (index !== this.selectedPolygonIndex) {
            console.log(`Polygon selection changed from ${this.selectedPolygonIndex} to ${index} - clearing vertex selection`);
            this.vertexSelection.clearSelection();
            this._splitSequence = [];
            this.updateVertexSelectionInfo();
        }

        this.selectedPolygonIndex = index;
        this.selectedPolygonIndices.clear(); // Clear multi-selection
        if (index !== null) {
            this.selectedPolygonIndices.add(index);
        }
        this.uiController.setSelectedPolygon(index);
        this.updatePolygonInfo();
        this.updateCombineButton();
        this.updateSplitButton();
        this.draw();

        if (index !== null) {
            this.uiController.showStatus(`Selected polygon: ${this.polygons[index].id}`);
        }
    }

    /**
     * Toggle polygon selection for multi-selection (Ctrl+Click)
     * @param {number} index - Index of polygon to toggle
     */
    togglePolygonSelection(index) {
        console.log('Toggle polygon selection:', index, 'Current selection:', Array.from(this.selectedPolygonIndices));

        if (this.selectedPolygonIndices.has(index)) {
            this.selectedPolygonIndices.delete(index);
            console.log('Deselected polygon', index);
            // If we just deselected the main selected polygon, choose another
            if (this.selectedPolygonIndex === index) {
                const remaining = Array.from(this.selectedPolygonIndices);
                this.selectedPolygonIndex = remaining.length > 0 ? remaining[0] : null;
            }
        } else {
            this.selectedPolygonIndices.add(index);
            this.selectedPolygonIndex = index; // Make this the primary selection
            console.log('Added polygon', index, 'to selection. Total:', this.selectedPolygonIndices.size);
        }

        // Update UI
        this.uiController.setSelectedPolygon(this.selectedPolygonIndex);
        this.updatePolygonInfo();
        this.updateCombineButton();
        this.updateSplitButton();
        this.draw();

        const count = this.selectedPolygonIndices.size;
        if (count > 1) {
            this.uiController.showStatus(`${count} polygons selected for combining`);
        } else if (count === 1) {
            this.uiController.showStatus(`Selected polygon: ${this.polygons[this.selectedPolygonIndex].id}`);
        }
    }

    /**
     * Update combine button state based on selection
     */
    updateCombineButton() {
        const canCombine = this.selectedPolygonIndices.size >= 2;
        this.uiController.setCombineEnabled(canCombine);
    }

    /**
     * Update split button state based on selection
     */
    updateSplitButton() {
        const size = this.selectedPolygonIndices.size;
        const canSplit    = size === 1;
        const canOsmSplit = size >= 1;
        this.uiController.setSplitEnabled(canSplit);
        this.uiController.setOsmSplitEnabled(canOsmSplit);
        this.uiController.setDeletePolygonEnabled(canSplit);

        // Disable regenerate if selection changes (unless exactly 1 polygon selected)
        if (!canSplit) {
            this.uiController.setRegenerateEnabled(false);
        }
    }

    /**
     * Check whether all polygons in a Set of indices form a connected subgraph
     * (every polygon reachable from every other via shared-boundary adjacency).
     * @param {Set<number>} polygonIndices
     * @returns {boolean}
     */
    _arePolygonsConnected(polygonIndices) {
        if (polygonIndices.size <= 1) return true;
        const ids   = [...polygonIndices].map(i => this.polygons[i].id);
        const idSet = new Set(ids);
        const visited = new Set();
        const queue   = [ids[0]];
        while (queue.length > 0) {
            const cur = queue.shift();
            if (visited.has(cur)) continue;
            visited.add(cur);
            for (const nb of this.adjacencyGraph.getNeighbors(cur)) {
                if (idSet.has(nb) && !visited.has(nb)) queue.push(nb);
            }
        }
        return ids.every(id => visited.has(id));
    }

    /**
     * Delete the currently selected polygon after user confirmation.
     * Removes the polygon from this.polygons, updates the adjacency graph,
     * saves to history (undo/redo supported), auto-saves CSV to the same file,
     * and redraws.
     */
    async deleteSelectedPolygon() {
        if (this.selectedPolygonIndex === null) return;

        const polygon = this.polygons[this.selectedPolygonIndex];
        if (!polygon) return;

        const confirmed = confirm(
            `Delete polygon "${polygon.id}"?\n\nThis will remove it permanently from the CSV. Undo is available.`
        );
        if (!confirmed) return;

        const index = this.selectedPolygonIndex;

        // Collect neighbors before removal so we can rebuild their adjacency entries.
        const neighborIds = this.adjacencyGraph.getNeighbors(polygon.id);

        // Remove from array
        this.polygons.splice(index, 1);

        // Update adjacency: the deleted polygon is gone; rebuild its former neighbors
        // so they no longer list it.  The deleted polygon's own entry is intentionally
        // left stale in the graph — _diffPolygonStates reads it during undo to expand
        // the zone so rebuildForAffected can correctly restore adjacency on undo/redo.
        if (neighborIds.length > 0) {
            this.adjacencyGraph.rebuildForAffected(
                this.polygons,
                neighborIds,
                neighborIds
            );
        }

        // Sync layer manager
        this.layerManager.layers.subCounty.polygons = this.polygons;

        // Deselect
        this.selectedPolygonIndex = null;
        this.selectedPolygonIndices.clear();
        this.vertexSelection.clearSelection();

        // Persist history for undo/redo
        this.historyManager.saveToHistory(this.polygons, `Delete polygon: ${polygon.id}`);
        this.updateUndoRedoButtons();

        // Refresh UI
        this.uiController.populatePolygonSelect(this.polygons);
        this.updateCombineButton();
        this.updateSplitButton();
        this.draw();
        this.updatePolygonInfo();

        // Auto-save CSV to the same file if we know its name
        await this._autoSaveCsvAfterDelete(polygon.id);
    }

    /**
     * Silently save the current polygons back to the currently-loaded CSV file.
     * Falls back to a timestamped download if no filename is tracked or the
     * server write fails.
     * @param {string} deletedId - Used only for the status message
     */
    async _autoSaveCsvAfterDelete(deletedId) {
        try {
            const csvContent = this.dataManager.exportToCSV(this.polygons);
            const filename = window._currentCsvFilename;

            if (filename) {
                const response = await fetch('/save_csv', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename, content: csvContent })
                });
                if (response.ok) {
                    this.uiController.showSuccess(`Deleted "${deletedId}" and saved to ${filename}`);
                    return;
                }
            }

            // Fallback: browser download
            const now = new Date();
            const z = n => String(n).padStart(2, '0');
            const fallbackName = `${z(now.getMonth() + 1)}${z(now.getDate())}${z(now.getHours())}${z(now.getMinutes())}_modified_shapefile.csv`;
            this.uiController.downloadCSV(csvContent, filename || fallbackName);
            this.uiController.showSuccess(`Deleted "${deletedId}". CSV downloaded (place in ./csv_input to reload).`);
        } catch (err) {
            console.warn('Auto-save after delete failed:', err);
            this.uiController.showError(`Deleted "${deletedId}" but CSV save failed: ${err.message}`);
        }
    }

    /**
     * Set edit/view mode
     * @param {boolean} isEdit - True for edit mode, false for view mode
     */
    setEditMode(isEdit) {
        this.isEditMode = isEdit;
        this.uiController.setMode(isEdit);
        this.mouseHandler.setInteractionMode(isEdit ? 'edit' : 'view');
        this.draw();
    }

    /**
     * Update polygon information display
     */
    updatePolygonInfo() {
        const polygon = this.selectedPolygonIndex !== null ?
            this.polygons[this.selectedPolygonIndex] : null;
        this.uiController.updatePolygonInfo(polygon, this.sharedVertices, this.adjacencyGraph);
    }

    /**
     * Update undo/redo button states
     */
    updateUndoRedoButtons() {
        const stats = this.historyManager.getHistoryStats();
        this.uiController.updateUndoRedoButtons(
            this.historyManager.canUndo(),
            this.historyManager.canRedo(),
            stats.undoableActions,
            stats.redoableActions
        );
    }

    /**
     * Undo last action
     */
    undo() {
        const previousState = this.historyManager.undo();
        if (previousState) {
            // Diff BEFORE replacing this.polygons so the adjacency graph still reflects
            // the current (pre-undo) state — neighbors of removed polygons are readable.
            const { affectedIds, zoneIds } = this._diffPolygonStates(this.polygons, previousState.polygons);

            this.polygons = previousState.polygons;

            // Restore virtual node state if this snapshot includes one
            if (previousState.vnSnapshot !== null) {
                this.virtualNodeManager.loadSnapshot(previousState.vnSnapshot);
                this._splitSequence = [];
            }

            // Clear vertex selection (important for undo after vertex deletion)
            this.vertexSelection.clearSelection();
            this._splitSequence = [];
            this.updateVertexSelectionInfo();

            // Targeted adjacency rebuild — O(Z²·V²) instead of O(P²·V²).
            // affectedIds = [] means no polygon ring data changed (e.g. a pure virtual-node
            // action was undone).  The adjacency graph is still valid — skip rebuild entirely.
            console.log(`Rebuilding adjacency after undo: ${affectedIds.length} affected, ${zoneIds.length} zone polygons`);
            if (affectedIds.length > 0) {
                this.adjacencyGraph.rebuildForAffected(this.polygons, affectedIds, zoneIds);
            }

            // CRITICAL: Sync layer manager with restored polygon state
            this.layerManager.layers.subCounty.polygons = this.polygons;

            // Update UI
            this.uiController.populatePolygonSelect(this.polygons);
            this.draw();
            this.updatePolygonInfo();
            this.updateUndoRedoButtons();
            this.uiController.showStatus(`Undo: ${previousState.action}`);
        }
    }

    /**
     * Redo next action
     */
    redo() {
        const nextState = this.historyManager.redo();
        if (nextState) {
            // Diff BEFORE replacing this.polygons — same reason as in undo().
            const { affectedIds, zoneIds } = this._diffPolygonStates(this.polygons, nextState.polygons);

            this.polygons = nextState.polygons;

            // Restore virtual node state if this snapshot includes one
            if (nextState.vnSnapshot !== null) {
                this.virtualNodeManager.loadSnapshot(nextState.vnSnapshot);
                this._splitSequence = [];
            }

            // Clear vertex selection (important for redo after vertex deletion)
            this.vertexSelection.clearSelection();
            this._splitSequence = [];
            this.updateVertexSelectionInfo();

            // Targeted adjacency rebuild — O(Z²·V²) instead of O(P²·V²).
            // affectedIds = [] means no polygon ring data changed — skip rebuild entirely.
            console.log(`Rebuilding adjacency after redo: ${affectedIds.length} affected, ${zoneIds.length} zone polygons`);
            if (affectedIds.length > 0) {
                this.adjacencyGraph.rebuildForAffected(this.polygons, affectedIds, zoneIds);
            }

            // CRITICAL: Sync layer manager with restored polygon state
            this.layerManager.layers.subCounty.polygons = this.polygons;

            // Update UI
            this.uiController.populatePolygonSelect(this.polygons);

            this.draw();
            this.updatePolygonInfo();
            this.updateUndoRedoButtons();
            this.uiController.showStatus(`Redo: ${nextState.action}`);
        }
    }

    // ─── Undo/Redo helpers ────────────────────────────────────────────────────

    /**
     * Diff two polygon snapshots and return the minimal set of IDs that need
     * their adjacency recomputed.
     *
     * Three categories of change are detected:
     *   • Removed — ID present in oldPolygons but absent in newPolygons
     *   • Added   — ID present in newPolygons but absent in oldPolygons
     *   • Modified — same ID, but ring vertices differ
     *
     * The "zone" expands the affected set by one hop: all current (pre-swap)
     * adjacency-graph neighbors of every affected polygon are included so that
     * their neighbor lists are refreshed too.
     *
     * Complexity: O(P·V) for the diff + O(Z·degree) for the zone expansion,
     * where Z = |affected| and degree = avg neighbor count.
     *
     * @param {Array<Object>} oldPolygons - Polygon array before the state transition
     * @param {Array<Object>} newPolygons - Polygon array after  the state transition
     * @returns {{ affectedIds: string[], zoneIds: string[] }}
     */
    _diffPolygonStates(oldPolygons, newPolygons) {
        const affected = new Set();

        // ── Fast path: same count + IDs in same positional order ─────────────────
        // This is true for every pure virtual-node action (place / delete / midpoint /
        // alignX / alignY) because those actions never add, remove or re-order polygons.
        // Skips 4 Map/Set allocations and two O(P) set-difference loops; goes straight
        // to index-based ring comparison — O(P·V) but with a much lower constant.
        if (oldPolygons.length === newPolygons.length &&
            oldPolygons.every((p, i) => p.id === newPolygons[i].id)) {

            for (let i = 0; i < oldPolygons.length; i++) {
                if (this._polygonRingsChanged(oldPolygons[i], newPolygons[i])) {
                    affected.add(oldPolygons[i].id);
                }
            }

        } else {
            // ── General path: polygon count or IDs changed (split / combine / load) ──
            const oldIdSet = new Set(oldPolygons.map(p => p.id));
            const newIdSet = new Set(newPolygons.map(p => p.id));
            const oldMap   = new Map(oldPolygons.map(p => [p.id, p]));
            const newMap   = new Map(newPolygons.map(p => [p.id, p]));

            // Removed: existed before, gone now
            for (const id of oldIdSet) {
                if (!newIdSet.has(id)) affected.add(id);
            }

            // Added: new in the restored state
            for (const id of newIdSet) {
                if (!oldIdSet.has(id)) affected.add(id);
            }

            // Modified: same ID but ring geometry changed
            for (const id of oldIdSet) {
                if (newIdSet.has(id) && this._polygonRingsChanged(oldMap.get(id), newMap.get(id))) {
                    affected.add(id);
                }
            }
        }

        // Zone = affected + their pre-swap neighbors (one adjacency hop).
        // Reading neighbors before this.polygons is replaced means the adjacency
        // graph still knows who was adjacent to removed/modified polygons.
        const zone = new Set(affected);
        for (const id of affected) {
            for (const neighborId of this.adjacencyGraph.getNeighbors(id)) {
                zone.add(neighborId);
            }
        }

        return {
            affectedIds: [...affected],
            zoneIds:     [...zone]
        };
    }

    /**
     * Returns true if the two polygons have different ring vertex data.
     * Exits early on the first mismatch — O(V) best/average case.
     *
     * Uses exact (===) comparison because both snapshots are produced by the
     * same JSON.stringify → JSON.parse path and share the same float values.
     *
     * @param {Object} polyA
     * @param {Object} polyB
     * @returns {boolean}
     */
    _polygonRingsChanged(polyA, polyB) {
        if (!polyA || !polyB) return true;
        if (polyA.rings.length !== polyB.rings.length) return true;
        for (let r = 0; r < polyA.rings.length; r++) {
            const ra = polyA.rings[r];
            const rb = polyB.rings[r];
            if (ra.length !== rb.length) return true;
            for (let v = 0; v < ra.length; v++) {
                if (ra[v].x !== rb[v].x || ra[v].y !== rb[v].y) return true;
            }
        }
        return false;
    }

    /**
     * Combine selected polygons into a single polygon (async - calls Python backend)
     */
    async combineSelectedPolygons() {
        const indices = Array.from(this.selectedPolygonIndices).sort((a, b) => a - b);

        if (indices.length < 2) {
            this.uiController.showError('Select at least 2 polygons to combine');
            return;
        }

        // Validate combination
        const validation = this.polygonCombiner.validateCombination(this.polygons, indices);
        if (!validation.valid) {
            this.uiController.showError(validation.message);
            return;
        }

        // Show loading message
        this.uiController.showMessage(`Combining ${indices.length} polygons... Please wait.`);

        // Capture neighbor IDs of all source polygons BEFORE they are removed
        const combineSourceIds = new Set(indices.map(i => this.polygons[i].id));
        const combineNeighborIds = new Set();
        combineSourceIds.forEach(id => {
            this.adjacencyGraph.getNeighbors(id).forEach(nId => {
                if (!combineSourceIds.has(nId)) combineNeighborIds.add(nId);
            });
        });

        try {
            // Perform combination (now async - calls Python service)
            const result = await this.polygonCombiner.combinePolygons(this.polygons, indices);

            if (!result.success) {
                this.uiController.showError(result.message);
                return;
            }

            console.log('Polygon combination successful');

            // Replace the first selected polygon with the combined one
            const firstIndex = indices[0];
            this.polygons[firstIndex] = result.newPolygon;

            // Remove other polygons (in reverse order to preserve indices)
            for (let i = result.removedIndices.length - 1; i >= 0; i--) {
                const removeIndex = result.removedIndices[i];
                this.polygons.splice(removeIndex, 1);
            }

            // Assign consistent {County}_NNN ID after all source polygons are removed (gap-filling from 001).
            // firstIndex is still valid since we only removed indices > firstIndex.
            this.polygons[firstIndex].id = this.nextPolygonIds(result.newPolygon.county, 1)[0];
            const mergedId = this.polygons[firstIndex].id;
            const combineZoneIds = [mergedId, ...combineNeighborIds];

            // STEP 1: Rebuild adjacency for merged polygon + its known neighbors only
            console.log('Rebuilding adjacency graph after polygon combination...');
            this.adjacencyGraph.rebuildForAffected(this.polygons, [mergedId], combineZoneIds);

            // STEP 2: Synchronize vertices with neighbors
            console.log('Synchronizing vertices after merge...');
            const originalPolygons = [...this.polygons];
            this.polygons = this.vertexSync.syncAfterMerge(
                this.polygons,
                this.adjacencyGraph,
                firstIndex
            );

            // Log vertex sync statistics
            const syncStats = this.vertexSync.getStats(originalPolygons, this.polygons);
            console.log('Vertex sync stats after merge:', syncStats);

            // STEP 3: Rebuild adjacency again after vertex sync (same zone)
            console.log('Rebuilding adjacency graph with synchronized vertices...');
            this.adjacencyGraph.rebuildForAffected(this.polygons, [mergedId], combineZoneIds);

            // CRITICAL: Sync layer manager with updated polygon list
            this.layerManager.layers.subCounty.polygons = this.polygons;

            // Update UI
            this.uiController.populatePolygonSelect(this.polygons);
            this.selectPolygon(firstIndex);

            // Save to history
            this.historyManager.saveToHistory(this.polygons, 'Combined polygons');
            this.updateUndoRedoButtons();

            // Redraw
            this.draw();

            this.uiController.showSuccess(result.message);

        } catch (error) {
            console.error('Combine operation failed:', error);
            this.uiController.showError(`Combine failed: ${error.message}`);
        }
    }

    /**
     * Show dialog to configure polygon split
     * Now uses the UI controls instead of prompt dialog
     */
    showSplitDialog() {
        if (this.selectedPolygonIndices.size !== 1) {
            this.uiController.showError('Select exactly 1 polygon to split');
            return;
        }

        const index = this.selectedPolygonIndex;
        const polygon = this.polygons[index];

        // Get values from UI controls
        const numDistricts = parseInt(document.getElementById('numDistricts').value);

        // Validate number of districts
        if (isNaN(numDistricts) || numDistricts < 2 || numDistricts > 20) {
            this.uiController.showError('Please enter a number between 2 and 20');
            return;
        }

        // Always use seed=42 for reproducible results
        const seed = 42;

        console.log(`Splitting polygon ${polygon.id}: districts=${numDistricts}, seed=${seed}`);

        this.splitSelectedPolygon(numDistricts, seed);
    }

    /**
     * Regenerate the last split with random variation
     */
    regenerateSplit() {
        if (this.selectedPolygonIndices.size !== 1) {
            this.uiController.showError('Select exactly 1 polygon to regenerate');
            return;
        }

        // Get number of districts from UI
        const numDistricts = parseInt(document.getElementById('numDistricts').value);

        // Validate number of districts
        if (isNaN(numDistricts) || numDistricts < 2 || numDistricts > 20) {
            this.uiController.showError('Please enter a number between 2 and 20');
            return;
        }

        console.log('Regenerating split with random variation...');

        // Step 1: Undo the previous split
        this.undo();

        // Step 2: Wait for undo to complete, then split with random seed
        setTimeout(() => {
            // Generate random seed for variation
            const randomSeed = Math.floor(Math.random() * 1000000);
            console.log(`Regenerating with random seed: ${randomSeed}`);

            this.splitSelectedPolygon(numDistricts, randomSeed);
        }, 100);
    }

    // ─── OSM-based split ─────────────────────────────────────────────────

    /**
     * Initialise the Leaflet map inside the OSM split modal.
     * Called lazily on first open; subsequent calls are no-ops.
     */
    _initOsmMap() {
        if (this._osmMap) return;
        const mapEl = document.getElementById('osmSplitMap');
        if (!mapEl || typeof L === 'undefined') return;

        this._osmMap = L.map('osmSplitMap').setView([51.5, -0.1], 10);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 19,
        }).addTo(this._osmMap);

        this._osmBbox = null;

        // Update the fixed frame overlay and bbox on every pan/zoom
        this._osmMap.on('move zoom', () => this._updateFrameRect());
    }

    /**
     * Recompute the green frame overlay position and the live _osmBbox from the
     * current map center and the stored polygon km size.
     * Called on every map 'move' and 'zoom' event.
     */
    _updateFrameRect() {
        if (!this._osmMap || !this._polygonKmSize) return;

        const { widthKm, heightKm } = this._polygonKmSize;
        const center = this._osmMap.getCenter();

        // Convert km half-extents to degrees
        const KM_PER_DEG_LAT = 111.0;
        const KM_PER_DEG_LON = 111.0 * Math.cos(center.lat * Math.PI / 180);
        const halfLatDeg = (heightKm / 2) / KM_PER_DEG_LAT;
        const halfLonDeg = (widthKm  / 2) / KM_PER_DEG_LON;

        // Screen corners of the bounding box
        const tl = this._osmMap.latLngToContainerPoint(
            L.latLng(center.lat + halfLatDeg, center.lng - halfLonDeg)
        );
        const br = this._osmMap.latLngToContainerPoint(
            L.latLng(center.lat - halfLatDeg, center.lng + halfLonDeg)
        );
        const screenW = br.x - tl.x;
        const screenH = br.y - tl.y;

        // ── SVG: draw the actual polygon shape(s) ───────────────────────────
        const polyEl   = document.getElementById('osmFramePoly');
        const bboxEl2  = document.getElementById('osmFrameBbox');
        const svgEl    = document.getElementById('osmFrameSvg');
        const polyGroup = document.getElementById('osmFramePolyGroup');

        const rings = this._osmPolygonRings || (this._osmPolygonRing ? [this._osmPolygonRing] : null);

        if (svgEl && rings) {
            const mapSize = this._osmMap.getSize();
            svgEl.setAttribute('width',  mapSize.x);
            svgEl.setAttribute('height', mapSize.y);

            // Combined bounds across all rings
            const allPts = rings.flat();
            const rxs = allPts.map(p => p.x), rys = allPts.map(p => p.y);
            const minX = Math.min(...rxs), maxX = Math.max(...rxs);
            const minY = Math.min(...rys), maxY = Math.max(...rys);
            const dw = maxX - minX || 1;
            const dh = maxY - minY || 1;

            // Normalize a ring to SVG screen coordinates (data Y is up → flip)
            const toSvgPts = ring => ring.map(p => {
                const sx = tl.x + ((p.x - minX) / dw) * screenW;
                const sy = tl.y + ((maxY - p.y) / dh) * screenH;
                return `${sx.toFixed(1)},${sy.toFixed(1)}`;
            }).join(' ');

            if (rings.length === 1) {
                // Single polygon: use static element, clear group
                if (polyEl) polyEl.setAttribute('points', toSvgPts(rings[0]));
                if (polyGroup) polyGroup.innerHTML = '';
            } else {
                // Multiple polygons: hide static element, build group dynamically
                if (polyEl) polyEl.setAttribute('points', '');
                if (polyGroup) {
                    polyGroup.innerHTML = '';
                    for (const ring of rings) {
                        const el = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                        el.setAttribute('points', toSvgPts(ring));
                        el.setAttribute('fill', 'rgba(39,174,96,0.12)');
                        el.setAttribute('stroke', '#27ae60');
                        el.setAttribute('stroke-width', '2.5');
                        el.setAttribute('stroke-linejoin', 'round');
                        polyGroup.appendChild(el);
                    }
                }
            }

            // Dashed bounding box (shows the OSM download area)
            if (bboxEl2) {
                bboxEl2.setAttribute('x',      tl.x.toFixed(1));
                bboxEl2.setAttribute('y',      tl.y.toFixed(1));
                bboxEl2.setAttribute('width',  screenW.toFixed(1));
                bboxEl2.setAttribute('height', screenH.toFixed(1));
            }
        }

        // Update live bbox state (always the bounding rectangle for OSM download)
        this._osmBbox = {
            north: center.lat + halfLatDeg,
            south: center.lat - halfLatDeg,
            east:  center.lng + halfLonDeg,
            west:  center.lng - halfLonDeg,
        };

        const bboxEl = document.getElementById('osmBboxDisplay');
        if (bboxEl) {
            const b = this._osmBbox;
            bboxEl.textContent = `N ${b.north.toFixed(4)}  S ${b.south.toFixed(4)}  E ${b.east.toFixed(4)}  W ${b.west.toFixed(4)}`;
        }
    }

    /**
     * Compute the km dimensions of one or more polygons and an initial map center.
     * Stores _polygonKmSize and _osmPolygonRings for use by _updateFrameRect().
     *
     * @param {Object|Array<Object>} polygons - Single polygon or array of polygons with rings
     * @returns {{ lat, lon }} Initial map center
     */
    _setupOsmFrame(polygons) {
        const polyArray  = Array.isArray(polygons) ? polygons : [polygons];
        const allPoints  = polyArray.flatMap(p => p.rings[0]);
        const xs = allPoints.map(p => p.x);
        const ys = allPoints.map(p => p.y);
        this._polygonKmSize = {
            widthKm:  (Math.max(...xs) - Math.min(...xs)) / 8.01,
            heightKm: (Math.max(...ys) - Math.min(...ys)) / 8.01,
        };
        // Store all ring vertex arrays (excluding closing duplicate) for SVG overlay
        this._osmPolygonRings = polyArray.map(p => {
            const r = p.rings[0];
            return r.slice(0, r.length - 1);
        });
        // Keep legacy single-ring reference for backward compat
        this._osmPolygonRing = this._osmPolygonRings[0];

        let center = { lat: 51.5, lon: -0.1 };
        try {
            const stored = localStorage.getItem('osmSplitLastCenter');
            if (stored) center = JSON.parse(stored);
        } catch (_) {}
        return center;
    }

    /**
     * Open the Split by OSM modal (1 polygon selected, or multiple connected polygons).
     * The fixed green frame is sized to cover all selected polygons' real-world dimensions.
     * Pan the map to position the frame over the target geographic area.
     */
    showOsmSplitDialog() {
        const size = this.selectedPolygonIndices.size;
        if (size === 0) {
            this.uiController.showError('Select at least 1 polygon to split by OSM');
            return;
        }
        if (size > 1 && !this._arePolygonsConnected(this.selectedPolygonIndices)) {
            this.uiController.showError('Selected polygons must share a boundary — select only connected (adjacent) polygons for multi-polygon OSM split');
            return;
        }

        const modal = document.getElementById('osmSplitModal');
        if (!modal) return;
        modal.style.display = 'flex';

        // Update modal title and subtitle for multi-polygon case
        const titleEl    = document.getElementById('osmSplitTitle');
        const subtitleEl = document.getElementById('osmSplitSubtitle');
        if (titleEl) {
            titleEl.textContent = size === 1
                ? 'Split Polygon by OSM Districts'
                : `Split ${size} Connected Polygons by OSM Districts`;
        }
        if (subtitleEl) {
            subtitleEl.textContent = size === 1
                ? 'Pan and zoom the map to position the green frame over your target area. The frame is sized to match the selected polygon\'s real-world dimensions. OSM road data will be downloaded for the framed area.'
                : `${size} selected polygons will be merged and re-split using OSM road data. Pan the map to position the combined frame over the target area.`;
        }

        const selectedPolygons = [...this.selectedPolygonIndices].map(i => this.polygons[i]);

        setTimeout(() => {
            this._initOsmMap();
            if (this._osmMap) {
                this._osmMap.invalidateSize();
                const center = this._setupOsmFrame(selectedPolygons);
                this._osmMap.setView([center.lat, center.lon], 11);
                this._updateFrameRect();
            }
        }, 120);
    }

    /**
     * Called when the user clicks "Split" inside the OSM split modal.
     */
    handleOsmSplitConfirm() {
        if (!this._osmBbox) {
            this.uiController.showError('Map is still loading — please wait a moment');
            return;
        }
        const modal = document.getElementById('osmSplitModal');
        if (modal) modal.style.display = 'none';

        const useSecondary = document.getElementById('osmUseSecondary')?.checked || false;
        this.splitSelectedPolygonByOsm(this._osmBbox, useSecondary);
    }

    /**
     * Core OSM split: sends bbox + selected polygon(s) to the backend, integrates
     * returned sub-polygons. Supports both single-polygon and multi-polygon (merge
     * then split) workflows.
     *
     * @param {{ north, south, east, west }} bbox - WGS84 bounding box
     * @param {boolean} useSecondary - Include tertiary roads for subdivision
     */
    async splitSelectedPolygonByOsm(bbox, useSecondary = false) {
        const size = this.selectedPolygonIndices.size;
        if (size === 0) {
            this.uiController.showError('Select at least 1 polygon to split');
            return;
        }

        // Collect selected polygons sorted by index so we can splice correctly
        const sortedIndices    = [...this.selectedPolygonIndices].sort((a, b) => a - b);
        const selectedPolygons = sortedIndices.map(i => this.polygons[i]);
        const selectedIds      = new Set(selectedPolygons.map(p => p.id));

        // External neighbors: all adjacency neighbors that are NOT being replaced
        const extNeighborSet = new Set();
        for (const p of selectedPolygons) {
            for (const nId of this.adjacencyGraph.getNeighbors(p.id)) {
                if (!selectedIds.has(nId)) extNeighborSet.add(nId);
            }
        }
        const parentNeighborIds = [...extNeighborSet];

        this.uiController.showMessage(
            size === 1
                ? 'Downloading OSM data and generating districts… (30–90 s)'
                : `Downloading OSM data for ${size} polygons (boundaries preserved)… (30–90 s)`
        );

        try {
            const result = size === 1
                ? await this.polygonSplitter.splitByOsm(
                    selectedPolygons[0], bbox.north, bbox.south, bbox.east, bbox.west, useSecondary
                  )
                : await this.polygonSplitter.splitMultipleByOsm(
                    selectedPolygons, bbox.north, bbox.south, bbox.east, bbox.west, useSecondary
                  );

            if (!result.success) {
                this.uiController.showError(result.message);
                return;
            }

            const allNewIds = [];

            if (size === 1) {
                // ── Single polygon: flat list of sub-polygons ─────────────────
                const subPolygons = result.subPolygons;
                console.log(`OSM split produced ${subPolygons.length} sub-polygons`);

                const insertIndex = sortedIndices[0];
                this.polygons.splice(insertIndex, 1);

                const county   = selectedPolygons[0].county;
                const splitIds = this.nextPolygonIds(county, subPolygons.length);
                subPolygons.forEach((p, i) => { p.id = splitIds[i]; });
                this.polygons.splice(insertIndex, 0, ...subPolygons);
                allNewIds.push(...splitIds);

            } else {
                // ── Multi-polygon: boundary-preserving split ──────────────────
                // result.resultsByIndex is sorted DESCENDING by sourceIndex so
                // splicing at higher indices first keeps lower indices intact.
                console.log(`OSM boundary-preserving split for ${size} polygons`);

                for (const { sourceIndex, subPolygons } of result.resultsByIndex) {
                    const actualIdx = sortedIndices[sourceIndex];
                    const county    = selectedPolygons[sourceIndex].county;

                    // Remove the original; assign IDs after removal so nextPolygonIds
                    // sees the freed slot and won't generate duplicates
                    this.polygons.splice(actualIdx, 1);
                    const newIds = this.nextPolygonIds(county, subPolygons.length);
                    subPolygons.forEach((p, i) => { p.id = newIds[i]; });
                    this.polygons.splice(actualIdx, 0, ...subPolygons);
                    allNewIds.push(...newIds);
                }
            }

            // Persist the geographic center so future splits open at the same location
            if (this._osmBbox) {
                try {
                    localStorage.setItem('osmSplitLastCenter', JSON.stringify({
                        lat: (this._osmBbox.north + this._osmBbox.south) / 2,
                        lon: (this._osmBbox.east  + this._osmBbox.west)  / 2,
                    }));
                } catch (_) {}
            }

            const splitZoneIds = [...allNewIds, ...parentNeighborIds];
            this.adjacencyGraph.rebuildForAffected(this.polygons, allNewIds, splitZoneIds);
            this.layerManager.layers.subCounty.polygons = this.polygons;
            this.uiController.populatePolygonSelect(this.polygons);
            this.selectPolygon(sortedIndices[0]);
            this.historyManager.saveToHistory(
                this.polygons,
                size === 1 ? 'Split polygon by OSM' : `Split ${size} polygons by OSM (boundaries preserved)`
            );
            this.updateUndoRedoButtons();
            this.draw();
            this.uiController.showSuccess(result.message);

        } catch (error) {
            console.error('OSM split failed:', error);
            this.uiController.showError(`OSM split failed: ${error.message}`);
        }
    }

    /**
     * Split selected polygon into multiple sub-polygons
     * @param {number} numDistricts - Number of districts to create
     * @param {number} seed - Random seed for reproducible splits
     */
    async splitSelectedPolygon(numDistricts, seed = 42) {
        if (this.selectedPolygonIndices.size !== 1) {
            this.uiController.showError('Select exactly 1 polygon to split');
            return;
        }

        const index = this.selectedPolygonIndex;
        const polygon = this.polygons[index];

        console.log(`Splitting polygon ${polygon.id} into ${numDistricts} districts with seed ${seed}...`);

        // IMPORTANT: Get parent's neighbors BEFORE removing it from the list
        // These neighbors will need to be updated with vertices from the new sub-polygons
        const parentNeighborIds = this.adjacencyGraph.getNeighbors(polygon.id);
        console.log(`Parent polygon has ${parentNeighborIds.length} neighbors: ${parentNeighborIds.join(', ')}`);

        // Show loading message
        this.uiController.showMessage('Splitting polygon... Please wait.');

        try {
            // Perform split (now async - calls Python service)
            const result = await this.polygonSplitter.splitPolygon(polygon, numDistricts, seed);

            if (!result.success) {
                this.uiController.showError(result.message);
                return;
            }

            console.log(`Successfully created ${result.subPolygons.length} sub-polygons`);

            // Replace the original polygon with the sub-polygons
            // Remove original first — this frees its number for gap-filling
            this.polygons.splice(index, 1);

            // Assign consistent {County}_NNN IDs (gap-filling from 001)
            const splitIds = this.nextPolygonIds(polygon.county, result.subPolygons.length);
            result.subPolygons.forEach((p, i) => { p.id = splitIds[i]; });

            // Insert sub-polygons at the same position
            this.polygons.splice(index, 0, ...result.subPolygons);

            // STEP 1: Rebuild adjacency for split polygons + their known neighbors only
            console.log('Rebuilding adjacency graph after polygon split...');
            const splitZoneIds = [...splitIds, ...parentNeighborIds];
            this.adjacencyGraph.rebuildForAffected(this.polygons, splitIds, splitZoneIds);

            // STEP 2: Align shared vertices between split polygons and neighboring polygons
            console.log('Aligning shared vertices after split...');
            this.alignSharedVerticesAfterSplit(index, result.subPolygons.length);

            // STEP 3: Synchronize vertices using VertexSync for precise alignment
            console.log('Synchronizing vertices with neighbors...');
            const originalPolygons = [...this.polygons];
            this.polygons = this.vertexSync.syncAfterSplit(
                this.polygons,
                this.adjacencyGraph,
                index,
                result.subPolygons.length,
                polygon,  // Pass original parent polygon for vertex inheritance
                parentNeighborIds  // Pass parent's neighbors for bidirectional sync
            );

            // Log vertex sync statistics
            const syncStats = this.vertexSync.getStats(originalPolygons, this.polygons);
            console.log('Vertex sync stats:', syncStats);

            // STEP 4: Rebuild adjacency again after vertex sync (same zone)
            console.log('Rebuilding adjacency graph with synchronized vertices...');
            this.adjacencyGraph.rebuildForAffected(this.polygons, splitIds, splitZoneIds);

            // CRITICAL: Update layer manager with the new polygon list
            // The split polygons need to be registered in the subCounty layer
            console.log('Updating layer manager with split polygons...');
            this.layerManager.layers.subCounty.polygons = this.polygons;

            // Update UI
            this.uiController.populatePolygonSelect(this.polygons);
            this.selectPolygon(index); // Select first sub-polygon

            // Save to history
            this.historyManager.saveToHistory(this.polygons, 'Split polygon');
            this.updateUndoRedoButtons();

            // Redraw
            this.draw();

            // Show statistics about shared vertices
            const sharedStats = this.sharedVertices.getStatistics(this.polygons);
            console.log('Shared vertex statistics:', sharedStats);

            // Enable regenerate button after successful split
            this.uiController.setRegenerateEnabled(true);

            this.uiController.showSuccess(result.message);

        } catch (error) {
            console.error('Split failed:', error);
            this.uiController.showError(`Split failed: ${error.message}`);
        }
    }

    /**
     * Export current polygon data to CSV
     */
    exportCSV() {
        try {
            const csvContent = this.dataManager.exportToCSV(this.polygons);
            this.uiController.downloadCSV(csvContent);
            this.uiController.showSuccess('CSV exported successfully!');
        } catch (error) {
            console.error('Export failed:', error);
            this.uiController.showError(`Export failed: ${error.message}`);
        }
    }

    /**
     * Resize canvas to fit container
     */
    resizeCanvas() {
        const container = this.canvas.parentElement;

        // Measure the exact container padding via getComputedStyle so this works on
        // every screen size, display scaling, and browser zoom level — no magic numbers.
        // The canvas uses box-shadow (not border) so getBoundingClientRect() == canvas.width,
        // meaning no border offset needs to be subtracted here or in getCanvasPos().
        const cs   = getComputedStyle(container);
        const padH = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
        const padV = parseFloat(cs.paddingTop)  + parseFloat(cs.paddingBottom);

        const newWidth  = Math.max(200, Math.round(container.clientWidth  - padH));
        const newHeight = Math.max(600, Math.round(container.clientHeight - padV));

        this.renderer.setCanvasSize(newWidth, newHeight);
        this.draw();
    }

    /**
     * Update adjacency graph after vertex edits
     */
    /**
     * Align shared vertices between split polygons and their neighbors
     * This ensures vertices on shared boundaries are exactly aligned
     * @param {number} startIndex - Index where split polygons start
     * @param {number} count - Number of split polygons inserted
     */
    alignSharedVerticesAfterSplit(startIndex, count) {
        if (!this.sharedVertices.isEnabled()) {
            console.log('Shared vertices disabled, skipping alignment');
            return;
        }

        console.log(`Aligning shared vertices for ${count} split polygons starting at index ${startIndex}`);

        const tolerance = this.sharedVertices.getTolerance();
        let alignmentCount = 0;

        // Get the split polygons
        const splitPolygons = this.polygons.slice(startIndex, startIndex + count);

        // For each split polygon
        splitPolygons.forEach((splitPoly, splitIdx) => {
            const globalIndex = startIndex + splitIdx;

            // For each vertex in the split polygon
            splitPoly.rings.forEach((ring) => {
                ring.forEach((vertex) => {
                    // Find all vertices near this position across ALL polygons
                    const nearbyVertices = [];

                    this.polygons.forEach((otherPoly, otherPolyIdx) => {
                        // Skip the current split polygon
                        if (otherPolyIdx === globalIndex) return;

                        otherPoly.rings.forEach((otherRing, otherRingIdx) => {
                            otherRing.forEach((otherVertex, otherVertexIdx) => {
                                const dx = Math.abs(otherVertex.x - vertex.x);
                                const dy = Math.abs(otherVertex.y - vertex.y);

                                if (dx < tolerance && dy < tolerance) {
                                    nearbyVertices.push({
                                        polyIdx: otherPolyIdx,
                                        ringIdx: otherRingIdx,
                                        vertexIdx: otherVertexIdx,
                                        vertex: otherVertex,
                                        polyId: otherPoly.id
                                    });
                                }
                            });
                        });
                    });

                    // If we found nearby vertices, align them all to the average position
                    if (nearbyVertices.length > 0) {
                        // Calculate average position
                        let sumX = vertex.x;
                        let sumY = vertex.y;

                        nearbyVertices.forEach(nv => {
                            sumX += nv.vertex.x;
                            sumY += nv.vertex.y;
                        });

                        const avgX = this.dataManager.roundCoordinate(sumX / (nearbyVertices.length + 1));
                        const avgY = this.dataManager.roundCoordinate(sumY / (nearbyVertices.length + 1));

                        // Update the current vertex
                        vertex.x = avgX;
                        vertex.y = avgY;

                        // Update all nearby vertices
                        nearbyVertices.forEach(nv => {
                            nv.vertex.x = avgX;
                            nv.vertex.y = avgY;
                        });

                        alignmentCount++;

                        if (nearbyVertices.length > 0) {
                            const polyIds = nearbyVertices.map(nv => nv.polyId).join(', ');
                            console.log(`Aligned vertex at (${avgX.toFixed(3)}, ${avgY.toFixed(3)}) shared with: ${polyIds}`);
                        }
                    }
                });
            });
        });

        console.log(`Aligned ${alignmentCount} shared vertices after polygon split`);

        // Validate shared vertices
        const validation = this.sharedVertices.validateSharedVertices(this.polygons);
        if (!validation.isValid) {
            console.warn('Shared vertex validation found issues:', validation.issues);
        } else {
            console.log(`✓ Shared vertices validated: ${validation.sharedGroupCount} groups, ${validation.totalSharedVertices} total vertices`);
        }
    }

    updateAdjacencyAfterEdit() {
        // Determine which polygons were affected
        // We'll update adjacency for the selected polygon and its current neighbors
        if (this.selectedPolygonIndex === null) return;

        const selectedPolygon = this.polygons[this.selectedPolygonIndex];
        const affectedIds = new Set([selectedPolygon.id]);

        // Add current neighbors to the affected set
        const currentNeighbors = this.adjacencyGraph.getNeighbors(selectedPolygon.id);
        currentNeighbors.forEach(id => affectedIds.add(id));

        // Update adjacency for these polygons
        console.log('Updating adjacency for:', Array.from(affectedIds));
        this.adjacencyGraph.updateAdjacency(this.polygons, affectedIds);

        const stats = this.adjacencyGraph.getStatistics();
        console.log('Adjacency graph updated:', stats);
    }

    // ─── Polygon Simplification ──────────────────────────────────────────────

    /**
     * Simplify vertices of the selected polygon (RDP when tolerance > 0)
     * or all polygons (exact collinear when tolerance == 0 / no selection).
     * Saves an undo snapshot before modifying anything.
     */
    handleSimplification() {
        if (!this.polygons || this.polygons.length === 0) {
            this.uiController.showError('No polygons loaded');
            return;
        }

        const tolInput  = document.getElementById('simplifyTolerance');
        const tolMetres = tolInput ? (parseFloat(tolInput.value) || 0) : 0;
        // Convert metres → data units (8.01 data units = 1 km)
        const epsilon   = tolMetres * 8.01 / 1000;

        // ── RDP path: tolerance > 0 with exactly 1 polygon selected ──────────
        if (epsilon > 0 && this.selectedPolygonIndices.size === 1) {
            const idx = this.selectedPolygonIndex;
            this.historyManager.saveToHistory(this.polygons, 'Before RDP simplification');

            const removed = this.polygonSimplifier.simplifyRDP(this.polygons, idx, epsilon);

            if (removed === 0) {
                this.historyManager.undo();
                this.uiController.showStatus(
                    `No vertices removed at ${tolMetres}m — try a higher value`, 3000
                );
                return;
            }

            this.adjacencyGraph.buildAdjacencyList(this.polygons);
            this.uiController.populatePolygonSelect(this.polygons);
            this.updateUndoRedoButtons();
            this.draw();
            this.uiController.showSuccess(
                `RDP simplified: removed ${removed} vertices (tolerance ${tolMetres}m)`
            );
            return;
        }

        // ── Exact collinear path: all polygons ────────────────────────────────
        if (epsilon > 0 && this.selectedPolygonIndices.size !== 1) {
            this.uiController.showStatus('Select exactly 1 polygon for RDP simplification', 3000);
            return;
        }

        this.historyManager.saveToHistory(this.polygons, 'Before vertex simplification');

        const { polygons, removedCount } = this.polygonSimplifier.simplify(this.polygons);
        this.polygons = polygons;

        if (removedCount === 0) {
            this.historyManager.undo();
            this.uiController.showStatus('No redundant vertices found', 3000);
            return;
        }

        this.adjacencyGraph.buildAdjacencyList(this.polygons);
        this.uiController.populatePolygonSelect(this.polygons);
        const stats = this.historyManager.getHistoryStats();
        this.uiController.updateUndoRedoButtons(
            this.historyManager.canUndo(),
            this.historyManager.canRedo(),
            stats.undoableActions,
            stats.redoableActions
        );
        this.draw();
        this.uiController.showSuccess(
            `Simplification complete: removed ${removedCount} redundant vertex${removedCount !== 1 ? 'es' : ''}`
        );
    }

    // ─── Update Neighbours ───────────────────────────────────────────────────

    /**
     * Fully rebuild the adjacency graph from the current polygon set.
     * Useful after merge/split operations that may leave the graph stale.
     * Rules applied (same as initialisation):
     *   - Every polygon pair is compared via shared boundary length.
     *   - A pair is neighbours iff their shared boundary length > 1e-4.
     *   - Shared boundary = collinear overlapping edges or fully matching edges.
     *   - Result is bidirectional and stored as sorted arrays.
     */
    handleUpdateNeighbours() {
        if (!this.polygons || this.polygons.length === 0) {
            this.uiController.showError('No polygons loaded');
            return;
        }

        console.log('Rebuilding adjacency graph (Update Neighbours)...');
        this.adjacencyGraph.buildAdjacencyList(this.polygons);
        const stats = this.adjacencyGraph.getStatistics();
        console.log('Adjacency graph rebuilt:', stats);

        this.draw();
        this.updatePolygonInfo();
        this.uiController.showSuccess(
            `Neighbours updated: ${stats.polygonCount} polygons, ${stats.totalEdges} shared edges`
        );
    }

    // ─── Measure Tool ────────────────────────────────────────────────────────

    /**
     * Toggle measure mode on/off from the toolbar button.
     */
    toggleMeasureMode() {
        const nowActive = this.measureTool.toggle();
        this.mouseHandler.blocked = nowActive;
        this.canvas.style.cursor  = nowActive ? 'crosshair' : 'grab';

        const btn = document.getElementById('measureBtn');
        if (btn) btn.classList.toggle('active', nowActive);

        const info = document.getElementById('measureInfo');
        if (info) info.style.display = nowActive ? 'block' : 'none';

        this.draw();
    }

    /**
     * Attach canvas event listeners for measure-mode interactions.
     * These run independently from MouseHandler (which is blocked when active).
     */
    setupMeasureMouseHandlers() {
        this.canvas.addEventListener('mousedown', (e) => {
            if (!this.measureTool.active) return;
            const { x: sx, y: sy } = this.mouseHandler.getCanvasPos(e);
            const dp = this.geometryOps.screenToData(sx, sy);
            const hit = this.measureTool.findPointAt(dp.x, dp.y, this.geometryOps.scale);
            if (hit >= 0) {
                this._measureDragIndex = hit;
                this._measureDragMoved = false;
            } else {
                // Add new point on click in empty space
                this.measureTool.addPoint(dp.x, dp.y);
                this._measureDragIndex = -1;
                this.draw();
            }
        });

        this.canvas.addEventListener('mousemove', (e) => {
            if (!this.measureTool.active) return;
            const { x: sx, y: sy } = this.mouseHandler.getCanvasPos(e);
            const dp = this.geometryOps.screenToData(sx, sy);

            if (this._measureDragIndex >= 0) {
                this.measureTool.movePoint(this._measureDragIndex, dp.x, dp.y);
                this._measureDragMoved = true;
                this.draw();
            } else {
                // Cursor hint: pointer over a circle, crosshair otherwise
                const hit = this.measureTool.findPointAt(dp.x, dp.y, this.geometryOps.scale);
                this.canvas.style.cursor = hit >= 0 ? 'pointer' : 'crosshair';
            }
        });

        this.canvas.addEventListener('mouseup', () => {
            if (!this.measureTool.active) return;
            if (this._measureDragIndex >= 0 && !this._measureDragMoved) {
                // Pure click on an existing circle → remove it
                this.measureTool.removePoint(this._measureDragIndex);
                this.draw();
            }
            this._measureDragIndex = -1;
            this._measureDragMoved = false;
        });

        // Escape key exits measure mode
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.measureTool.active) {
                this.toggleMeasureMode();
            }
        });
    }

    /**
     * Draw the measurement overlay (lines, circles, distance labels) on top of the map.
     */
    renderMeasureOverlay() {
        const pts = this.measureTool.points;
        if (pts.length === 0) return;

        const ctx = this.renderer.ctx;
        ctx.save();

        // ── Lines ──────────────────────────────────────────────────────────
        if (pts.length >= 2) {
            ctx.beginPath();
            const s0 = this.geometryOps.dataToScreen(pts[0].x, pts[0].y);
            ctx.moveTo(s0.x, s0.y);
            for (let i = 1; i < pts.length; i++) {
                const si = this.geometryOps.dataToScreen(pts[i].x, pts[i].y);
                ctx.lineTo(si.x, si.y);
            }
            ctx.strokeStyle = '#1a1a1a';
            ctx.lineWidth   = 2;
            ctx.setLineDash([]);
            ctx.stroke();

            // ── Segment distance labels ─────────────────────────────────
            ctx.font         = 'bold 11px "Segoe UI", sans-serif';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            for (let i = 1; i < pts.length; i++) {
                const sa = this.geometryOps.dataToScreen(pts[i - 1].x, pts[i - 1].y);
                const sb = this.geometryOps.dataToScreen(pts[i].x, pts[i].y);
                const mx  = (sa.x + sb.x) / 2;
                const my  = (sa.y + sb.y) / 2;
                const label = this.measureTool.formatDistance(this.measureTool.segmentDistanceM(i));
                const tw = ctx.measureText(label).width;
                const pad = 4, h = 16;
                ctx.fillStyle = 'rgba(255,255,255,0.92)';
                ctx.beginPath();
                ctx.roundRect(mx - tw / 2 - pad, my - h / 2, tw + pad * 2, h, 3);
                ctx.fill();
                ctx.fillStyle = '#111';
                ctx.fillText(label, mx, my);
            }
        }

        // ── Point circles ───────────────────────────────────────────────
        for (let i = 0; i < pts.length; i++) {
            const sp = this.geometryOps.dataToScreen(pts[i].x, pts[i].y);
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
            ctx.fillStyle   = 'white';
            ctx.fill();
            ctx.strokeStyle = '#1a1a1a';
            ctx.lineWidth   = 2;
            ctx.stroke();
        }

        ctx.restore();

        // ── Update sidebar total ────────────────────────────────────────
        const totalEl = document.getElementById('measureTotal');
        if (totalEl) {
            const total = this.measureTool.totalDistanceM();
            totalEl.textContent = pts.length >= 2
                ? `Total: ${this.measureTool.formatDistance(total)}`
                : 'Click the map to start measuring';
        }
    }

    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Main drawing method
     */
    draw() {
        // Get visible polygons based on layer settings
        let visiblePolygons = this.layerManager.getVisiblePolygons();

        // Apply district filter only while in Redistricting mode
        if (this.districtFilter && window.AppMode && window.AppMode.current === 'redistricting') {
            visiblePolygons = visiblePolygons.filter(p => p.district === this.districtFilter);
        }

        this.renderer.draw(
            visiblePolygons,
            this.selectedPolygonIndex,
            this.isEditMode,
            this.sharedVertices,
            this.selectedPolygonIndices,  // Pass multi-selection set
            this.vertexSelection,  // Pass vertex selection manager
            this.fixedCountyVertices  // Pass fixed county vertices for blue rendering
        );

        // Draw bold county boundaries in all modes
        this.renderCountyBoundaryOverlay();

        // Draw ward selection highlights in Redistricting mode only
        if (window.AppMode && window.AppMode.current === 'redistricting') {
            this.renderWardSelectionOverlay();
        }

        this.renderMeasureOverlay();

        // Draw virtual nodes on top of everything else
        if (this.virtualNodeManager && this.virtualNodeManager.count > 0) {
            this.renderVirtualNodeOverlay();
        }
    }

    /**
     * Highlight polygons that are in the current ward draft (Redistricting mode).
     */
    renderWardSelectionOverlay() {
        if (!window.WardManager) return;

        const ctx = this.renderer.ctx;
        const geo = this.geometryOps;

        ctx.save();
        ctx.lineJoin = 'round';
        ctx.setLineDash([]);

        // Draw saved wards (each in their own colour); selected ward gets a bolder ring
        const activeDistrict = this.districtFilter || null;
        const selectedIds = window.WardManager.getSelectedWardIds ? window.WardManager.getSelectedWardIds() : null;
        window.WardManager.getSavedWards()
            .filter(ward => !activeDistrict || ward.district === activeDistrict)
            .forEach(ward => {
            const hex = ward.color.hex;
            const isSelected = selectedIds && ward.polygonIds.some(id => selectedIds.has(id));
            ctx.fillStyle   = hex + (isSelected ? '55' : '40');
            ctx.strokeStyle = isSelected ? hex : hex + 'cc';
            ctx.lineWidth   = isSelected ? 3.5 : 2;
            if (isSelected) ctx.setLineDash([]);
            this.polygons
                .filter(p => ward.polygonIds.includes(p.id))
                .forEach(p => {
                    p.rings.forEach(ring => {
                        if (ring.length < 2) return;
                        ctx.beginPath();
                        ring.forEach((pt, i) => {
                            const s = geo.dataToScreen(pt.x, pt.y);
                            if (i === 0) ctx.moveTo(s.x, s.y);
                            else         ctx.lineTo(s.x, s.y);
                        });
                        ctx.closePath();
                        ctx.fill();
                        ctx.stroke();
                    });
                });
        });

        // Draw current draft ward (in the selected creation colour)
        const wardIds = window.WardManager.getCurrentWardIds();
        if (wardIds && wardIds.size > 0 && window.WardManager.isCreateMode()) {
            const color = window.WardManager.getCurrentColor();
            ctx.fillStyle   = color.hex + '40';
            ctx.strokeStyle = color.hex + 'ee';
            ctx.lineWidth   = 2.5;

            this.polygons
                .filter(p => wardIds.has(p.id))
                .forEach(p => {
                    p.rings.forEach(ring => {
                        if (ring.length < 2) return;
                        ctx.beginPath();
                        ring.forEach((pt, i) => {
                            const s = geo.dataToScreen(pt.x, pt.y);
                            if (i === 0) ctx.moveTo(s.x, s.y);
                            else         ctx.lineTo(s.x, s.y);
                        });
                        ctx.closePath();
                        ctx.fill();
                        ctx.stroke();
                    });
                });
        }

        ctx.restore();
    }

    /**
     * Draw bold county boundary outlines as a purely visual overlay.
     * No polygon data is modified — this is a rendering-only effect.
     * When a district filter is active, only draws boundaries for counties
     * that contain sub-polygons belonging to the selected district.
     */
    renderCountyBoundaryOverlay() {
        const countyPolygons = this.layerManager.layers.county.polygons;
        if (!countyPolygons || countyPolygons.length === 0) return;

        // Determine which counties to outline
        let visibleCounties = countyPolygons;
        if (this.districtFilter) {
            const relevantCounties = new Set(
                this.polygons
                    .filter(p => p.district === this.districtFilter)
                    .map(p => p.county)
            );
            visibleCounties = countyPolygons.filter(c => relevantCounties.has(c.county));
        }

        if (visibleCounties.length === 0) return;

        const ctx = this.renderer.ctx;
        const geo = this.geometryOps;

        ctx.save();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.lineWidth   = 3;
        ctx.lineJoin    = 'round';
        ctx.setLineDash([]);

        visibleCounties.forEach(county => {
            const rings = county.rings;
            if (!rings || rings.length === 0) return;

            rings.forEach(ring => {
                if (ring.length < 2) return;
                ctx.beginPath();
                ring.forEach((pt, i) => {
                    const s = geo.dataToScreen(pt.x, pt.y);
                    if (i === 0) ctx.moveTo(s.x, s.y);
                    else         ctx.lineTo(s.x, s.y);
                });
                ctx.closePath();
                ctx.stroke();
            });
        });

        ctx.restore();
    }

    /**
     * Get current application state
     * @returns {Object} - Current state
     */
    getState() {
        return {
            polygonsCount: this.polygons.length,
            selectedPolygonIndex: this.selectedPolygonIndex,
            isEditMode: this.isEditMode,
            canUndo: this.historyManager.canUndo(),
            canRedo: this.historyManager.canRedo(),
            transformation: this.geometryOps.getTransformation(),
            historyStats: this.historyManager.getHistoryStats()
        };
    }

    /**
     * Load polygon data directly (for programmatic use)
     * @param {Array<Object>} polygons - Polygon data to load
     */
    loadPolygons(polygons) {
        this.polygons = polygons;
        this.geometryOps.calculateBounds(this.polygons);
        this.geometryOps.fitToView();
        // this.streetLayer.generate(this.geometryOps.bounds);  // deferred: generated on first toggle-on

        // Build adjacency graph
        console.log('Building adjacency graph...');
        this.adjacencyGraph.buildAdjacencyList(this.polygons);
        const stats = this.adjacencyGraph.getStatistics();
        console.log('Adjacency graph built:', stats);

        this.uiController.populatePolygonSelect(this.polygons);
        this.uiController.setExportEnabled(true);
        this.uiController.setEditingEnabled(true);

        this.historyManager.clearHistory();
        this.historyManager.saveToHistory(this.polygons, 'Polygons loaded programmatically');
        this.updateUndoRedoButtons();

        // Activate the default app mode (Edit Polygon) on every fresh CSV load
        if (window.AppMode) window.AppMode.initDefault();

        this.draw();
    }

    /**
     * Switch to county layer view
     * Updates the polygon list to show county-level polygons (auto-generated)
     */
    switchToCountyLayer() {
        if (this.layerManager.layers.county.polygons.length === 0) {
            console.warn('County layer is empty. Please load a CSV file first.');
            this.uiController.showError('No data loaded. Please load a CSV file.');
            return;
        }

        // Switch to county polygons for selection and editing
        this.polygons = this.layerManager.layers.county.polygons;

        // Recalculate bounds and fit to view
        this.geometryOps.calculateBounds(this.polygons);
        this.geometryOps.fitToView();

        // Rebuild adjacency graph for new layer
        this.adjacencyGraph.buildAdjacencyList(this.polygons);

        // Update UI
        this.uiController.populatePolygonSelect(this.polygons);
        this.selectedPolygonIndex = null;
        this.selectedPolygonIndices.clear();
        this.uiController.setSelectedPolygon(null);

        // Fixed county vertices already initialized during data load (immutable)
        // No re-initialization allowed - vertices are protected

        // Keep current mode (allow view mode for county layer to show vertices and info)
        // Editing operations will be blocked separately

        console.log(`Switched to county layer: ${this.polygons.length} polygons`);
    }

    /**
     * Switch to sub-county layer view
     * Updates the polygon list to show only sub-county polygons
     */
    switchToSubCountyLayer() {
        if (this.layerManager.layers.subCounty.polygons.length === 0) {
            console.warn('Sub-county layer is empty. Please load stage1_subdivided_synced_polygons.csv first.');
            this.uiController.showError('Sub-county layer not loaded. Please load stage1_subdivided_synced_polygons.csv');
            return;
        }

        // Switch to sub-county polygons for selection and editing
        this.polygons = this.layerManager.layers.subCounty.polygons;

        // Recalculate bounds and fit to view
        this.geometryOps.calculateBounds(this.polygons);
        this.geometryOps.fitToView();

        // Rebuild adjacency graph for new layer
        this.adjacencyGraph.buildAdjacencyList(this.polygons);

        // Update UI
        this.uiController.populatePolygonSelect(this.polygons);
        this.selectedPolygonIndex = null;
        this.selectedPolygonIndices.clear();
        this.uiController.setSelectedPolygon(null);

        console.log(`Switched to sub-county layer: ${this.polygons.length} polygons`);
    }

    /**
     * Enable or disable specific features
     * @param {Object} features - Features to enable/disable
     */
    setFeatures(features) {
        if (features.sharedVertices !== undefined) {
            this.sharedVertices.setEnabled(features.sharedVertices);
        }
        
        if (features.overlapDetection !== undefined) {
            this.overlapDetection.setEnabled(features.overlapDetection);
        }
        
        if (features.grid !== undefined) {
            const options = this.renderer.getOptions();
            options.showGrid = features.grid;
            this.renderer.setOptions(options);
        }
        
        if (features.vertexNumbers !== undefined) {
            const options = this.renderer.getOptions();
            options.showVertexNumbers = features.vertexNumbers;
            this.renderer.setOptions(options);
        }
        this.draw();
    }

    /**
     * Toggle the procedural street layer on/off and redraw.
     * @returns {boolean} new visibility state
     */
    toggleStreetLayer() {
        const visible = this.streetLayer.toggle();
        this.draw();
        return visible;
    }

    /**
     * Toggle the density colour map layer on/off and redraw.
     * @returns {boolean} new visibility state
     */
    toggleDensityColorMap() {
        const active = this.renderer.toggleDensityColorMap();
        this.draw();
        return active;
    }

    /**
     * Get statistics about current data
     * @returns {Object} - Statistics
     */
    getStatistics() {
        if (this.polygons.length === 0) {
            return { polygonsCount: 0 };
        }
        
        const totalVertices = this.polygons.reduce((sum, polygon) => {
            return sum + polygon.rings.reduce((ringSum, ring) => ringSum + ring.length, 0);
        }, 0);
        
        const sharedVertexStats = this.sharedVertices.getStatistics(this.polygons);
        const overlapInfo = this.overlapDetection.findAllOverlaps(this.polygons);
        
        return {
            polygonsCount: this.polygons.length,
            totalVertices,
            averageVerticesPerPolygon: (totalVertices / this.polygons.length).toFixed(1),
            polygonsWithHoles: this.polygons.filter(p => p.rings.length > 1).length,
            sharedVertexStats,
            overlappingPairs: overlapInfo.length,
            historyStats: this.historyManager.getHistoryStats()
        };
    }

    /**
     * Cleanup and destroy the editor
     */
    destroy() {
        this.mouseHandler.destroy();
        this.historyManager.clearHistory();
        console.log('Polygon Editor destroyed');
    }
}
