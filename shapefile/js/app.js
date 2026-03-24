/**
 * Application Bootstrap - Initialize and start the Polygon Editor
 */

// Global application instance
let polygonEditor;

/**
 * Setup layer button event listeners
 */
function setupLayerButtons() {
    const layerCountyBtn = document.getElementById('layerCounty');
    const layerSubCountyBtn = document.getElementById('layerSubCounty');

    if (layerCountyBtn) {
        layerCountyBtn.addEventListener('click', function() {
            if (window.polygonEditor && window.polygonEditor.layerManager) {
                // Show county, hide sub-county
                window.polygonEditor.layerManager.layers.county.visible = true;
                window.polygonEditor.layerManager.layers.subCounty.visible = false;

                // Update button states
                layerCountyBtn.classList.add('active');
                layerSubCountyBtn.classList.remove('active');

                // Switch to county polygon list
                window.polygonEditor.switchToCountyLayer();

                window.polygonEditor.draw();
                console.log('County layer shown, Sub-County layer hidden');
            }
        });
    }

    if (layerSubCountyBtn) {
        layerSubCountyBtn.addEventListener('click', function() {
            if (window.polygonEditor && window.polygonEditor.layerManager) {
                // Show sub-county, hide county
                window.polygonEditor.layerManager.layers.county.visible = false;
                window.polygonEditor.layerManager.layers.subCounty.visible = true;

                // Update button states
                layerSubCountyBtn.classList.add('active');
                layerCountyBtn.classList.remove('active');

                // Switch to sub-county polygon list
                window.polygonEditor.switchToSubCountyLayer();

                window.polygonEditor.draw();
                console.log('Sub-County layer shown, County layer hidden');
            }
        });
    }
}

/**
 * Get list of CSV files in csv_input directory
 * @returns {Promise<Array<{name:string,url:string}>>}
 */
async function getCsvFiles() {
    // Prefer backend list endpoint that works with FastAPI
    try {
        const backendUrl = window.BACKEND_URL || window.location.origin;
        const response = await fetch(`${backendUrl}/csv_files`, { cache: 'no-store' });
        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data.files)) {
                return data.files.map(name => ({
                    name: name,
                    url: `${backendUrl}/csv_input/${encodeURIComponent(name)}`
                }));
            }
        } else {
            console.warn(`getCsvFiles: /csv_files returned ${response.status}`);
        }
    } catch (error) {
        console.warn('getCsvFiles: /csv_files fetch failed', error);
    }

    // Fallback directory scan for browsers that expose listing (older behavior)
    const paths = ['./csv_input/', './csv_input', '/shapefile/csv_input/', '/shapefile/csv_input'];

    for (const path of paths) {
        try {
            const response = await fetch(path, { cache: 'no-store' });
            if (!response.ok) {
                console.warn(`getCsvFiles: '${path}' returned ${response.status}`);
                continue;
            }

            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const anchors = Array.from(doc.querySelectorAll('a[href$=".csv"]'));

            const baseUrl = new URL(path, window.location.href).href;

            if (anchors.length > 0) {
                return anchors.map(a => {
                    const href = a.getAttribute('href');
                    return {
                        name: a.textContent.trim(),
                        url: href ? new URL(href, baseUrl).href : ''
                    };
                });
            }

            // fallback parse as plain href matches
            const found = [];
            const regex = /href="([^"]+\.csv)"/gi;
            let match;
            while ((match = regex.exec(html)) !== null) {
                const href = match[1];
                const name = href.split('/').pop();
                const url = new URL(href, baseUrl).href;
                found.push({ name, url });
            }

            if (found.length > 0) {
                return found;
            }
        } catch (error) {
            console.warn(`getCsvFiles: fetch failed for '${path}'`, error);
        }
    }

    return [];
}

function showCsvList(files) {
    const statusEl = document.getElementById('csvStatus');
    const modalBackdrop = document.getElementById('csvModalBackdrop');
    const modalList = document.getElementById('csvModalList');

    if (!modalBackdrop || !modalList || !statusEl) {
        console.error('showCsvList: modal elements missing', { modalBackdrop, modalList, statusEl });
        alert('CSV modal UI elements missing; check the page structure.');
        return;
    }

    modalList.innerHTML = '';
    if (files.length === 0) {
        statusEl.textContent = 'No CSV files found in ./csv_input';
        modalBackdrop.classList.add('open');
        return;
    }

    files.forEach(file => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = file.name;
        button.style.display = 'block';
        button.style.width = '100%';
        button.style.textAlign = 'left';
        button.style.whiteSpace = 'nowrap';
        button.addEventListener('click', async () => {
            statusEl.textContent = `Loading ${file.name} ...`;

            if (window.polygonEditor) {
                try {
                    await window.polygonEditor.handleFileSelect({ target: { value: file.url } });
                    statusEl.textContent = `Loaded ${file.name}`;
                    modalBackdrop.classList.remove('open');
                } catch (e) {
                    console.error('Error loading CSV:', e);
                    statusEl.textContent = `Failed to load ${file.name}`;
                }
            }
        });

        item.appendChild(button);
        modalList.appendChild(item);
    });

    statusEl.textContent = `Select CSV to load (${files.length} files)`;
    modalBackdrop.classList.add('open');

}

