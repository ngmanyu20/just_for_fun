/**
 * DataManager - loads and holds FOUR independent shapefiles, one per modelling layer
 * (constituency / county / ward / individual), each its own CSV with WKT geometry.
 *
 * Each row IS the entity at that layer's level, so there is no one-hot encoding step
 * anymore: adding a "custom parameter" to a shape just sets (or creates) a plain column
 * on that shape's own row — layer.rows / layer.headers are the single source of truth,
 * mutated in place, and exported back out as-is. This also makes reload trivial: whatever
 * columns a previously-saved file has are just its schema now, no special-case detection.
 */
class DataManager {
    constructor(config) {
        this.config = config;
        this.layers = {};
        for (const key of config.layers.options) {
            this.layers[key] = { headers: [], rows: [], entities: [] };
        }
    }

    roundCoordinate(value) {
        return Math.round(value * 10000) / 10000;
    }

    /** Columns actually required for the app to function (validated on load). */
    _minRequiredColumns(datasetConfig) {
        return [...datasetConfig.idColumns, 'geometry', 'Area', 'Region', 'Population', 'centroid'];
    }

    /**
     * @param {Object} sourceMap - { constituency: File|url, county: ..., ward: ..., individual: ... }
     * @returns {Promise<Object>} - { layerKey: { count, rowCount } }
     */
    async loadAll(sourceMap) {
        const summary = {};
        for (const key of this.config.layers.options) {
            summary[key] = await this._loadLayer(key, sourceMap[key]);
        }
        return summary;
    }

    async _loadLayer(layerKey, fileOrUrl) {
        const ds = this.config.datasets[layerKey];
        if (!fileOrUrl) throw new Error(`No file provided for the "${layerKey}" layer (expected ${ds.file})`);

        let text;
        if (typeof fileOrUrl === 'string') {
            const res = await fetch(fileOrUrl);
            if (!res.ok) throw new Error(`Failed to fetch ${ds.file}: ${res.statusText}`);
            text = await res.text();
        } else {
            text = await fileOrUrl.text();
        }

        const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
        if (lines.length < 2) throw new Error(`${ds.file} must have a header and at least one data row`);

        const headers = this.parseCSVLine(lines[0]).map(h => h.trim());
        const required = this._minRequiredColumns(ds);
        const missing = required.filter(c => !headers.includes(c));
        if (missing.length) {
            throw new Error(`${ds.file} is missing required column(s): ${missing.join(', ')}`);
        }

        // Columns this dataset always carries even if unused (e.g. ward_immigrant/ward_localists) —
        // added now so they round-trip on export from the very first load, not only once edited.
        for (const c of (ds.extraColumnsAlways || [])) {
            if (!headers.includes(c)) headers.push(c);
        }

        const rows = [];
        const entities = [];

        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const values = this.parseCSVLine(lines[i]);
            const row = {};
            headers.forEach((h, idx) => { row[h] = values[idx] !== undefined ? values[idx] : ''; });
            const rowIndex = rows.length;
            rows.push(row);

            if (!row.geometry) continue;
            let rings;
            try {
                rings = this.parseWKT(row.geometry);
            } catch (err) {
                console.warn(`${ds.file} row ${i}: failed to parse geometry`, err);
                continue;
            }
            if (!rings.length) continue;

            const area = parseFloat(row.Area) || 0;
            const rawPop = (row.Population || '').trim();
            const population = (rawPop && rawPop.toUpperCase() !== 'NA') ? parseFloat(rawPop) : NaN;
            const populationDensity = (area > 0 && !isNaN(population)) ? population / area : 0;

            const displayName = ds.idColumns.map(c => row[c]).filter(Boolean).join(' ') || `Row ${i}`;
            const zone = ds.zoneColumn ? (row[ds.zoneColumn] || '') : '';

            entities.push({
                rowIndex,
                displayName,
                region: row.Region || '',
                zone,
                area,
                population,
                populationDensity,
                countyType: row.County_Type || '', // individual layer only; '' elsewhere (Type Map no-ops)
                location: row.Location || '',       // individual layer only; '' elsewhere (Location Map no-ops)
                centroid: this.parseCentroid(row.centroid, rings),
                rings
            });
        }

