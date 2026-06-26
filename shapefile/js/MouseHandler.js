/**
 * MouseHandler - Manages mouse interactions for polygon editing
 * Updated with midpoint handle support
 */
class MouseHandler {
    constructor(canvas, geometryOps) {
        this.canvas = canvas;
        this.geometryOps = geometryOps;

        // When true, all mouse-down/move/up handling is suppressed so another
        // layer (e.g. MeasureTool) can own the events instead.
        this.blocked = false;

        // Interaction state
        this.isDragging = false;
        this.isPanning = false;
        this.isRectSelecting = false;
        this.lassoPath = []; // screen-coord [{x,y}] points for current freehand lasso
        this.selectedVertex = null;
        this.lastMousePos = { x: 0, y: 0 };
        this.isReplacementDrag = false; // Track if this is a vertex replacement drag

        // Long-press detection state
        this._longPressTimer  = null;
        this._longPressOrigin = null; // {x,y} screen coords at mousedown
        this._longPressData   = null; // {x,y} data coords at mousedown
        this._longPressCtrl   = false;

        // Keyboard navigation state
        this.keysPressed = new Set();
        this.keyboardPanInterval = null;
        this.keyboardPanSpeed = 5; // Initial speed (pixels per frame)
        this.keyboardPanAcceleration = 0.5; // Speed increase per frame
        this.maxKeyboardPanSpeed = 50; // Maximum speed
        this.currentPanSpeed = this.keyboardPanSpeed;

        // Callback functions
        this.callbacks = {
            onVertexDrag: null,
            onVertexSelect: null,
            onPolygonSelect: null,
            onViewUpdate: null,
            onDragEnd: null,
            onVertexDelete: null,
            onReplacementDragEnd: null, // Callback for vertex replacement drag
            onMidpointCreate: null,     // Callback for midpoint creation (M key)
            onRectSelectUpdate: null,   // (lassoPath) called each frame while lasso is drawing
            onRectSelect: null          // (lassoPath) called when lasso drag ends
        };

        // Setup event listeners
        this.setupEventListeners();
    }

    /**
     * Set callback functions for mouse events
     * @param {Object} callbacks - Object containing callback functions
     */
    setCallbacks(callbacks) {
        this.callbacks = { ...this.callbacks, ...callbacks };
    }