async function onLoadCsvClick() {
    console.log('onLoadCsvClick: start');
    const statusEl = document.getElementById('csvStatus');
    if (statusEl) statusEl.textContent = 'Loading CSV file list...';

    const addCsvBtn = document.getElementById('addCsvBtn');

    const files = await getCsvFiles();
    console.log('onLoadCsvClick: got files', files);

    showCsvList(files);

    if (files.length === 0) {
        alert('No CSV files found in ./csv_input, or directory not accessible.');
    }

    if (addCsvBtn) addCsvBtn.style.display = 'inline-flex';
}



async function onSaveCsvClick() {
    if (!window.polygonEditor) {
        alert('Polygon editor not ready');
        return;
    }

    console.log('onSaveCsvClick: start');

    const now = new Date();
    const z = n => String(n).padStart(2, '0');
    const defaultName = `${z(now.getMonth() + 1)}${z(now.getDate())}${z(now.getHours())}${z(now.getMinutes())}_modified_shapefile.csv`;

    const filename = prompt('Enter filename', defaultName);
    if (!filename) {
        return;
    }

    try {
        const csvContent = window.polygonEditor.dataManager.exportToCSV(window.polygonEditor.polygons);

        // try backend write endpoint first
        const response = await fetch('/save_csv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, content: csvContent })
        });

        if (response.ok) {
            const result = await response.json();
            document.getElementById('csvStatus').textContent = `Saved to ${result.path} (server).`;
            return;
        }

        throw new Error(`server returned ${response.status}`);
    } catch (err) {
        console.warn('Failed to save via server, falling back to download', err);
        window.polygonEditor.uiController.downloadCSV(window.polygonEditor.dataManager.exportToCSV(window.polygonEditor.polygons), filename);
        document.getElementById('csvStatus').textContent = `Download started: ${filename}. Place file into ./csv_input if you want re-use.`;
    }
}

function hideCsvModal() {
    const modalBackdrop = document.getElementById('csvModalBackdrop');
    if (modalBackdrop) modalBackdrop.classList.remove('open');
}

async function onAddCsvClick() {
    const statusEl = document.getElementById('csvStatus');
    if (statusEl) statusEl.textContent = 'Select one or more CSV file(s) to upload...';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.csv';
    fileInput.multiple = false;
    fileInput.style.display = 'none';

    fileInput.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) {
            if (statusEl) statusEl.textContent = 'No file selected.';
            document.body.removeChild(fileInput);
            return;
        }

        try {
            if (statusEl) statusEl.textContent = `Loading ${file.name}...`;
            if (window.polygonEditor && typeof window.polygonEditor.handleFileSelect === 'function') {
                await window.polygonEditor.handleFileSelect({ target: { value: file, files: [file] } });
            }
            if (statusEl) statusEl.textContent = `Loaded ${file.name}`;
        } catch (error) {
            console.error('Error loading local CSV', file.name, error);
            if (statusEl) statusEl.textContent = `Failed to load ${file.name}: ${error.message}`;
        }

        document.body.removeChild(fileInput);
    });

    document.body.appendChild(fileInput);
    fileInput.click();
}

/**
 * Initialize the application when DOM is loaded
 */
