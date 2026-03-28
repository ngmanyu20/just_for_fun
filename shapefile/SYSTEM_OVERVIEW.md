# Polygon Shape Editor — System Overview

## What This App Does

A browser-based editor for election district shapefiles stored as CSV/WKT. You load a CSV of polygon geometries, view them on a canvas, and use tools to **split**, **combine**, **edit vertices**, and **export** the result back to CSV.

---

## Architecture

```
Browser (index.html + js/)
        |
        |  HTTP API calls (split, merge, merge-county, csv_files, save_csv)
        v
FastAPI Server (app.py)  ←→  geometry_core.py  (Shapely + Voronoi)
        |
        └── Serves index.html and /js/* static files
```

- The **frontend** handles all UI, rendering, and vertex editing in JavaScript.
- The **backend** handles all heavy geometric operations (split, merge) using Python/Shapely.
- No geometry math is done in JavaScript — only coordinate manipulation.

---

## How to Start

Run `start_app.bat`, which:
1. Starts `uvicorn app:app --port 8000` using `E:\Store\Python\venv\Scripts\python.exe`
2. Opens `http://localhost:8000` in your browser

---

## Data Format

The app reads/writes **CSV files** with a `geometry` column in **WKT format**:

```
County, Shape_ID, Parent, Shape, geometry
NC1,    NC1_001,  NC1,    Sub,   "POLYGON ((x1 y1, x2 y2, ...))"
```

- Coordinates are rounded to **4 decimal places** throughout.
- `Shape_ID` follows the format `{County}_{NNN}` where NNN is a zero-padded number from `001` to `999`, gap-filled on every split/combine operation.
- `Parent` is preserved from the original CSV row through all split and combine operations.

---

## Backend Files

### `app.py` — FastAPI Server

Serves the frontend and exposes API endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | Serves `index.html` |
| `/csv_files` | GET | Lists CSV files in `csv_input/` directory |
| `/split` | POST | Splits a polygon into N districts using Voronoi |
| `/merge` | POST | Merges multiple polygons into one |
| `/merge-county` | POST | Merges sub-county polygons into a county boundary (applies `SIMPLIFY_TOLERANCE = 0.001`) |
| `/save_csv` | POST | Saves a CSV file to `csv_input/` (path traversal protected) |

### `geometry_core.py` — Geometry Engine

| Function | Purpose |
|---|---|
| `random_points_in_polygon(polygon, num_points)` | Generates random seed points inside a polygon for Voronoi |
| `voronoi_finite_polygons_2d(vor, radius)` | Converts infinite Voronoi regions to finite polygons |
| `_explode_to_polygons(geom)` | Flattens MultiPolygon/GeometryCollection to a list of Polygons |
| `split_polygon_geojson(geometry, num_districts, seed, ...)` | **Main split function** — uses Voronoi tessellation; always generates `max(num_districts, 3)` seeds (qhull requires ≥3), merges excess cells back; multi-pass gap absorption (up to 5 passes) absorbs uncovered areas into the district with the **longest shared boundary** rather than emitting them as separate features |
| `merge_polygons_geojson(features, snap_tol, require_single)` | Merges multiple GeoJSON polygon features into a single polygon using Shapely's `unary_union` |

### `schemas.py` — API Request/Response Models

| Class | Fields |
|---|---|
| `SplitRequest` | `geometry` (GeoJSON), `num_districts`, `seed`, `include_gaps`, `gap_area_tol`, `min_cell_area` |
| `SplitResponse` | `type`, `features` |
| `MergeRequest` | `features` (GeoJSON list), `snap_tol`, `require_single` |

---

## Frontend Files

### `index.html` — Main UI

Single-page app with:
- **Canvas** (left) — renders polygons
- **Controls panel** (right) — collapsible sections for File, Layer, Polygon, Split, Vertices
- Loads `VertexClassifier.js` before `FixedCountyVertices.js` (load order matters)

