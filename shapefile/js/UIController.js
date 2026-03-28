/**
 * UIController - Manages user interface state and updates
 */
class UIController {
    constructor() {
        this.elements = {
            csvFile: document.getElementById('csvFile'),
            polygonSelect: document.getElementById('polygonSelect'),
            editMode: document.getElementById('editMode'),
            viewMode: document.getElementById('viewMode'),
            undoBtn: document.getElementById('undoBtn'),
            redoBtn: document.getElementById('redoBtn'),
            combineBtn: document.getElementById('combineBtn'),
            splitBtn: document.getElementById('splitBtn'),
            regenerateBtn: document.getElementById('regenerateBtn'),
            exportData: document.getElementById('exportData'),
            resetView: document.getElementById('resetView'),
            polygonInfo: document.getElementById('polygonInfo'),
            coordinates: document.getElementById('coordinates'),
            sharedInfo: document.getElementById('sharedInfo'),
            status: document.getElementById('status')
        };

        this.currentMode = 'view';
        this.selectedPolygonIndex = null;
    }

    /**
     * Set edit/view mode and update UI accordingly
     * @param {boolean} isEditMode - True for edit mode, false for view mode
     */
    setMode(isEditMode) {
        this.currentMode = isEditMode ? 'edit' : 'view';
        
        if (this.elements.editMode && this.elements.viewMode) {
            if (isEditMode) {
                this.elements.editMode.classList.add('active');
                this.elements.viewMode.classList.remove('active');
            } else {
                this.elements.editMode.classList.remove('active');
                this.elements.viewMode.classList.add('active');
            }
        }
        
        // Mode changed - no status message needed
    }

    /**
     * Populate the polygon selection dropdown
     * @param {Array<Object>} polygons - Array of polygon objects
     */
    populatePolygonSelect(polygons) {
        if (!this.elements.polygonSelect) return;
        
        this.elements.polygonSelect.innerHTML = '<option value="">Choose a polygon to edit...</option>';
        
        polygons.forEach((polygon, index) => {
            const option = document.createElement('option');
            option.value = index;
            // Show Shape_ID and County if both are available
            if (polygon.county && polygon.county !== polygon.id) {
                option.textContent = `${polygon.id} (${polygon.county})`;
            } else {
                option.textContent = polygon.id;
            }
            this.elements.polygonSelect.appendChild(option);
        });
    }

    /**
     * Set the selected polygon in the dropdown
     * @param {number|null} index - Index of selected polygon or null for none
     */
    setSelectedPolygon(index) {
        this.selectedPolygonIndex = index;
        if (this.elements.polygonSelect) {
            this.elements.polygonSelect.value = index !== null ? index : '';
        }
    }

    /**
     * Get the currently selected polygon index from dropdown
     * @returns {number|null} - Selected polygon index or null
     */
    getSelectedPolygon() {
        if (!this.elements.polygonSelect) return null;
        const value = this.elements.polygonSelect.value;
        return value === '' ? null : parseInt(value);
    }