document.addEventListener('DOMContentLoaded', function() {
    console.log('Starting Polygon Editor application...');
    
    try {
        // Create the main application instance
        polygonEditor = new PolygonEditor();
        
        // Expose to global scope for debugging
        window.polygonEditor = polygonEditor;

        // Setup layer buttons
        setupLayerButtons();

        // No direct Load/Save click handlers here (safe script handles binding to avoid double invocation)
        const csvFileListClose = document.getElementById('csvFileListClose');

        const addCsvBtn = document.getElementById('addCsvBtn');
        if (addCsvBtn) {
            addCsvBtn.addEventListener('click', async () => {
                console.log('addCsvBtn clicked');
                await onAddCsvClick();
            });
        }

        const csvModalClose = document.getElementById('csvModalClose');
        const csvModalCancel = document.getElementById('csvModalCancel');
        const csvModalRefresh = document.getElementById('csvModalRefresh');

        if (csvModalClose) csvModalClose.addEventListener('click', hideCsvModal);
        if (csvModalCancel) csvModalCancel.addEventListener('click', hideCsvModal);
        if (csvModalRefresh) csvModalRefresh.addEventListener('click', onLoadCsvClick);

        // Expose for inline handler compatibility (legacy / cache issues)
        window.onLoadCsvClick = onLoadCsvClick;
        window.onSaveCsvClick = onSaveCsvClick;

        // Extra debug UI element
        let debugEl = document.getElementById('loadCsvDebug');
        if (!debugEl) {
            debugEl = document.createElement('div');
            debugEl.id = 'loadCsvDebug';
            debugEl.style.fontSize = '11px';
            debugEl.style.color = '#333';
            debugEl.style.margin = '4px 0';
            const parent = document.querySelector('.controls');
            if (parent) parent.insertBefore(debugEl, parent.firstChild);
        }

        if (loadCsvBtn) {
            loadCsvBtn.addEventListener('click', () => {
                debugEl.textContent = 'Load CSV button clicked';
                console.log('loadCsvBtn clicked (from explicit handler)');
            });
        }

        if (saveCsvBtn) {
            saveCsvBtn.addEventListener('click', () => {
                if (debugEl) debugEl.textContent = 'Save CSV button clicked';
                console.log('saveCsvBtn clicked (from explicit handler)');
            });
        }

        console.log('Polygon Editor started successfully');
        console.log('Available commands:', {
            'polygonEditor.getState()': 'Get current application state',
            'polygonEditor.getStatistics()': 'Get statistics about loaded data',
            'polygonEditor.setFeatures({})': 'Enable/disable features',
            'polygonEditor.loadPolygons([])': 'Load polygon data programmatically'
        });
        
    } catch (error) {
        console.error('Failed to start Polygon Editor:', error);
        
        // Only show error for critical failures, not missing optional elements
        if (error.message && !error.message.includes('null')) {
            const status = document.getElementById('status');
            if (status) {
                status.textContent = `Failed to initialize: ${error.message}`;
                status.style.background = '#dc3545';
                status.style.display = 'block';
            }
        } else {
            // Log but don't show UI error for missing optional elements
            console.warn('Non-critical initialization issue:', error.message);
        }
    }
});

/**
 * Try to load sample data if available
 */
window.addEventListener('load', async function() {
    if (!polygonEditor) {
        console.log('Polygon editor not initialized, skipping sample data load');
        return;
    }
    
    try {
        // Check if sample file is available via window.fs API
        if (window.fs && window.fs.readFile) {
            console.log('Attempting to load sample data...');
            
            const response = await window.fs.readFile('output_polygons.csv', { encoding: 'utf8' });
            const file = new Blob([response], { type: 'text/csv' });
            
            // Load the sample data
            const result = await polygonEditor.dataManager.loadCSV(file);
            polygonEditor.loadPolygons(result.polygons);
            
            console.log(`Sample data loaded: ${result.count} polygons`);
            polygonEditor.uiController.showSuccess(`Sample data loaded: ${result.count} polygons`);
            
        } else {
            console.log('No sample file API available, waiting for user upload');
        }
        
    } catch (error) {
        // This is expected if no sample file exists - don't show error to user
        console.log('No sample file found, waiting for user upload');
    }
});

/**
 * Handle any unhandled errors
 */
window.addEventListener('error', function(event) {
    console.error('Application error:', event.error);
    
    // Don't show UI errors for non-critical issues
    const isCriticalError = event.error && 
                           event.error.message && 
                           !event.error.message.includes('null') &&
                           !event.error.message.includes('resetView') &&
                           !event.error.message.toLowerCase().includes('cannot read');
    
    if (polygonEditor && polygonEditor.uiController && isCriticalError) {
        polygonEditor.uiController.showError('An unexpected error occurred');
    }
});

/**
 * Handle before page unload (warn about unsaved changes)
 */
window.addEventListener('beforeunload', function(event) {
    if (polygonEditor && polygonEditor.historyManager) {
        const stats = polygonEditor.historyManager.getHistoryStats();
        
        // If there are unsaved changes (more than just the initial load)
        if (stats.totalStates > 1) {
            event.preventDefault();
            event.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
            return event.returnValue;
        }
    }
});

/**
 * Cleanup on page unload
 */
window.addEventListener('unload', function() {
    if (polygonEditor && typeof polygonEditor.destroy === 'function') {
        polygonEditor.destroy();
    }
});

/**
 * Utility functions for console debugging
 */
