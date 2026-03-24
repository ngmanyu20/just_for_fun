# Polygon Shape Editor — System Overview

## What This App Does

A browser-based editor for election district shapefiles stored as CSV/WKT. You load a CSV of polygon geometries, view them on a canvas, and use tools to **split**, **combine**, **edit vertices**, and **export** the result back to CSV.

---

## Architecture

```
Browser (index.html + js/)
        |
        |  HTTP API calls (split, merge, merge-county)
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
1. Starts `uvicorn app:app --port 8000`
2. Opens `http://localhost:8000` in your browser

---

## Data Format

The app reads/writes **CSV files** with a `geometry` column in **WKT format**:

```
Shape_ID, County, Parent, Shape, geometry
NC8_01,   NC8,   NC8,    Sub,   "POLYGON ((x1 y1, x2 y2, ...))"
```

Coordinates are rounded to **4 decimal places** throughout.

---

## Backend Files

### `app.py` — FastAPI Server
Serves the frontend and exposes 3 API endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | Serves `index.html` |
| `/split` | POST | Splits a polygon into N districts using Voronoi |
| `/merge` | POST | Merges multiple polygons into one |
| `/merge-county` | POST | Merges sub-county polygons into a county boundary |

### `geometry_core.py` — Geometry Engine

| Function | Purpose |
|---|---|
| `random_points_in_polygon(polygon, num_points)` | Generates random seed points inside a polygon for Voronoi |
| `voronoi_finite_polygons_2d(vor, radius)` | Converts infinite Voronoi regions to finite polygons |
| `_explode_to_polygons(geom)` | Flattens MultiPolygon/GeometryCollection to a list of Polygons |
| `split_polygon_geojson(geometry, num_districts, seed, ...)` | **Main split function** — uses Voronoi tessellation to divide a polygon into N districts; fills uncovered "gap" areas automatically |
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

### `js/app.js` — Application Bootstrap
- Creates the `PolygonEditor` instance on `DOMContentLoaded`
- Sets up layer toggle buttons (County / Sub-County)
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

---

### `DataManager.js` — CSV and WKT I/O

| Method | Purpose |
|---|---|
| `loadCSV(file)` | Reads CSV file, parses each row's `geometry` WKT into rings |
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
| `drawVertices(polygon)` | Draws vertex dots |
| `toggleGrid()` / `toggleVertices()` / `togglePolygonLabels()` | Visual toggles |

---

### `MouseHandler.js` — User Interactions

Handles all mouse events on the canvas:
- **Click** — select polygon or vertex (Shift+Click for vertex)
- **Ctrl+Click** — multi-select for combine
- **Drag** — pan the view or drag a selected vertex
- **Scroll** — zoom in/out

---

### `HistoryManager.js` — Undo/Redo

Stores deep copies of polygon state. Key methods:
- `saveState(polygons, description)` — snapshot current state
- `undo(currentPolygons)` / `redo(currentPolygons)` — navigate history
- `createCheckpoint(polygons, name)` — named restore point
- `getHistoryStats()` — returns total states, current position

---

### `PolygonSplitter.js` — Split Client

Sends a polygon to the Python `/split` API and converts the response back to internal format.

| Method | Purpose |
|---|---|
| `convertToGeoJSON(polygon)` | Converts internal rings to GeoJSON Polygon |
| `convertFromGeoJSON(geojson, source)` | Converts API response features back to internal polygons |
| `splitPolygon(polygon, numDistricts, seed)` | POSTs to `/split`, returns array of new polygons |
| `calculateSuggestedDistricts(polygon, mode)` | Suggests district count based on polygon area |

---

### `PolygonCombiner.js` — Combine Client

Sends selected polygons to the Python `/merge` API.

| Method | Purpose |
|---|---|
| `arePolygonsConnected(ids)` | BFS check that all selected polygons are topologically adjacent |
| `convertToGeoJSONFeature(polygon)` | Converts internal polygon to GeoJSON Feature |
| `combinePolygons(polygons, name)` | POSTs to `/merge`, returns merged polygon |

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

