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

        // Application state
        this.polygons = [];
        this.selectedPolygonIndex = null;
        this.selectedPolygonIndices = new Set(); // Multi-selection for combining
        this.isEditMode = false;
        this.vertexWasDragged = false;
        this.isDraggingVertex = false; // Track if dragging a shift-selected vertex
        this.draggedVertex = null; // {polygonIndex, ringIndex, vertexIndex, x, y}

        // Initialize the application
        this.initialize();
    }

    /**
     * Initialize the application
     */
    initialize() {
        this.setupEventListeners();
        this.setupMouseCallbacks();
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
        // Track which keys are currently pressed
        const isCtrl = e.code === 'ControlLeft' || e.code === 'ControlRight' ||
                       e.key === 'Control' || e.keyCode === 17;
        const isMeta = e.code === 'MetaLeft' || e.code === 'MetaRight' ||
                       e.key === 'Meta' || e.keyCode === 91 || e.keyCode === 93;

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

        // S key: Split polygon
        if (hasS && !hasCtrlOrMeta) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            console.log('>>> S: Split polygon triggered');

            // Check if split button is enabled
            const splitBtn = document.getElementById('splitBtn');
            if (splitBtn && !splitBtn.disabled) {
                this.showSplitDialog();
            } else {
                console.log('>>> Split not available (button disabled)');
                this.uiController.showError('Select exactly 1 polygon to split');
            }

            this.keysPressed.clear();
            return false;
        }

        // C key: Split by vertices (without Ctrl/Meta)
        if (hasC && !hasCtrlOrMeta) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            console.log('>>> C: Split by vertices triggered');

            // Check if split by vertices button is enabled
            const splitByVerticesBtn = document.getElementById('splitByVerticesBtn');
            if (splitByVerticesBtn && !splitByVerticesBtn.disabled) {
                this.handleSplitByVertices();
            } else {
                console.log('>>> Split by vertices not available (button disabled)');
                this.uiController.showError('Select at least 3 vertices in the same county to split');
            }

            this.keysPressed.clear();
            return false;
        }

        // 1 key: Replace selected vertex with previous vertex (without Ctrl/Meta)
        if (has1 && !hasCtrlOrMeta) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            console.log('>>> 1: Replace with previous vertex triggered');

            // Check if replace button is enabled (1 vertex selected, not fixed)
            const replaceBtn = document.getElementById('replaceVertexBtn');
            if (replaceBtn && !replaceBtn.disabled) {
                this.handleVertexReplaceWithKey('previous');
            } else {
                console.log('>>> Replace not available (button disabled)');
                this.uiController.showError('Select exactly 1 non-fixed vertex to replace');
            }

            this.keysPressed.clear();
            return false;
        }

        // 2 key: Replace selected vertex with next vertex (without Ctrl/Meta)
        if (has2 && !hasCtrlOrMeta) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            console.log('>>> 2: Replace with next vertex triggered');

            // Check if replace button is enabled (1 vertex selected, not fixed)
            const replaceBtn = document.getElementById('replaceVertexBtn');
            if (replaceBtn && !replaceBtn.disabled) {
                this.handleVertexReplaceWithKey('next');
            } else {
                console.log('>>> Replace not available (button disabled)');
                this.uiController.showError('Select exactly 1 non-fixed vertex to replace');
            }

            this.keysPressed.clear();
            return false;
        }
    }

    /**
     * Handle keyboard shortcuts - keyup
     * @param {KeyboardEvent} e - Keyboard event
     */
    handleKeyUp(e) {
        // Remove keys from pressed set when released
        const isCtrl = e.code === 'ControlLeft' || e.code === 'ControlRight' ||
                       e.key === 'Control' || e.keyCode === 17;
        const isMeta = e.code === 'MetaLeft' || e.code === 'MetaRight' ||
                       e.key === 'Meta' || e.keyCode === 91 || e.keyCode === 93;

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
        this.mouseHandler.setCallbacks({
            onVertexSelect: (dataX, dataY, cursorCheckOnly = false) => {
                return this.handleVertexSelection(dataX, dataY, cursorCheckOnly);
            },
            onVertexClick: (dataX, dataY) => {
                return this.handleVertexClick(dataX, dataY);
            },
            onVertexDrag: (vertex, newX, newY) => {
                this.handleVertexDrag(vertex, newX, newY);
            },
            onPolygonSelect: (dataX, dataY, cursorCheckOnly = false, isCtrlKey = false) => {
                return this.handlePolygonSelection(dataX, dataY, cursorCheckOnly, isCtrlKey);
            },
            onDeselectPolygon: () => {
                // Deselect current polygon when clicking on empty area
                this.selectPolygon(null);
                this.draw();
            },
            onViewUpdate: () => {
                this.draw();
            },
            onVertexDelete: () => {
                this.handleVertexDelete();
            },
            onDragEnd: () => {
                if (this.vertexWasDragged) {
                    // Overlap detection is DISABLED - no checking
                    // Just save to history directly
                    this.historyManager.saveToHistory(this.polygons, 'Vertex moved');
                    this.updateUndoRedoButtons();

                    // Update adjacency graph for affected polygons
                    this.updateAdjacencyAfterEdit();

                    this.vertexWasDragged = false;
                }

                this.draw();
            },
            onReplacementDragEnd: (sourceVertex, targetX, targetY) => {
                this.handleVertexReplacement(sourceVertex, targetX, targetY);
            },
            onMidpointCreate: () => {
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

            // Build adjacency graph
            console.log('Building adjacency graph...');
            this.adjacencyGraph.buildAdjacencyList(this.polygons);
            const stats = this.adjacencyGraph.getStatistics();
            console.log('Adjacency graph built:', stats);

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
                    // CRITICAL: Block protected vertices (fixed or cross-county) from dragging
                    if (this.vertexClassifier.isProtected(vertex.x, vertex.y, this.polygons)) {
                        const type = this.vertexClassifier.classify(vertex.x, vertex.y, this.polygons);
                        console.log(`Cannot select ${this.vertexClassifier.label(type)} vertex for dragging`);
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

                for (let vertexIndex = 0; vertexIndex < ring.length; vertexIndex++) {
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
            // Update polygons with result
            this.polygons = result.polygons;

            // Clear vertex selection
            this.vertexSelection.clearSelection();
            this.updateVertexSelectionInfo();

            // CRITICAL: Validate shared vertices after deletion
            console.log('Validating shared vertices after deletion...');
            const validation = this.sharedVertices.validateSharedVertices(this.polygons);
            if (!validation.isValid) {
                console.warn('Shared vertex validation found issues:', validation.issues);
            } else {
                console.log(`✓ Shared vertices validated: ${validation.sharedGroupCount} groups, ${validation.totalSharedVertices} total vertices`);
            }

            // CRITICAL: Rebuild adjacency graph (full rebuild since deletion affects multiple polygons)
            console.log('Rebuilding adjacency graph after deletion...');
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

            // CRITICAL: Validate shared vertices after midpoint creation
            console.log('Validating shared vertices after midpoint creation...');
            const validation = this.sharedVertices.validateSharedVertices(this.polygons);
            if (!validation.isValid) {
                console.warn('Shared vertex validation found issues:', validation.issues);
            } else {
                console.log(`✓ Shared vertices validated: ${validation.sharedGroupCount} groups, ${validation.totalSharedVertices} total vertices`);
            }

            // CRITICAL: Rebuild adjacency graph (full rebuild since midpoint affects multiple polygons)
            console.log('Rebuilding adjacency graph after midpoint creation...');
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

            console.log('Midpoint creation successful:', result.message);
            this.uiController.showStatus(result.message);
        } else {
            console.log('Midpoint creation failed:', result.message);
            alert('Cannot create midpoints: ' + result.message);
        }
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

            // CRITICAL: Validate shared vertices after split
            console.log('Validating shared vertices after split...');
            const validation = this.sharedVertices.validateSharedVertices(this.polygons);
            if (!validation.isValid) {
                console.warn('Shared vertex validation found issues:', validation.issues);
            } else {
                console.log(`✓ Shared vertices validated: ${validation.sharedGroupCount} groups, ${validation.totalSharedVertices} total vertices`);
            }

            // CRITICAL: Rebuild adjacency graph (full rebuild since split creates new polygons)
            console.log('Rebuilding adjacency graph after split...');
            this.adjacencyGraph.buildAdjacencyList(this.polygons);

            const stats = this.adjacencyGraph.getStatistics();
            console.log('Adjacency graph rebuilt:', stats);

            // CRITICAL: Sync layer manager with updated polygon state
            // This ensures the split polygons are visible immediately
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

        // Check if any selected vertices are fixed
        let hasFixedVertex = false;
        let allInSameCounty = true;
        let hasOrphanedVertex = false;   // vertex coordinate not found in any polygon
        let hasMissingCounty = false;    // vertex found but all owning polygons lack county data
        let countyName = null;

        if (selectedInfo.length > 0) {
            selectedInfo.forEach(v => {
                if (this.vertexClassifier.isProtected(v.x, v.y, this.polygons)) {
                    hasFixedVertex = true;
                }

                // Use resolveVertexInfo to distinguish:
                //   not found → orphaned vertex (invalid)
                //   found, no counties → polygon exists but county field is missing/same-as-id
                //   found, counties → normal case; intersect to check same-county
                const info = this.vertexClassifier.resolveVertexInfo(v.x, v.y, this.polygons);

                if (!info.found) {
                    hasOrphanedVertex = true;
                    allInSameCounty = false;
                    return;
                }
                if (info.counties.size === 0) {
                    hasMissingCounty = true;
                    allInSameCounty = false;
                    return;
                }

                if (countyName === null) {
                    countyName = Array.from(info.counties)[0];
                } else if (!info.counties.has(countyName)) {
                    allInSameCounty = false;
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
            const crossCountyText = (!hasOrphanedVertex && !hasMissingCounty && !allInSameCounty) ? '<span style="color: #FF6600; font-weight: bold;">⚠️ Vertices span multiple counties</span><br>' : '';

            vertexInfo.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 4px;">${stats.selectedCount} vertex${stats.selectedCount > 1 ? 'es' : ''} selected</div>
                <div style="font-size: 9px; color: #666; margin-bottom: 4px;">${coordsText}</div>
                ${orphanText}${missingCountyText}${crossCountyText}${fixedText}
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
        const clickedPolygonIndex = this.geometryOps.findPolygonAtPosition(dataX, dataY, this.polygons);

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
        // CRITICAL: Clear vertex selection when switching to a different polygon
        // This ensures all selected vertices always belong to the currently selected polygon
        if (index !== this.selectedPolygonIndex) {
            console.log(`Polygon selection changed from ${this.selectedPolygonIndex} to ${index} - clearing vertex selection`);
            this.vertexSelection.clearSelection();
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
        const canSplit = this.selectedPolygonIndices.size === 1;
        this.uiController.setSplitEnabled(canSplit);

        // Disable regenerate if selection changes (unless exactly 1 polygon selected)
        if (!canSplit) {
            this.uiController.setRegenerateEnabled(false);
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
            this.polygons = previousState.polygons;

            // Clear vertex selection (important for undo after vertex deletion)
            this.vertexSelection.clearSelection();
            this.updateVertexSelectionInfo();

            // Rebuild adjacency graph with new polygon data
            console.log('Rebuilding adjacency graph after undo...');
            this.adjacencyGraph.buildAdjacencyList(this.polygons);

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
            this.polygons = nextState.polygons;

            // Clear vertex selection (important for redo after vertex deletion)
            this.vertexSelection.clearSelection();
            this.updateVertexSelectionInfo();

            // Rebuild adjacency graph with new polygon data
            console.log('Rebuilding adjacency graph after redo...');
            this.adjacencyGraph.buildAdjacencyList(this.polygons);

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

            // STEP 1: Rebuild adjacency graph FIRST (needed for vertex sync)
            console.log('Rebuilding adjacency graph after polygon combination...');
            this.adjacencyGraph.buildAdjacencyList(this.polygons);

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

            // STEP 3: Rebuild adjacency graph AGAIN with synchronized vertices
            console.log('Rebuilding adjacency graph with synchronized vertices...');
            this.adjacencyGraph.buildAdjacencyList(this.polygons);

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

            // STEP 1: Rebuild adjacency graph FIRST (needed for vertex sync)
            console.log('Rebuilding adjacency graph after polygon split...');
            this.adjacencyGraph.buildAdjacencyList(this.polygons);

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

            // STEP 4: Rebuild adjacency graph AGAIN with synchronized vertices
            console.log('Rebuilding adjacency graph with synchronized vertices...');
            this.adjacencyGraph.buildAdjacencyList(this.polygons);

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
        const newWidth = container.clientWidth - 40;
        const newHeight = Math.max(600, window.innerHeight * 0.6);
        
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
            splitPoly.rings.forEach((ring, ringIdx) => {
                ring.forEach((vertex, vertexIdx) => {
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

    /**
     * Main drawing method
     */
    draw() {
        // Get visible polygons based on layer settings
        const visiblePolygons = this.layerManager.getVisiblePolygons();

        this.renderer.draw(
            visiblePolygons,
            this.selectedPolygonIndex,
            this.isEditMode,
            this.sharedVertices,
            this.selectedPolygonIndices,  // Pass multi-selection set
            this.vertexSelection,  // Pass vertex selection manager
            this.fixedCountyVertices  // Pass fixed county vertices for blue rendering
        );
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
