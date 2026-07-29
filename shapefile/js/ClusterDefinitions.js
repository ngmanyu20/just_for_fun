/**
 * ClusterDefinitions - Loads Population_Cluster_Proposed.csv and exposes a
 * Region + Type + Key -> cluster row lookup for the Edit Clusters tool.
 */
(function () {
    const CSV_PATH = './csv_input/Info_CSV/Population_Cluster_Proposed.csv';

    function parseCSVLine(line) {
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

    // Some shapefile CSVs still use legacy named-district Region values instead of the
    // macro Region (Capital/Highland/Lowland) that Population_Cluster_Proposed.csv keys on.
    // Resolve those here so polygon.region can be passed through as-is everywhere else.
    const REGION_ALIAS = {
        'Alma Valley East': 'Capital',
        'Alma Valley West': 'Capital',
        'Midlands':         'Lowland',
        'South East':       'Lowland',
    };

    function resolveRegion(region) {
        return REGION_ALIAS[region] || region;
    }

    const list = [];
    const byLookup   = new Map(); // `${Region}|${Type}|${Key}` -> row
    const byNameLookup = new Map(); // `${Region}|${Type}|${Cluster_Name}` -> row (reverse lookup)

    function lookupKey(region, type, key) {
        return `${resolveRegion(region)}|${type}|${String(key).toUpperCase()}`;
    }

    function nameLookupKey(region, type, name) {
        return `${resolveRegion(region)}|${type}|${name}`;
    }

    async function load() {
        try {
            const response = await fetch(CSV_PATH);
            if (!response.ok) throw new Error(response.statusText);
            const text = await response.text();
            const lines = text.trim().split('\n');
            if (lines.length < 2) return;

            const headers = parseCSVLine(lines[0]);
            for (let i = 1; i < lines.length; i++) {
                if (!lines[i].trim()) continue;
                const values = parseCSVLine(lines[i]);
                const row = {};
                headers.forEach((h, idx) => { row[h] = values[idx] !== undefined ? values[idx] : ''; });
                if (!row.Region || !row.Type || !row.Key) continue;
                list.push(row);
                byLookup.set(lookupKey(row.Region, row.Type, row.Key), row);
                if (row.Cluster_Name) {
                    byNameLookup.set(nameLookupKey(row.Region, row.Type, row.Cluster_Name), row);
                }
            }
            console.log(`ClusterDefs: loaded ${list.length} cluster definitions from ${CSV_PATH}`);
        } catch (err) {
            console.warn('ClusterDefs: failed to load cluster definitions:', err);
        }
    }

    window.ClusterDefs = {
        list,
        /** Look up a cluster row by the polygon's Region, Type (Location) and a pressed Key. */
        find(region, type, key) {
            if (!region || !type || key === undefined || key === null) return null;
            return byLookup.get(lookupKey(region, type, key)) || null;
        },
        /** Reverse lookup: recover the cluster row (incl. Key) from a stored Cluster_Name. */
        findByName(region, type, clusterName) {
            if (!region || !type || !clusterName) return null;
            return byNameLookup.get(nameLookupKey(region, type, clusterName)) || null;
        },
        ready: load()
    };
})();