    /**
     * Update polygon information display
     * @param {Object} polygon - Polygon object to display info for
     * @param {Object} sharedVerticesManager - Shared vertices manager for statistics
     * @param {Object} adjacencyGraph - Adjacency graph for neighbor information
     */
    updatePolygonInfo(polygon, sharedVerticesManager = null, adjacencyGraph = null) {
        if (!this.elements.polygonInfo) return;

        if (!polygon) {
            this.elements.polygonInfo.innerHTML = '<p>Select a polygon to see its information.</p>';
            if (this.elements.coordinates) {
                this.elements.coordinates.textContent = '';
            }
            return;
        }

        const hasHoles = polygon.rings.length > 1;
        const totalVertices = polygon.rings.reduce((sum, ring) => sum + ring.length, 0);

        // Count shared vertices if manager is provided
        let sharedVerticesCount = 0;
        if (sharedVerticesManager && sharedVerticesManager.isEnabled()) {
            polygon.rings.forEach(ring => {
                ring.forEach(vertex => {
                    const shared = sharedVerticesManager.findSharedVertices(vertex.x, vertex.y, [polygon]);
                    if (shared.length > 1) {
                        sharedVerticesCount++;
                    }
                });
            });
        }

        // Get neighbor information from adjacency graph
        let neighborInfo = '';
        let neighborCount = 0;
        if (adjacencyGraph) {
            const neighbors = adjacencyGraph.getNeighbors(polygon.id);
            neighborCount = neighbors.length;

            if (neighborCount > 0) {
                const neighborList = neighbors.join(', ');
                neighborInfo = `<p><strong>Neighbors (${neighborCount}):</strong><br><span style="font-size: 0.9em;">${neighborList}</span></p>`;
            } else {
                neighborInfo = `<p><strong>Neighbors:</strong> None (isolated polygon)</p>`;
            }
        }

        let infoHTML = `
            <h4>${polygon.id}</h4>
            <p><strong>County:</strong> ${polygon.county || '—'}</p>
            <p><strong>Total Vertices:</strong> ${totalVertices}</p>`;

        infoHTML += neighborInfo;

        this.elements.polygonInfo.innerHTML = infoHTML;
        
        // Update coordinates display
        if (this.elements.coordinates) {
            const wkt = this.ringsToWKT(polygon.rings);
            this.elements.coordinates.textContent = wkt;
        }
    }

    /**
     * Convert rings to WKT format for display
     * @param {Array<Array<Object>>} rings - Polygon rings
     * @returns {string} - WKT string
     */
    ringsToWKT(rings) {
        const ringStrings = rings.map(ring => {
            const coords = ring.map(point => `${point.x} ${point.y}`).join(', ');
            return `(${coords})`;
        });
        return `POLYGON (${ringStrings.join(', ')})`;
    }

    /**
     * Update undo/redo button states
     * @param {boolean} canUndo - Whether undo is available
     * @param {boolean} canRedo - Whether redo is available  
     * @param {number} undoCount - Number of undo steps available
     * @param {number} redoCount - Number of redo steps available
     */
    updateUndoRedoButtons(canUndo, canRedo, undoCount = 0, redoCount = 0) {
        if (this.elements.undoBtn) {
            this.elements.undoBtn.disabled = !canUndo;
            this.elements.undoBtn.textContent = `↶ Undo${undoCount > 0 ? ` (${undoCount})` : ''}`;
        }
        
        if (this.elements.redoBtn) {
            this.elements.redoBtn.disabled = !canRedo;
            this.elements.redoBtn.textContent = `↷ Redo${redoCount > 0 ? ` (${redoCount})` : ''}`;
        }
    }

    /**
     * Show shared vertex information
     * @param {Array<string>} polygonNames - Names of polygons sharing the vertex
     */
    showSharedVertexInfo(polygonNames) {
        if (!this.elements.sharedInfo) return;
        
        if (polygonNames.length > 1) {
            this.elements.sharedInfo.textContent = 
                `Editing shared vertex - affecting ${polygonNames.length} polygons: ${polygonNames.join(', ')}`;
            this.elements.sharedInfo.style.display = 'block';
        } else {
            this.hideSharedVertexInfo();
        }
    }

    /**
     * Hide shared vertex information
     */
    hideSharedVertexInfo() {
        if (this.elements.sharedInfo) {
            this.elements.sharedInfo.style.display = 'none';
        }
    }

    /**
     * Show status message
     * @param {string} message - Message to display
     * @param {number} duration - Duration in milliseconds (default 3000)
     */
    showStatus(message, duration = 3000) {
        if (!this.elements.status) return;
        
        this.elements.status.textContent = message;
        this.elements.status.style.display = 'block';
        
        if (duration > 0) {
            setTimeout(() => {
                if (this.elements.status) {
                    this.elements.status.style.display = 'none';
                }
            }, duration);
        }
    }