        this.layers[layerKey] = { headers, rows, entities };
        return { count: entities.length, rowCount: rows.length };
    }

    parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
                else inQuotes = !inQuotes;
            } else if (ch === ',' && !inQuotes) {
                result.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        result.push(current);
        return result;
    }

    parseWKT(wkt) {
        const match = wkt.match(/POLYGON\s*\(\s*(.*)\s*\)$/);
        if (!match) throw new Error('Invalid WKT format - must be POLYGON');

        const content = match[1];
        const rings = [];
        let depth = 0, start = 0;

        for (let i = 0; i < content.length; i++) {
            if (content[i] === '(') {
                if (depth === 0) start = i + 1;
                depth++;
            } else if (content[i] === ')') {
                depth--;
                if (depth === 0) {
                    const points = this.parseRingCoordinates(content.substring(start, i));
                    if (points.length > 0) rings.push(points);
                }
            }
        }
        return rings;
    }

    parseRingCoordinates(coordString) {
        const points = [];
        for (const coord of coordString.split(',')) {
            const parts = coord.trim().split(/\s+/);
            if (parts.length >= 2) {
                const x = parseFloat(parts[0]);
                const y = parseFloat(parts[1]);
                if (!isNaN(x) && !isNaN(y)) {
                    points.push({ x: this.roundCoordinate(x), y: this.roundCoordinate(y) });
                }
            }
        }
        return points;
    }

    /** Parse "(x, y)" centroid strings; fall back to the exterior ring's bbox centre. */
    parseCentroid(str, rings) {
        if (str) {
            const m = str.match(/\(?\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\)?/);
            if (m) {
                const x = parseFloat(m[1]), y = parseFloat(m[2]);
                if (!isNaN(x) && !isNaN(y)) return { x, y };
            }
        }
        if (rings && rings[0] && rings[0].length) {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const p of rings[0]) {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.y > maxY) maxY = p.y;
            }
            return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
        }
        return null;
    }

    csvEscape(value) {
        const s = String(value === undefined || value === null ? '' : value);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
            return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
    }

    // ── Layer accessors ──────────────────────────────────────────────────────

    entities(layerKey) {
        return (this.layers[layerKey] || {}).entities || [];
    }

    row(layerKey, rowIndex) {
        return this.layers[layerKey].rows[rowIndex];
    }

    headers(layerKey) {
        return this.layers[layerKey].headers;
    }

    /** Columns beyond the dataset's known schema — the editable "custom parameters". */
    extraColumns(layerKey) {
        const ds = this.config.datasets[layerKey];
        const known = new Set(ds.schemaColumns);
        return this.headers(layerKey).filter(h => !known.has(h));
    }

    /** Known schema columns actually present, excluding geometry/centroid/index (not useful to show). */
    infoColumns(layerKey) {
        const ds = this.config.datasets[layerKey];
        const present = new Set(this.headers(layerKey));
        const hidden = new Set(['geometry', 'centroid', 'index']);
        return ds.schemaColumns.filter(h => !hidden.has(h) && present.has(h));
    }

    _tallyLocationType(rows) {
        let total = 0;
        const locationCounts = new Map();
        const typeCounts = new Map();
        for (const row of rows) {
            total++;
            const loc = (row.Location || '').trim();
            if (loc) locationCounts.set(loc, (locationCounts.get(loc) || 0) + 1);
            const type = (row.County_Type || '').trim();
            if (type) typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
        }
        if (total === 0) return null;

        const toBreakdown = (map) => [...map.entries()]
            .map(([key, count]) => ({ key, count, pct: (count / total) * 100 }))
            .sort((a, b) => b.count - a.count);

        return { total, location: toBreakdown(locationCounts), type: toBreakdown(typeCounts) };
    }

    /**
     * Constituency/County/Ward layers have no Location/County_Type of their own (only the
     * individual layer's CSV carries those columns). Instead of colouring by them, aggregate
     * the individual shapes that fall inside the selected entity/entities and report the
     * non-zero breakdown of each as percentages — e.g. "Rural — 62% (24)".
     * @param {Set<number>|number[]} rowIndices - rowIndex/es within layerKey's own dataset.
     * @returns {null|{ total:number, location:Array, type:Array }}
     */
    individualBreakdownForSet(layerKey, rowIndices) {
        const indices = rowIndices instanceof Set ? [...rowIndices] : (rowIndices || []);
        if (!indices.length) return null;

        if (layerKey === 'individual') {
            const rows = indices.map(idx => this.row('individual', idx)).filter(Boolean);
            return this._tallyLocationType(rows);
        }

        const indiv = this.layers.individual;
        if (!indiv || !indiv.rows.length) return null;

        let matchFn;
        if (layerKey === 'constituency') {
            const names = new Set(indices.map(idx => this.row('constituency', idx).Constituency));
            matchFn = (r) => names.has(r.Constituency);
        } else if (layerKey === 'county') {
            const names = new Set(indices.map(idx => this.row('county', idx).County));
            matchFn = (r) => names.has(r.County);
        } else if (layerKey === 'ward') {
            const keys = new Set(indices.map(idx => {
                const row = this.row('ward', idx);
                return `${row.District}||${row.District_Ward}`;
            }));
            matchFn = (r) => keys.has(`${r.District}||${r.District_Ward}`);
        } else {
            return null;
        }

        return this._tallyLocationType(indiv.rows.filter(matchFn));
    }

    /** Single-entity convenience wrapper around individualBreakdownForSet(). */
    individualBreakdown(layerKey, entity) {
        if (layerKey === 'individual' || !entity) return null;
        return this.individualBreakdownForSet(layerKey, [entity.rowIndex]);
    }

    /**
     * Dataset-wide tally for the ward-only Edit Immigrant/Edit Localist modes: total
     * population (and ward count) for each of that attribute's possible values, keyed by
     * the value string itself ("" = unassigned).
     * @param {'immigrant'|'localist'} attrKey
     * @returns {null|Object<string,{count:number,population:number}>}
     */
    wardEditSummary(attrKey) {
        const cfg = this.config.wardEdit && this.config.wardEdit[attrKey];
        const layer = this.layers.ward;
        if (!cfg || !layer || !layer.rows.length) return null;

        const col = cfg.column;
        const totals = {};
        for (const v of Object.values(cfg.values)) totals[v] = { count: 0, population: 0 };

        for (const row of layer.rows) {
            const val = row[col] || '';
            if (!(val in totals)) totals[val] = { count: 0, population: 0 };
            const pop = parseFloat(row.Population);
            totals[val].count++;
            if (!isNaN(pop)) totals[val].population += pop;
        }
        return totals;
    }

    /** Every distinct value string reachable across all of config.winningPerspective's hotkey
     *  cycles (0-4), de-duplicated in first-seen key/array order. Values are shared between
     *  cycles on purpose (e.g. "Vote: Left_MR" is reachable from both key 1 and key 2), so this
     *  is the single place that flattens them for display (summary table / legend). */
    winningPerspectiveValueList() {
        const cfg = this.config.winningPerspective;
        const seen = new Set();
        const list = [];
        for (const k of Object.keys(cfg.values).sort((a, b) => Number(a) - Number(b))) {
            for (const v of cfg.values[k]) {
                if (!seen.has(v)) { seen.add(v); list.push(v); }
            }
        }
        return list;
    }

    /**
     * Dataset-wide tally for the Winning Perspectives mode: total population (and shape count)
     * for each of the config's possible values, keyed by the value string itself ("" =
     * unassigned). Same shape as wardEditSummary() but works on whichever layer (Constituency
     * or Ward) is currently active, since Winning Perspectives isn't tied to a single layer.
     * @param {'constituency'|'ward'} layerKey
     * @returns {null|Object<string,{count:number,population:number}>}
     */
    winningPerspectiveSummary(layerKey) {
        const cfg = this.config.winningPerspective;
        const layer = this.layers[layerKey];
        if (!cfg || !layer || !layer.rows.length) return null;

        const col = cfg.column;
        const totals = {};
        for (const v of this.winningPerspectiveValueList()) totals[v] = { count: 0, population: 0 };

        for (const row of layer.rows) {
            const val = row[col] || '';
            if (!(val in totals)) totals[val] = { count: 0, population: 0 };
            const pop = parseFloat(row.Population);
            totals[val].count++;
            if (!isNaN(pop)) totals[val].population += pop;
        }
        return totals;
    }

    /** Set (or create) a column's value on one row — the whole "custom parameter" mechanism. */
    setParam(layerKey, rowIndex, colName, value) {
        const layer = this.layers[layerKey];
        if (!layer.headers.includes(colName)) layer.headers.push(colName);
        layer.rows[rowIndex][colName] = value;
    }

    /** Blank out a column's value on one row (the column itself stays, other rows keep their values). */
    clearParam(layerKey, rowIndex, colName) {
        const layer = this.layers[layerKey];
        if (layer.rows[rowIndex]) layer.rows[rowIndex][colName] = '';
    }

    exportLayerCSV(layerKey) {
        const layer = this.layers[layerKey];
        if (!layer || !layer.rows.length) throw new Error(`No ${layerKey} data loaded to export`);
        const headers = layer.headers;
        const lines = [headers.join(',')];
        for (const row of layer.rows) {
            lines.push(headers.map(h => this.csvEscape(row[h])).join(','));
        }
        return lines.join('\n');
    }

    /** @returns {Object} - { layerKey: csvString } for all four layers. */
    exportAll() {
        const out = {};
        for (const key of this.config.layers.options) out[key] = this.exportLayerCSV(key);
        return out;
    }
}