    /**
     * Convert a mouse event's client coordinates to canvas-intrinsic pixel coordinates.
     * This corrects for any mismatch between the canvas's CSS display size (e.g. width:100%)
     * and its intrinsic drawing-buffer size (canvas.width / canvas.height).
     * Without this correction, hits become increasingly inaccurate at high zoom levels.
     * @param {MouseEvent} e
     * @returns {{ x: number, y: number }}
     */
    getCanvasPos(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (this.canvas.width / rect.width),
            y: (e.clientY - rect.top)  * (this.canvas.height / rect.height)
        };
    }

    /**
     * Setup mouse and keyboard event listeners
     */
    setupEventListeners() {
        this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        this.canvas.addEventListener('wheel', (e) => this.handleWheel(e));
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Keyboard event listeners for arrow key navigation
        window.addEventListener('keydown', (e) => this.handleKeyDown(e));
        window.addEventListener('keyup', (e) => this.handleKeyUp(e));
    }

    /**
     * Handle mouse down events
     * @param {MouseEvent} e - Mouse event
     */
    handleMouseDown(e) {
        if (this.blocked) return;
        const { x: screenX, y: screenY } = this.getCanvasPos(e);

        this.lastMousePos = { x: screenX, y: screenY };

        const dataPos = this.geometryOps.screenToData(screenX, screenY);

        // Store Ctrl/Cmd key state
        const isCtrlPressed = e.ctrlKey || e.metaKey;
        const isShiftPressed = e.shiftKey;

        // Debug: log all modifier keys
        console.log('MouseDown - ctrlKey:', e.ctrlKey, 'metaKey:', e.metaKey, 'shiftKey:', e.shiftKey, 'altKey:', e.altKey);

        // Prevent default browser behavior for Ctrl+Click
        if (isCtrlPressed) {
            e.preventDefault();
        }

        // HIGHEST PRIORITY: Shift+Click vertex selection (for highlighting neighboring vertices)
        // This must be checked BEFORE any other vertex/midpoint operations
        if (isShiftPressed && this.callbacks.onVertexClick) {
            console.log('Shift+Click detected, calling onVertexClick callback...');
            const vertexResult = this.callbacks.onVertexClick(dataPos.x, dataPos.y);
            console.log('onVertexClick result:', vertexResult);
            if (vertexResult.vertexFound) {
                console.log('Vertex selection triggered (Shift+Click)');
                e.preventDefault();
                return;
            } else {
                console.log('No vertex found at this position during Shift+Click');
            }
        } else if (isShiftPressed) {
            console.log('Shift+Click detected but onVertexClick callback is not defined!');
        }

        // Check for vertex selection - only in edit mode and not when Ctrl or Shift is pressed
        if (this.callbacks.onVertexSelect && !isCtrlPressed && !isShiftPressed) {
            const vertexResult = this.callbacks.onVertexSelect(dataPos.x, dataPos.y);

            if (vertexResult.vertexFound) {
                this.selectedVertex = vertexResult.vertex;
                this.isDragging = true;
                this.canvas.style.cursor = 'move';
                return;
            }
        }

        // Start long-press timer.  Resolves into one of three gestures:
        //   • mouse-up before timer  → quick click  (polygon select / Ctrl-toggle)
        //   • movement before timer  → pan
        //   • 300 ms hold            → freehand lasso selection
        this._longPressCtrl   = isCtrlPressed;
        this._longPressOrigin = { x: screenX, y: screenY };
        this._longPressData   = { x: dataPos.x, y: dataPos.y };
        this._longPressTimer  = setTimeout(() => {
            this._longPressTimer = null;
            this.isRectSelecting = true;
            this.lassoPath = [{ x: this._longPressOrigin.x, y: this._longPressOrigin.y }];
            this.canvas.style.cursor = 'crosshair';
            if (this.callbacks.onRectSelectUpdate) {
                this.callbacks.onRectSelectUpdate(this.lassoPath);
            }
        }, 100);
    }

    /**
     * Handle mouse move events
     * @param {MouseEvent} e - Mouse event
     */
    handleMouseMove(e) {
        if (this.blocked) return;
        const { x: screenX, y: screenY } = this.getCanvasPos(e);

        // Waiting for long-press decision — cancel into pan if the mouse moved enough
        if (this._longPressTimer !== null) {
            const dx = screenX - this._longPressOrigin.x;
            const dy = screenY - this._longPressOrigin.y;
            if (dx * dx + dy * dy > 25) { // > 5 px
                clearTimeout(this._longPressTimer);
                this._longPressTimer = null;
                this.isPanning = true;
                this.lastMousePos = { x: screenX, y: screenY };
                this.canvas.style.cursor = 'grabbing';
            }
            return;
        }

        if (this.isDragging && this.selectedVertex !== null) {
            // Dragging existing vertex
            const dataPos = this.geometryOps.screenToData(screenX, screenY);

            if (this.callbacks.onVertexDrag) {
                this.callbacks.onVertexDrag(this.selectedVertex, dataPos.x, dataPos.y);
            }

        } else if (this.isRectSelecting) {
            const last = this.lassoPath[this.lassoPath.length - 1];
            const dx = screenX - last.x, dy = screenY - last.y;
            if (dx * dx + dy * dy > 9) { // only append if moved > 3 px
                this.lassoPath.push({ x: screenX, y: screenY });
            }
            if (this.callbacks.onRectSelectUpdate) {
                this.callbacks.onRectSelectUpdate(this.lassoPath);
            }

        } else if (this.isPanning) {
            const deltaX = screenX - this.lastMousePos.x;
            const deltaY = screenY - this.lastMousePos.y;

            this.geometryOps.applyPan(deltaX, deltaY);
            this.lastMousePos = { x: screenX, y: screenY };

            if (this.callbacks.onViewUpdate) {
                this.callbacks.onViewUpdate();
            }

        } else {
            // Update cursor based on what's under the mouse
            this.updateCursor(screenX, screenY);
        }
    }

    /**
     * Handle mouse up events
     * @param {MouseEvent} e - Mouse event
     */
    handleMouseUp(e) {
        if (this.blocked) return;
        const wasDragging = this.isDragging;
        const wasRectSelecting = this.isRectSelecting;

        const { x: screenX, y: screenY } = this.getCanvasPos(e);

        // Capture lasso before clearing state
        const finishedLasso = wasRectSelecting ? this.lassoPath.slice() : null;

        // Quick release — timer still pending, treat as a click
        if (this._longPressTimer !== null) {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
            this._commitPendingClick();
            this.isDragging = false;
            this.isPanning = false;
            this.selectedVertex = null;
            this.canvas.style.cursor = 'grab';
            if (this.callbacks.onViewUpdate) this.callbacks.onViewUpdate();
            return;
        }

        // Clear state
        this.isDragging = false;
        this.isPanning = false;
        this.isRectSelecting = false;
        this.lassoPath = [];
        this.selectedVertex = null;
        this.canvas.style.cursor = 'grab';

        // Lasso finished
        if (wasRectSelecting && this.callbacks.onRectSelect) {
            this.callbacks.onRectSelect(finishedLasso);
            return;
        }

        // Vertex drag finished
        if (wasDragging && this.callbacks.onDragEnd) {
            this.callbacks.onDragEnd();
        }

        if (this.callbacks.onViewUpdate) {
            this.callbacks.onViewUpdate();
        }
    }

    /**
     * Commit a pending long-press as a plain click:
     * single-select or Ctrl-toggle the polygon at the stored origin position.
     */
    _commitPendingClick() {
        if (!this._longPressOrigin) return;
        if (this.callbacks.onPolygonSelect) {
            const result = this.callbacks.onPolygonSelect(
                this._longPressData.x, this._longPressData.y,
                false, this._longPressCtrl
            );
            // Deselect only when nothing was found or selected under the cursor
            if (!result.polygonFound && !result.polygonSelected && !this._longPressCtrl) {
                if (this.callbacks.onDeselectPolygon) {
                    this.callbacks.onDeselectPolygon();
                }
            }
        }
        this._longPressOrigin = null;
        this._longPressData   = null;
        this._longPressCtrl   = false;
    }

    /**
     * Handle mouse wheel events for zooming
     * @param {WheelEvent} e - Wheel event
     */
    handleWheel(e) {
        e.preventDefault();
        const { x: mouseX, y: mouseY } = this.getCanvasPos(e);

        const scaleFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const applied = this.geometryOps.applyZoom(mouseX, mouseY, scaleFactor);

        if (applied && this.callbacks.onViewUpdate) {
            this.callbacks.onViewUpdate();
        }
    }

    /**
     * Update cursor based on what's under the mouse
     * @param {number} screenX - Screen X coordinate
     * @param {number} screenY - Screen Y coordinate
     */
    updateCursor(screenX, screenY) {
        if (this.isRectSelecting || this._longPressTimer !== null) return;
        const dataPos = this.geometryOps.screenToData(screenX, screenY);
        // Check if over a vertex (in edit mode)
        if (this.callbacks.onVertexSelect) {
            const vertexResult = this.callbacks.onVertexSelect(dataPos.x, dataPos.y, true);
            if (vertexResult.vertexFound) {
                this.canvas.style.cursor = 'pointer';
                return;
            }
        }

        // Check if over a polygon (in edit mode)
        if (this.callbacks.onPolygonSelect) {
            const polygonResult = this.callbacks.onPolygonSelect(dataPos.x, dataPos.y, true);
            if (polygonResult.polygonFound) {
                this.canvas.style.cursor = 'pointer';
                return;
            }
        }

        // Default cursor
        this.canvas.style.cursor = 'grab';
    }

    /**
     * Get current interaction state
     * @returns {Object} - Current interaction state
     */
    getInteractionState() {
        return {
            isDragging: this.isDragging,
            isPanning: this.isPanning,
            hasSelectedVertex: this.selectedVertex !== null,
            selectedVertex: this.selectedVertex,
            lastMousePos: { ...this.lastMousePos }
        };
    }

    /**
     * Set interaction mode (affects cursor behavior)
     * @param {string} mode - Interaction mode ('edit' or 'view')
     */
    setInteractionMode(mode) {
        this.interactionMode = mode;

        if (mode === 'view') {
            // In view mode, only allow panning and zooming
            this.selectedVertex = null;
            this.isDragging = false;
            this.canvas.style.cursor = 'grab';
        }
    }

    /**
     * Force end any current interaction
     */
    endInteraction() {
        if (this._longPressTimer !== null) {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
        }
        this._longPressOrigin = null;
        this._longPressData   = null;
        this._longPressCtrl   = false;
        this.isDragging = false;
        this.isPanning = false;
        this.isRectSelecting = false;
        this.lassoPath = [];
        this.selectedVertex = null;
        this.canvas.style.cursor = 'grab';
    }

    /**
     * Check if currently interacting
     * @returns {boolean} - True if currently dragging, panning, or lasso-selecting
     */
    isInteracting() {
        return this.isDragging || this.isPanning || this.isRectSelecting || this._longPressTimer !== null;
    }

    /**
     * Handle keyboard key down events for arrow key navigation and vertex deletion
     * @param {KeyboardEvent} e - Keyboard event
     */
    handleKeyDown(e) {
        // Don't process keyboard shortcuts if user is typing in an input field
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            return;
        }

        // Check for Delete or Backspace key
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault(); // Prevent browser back navigation

            if (this.callbacks.onVertexDelete) {
                this.callbacks.onVertexDelete();
            }
            return;
        }

        // Check for M key (midpoint creation)
        if (e.key === 'm' || e.key === 'M') {
            e.preventDefault();

            if (this.callbacks.onMidpointCreate) {
                this.callbacks.onMidpointCreate();
            }
            return;
        }

        // Check if arrow key is pressed
        const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

        if (arrowKeys.includes(e.key)) {
            e.preventDefault(); // Prevent page scrolling

            // Add key to pressed keys set
            this.keysPressed.add(e.key);

            // Start keyboard pan if not already running
            if (!this.keyboardPanInterval) {
                this.startKeyboardPan();
            }
        }
    }

    /**
     * Handle keyboard key up events
     * @param {KeyboardEvent} e - Keyboard event
     */
    handleKeyUp(e) {
        // Remove key from pressed keys set
        this.keysPressed.delete(e.key);

        // Stop keyboard pan if no arrow keys are pressed
        if (this.keysPressed.size === 0) {
            this.stopKeyboardPan();
        }
    }

    /**
     * Start keyboard panning animation loop
     */
    startKeyboardPan() {
        this.currentPanSpeed = this.keyboardPanSpeed; // Reset speed

        this.keyboardPanInterval = setInterval(() => {
            let deltaX = 0;
            let deltaY = 0;

            // Calculate movement based on pressed keys
            if (this.keysPressed.has('ArrowUp')) {
                deltaY = this.currentPanSpeed;
            }
            if (this.keysPressed.has('ArrowDown')) {
                deltaY = -this.currentPanSpeed;
            }
            if (this.keysPressed.has('ArrowLeft')) {
                deltaX = this.currentPanSpeed;
            }
            if (this.keysPressed.has('ArrowRight')) {
                deltaX = -this.currentPanSpeed;
            }

            // Apply panning if there's movement
            if (deltaX !== 0 || deltaY !== 0) {
                this.geometryOps.applyPan(deltaX, deltaY);

                // Trigger view update
                if (this.callbacks.onViewUpdate) {
                    this.callbacks.onViewUpdate();
                }

                // Increase speed for acceleration effect (up to max)
                if (this.currentPanSpeed < this.maxKeyboardPanSpeed) {
                    this.currentPanSpeed += this.keyboardPanAcceleration;
                }
            }
        }, 16); // ~60 FPS (16ms per frame)
    }

    /**
     * Stop keyboard panning animation loop
     */
    stopKeyboardPan() {
        if (this.keyboardPanInterval) {
            clearInterval(this.keyboardPanInterval);
            this.keyboardPanInterval = null;
            this.currentPanSpeed = this.keyboardPanSpeed; // Reset speed
        }
    }

    /**
     * Cleanup event listeners
     */
    destroy() {
        // Stop keyboard panning if active
        this.stopKeyboardPan();

        // Remove mouse event listeners
        this.canvas.removeEventListener('mousedown', this.handleMouseDown);
        this.canvas.removeEventListener('mousemove', this.handleMouseMove);
        this.canvas.removeEventListener('mouseup', this.handleMouseUp);
        this.canvas.removeEventListener('wheel', this.handleWheel);
        this.canvas.removeEventListener('contextmenu', (e) => e.preventDefault());

        // Remove keyboard event listeners
        window.removeEventListener('keydown', this.handleKeyDown);
        window.removeEventListener('keyup', this.handleKeyUp);

        this.callbacks = null;
    }
}