    /**
     * Show error message
     * @param {string} message - Error message to display
     */
    showError(message) {
        if (!this.elements.status) return;
        
        this.elements.status.textContent = message;
        this.elements.status.style.background = '#dc3545';
        this.elements.status.style.display = 'block';
        
        setTimeout(() => {
            if (this.elements.status) {
                this.elements.status.style.display = 'none';
                this.elements.status.style.background = '#28a745'; // Reset to success color
            }
        }, 5000);
    }

    /**
     * Show success message
     * @param {string} message - Success message to display
     */
    showSuccess(message) {
        if (!this.elements.status) return;

        this.elements.status.textContent = message;
        this.elements.status.style.background = '#28a745';
        this.elements.status.style.display = 'block';

        setTimeout(() => {
            if (this.elements.status) {
                this.elements.status.style.display = 'none';
            }
        }, 3000);
    }

    /**
     * Show info/loading message
     * @param {string} message - Info message to display
     */
    showMessage(message) {
        if (!this.elements.status) return;

        this.elements.status.textContent = message;
        this.elements.status.style.background = '#007bff'; // Blue for info
        this.elements.status.style.display = 'block';
    }

    /**
     * Enable or disable export button
     * @param {boolean} enabled - Whether to enable the export button
     */
    setExportEnabled(enabled) {
        if (!this.elements.exportData) return;
        
        this.elements.exportData.disabled = !enabled;
        if (!enabled) {
            this.elements.exportData.title = 'Load a CSV file first';
        } else {
            this.elements.exportData.title = 'Export modified polygons to CSV';
        }
    }

    /**
     * Enable or disable combine button
     * @param {boolean} enabled - Whether to enable the combine button
     */
    setCombineEnabled(enabled) {
        if (!this.elements.combineBtn) return;

        this.elements.combineBtn.disabled = !enabled;
        if (!enabled) {
            this.elements.combineBtn.title = 'Select 2 or more polygons with Ctrl+Click';
        } else {
            this.elements.combineBtn.title = 'Combine selected polygons';
        }
    }

    /**
     * Enable or disable split button
     * @param {boolean} enabled - Whether to enable the split button
     */
    setSplitEnabled(enabled) {
        if (!this.elements.splitBtn) return;

        this.elements.splitBtn.disabled = !enabled;
        if (!enabled) {
            this.elements.splitBtn.title = 'Select exactly 1 polygon to split';
        } else {
            this.elements.splitBtn.title = 'Split selected polygon into districts';
        }
    }

    /**
     * Enable or disable regenerate button
     * @param {boolean} enabled - Whether to enable the regenerate button
     */
    setRegenerateEnabled(enabled) {
        if (!this.elements.regenerateBtn) return;

        this.elements.regenerateBtn.disabled = !enabled;
        if (!enabled) {
            this.elements.regenerateBtn.title = 'Split a polygon first to enable regenerate';
        } else {
            this.elements.regenerateBtn.title = 'Regenerate split with different random variation';
        }
    }

    /**
     * Enable or disable all editing controls
     * @param {boolean} enabled - Whether to enable editing controls
     */
    setEditingEnabled(enabled) {
        if (this.elements.editMode) {
            this.elements.editMode.disabled = !enabled;
        }
        if (this.elements.polygonSelect) {
            this.elements.polygonSelect.disabled = !enabled;
        }
        if (this.elements.undoBtn) {
            this.elements.undoBtn.disabled = !enabled;
        }
        if (this.elements.redoBtn) {
            this.elements.redoBtn.disabled = !enabled;
        }
        if (this.elements.resetView) {
            this.elements.resetView.disabled = !enabled;
        }
    }

    /**
     * Get current UI state
     * @returns {Object} - Current UI state
     */
    getUIState() {
        return {
            mode: this.currentMode,
            selectedPolygonIndex: this.selectedPolygonIndex,
            exportEnabled: this.elements.exportData ? !this.elements.exportData.disabled : false,
            editingEnabled: this.elements.editMode ? !this.elements.editMode.disabled : false
        };
    }

