/**
 * config.js — data root resolution.
 *
 * All raw-file paths in the manifests (`election_meta.json` /
 * `referendum_meta.json`) are given relative to `data/` (FEATURE_SPEC.md
 * Section 8, e.g. `"results/df_results_general_direct.csv"`). This module
 * is the single place that turns such a relative path into a fetchable URL.
 *
 * The root is anchored via `import.meta.url` rather than a path relative to
 * the current page's URL, so it resolves correctly regardless of which HTML
 * page (index.html, results.html, referendum.html, ...) happens to import
 * this module, or how deep that page lives under `election-site/`.
 *
 * `election-site/js/data/config.js` -> `../../../data/` -> `Result Webpage/data/`.
 *
 * Note: this only works when the site is served over http(s) (e.g. a local
 * static file server) — browsers block `fetch()` of local files under a
 * bare `file://` origin. See the data-layer report for this caveat.
 */

export const DATA_ROOT = new URL('../../../data/', import.meta.url).href;

// Bumped by bumpCacheEpoch() (called from data.js's refreshAllData()) so a
// manual "Reload results" click gets URLs that differ from whatever was
// fetched before -- browsers (and any CDN in front of production, per
// serve_no_cache.py's own doc comment about production caching) are free to
// reuse a cached response for an identical URL even after the in-memory
// promise caches below have been cleared, so the reload button needs the
// URL itself to change, not just a fresh fetch() call.
let _cacheEpoch = 0;

/** Advances the cache-busting epoch used by dataPath() below. */
export function bumpCacheEpoch() {
  _cacheEpoch += 1;
}

/**
 * Resolve a path relative to the data root (as stored in the JSON
 * manifests) to an absolute fetchable URL.
 * @param {string} relPath e.g. "results/df_results_general_direct.csv"
 * @returns {string}
 */
export function dataPath(relPath) {
  if (!relPath) throw new Error('data layer: dataPath() called with an empty path');
  const url = new URL(relPath, DATA_ROOT);
  if (_cacheEpoch > 0) url.searchParams.set('v', String(_cacheEpoch));
  return url.href;
}

/**
 * File-naming convention for General Election seat result files
 * (FEATURE_SPEC.md Section 4): `df_results_{slug(name)}.csv`, where
 * slug() lowercases the seat type's `name` and replaces spaces with
 * underscores. NOT used to locate files at runtime — `results_file` in
 * election_meta.json is always the source of truth for that (the spec's
 * "JSON is the manifest, no file names need to be hardcoded in code"
 * principle) — this is exposed only as a documented reference/validation
 * helper, e.g. for a QA agent wanting to confirm `results_file` matches
 * the convention.
 * @param {string} name Seat type's display `name` field.
 * @returns {string}
 */
export function slugifyName(name) {
  return String(name).toLowerCase().trim().replace(/\s+/g, '_');
}