### `SharedVertices.js` — Shared Vertex Tracking

Tracks which vertices are shared between adjacent polygons so that when one is moved, all copies move together.

| Method | Purpose |
|---|---|
| `findAllSharedVertices(polygons)` | Builds map of vertices shared across polygons |
| `syncVertex(polygons, polyIdx, ringIdx, vtxIdx, newPos)` | Moves a vertex and syncs all copies |
| `validateSharedVertices(polygons)` | Checks for consistency errors |
| `getStatistics(polygons)` | Returns count of shared vertex groups |

---

### `VertexSync.js` — Sync After Edit

After any polygon edit, re-syncs shared vertices across the whole dataset to prevent gaps/overlaps.

---

### `FixedCountyVertices.js` — Boundary Lock

Tracks county boundary vertices that must not be moved (they sit on the outer county edge). Prevents edits from breaking the county outline.

| Method | Purpose |
|---|---|
| `buildFromPolygons(polygons)` | Identifies and locks outer boundary vertices |
| `isFixed(polyIdx, ringIdx, vtxIdx)` | Returns true if a vertex is locked |

---

### `VertexSelection.js` — Vertex Pick

Manages the set of Shift+Clicked vertices and UI display of selection info.

---

### `VertexDeletion.js` — Delete Vertex

Removes a selected vertex from a polygon ring, respecting fixed county boundary vertices.

---

### `VertexReplacement.js` — Replace Vertex

Replaces a selected vertex with either its previous or next neighbor vertex (keyboard: `1` = prev, `2` = next).

---

### `MidpointCreation.js` — Insert Midpoint

Inserts a new vertex at the midpoint between two selected adjacent vertices (keyboard: `M`).

---

### `VertexSplitter.js` — Split by Vertices

Splits a polygon along a line defined by two selected vertices (keyboard: `C`).

---

### `OverlapDetection.js` — Overlap Check

After edits, checks whether any polygon now overlaps another. Flags overlapping polygons visually.

---

### `UIController.js` — UI Wiring

Manages button states (enabled/disabled), status messages, mode labels, and polygon dropdown population.

---

## Complete Data Flow

```
User loads CSV
    → DataManager.loadCSV()  parses WKT → internal rings [{x,y}]
    → LayerManager.loadSubCountyData() → calls /merge-county for each county
    → GeometryOps.calculateBounds() + fitToView()
    → Renderer draws all polygons on canvas

User selects polygon → clicks Split
    → PolygonSplitter.convertToGeoJSON() → POST /split
    → geometry_core.split_polygon_geojson() (Voronoi + gap fill)
    → PolygonSplitter.convertFromGeoJSON() → new polygons replace original
    → HistoryManager.saveState()
    → VertexSync re-syncs shared boundaries
    → Renderer redraws

User Shift+Clicks vertex → selects it → clicks Delete / M / C
    → VertexDeletion / MidpointCreation / VertexSplitter operates
    → FixedCountyVertices blocks operation if vertex is locked
    → SharedVertices.syncVertex() propagates change to neighbors
    → HistoryManager.saveState()

User Ctrl+Clicks polygons → clicks Combine
    → PolygonCombiner.arePolygonsConnected() checks adjacency
    → POST /merge → merged polygon replaces originals

User clicks Export CSV
    → DataManager.exportToCSV(polygons) → triggers file download
```

---

## Key Constraints

- **Fixed county vertices**: Outer boundary vertices cannot be deleted or moved — this preserves the county boundary.
- **Shared vertex sync**: When a boundary vertex is moved, all polygons sharing that vertex are updated simultaneously.
- **Server required**: Split and Combine features require the Python server (`uvicorn`) to be running. Vertex editing works offline.
- **Input format**: CSV must have a `geometry` column with WKT `POLYGON (...)` values. County grouping uses the `County` column.