    /**
     * Reset UI to initial state
     */
    resetUI() {
        this.setMode(false); // View mode
        this.setSelectedPolygon(null);
        if (this.elements.polygonSelect) {
            this.elements.polygonSelect.innerHTML = '<option value="">Choose a polygon to edit...</option>';
        }
        this.updatePolygonInfo(null);
        this.hideSharedVertexInfo();
        this.setExportEnabled(false);
        this.setEditingEnabled(false);
        this.updateUndoRedoButtons(false, false);
    }

    /**
     * Create download link for CSV export
     * @param {string} csvContent - CSV content to download
     * @param {string} filename - Filename for the download
     */
    downloadCSV(csvContent, filename = 'modified_polygons.csv') {
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Get file from file input
     * @returns {File|null} - Selected file or null
     */
    getSelectedFile() {
        return this.elements.csvFile && this.elements.csvFile.files[0] ? this.elements.csvFile.files[0] : null;
    }

    /**
     * Clear file input
     */
    clearFileInput() {
        if (this.elements.csvFile) {
            this.elements.csvFile.value = '';
        }
    }

    /**
     * Set loading state
     * @param {boolean} isLoading - Whether app is in loading state
     */
    setLoadingState(isLoading) {
        if (this.elements.csvFile) {
            this.elements.csvFile.disabled = isLoading;
        }
        
        if (isLoading) {
            this.showStatus('Loading CSV file...', 0);
        } else {
            if (this.elements.status) {
                this.elements.status.style.display = 'none';
            }
        }
    }

    /**
     * Add event listeners for UI elements
     * @param {Object} handlers - Object containing event handler functions
     */
    addEventListeners(handlers) {
        if (handlers.onFileSelect && this.elements.csvFile) {
            this.elements.csvFile.addEventListener('change', handlers.onFileSelect);
        }
        
        if (handlers.onModeChange) {
            if (this.elements.editMode) {
                this.elements.editMode.addEventListener('click', () => handlers.onModeChange(true));
            }
            if (this.elements.viewMode) {
                this.elements.viewMode.addEventListener('click', () => handlers.onModeChange(false));
            }
        }
        
        if (handlers.onPolygonSelect && this.elements.polygonSelect) {
            this.elements.polygonSelect.addEventListener('change', handlers.onPolygonSelect);
        }
        
        if (handlers.onExport && this.elements.exportData) {
            this.elements.exportData.addEventListener('click', handlers.onExport);
        }
        
        if (handlers.onUndo && this.elements.undoBtn) {
            this.elements.undoBtn.addEventListener('click', handlers.onUndo);
        }
        
        if (handlers.onRedo && this.elements.redoBtn) {
            this.elements.redoBtn.addEventListener('click', handlers.onRedo);
        }

        if (handlers.onCombine && this.elements.combineBtn) {
            this.elements.combineBtn.addEventListener('click', handlers.onCombine);
        }

        if (handlers.onSplit && this.elements.splitBtn) {
            this.elements.splitBtn.addEventListener('click', handlers.onSplit);
        }

        if (handlers.onRegenerate && this.elements.regenerateBtn) {
            this.elements.regenerateBtn.addEventListener('click', handlers.onRegenerate);
        }

        // Keyboard shortcuts
        if (handlers.onUndo || handlers.onRedo) {
            document.addEventListener('keydown', (e) => {
                if (e.ctrlKey || e.metaKey) {
                    if (e.key === 'z' && !e.shiftKey && handlers.onUndo) {
                        e.preventDefault();
                        handlers.onUndo();
                    } else if (((e.key === 'y') || (e.key === 'z' && e.shiftKey)) && handlers.onRedo) {
                        e.preventDefault();
                        handlers.onRedo();
                    }
                }
            });
        }
    }
}