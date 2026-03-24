/**
 * MouseHandler - Manages mouse interactions for polygon editing
 * Updated with midpoint handle support
 */
class MouseHandler {
    constructor(canvas, geometryOps) {
        this.canvas = canvas;
        this.geometryOps = geometryOps;

        // Interaction state
        this.isDragging = false;
        this.isPanning = false;
        this.selectedVertex = null;
        this.lastMousePos = { x: 0, y: 0 };
        this.isReplacementDrag = false; // Track if this is a vertex replacement drag

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
            onMidpointCreate: null // Callback for midpoint creation (M key)
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
        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

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

                // Shift+Click ONLY selects vertices - no drag replacement
                // Use keyboard keys '1' and '2' to replace with previous/next vertex

                e.preventDefault(); // Prevent any default behavior
                return; // Exit immediately - don't check other handlers
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

        // Try polygon selection (for both regular selection and Ctrl+Click multi-selection)
        if (this.callbacks.onPolygonSelect) {
            const polygonResult = this.callbacks.onPolygonSelect(dataPos.x, dataPos.y, false, isCtrlPressed);
            if (polygonResult.polygonSelected) {
                return;
            }

            // If no polygon found at this position, deselect current selection
            // This allows clicking on white/empty area to deselect
            if (!polygonResult.polygonFound && !isCtrlPressed) {
                // Call onPolygonSelect with null to deselect
                if (this.callbacks.onDeselectPolygon) {
                    this.callbacks.onDeselectPolygon();
                }
            }
        }

        // If no vertex, midpoint, or polygon selected, start panning (but not when Ctrl is pressed)
        // This allows dragging on white space to pan the map
        if (!isCtrlPressed) {
            this.isPanning = true;
            this.canvas.style.cursor = 'grabbing';
        }
    }

    /**
     * Handle mouse move events
     * @param {MouseEvent} e - Mouse event
     */
    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        if (this.isDragging && this.selectedVertex !== null) {
            // Dragging existing vertex
            const dataPos = this.geometryOps.screenToData(screenX, screenY);

            if (this.callbacks.onVertexDrag) {
                this.callbacks.onVertexDrag(this.selectedVertex, dataPos.x, dataPos.y);
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
        const wasDragging = this.isDragging;

        // Get mouse position for replacement target detection
        const rect = this.canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const dataPos = this.geometryOps.screenToData(screenX, screenY);

        this.isDragging = false;
        this.isPanning = false;
        this.selectedVertex = null;
        this.canvas.style.cursor = 'grab';

        // Call drag end callback if we were dragging
        if (wasDragging && this.callbacks.onDragEnd) {
            this.callbacks.onDragEnd();
        }

        // Notify that interaction ended
        if (this.callbacks.onViewUpdate) {
            this.callbacks.onViewUpdate();
        }
    }

    /**
     * Handle mouse wheel events for zooming
     * @param {WheelEvent} e - Wheel event
     */
    handleWheel(e) {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
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
        this.isDragging = false;
        this.isPanning = false;
        this.selectedVertex = null;
        this.canvas.style.cursor = 'grab';
    }

    /**
     * Check if currently interacting
     * @returns {boolean} - True if currently dragging or panning
     */
    isInteracting() {
        return this.isDragging || this.isPanning;
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