### `js/app.js` — Application Bootstrap
- Creates the `PolygonEditor` instance on `DOMContentLoaded`
- Sets up layer toggle buttons (County / Sub-County)
- Fetches available CSV files from `/csv_files` endpoint and shows a modal picker
- Handles unsaved-changes warning on page unload
- Exposes `window.PolygonEditorUtils` for browser console debugging

---

## JavaScript Modules

### `PolygonEditor.js` — Main Controller

The central class that creates and wires all modules together.

**Key state:**
- `polygons[]` — all loaded polygons
- `selectedPolygonIndex` — currently selected polygon
- `selectedPolygonIndices` — multi-selected polygons (for combine)
- `isEditMode` — edit vs. view mode

**Key methods:**
- `initialize()` — sets up event listeners and canvas
- `handleFileSelect()` — loads CSV file
- `loadPolygons()` — processes loaded data, fits canvas view
- `setEditMode()` — switches between Edit/View modes
- `exportCSV()` — triggers CSV download
- `undo()` / `redo()` — history navigation
- `combineSelectedPolygons()` — sends selected polygons to `/merge` API
- `showSplitDialog()` / `regenerateSplit()` — triggers polygon split via `/split` API
- `handleVertexDelete()` — deletes selected vertex
- `handleMidpointCreate()` — inserts midpoint between two selected vertices
- `switchToCountyLayer()` / `switchToSubCountyLayer()` — layer switching
- `nextPolygonIds(county, count)` — generates `count` gap-filling IDs for a county in format `{County}_{NNN}`, scanning current polygons and filling lowest available numbers first

---

### `DataManager.js` — CSV and WKT I/O

| Method | Purpose |
|---|---|
| `loadCSV(file)` | Reads CSV file or URL, parses each row's `geometry` WKT into rings |
| `parseCSVLine(line)` | Handles quoted commas in CSV values |
| `parseWKT(wkt)` | Converts `POLYGON ((x y, ...))` string to `[{x,y}]` rings |
| `parseRingCoordinates(str)` | Parses a coordinate string into `{x, y}` array |
| `ringsToWKT(rings)` | Converts rings back to WKT string |
| `exportToCSV(polygons)` | Produces full CSV string with updated geometries |
| `getPolygonById(id)` | Finds a polygon by its ID |
| `updatePolygonGeometry(id, rings)` | Updates a polygon's rings in-place |

---

### `LayerManager.js` — County / Sub-County Layers

Manages two layers:
- **Sub-County** (default visible) — original polygons from CSV
- **County** (auto-generated) — merged from sub-county polygons via `/merge-county` API

| Method | Purpose |
|---|---|
| `loadSubCountyData(polygons, dataManager)` | Loads sub-county data and triggers county generation |
| `generateCountyLayerRobust(dataManager)` | Calls `/merge-county` for each county; falls back to JS if server fails |
| `extractOuterBoundary(polygons)` | JS fallback: finds outer edges by counting edge occurrences (shared edges = internal) |
| `connectEdges(edges)` | Connects boundary edges into a closed ring |
| `simplifyVertices(vertices)` | Removes collinear vertices |
| `toggleLayer(name)` / `isLayerVisible(name)` | Layer visibility control |
| `getVisiblePolygons()` | Returns all polygons from currently visible layers |

---

### `GeometryOps.js` — Coordinate Transforms & Spatial Math

| Method | Purpose |
|---|---|
| `dataToScreen(x, y)` | Converts geographic coords to canvas pixel coords |
| `screenToData(x, y)` | Converts canvas pixels back to geographic coords |
| `calculateBounds(polygons)` | Computes bounding box across all polygons |
| `fitToView()` | Calculates scale/offset to fit all polygons on screen |
| `isPointInPolygon(point, ring)` | Ray-casting point-in-polygon test |
| `distanceToSegment(point, p1, p2)` | Distance from a point to a line segment (for vertex hit-testing) |

---

