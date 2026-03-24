/**
 * DataManager - Handles CSV file loading, parsing, and WKT geometry processing
 */
class DataManager {
    constructor() {
        this.originalData = [];
        this.polygons = [];
    }

    /**
     * Round coordinate to 4 decimal places
     * @param {number} value - Coordinate value
     * @returns {number} - Rounded value
     */
    roundCoordinate(value) {
        return Math.round(value * 10000) / 10000;
    }

    /**
     * Round all coordinates in a point object
     * @param {Object} point - Point with x, y properties
     * @returns {Object} - Point with rounded coordinates
     */
    roundPoint(point) {
        return {
            x: this.roundCoordinate(point.x),
            y: this.roundCoordinate(point.y)
        };
    }

    /**
     * Load and parse a CSV file
     * @param {File|string} fileOrUrl - The CSV file to load or URL to fetch
     * @returns {Promise<Object>} - Result object with polygons and original data
     */
    async loadCSV(fileOrUrl) {
        if (!fileOrUrl) {
            throw new Error('No file or URL provided');
        }

        let text;
        if (typeof fileOrUrl === 'string') {
            // It's a URL, fetch it
            const response = await fetch(fileOrUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch CSV: ${response.statusText}`);
            }
            text = await response.text();
        } else {
            // It's a File object
            text = await fileOrUrl.text();
        }
        const lines = text.trim().split('\n');
        
        if (lines.length < 2) {
            throw new Error('CSV file must have at least a header and one data row');
        }

        const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
        
        this.originalData = [];
        this.polygons = [];

        for (let i = 1; i < lines.length; i++) {
            const values = this.parseCSVLine(lines[i]);
            const row = {};
            
            headers.forEach((header, index) => {
                row[header] = values[index] || '';
            });
            
            this.originalData.push(row);
            
            if (row.geometry) {
                try {
                    const rings = this.parseWKT(row.geometry);
                    if (rings.length > 0) {
                        this.polygons.push({
                            id: row.Shape_ID || row.County || `Polygon ${i}`,
                            county: row.County || '',
                            parent: row.Parent || '',
                            shape: row.Shape || '',
                            rings: rings,
                            originalWKT: row.geometry,
                            rowIndex: i - 1  // Store original row index for export
                        });
                    }
                } catch (error) {
                    console.warn(`Failed to parse geometry for row ${i}:`, error);
                }
            }
        }

        return {
            polygons: this.polygons,
            originalData: this.originalData,
            count: this.polygons.length
        };
    }

    /**
     * Parse a CSV line handling quoted values and commas
     * @param {string} line - CSV line to parse
     * @returns {Array<string>} - Array of parsed values
     */
    parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current.trim());
        return result;
    }

    /**
     * Parse WKT (Well-Known Text) polygon geometry
     * @param {string} wkt - WKT string to parse
     * @returns {Array<Array<Object>>} - Array of rings, each containing coordinate objects
     */
    parseWKT(wkt) {
        const match = wkt.match(/POLYGON\s*\(\s*(.*)\s*\)$/);
        if (!match) {
            throw new Error('Invalid WKT format - must be POLYGON');
        }
        
        const content = match[1];
        const rings = [];
        
        let depth = 0;
        let start = 0;
        let i = 0;
        
        while (i < content.length) {
            if (content[i] === '(') {
                if (depth === 0) start = i + 1;
                depth++;
            } else if (content[i] === ')') {
                depth--;
                if (depth === 0) {
                    const ringContent = content.substring(start, i);
                    const points = this.parseRingCoordinates(ringContent);
                    if (points.length > 0) {
                        rings.push(points);
                    }
                }
            }
            i++;
        }
        
        return rings;
    }

    /**
     * Parse coordinate string into point objects
     * @param {string} coordString - Coordinate string from WKT
     * @returns {Array<Object>} - Array of {x, y} coordinate objects
     */
    parseRingCoordinates(coordString) {
        const coordinates = coordString.split(',');
        const points = [];

        for (const coord of coordinates) {
            const parts = coord.trim().split(/\s+/);
            if (parts.length >= 2) {
                const x = parseFloat(parts[0]);
                const y = parseFloat(parts[1]);
                if (!isNaN(x) && !isNaN(y)) {
                    // Round to 4 decimal places
                    points.push({
                        x: this.roundCoordinate(x),
                        y: this.roundCoordinate(y)
                    });
                }
            }
        }
        
        return points;
    }

    /**
     * Convert rings array back to WKT format
     * @param {Array<Array<Object>>} rings - Array of rings containing coordinate objects  
     * @returns {string} - WKT polygon string
     */
    ringsToWKT(rings) {
        const ringStrings = rings.map(ring => {
            const coords = ring.map(point => `${point.x} ${point.y}`).join(', ');
            return `(${coords})`;
        });
        return `POLYGON (${ringStrings.join(', ')})`;
    }

    /**
     * Export current polygon data to CSV format
     * @param {Array<Object>} polygons - Current polygon data
     * @returns {string} - CSV content string
     */
    exportToCSV(polygons) {
        if (this.originalData.length === 0) {
            throw new Error('No original data to export');
        }

        // Get headers from original data
        const headers = Object.keys(this.originalData[0]);

        // Export ALL current polygons (including new ones from splits)
        const exportData = polygons.map(polygon => {
            // Try to find matching original row
            const originalRow = this.originalData.find(row =>
                (row.Shape_ID && polygon.id === row.Shape_ID) ||
                (!row.Shape_ID && polygon.id === row.County) ||
                polygon.rowIndex !== undefined && polygon.rowIndex === this.originalData.indexOf(row)
            );

            // If we found an original row, update its geometry
            if (originalRow) {
                return {
                    ...originalRow,
                    geometry: this.ringsToWKT(polygon.rings)
                };
            }

            // For NEW polygons (from splits), create a new row
            // Extract base county from polygon ID (e.g., "NC8_05_sub1" -> "NC8")
            const extractCounty = (id) => {
                const firstPart = id.split('+')[0];
                const match = firstPart.match(/^([A-Z]+\d+)/);
                return match ? match[1] : firstPart;
            };

            // Create row for new polygon
            const newRow = {};
            headers.forEach(header => {
                if (header === 'geometry') {
                    newRow[header] = this.ringsToWKT(polygon.rings);
                } else if (header === 'Shape_ID') {
                    newRow[header] = polygon.id;
                } else if (header === 'County') {
                    newRow[header] = polygon.county || extractCounty(polygon.id);
                } else if (polygon[header] !== undefined) {
                    // Copy any other properties from polygon
                    newRow[header] = polygon[header];
                } else {
                    // Default empty value
                    newRow[header] = '';
                }
            });

            return newRow;
        });

        // Convert to CSV
        const csvContent = [
            headers.join(','),
            ...exportData.map(row =>
                headers.map(header => {
                    const value = row[header] || '';
                    return value.includes(',') ? `"${value}"` : value;
                }).join(',')
            )
        ].join('\n');

        return csvContent;
    }

    /**
     * Get polygon by ID
     * @param {string} id - Polygon ID to find
     * @returns {Object|null} - Found polygon or null
     */
    getPolygonById(id) {
        return this.polygons.find(p => p.id === id) || null;
    }

    /**
     * Get all polygon IDs
     * @returns {Array<string>} - Array of polygon IDs
     */
    getPolygonIds() {
        return this.polygons.map(p => p.id);
    }

    /**
     * Update polygon geometry
     * @param {string} id - Polygon ID
     * @param {Array<Array<Object>>} rings - New ring geometry
     * @returns {boolean} - Success status
     */
    updatePolygonGeometry(id, rings) {
        const polygon = this.getPolygonById(id);
        if (polygon) {
            polygon.rings = rings;
            return true;
        }
        return false;
    }

    /**
     * Get current polygon data
     * @returns {Array<Object>} - Current polygon array
     */
    getPolygons() {
        return this.polygons;
    }

    /**
     * Get original CSV data
     * @returns {Array<Object>} - Original data array
     */
    getOriginalData() {
        return this.originalData;
    }
}