window.PolygonEditorUtils = {
    /**
     * Get detailed information about the current state
     */
    getDetailedState: function() {
        if (!polygonEditor) return null;
        
        return {
            application: polygonEditor.getState(),
            statistics: polygonEditor.getStatistics(),
            historyStats: polygonEditor.historyManager.getHistoryStats(),
            geometryTransform: polygonEditor.geometryOps.getTransformation(),
            mouseState: polygonEditor.mouseHandler.getInteractionState(),
            uiState: polygonEditor.uiController.getUIState()
        };
    },
    
    /**
     * Export current configuration
     */
    exportConfig: function() {
        if (!polygonEditor) return null;
        
        return {
            renderingOptions: polygonEditor.renderer.getOptions(),
            sharedVerticesEnabled: polygonEditor.sharedVertices.isEnabled(),
            sharedVertexTolerance: polygonEditor.sharedVertices.getTolerance(),
            overlapDetectionEnabled: polygonEditor.overlapDetection.isEnabled(),
            overlapTolerance: polygonEditor.overlapDetection.getTolerance(),
            historySize: polygonEditor.historyManager.maxHistorySize
        };
    },
    
    /**
     * Load configuration
     */
    loadConfig: function(config) {
        if (!polygonEditor || !config) return false;
        
        try {
            if (config.renderingOptions) {
                polygonEditor.renderer.setOptions(config.renderingOptions);
            }
            
            if (config.sharedVerticesEnabled !== undefined) {
                polygonEditor.sharedVertices.setEnabled(config.sharedVerticesEnabled);
            }
            
            if (config.sharedVertexTolerance !== undefined) {
                polygonEditor.sharedVertices.setTolerance(config.sharedVertexTolerance);
            }
            
            if (config.overlapDetectionEnabled !== undefined) {
                polygonEditor.overlapDetection.setEnabled(config.overlapDetectionEnabled);
            }
            
            if (config.overlapTolerance !== undefined) {
                polygonEditor.overlapDetection.setTolerance(config.overlapTolerance);
            }
            
            if (config.historySize !== undefined) {
                polygonEditor.historyManager.setMaxHistorySize(config.historySize);
            }
            
            polygonEditor.draw();
            return true;
            
        } catch (error) {
            console.error('Failed to load configuration:', error);
            return false;
        }
    },
    
    /**
     * Create a checkpoint in history
     */
    createCheckpoint: function(name) {
        if (!polygonEditor) return false;
        
        polygonEditor.historyManager.createCheckpoint(polygonEditor.polygons, name || 'Manual checkpoint');
        polygonEditor.updateUndoRedoButtons();
        return true;
    },
    
    /**
     * Get all shared vertex information
     */
    getSharedVertexInfo: function() {
        if (!polygonEditor) return null;

        return {
            statistics: polygonEditor.sharedVertices.getStatistics(polygonEditor.polygons),
            allSharedGroups: polygonEditor.sharedVertices.findAllSharedVertices(polygonEditor.polygons),
            validation: polygonEditor.sharedVertices.validateSharedVertices(polygonEditor.polygons)
        };
    },

    /**
     * Get adjacency graph information
     */
    getAdjacencyGraph: function() {
        if (!polygonEditor) return null;

        return {
            adjacencyList: polygonEditor.adjacencyGraph.getAdjacencyList(),
            statistics: polygonEditor.adjacencyGraph.getStatistics()
        };
    },

    /**
     * Get neighbors of a specific polygon
     */
    getNeighbors: function(polygonId) {
        if (!polygonEditor) return null;

        return polygonEditor.adjacencyGraph.getNeighbors(polygonId);
    },

    /**
     * Check if two polygons are adjacent
     */
    areAdjacent: function(id1, id2) {
        if (!polygonEditor) return null;

        return polygonEditor.adjacencyGraph.areAdjacent(id1, id2);
    },
    
    /**
     * Get overlap detection information
     */
    getOverlapInfo: function() {
        if (!polygonEditor) return null;
        
        return {
            allOverlaps: polygonEditor.overlapDetection.findAllOverlaps(polygonEditor.polygons),
            validStateStats: polygonEditor.overlapDetection.getValidStateStats()
        };
    },
    
    /**
     * Toggle various visual features
     */
    toggleFeature: function(featureName) {
        if (!polygonEditor) return false;
        
        const renderer = polygonEditor.renderer;
        
        switch (featureName.toLowerCase()) {
            case 'grid':
                renderer.toggleGrid();
                break;
            case 'vertices':
                renderer.toggleVertices();
                break;
            case 'vertexnumbers':
                renderer.toggleVertexNumbers();
                break;
            case 'labels':
                renderer.togglePolygonLabels();
                break;
            default:
                console.log('Available features: grid, vertices, vertexnumbers, labels');
                return false;
        }
        
        polygonEditor.draw();
        return true;
    }
};

// Make utility functions available globally for easier debugging
window.getPolygonEditorState = window.PolygonEditorUtils.getDetailedState;
window.toggleFeature = window.PolygonEditorUtils.toggleFeature;