### `Renderer.js` — Canvas Drawing

Draws polygons, vertices, and selection highlights on the HTML5 canvas.

| Method | Purpose |
|---|---|
| `draw(polygons, selected, ...)` | Full canvas redraw |
| `drawPolygon(polygon, style)` | Draws a single polygon with fill and stroke |
| `drawVertices(polygon)` | Draws vertex dots — colour depends on vertex type: blue with "F" for fixed, red for shared/neighbor, purple for selected |
| `toggleGrid()` / `toggleVertices()` / `togglePolygonLabels()` | Visual toggles |

---

### `MouseHandler.js` — User Interactions

Handles all mouse events on the canvas:
- **Click** — select polygon or vertex (Shift+Click for vertex)
- **Ctrl+Click** — multi-select for combine
- **Drag** — pan the view or drag a selected vertex
- **Scroll** — zoom in/out
- **Keyboard** — arrow keys for pan, Delete to remove vertex, `M` for midpoint, `C` for vertex split

---

### `HistoryManager.js` — Undo/Redo

Stores deep copies of polygon state. Key methods:
- `saveToHistory(polygons, description)` — snapshot current state
- `undo(currentPolygons)` / `redo(currentPolygons)` — navigate history
- `createCheckpoint(polygons, name)` — named restore point
- `getHistoryStats()` — returns total states, current position

---

## Vertex Classification

All vertex edit operations route through a single classification hierarchy enforced by `VertexClassifier.js`. No operation queries `FixedCountyVertices` or `SharedVertices` directly.

### `VertexClassifier.js` — Single Source of Truth

```
FIXED  >  CROSS_COUNTY  >  SAME_COUNTY  >  ORDINARY
```

| Type | Definition | Editable? |
|---|---|---|
| `FIXED` | On the simplified county outline (`FixedCountyVertices`) | Never |
| `CROSS_COUNTY` | Shared between sub-polygons of **different** counties — catches vertices simplified out of the county outline by `SIMPLIFY_TOLERANCE=0.001` | Never |
| `SAME_COUNTY` | Shared between sub-polygons within **one** county | Yes |
| `ORDINARY` | Belongs to exactly one polygon | Yes |

**Key methods:**
- `classify(x, y, polygons)` — returns one of the four type constants
- `isProtected(x, y, polygons)` — `true` for FIXED or CROSS_COUNTY
- `getCountiesAtVertex(x, y, polygons)` — set of county names at this coordinate
- `label(type)` — human-readable string for error messages

**Operation permission matrix:**

| Operation | FIXED | CROSS_COUNTY | SAME_COUNTY | ORDINARY |
|---|---|---|---|---|
| Move (drag) | ❌ | ❌ | ✅ | ✅ |
| Delete | ❌ | ❌ | ✅ | ✅ |
| Replace (1/2 key) | ❌ | ⚠️ same boundary only | ✅ | ✅ |
| Midpoint (M key) | ❌ | ❌ | ✅ | ✅ |
| Vertex Split (C key) | ❌ | ❌ | ✅ | ✅ |

---

### `FixedCountyVertices.js` — Boundary Lock

Tracks county boundary vertices from the **simplified** county outline. Used internally by `VertexClassifier`.

| Method | Purpose |
|---|---|
| `initialize(countyPolygons)` | Builds the fixed vertex map (runs once; blocks re-initialization) |
| `isFixedVertex(x, y)` | Returns true if a vertex is on the simplified county outline |
| `findNearbyVertices(x, y, tolerance)` | Finds fixed vertices within a radius (for snapping) |

---

### `SharedVertices.js` — Shared Vertex Tracking

Tracks which vertices are shared between adjacent polygons so that when one is moved, all copies move together. Uses a `0.001` coordinate tolerance.

