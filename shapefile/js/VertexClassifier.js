/**
 * VertexClassifier - Single source of truth for vertex type classification.
 *
 * Hierarchy (highest priority first):
 *   FIXED          — on the simplified county outline; absolutely immutable
 *   CROSS_COUNTY   — shared between sub-polygons of different counties;
 *                    protected even if simplified away from the county outline
 *   SAME_COUNTY    — shared between sub-polygons within one county; editable
 *   ORDINARY       — belongs to exactly one polygon; fully editable
 *
 * All operations (move, delete, replace, midpoint, vertex-split) call
 * classify() or isProtected() here instead of querying FixedCountyVertices
 * or SharedVertices directly.
 */
class VertexClassifier {
    static FIXED        = 'fixed';
    static CROSS_COUNTY = 'shared-cross-county';
    static SAME_COUNTY  = 'shared-same-county';
    static ORDINARY     = 'ordinary';

    constructor(fixedCountyVertices) {
        this.fixedCountyVertices = fixedCountyVertices;
        this.tolerance = 0.000001;
    }

    /**
     * Classify a vertex by its role in the dataset.
     * @param {number} x
     * @param {number} y
     * @param {Array<Object>} polygons - full polygon list
     * @returns {string} one of the static constants above
     */
    classify(x, y, polygons) {
        // Level 1: Fixed — checked first, overrides everything else
        if (this.fixedCountyVertices.isFixedVertex(x, y)) {
            return VertexClassifier.FIXED;
        }

        // Scan for every polygon that contains this coordinate.
        // Track unique polygon indices and their county names.
        const counties = new Set();
        const polygonIndices = new Set();

        for (let i = 0; i < polygons.length; i++) {
            const polygon = polygons[i];
            let found = false;
            for (const ring of polygon.rings) {
                if (found) break;
                for (const v of ring) {
                    if (Math.abs(v.x - x) < this.tolerance &&
                        Math.abs(v.y - y) < this.tolerance) {
                        found = true;
                        polygonIndices.add(i);
                        if (polygon.county) counties.add(polygon.county);
                        break;
                    }
                }
            }
        }

        // Level 2: Cross-county — vertex straddles two or more counties.
        // This catches county-boundary vertices that were simplified out of
        // the county outline and therefore missed by FixedCountyVertices.
        if (counties.size > 1) {
            return VertexClassifier.CROSS_COUNTY;
        }

        // Level 3: Shared same-county — internal sub-polygon boundary
        if (polygonIndices.size > 1) {
            return VertexClassifier.SAME_COUNTY;
        }

        // Level 4: Ordinary
        return VertexClassifier.ORDINARY;
    }

    /**
     * Returns true for vertex types that must not be modified (fixed or cross-county).
     * Use this as the single gate for all edit operations.
     */
    isProtected(x, y, polygons) {
        const type = this.classify(x, y, polygons);
        return type === VertexClassifier.FIXED || type === VertexClassifier.CROSS_COUNTY;
    }

    /**
     * Returns detailed ownership info for a coordinate.
     *
     * Distinguishes three cases callers need to handle separately:
     *   found = false           → vertex is orphaned (not in any polygon) — invalid state
     *   found = true, counties empty → vertex exists but all owning polygons lack county data
     *   found = true, counties non-empty → normal case
     *
     * County validity rules (both must pass):
     *   1. polygon.county must be non-null/undefined/empty
     *   2. polygon.county must NOT equal polygon.id — guards against misconfigured data
     *      where the county field was set to the polygon's own ID (e.g. "NC1_01" instead of "NC1")
     *
     * @param {number} x
     * @param {number} y
     * @param {Array<Object>} polygons
     * @returns {{ found: boolean, polygonIds: number[], counties: Set<string> }}
     */
    resolveVertexInfo(x, y, polygons) {
        const polygonIds = [];
        const counties = new Set();

        for (let i = 0; i < polygons.length; i++) {
            const polygon = polygons[i];
            let found = false;
            for (const ring of polygon.rings) {
                if (found) break;
                for (const v of ring) {
                    if (Math.abs(v.x - x) < this.tolerance &&
                        Math.abs(v.y - y) < this.tolerance) {
                        found = true;
                        polygonIds.push(i);
                        if (polygon.county && polygon.county !== polygon.id) {
                            counties.add(polygon.county);
                        }
                        break;
                    }
                }
            }
        }

        return { found: polygonIds.length > 0, polygonIds, counties };
    }

    /**
     * Returns the set of county names that share this vertex.
     * Delegates to resolveVertexInfo — only returns valid county names
     * (non-null, not equal to the polygon's own ID).
     * Needed by VertexReplacement's special same-boundary allowance.
     */
    getCountiesAtVertex(x, y, polygons) {
        return this.resolveVertexInfo(x, y, polygons).counties;
    }

    /**
     * Human-readable label for user-facing error messages.
     */
    label(type) {
        switch (type) {
            case VertexClassifier.FIXED:        return 'fixed county boundary';
            case VertexClassifier.CROSS_COUNTY: return 'cross-county boundary';
            case VertexClassifier.SAME_COUNTY:  return 'shared sub-district boundary';
            case VertexClassifier.ORDINARY:     return 'ordinary';
            default:                            return 'unknown';
        }
    }
}