| Method | Purpose |
|---|---|
| `findSharedVertices(x, y, polygons)` | Returns all polygon/ring/vertex references at this coordinate |
| `updateSharedVertices(oldX, oldY, newX, newY, polygons)` | Moves a vertex and syncs all copies |
| `validateSharedVertices(polygons)` | Checks for consistency errors |
| `getStatistics(polygons)` | Returns count of shared vertex groups |

---

### `VertexSync.js` — Sync After Edit

After any polygon split or merge, re-syncs shared vertices across the whole dataset to prevent gaps/overlaps. Uses multi-pass approach:
1. Pre-pass: sibling split polygons
2. Pass 1: external neighbors
3. Pass 2: split polygons
4. Passes 3–4: final rounds

---

### `VertexSelection.js` — Vertex Pick

Manages the set of Shift+Clicked vertices and UI display of selection info. Also tracks neighboring (shared-coordinate) vertices for red highlighting.

---

### `VertexDeletion.js` — Delete Vertex

Removes a selected vertex from a polygon ring.

- Blocked for FIXED and CROSS_COUNTY vertices (via `VertexClassifier`)
- Blocked if ring would drop below 4 vertices (3 unique + closing)
- Automatically detects and fills gaps created by deletion using unmatched-edge analysis

---

### `VertexReplacement.js` — Replace Vertex

Replaces a selected vertex with either its previous or next neighbor vertex (keyboard: `1` = prev, `2` = next).

- FIXED vertices: always blocked
- CROSS_COUNTY → CROSS_COUNTY on **same** county boundary: allowed (safe simplification)
- All other cross-county or fixed combinations: blocked
- Automatically detects and fills gaps after replacement

---

### `MidpointCreation.js` — Insert Midpoint

Inserts a new vertex at the midpoint between two selected adjacent vertices (keyboard: `M`).

- Blocked if any selected vertex is FIXED or CROSS_COUNTY (a new unprotected midpoint on the boundary would be draggable)
- Propagates inserted midpoints to all polygons sharing the same edge

---

### `VertexSplitter.js` — Split by Vertices

Splits a polygon along a line defined by two or more selected vertices (keyboard: `C`).

- Blocked if any selected vertex is FIXED or CROSS_COUNTY
- Validates collinearity (collinear vertices cannot form a polygon)
- Creates new polygons assigned `{County}_{NNN}` IDs via `PolygonEditor.nextPolygonIds()`

---

### `PolygonSplitter.js` — Voronoi Split Client

Sends a polygon to the Python `/split` API and converts the response back to internal format.

| Method | Purpose |
|---|---|
| `convertToGeoJSON(polygon)` | Converts internal rings to GeoJSON Polygon |
| `convertFromGeoJSON(geojson, source)` | Converts API response features back to internal polygons |
| `splitPolygon(polygon, numDistricts, seed)` | POSTs to `/split`, returns array of new polygons |

New polygons are assigned `{County}_{NNN}` IDs by `PolygonEditor.nextPolygonIds()` after the source polygon is removed (so its number is freed for gap-filling).

---

### `PolygonCombiner.js` — Combine Client

Sends selected polygons to the Python `/merge` API.

| Method | Purpose |
|---|---|
| `arePolygonsConnected(ids)` | BFS check that all selected polygons are topologically adjacent |
| `convertToGeoJSONFeature(polygon)` | Converts internal polygon to GeoJSON Feature |
| `combinePolygons(polygons, name)` | POSTs to `/merge`, returns merged polygon |

The merged polygon receives a `{County}_{NNN}` ID via `PolygonEditor.nextPolygonIds()` after all source polygons are removed. `Parent` is set to the shared parent if all sources agree, otherwise falls back to the first polygon's parent.

---

### `AdjacencyGraph.js` — Topology

Builds and queries an adjacency graph from shared edges between polygons.

| Method | Purpose |
|---|---|
| `buildGraph(polygons)` | Scans all polygon edges, marks shared edges as adjacencies |
| `getNeighbors(id)` | Returns list of adjacent polygon IDs |
| `areAdjacent(id1, id2)` | Returns true if two polygons share an edge |
| `getAdjacencyList()` / `getStatistics()` | Inspection utilities |

---

### `OverlapDetection.js` — Overlap Check

After edits, checks whether any polygon now overlaps another. Distinguishes true interior overlap from shared boundary edges. Flags overlapping polygons visually.

---

### `UIController.js` — UI Wiring

Manages button states (enabled/disabled), status messages, mode labels, and polygon dropdown population.

---

## Polygon ID Naming Scheme

All new polygons (from any operation) receive IDs in the format `{County}_{NNN}`:

| Operation | ID assigned |
|---|---|
| Initial load | `Shape_ID` from CSV as-is |
| Voronoi split (N districts) | Next N gap-filled IDs for that county |
| Vertex split (C key) | Next N gap-filled IDs for that county |
| Combine | Next 1 gap-filled ID for that county |

Gap-filling starts from `001` and fills the lowest unused numbers first. Source polygons are removed before IDs are assigned so their numbers are available for reuse. Numbers are reserved within a batch to prevent duplicates.

---

## Complete Data Flow

```
User loads CSV
    → DataManager.loadCSV()  parses WKT → internal rings [{x,y}]
    → LayerManager.loadSubCountyData() → calls /merge-county for each county
    → FixedCountyVertices.initialize() — locks county outline vertices
    → VertexClassifier created (wraps FixedCountyVertices)
    → GeometryOps.calculateBounds() + fitToView()
    → Renderer draws all polygons on canvas

User selects polygon → clicks Split
    → PolygonSplitter.convertToGeoJSON() → POST /split
    → geometry_core.split_polygon_geojson() (Voronoi + multi-pass gap absorption)
    → source polygon removed from this.polygons
    → nextPolygonIds() assigns {County}_NNN IDs (gap-filling)
    → PolygonSplitter.convertFromGeoJSON() → new polygons inserted
    → HistoryManager.saveState()
    → VertexSync.syncAfterSplit() re-syncs shared boundaries
    → Renderer redraws

User Shift+Clicks vertex → selects it → clicks Delete / M / C
    → VertexClassifier.isProtected() checked — FIXED and CROSS_COUNTY blocked
    → VertexDeletion / MidpointCreation / VertexSplitter operates
    → SharedVertices.syncVertex() propagates change to neighbors
    → HistoryManager.saveState()

User Ctrl+Clicks polygons → clicks Combine
    → PolygonCombiner.arePolygonsConnected() checks adjacency
    → POST /merge → source polygons removed
    → nextPolygonIds() assigns {County}_NNN ID
    → merged polygon replaces originals

User clicks Export CSV
    → DataManager.exportToCSV(polygons) → triggers file download or POST /save_csv
```

---

## Key Constraints

- **Vertex hierarchy**: FIXED > CROSS_COUNTY > SAME_COUNTY > ORDINARY. All operations check via `VertexClassifier.isProtected()` — never directly.
- **Fixed county vertices**: Outer boundary vertices (from simplified county outline) cannot be deleted, moved, or used as midpoint/split anchors.
- **Cross-county vertices**: Vertices shared between different counties are equally protected — they may not appear in the fixed set if simplified away, but `VertexClassifier` catches them by scanning county membership.
- **Shared vertex sync**: When a SAME_COUNTY shared vertex is moved, all polygons sharing that vertex are updated simultaneously.
- **Gap absorption**: Voronoi split gaps are absorbed server-side (Python) into the adjacent district with the longest shared boundary — no gap polygons are ever emitted to the frontend.
- **Server required**: Split and Combine features require the Python server (`uvicorn`) to be running. Vertex editing works offline.
- **Input format**: CSV must have a `geometry` column (WKT `POLYGON (...)`) and a `County` column. `Shape_ID` and `Parent` columns are preserved and carried through all operations.
- **ID format**: `{County}_{NNN}` — three-digit zero-padded, gap-filled from 001 per county.
