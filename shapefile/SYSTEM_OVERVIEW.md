# Polygon Shape Editor — System Overview

## What This App Does

A browser-based editor for election district shapefiles stored as CSV/WKT. You load a CSV of polygon geometries, view them on a canvas, and use tools to **split**, **combine**, **edit vertices**, **simplify**, **measure distances**, **redistrict**, and **export** the result back to CSV.

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

Single-page app. Layout: canvas fills the left, a 260 px controls panel is fixed on the right.

**Canvas area (left)**
- `<canvas id="canvas">` — all polygon rendering
- **Floating Action Button (FAB)** — `+` circle top-left of canvas; expands a menu to switch app mode:
  - `Edit Polygon` → polygon editing mode (default)
  - `Edit Population Density` → density colour-map mode
  - `Edit District Type` → district-type labelling mode
- Hidden `#polygonInfo`, `#sharedInfo`, `#coordinates` divs — kept for JS/UIController compatibility; actual display is in `display.html`

**Controls panel (right)**
| Section | Controls |
|---|---|
| File | `📂 Load CSV` / `💾 Save CSV` — opens CSV modal picker |
| CSV modal | Lists `./csv_input` files; `➕ Add Files`, `Refresh`, `Close` |
| Mode | `✏️ Edit` / `👁️ View` toggle buttons (hidden in Redistricting mode) |
| Layer (collapsible) | `County` / `Sub-County` layer toggle (hidden in Redistricting mode) |
| Display | `🖥️ Display` — opens `display.html` popup |
| Change Density | `✏️ Change Density` — shown only in Population Density mode |
| **Polygon section** (Edit Polygon mode only) | Undo/Redo · Combine · Split (N districts input + Split button) · Replace Vertex · Delete Vertex · Create Midpoint · Split by Vertices · Clear Selection · Vertices Simplification · Update Neighbours |
| **Layer section** (non-polygon modes only) | Density Color Map · Display Data · Population Density mode · Est Population mode |
| **Redistricting section** (Redistricting mode only) | Redistricting Rule · Select Council · Council stats panel · Current ward · Wards list |
| Measure | `📏 Measure Dist` — toggles distance measurement tool |

**`countySelect` / `polygonSelect`** are hidden `<select>` elements kept for `UIController` internal state (canvas click → both hidden selects sync → `display.html` polls and mirrors them into its own visible dropdowns).

**App mode system (`window.AppMode`)**
- Modes: `'polygon'` | `'population'` | `'districtType'` | `'redistricting'`
- `AppMode.set(mode)` shows/hides `#toolbarPolygonSection`, `#toolbarLayerSection`, `#toolbarRedistrictingSection`, `#changeDensityBtn`, the CSV status label, and the Layer+County/Sub-County/Edit/View buttons; highlights the active FAB menu button
- `AppMode.initDefault()` activates `'polygon'` mode after CSV load

**Redistricting mode** — fourth app mode, accessed via the FAB menu:
- Hides the Layer section, CSV status label, Edit/View/County/Sub-County buttons, and all colour-map controls
- Renders all polygons without colour fill (plain outlines) plus a **bold black county boundary overlay**; only polygons in the selected district are visible
- `#toolbarRedistrictingSection` appears, containing:
  - **Redistricting Rule** button — opens a modal to set per-tier population quotas (4 tiers: ≤400k, ≤650k, ≤1M, >1M); rules stored in `window.redistrictingRules`
  - **Select Council** dropdown — populated from unique `District` values in the CSV; filters the canvas to the chosen district
  - **Council stats panel** (collapsible, closed by default) — shows Total Population, Allocated Seat, Quota, Boundary (±20%), Extra Seat checkbox; header always shows council name + Created/Remaining counts; quota cached in `window._currentCouncilQuota` and `window._currentCouncilSeats`
  - **Current ward panel** — Create/Cancel/Confirm buttons in the header, colour picker below; stats show Draft electorate and Variance with ✅ tick when within ±20%
  - **Wards list** (scrollable, max 220 px) — shows each saved ward's colour swatch, name, population, and variance in green/red with ✅ tick when within ±20%; collapsible Edit/Delete row per ward

**Ward management (`window.WardManager` IIFE)**
- `savedWards[]` — each entry: `{ name, district, color, polygonIds, population }`; `district` scopes wards per council so "Ward 1" in council A and "Ward 1" in council B are independent
- `createMode` flag — when active, canvas clicks toggle polygons into the draft; C key confirms; clicking outside create mode selects/highlights a saved ward row
- `selectedWardIdx` — index of the highlighted ward row; C key opens edit mode for it; clicking a ward-assigned polygon also selects its ward
- `colorIndex` — rotates through `WARD_COLORS` (10 colours) on each new ward; manual picker syncs `colorIndex`
- `openCreateMode()` / `closeCreateMode()` — show/hide colour picker and Cancel/Confirm buttons
- `editWard(idx)` — restores draft from saved ward; name is preserved on confirm
- `deleteWard(idx)` — clears `districtWard` on affected polygons
- `loadFromPolygons(polygons)` — on CSV reload, scans `districtWard` column and rebuilds `savedWards`, assigning colours by per-district rotation; called automatically after each CSV load
- `getQuota()` — returns `window._currentCouncilQuota` if set; otherwise computes quota directly from current district's polygon data (self-sufficient fallback so variance never gets stuck at −100%)
- `renderWardsList()` — filters to current `districtFilter`; exposed as `window.WardManager.renderWardsList()`
- `activateCKey()` — called by C key in redistricting mode: edits selected ward if one is highlighted, else opens create mode
- `selectWardByPolygon(polygonId)` — finds the saved ward containing this polygon ID and sets `selectedWardIdx`

**CSV columns used by redistricting**
- `District` — council/district name; populates the Select Council dropdown
- `District_Ward` — ward name assigned to the polygon; written on ward confirm, cleared on delete, persisted in CSV export

**Backend URL auto-detection**
- `localhost` / `127.0.0.1` → `http://localhost:8000`
- Any other host → `https://testing-josh.onrender.com`

**Script load order** (matters for class inheritance):
`DataManager` → `GeometryOps` → `SharedVertices` → `VertexSync` → `OverlapDetection` → `AdjacencyGraph` → `PolygonCombiner` → `PolygonSplitter` → `HistoryManager` → `LayerManager` → `VertexClassifier` → `FixedCountyVertices` → `VertexSelection` → `VertexDeletion` → `VertexReplacement` → `MidpointCreation` → `VertexSplitter` → `PolygonSimplifier` → `MeasureTool` → `UIController` → `MouseHandler` → `StreetLayer` → `Renderer` → `PolygonEditor` → `app.js`

---

### `display.html` — Popup Display Window

Opened by the `🖥️ Display` button in `index.html` (`window.open`). Polls the main window every **300 ms** and mirrors state.

**Panels:**
| Panel | Content |
|---|---|
| Select Polygon | **County** dropdown + **Polygon** dropdown (filtered by county, sorted by serial `_NNN`) |
| Polygon Information | Name, County, Area, Vertices, Neighbors list, Coordinates (collapsible) |
| Vertex Info | Selected vertex details (updated on Shift+Click) |

**Two-way sync:**
- Display→Main: county change dispatches `change` on `countySelect`; polygon change dispatches `change` on `polygonSelect` → canvas highlights selection
- Main→Display: every 300 ms `syncFromOpener()` mirrors `countySelect`, `polygonSelect`, `polygonInfo`, `sharedInfo`, `coordinates`, `vertexInfo`

---

### `js/app.js` — Application Bootstrap
- Creates the `PolygonEditor` instance on `DOMContentLoaded`
- Sets up layer toggle buttons (County / Sub-County)
- Fetches available CSV files from `/csv_files` endpoint and shows a modal picker; falls back to directory scan
- Handles Add Files (local file upload), Refresh, and Close on the CSV modal
- Calls `AppMode.initDefault()` after CSV load
- Wires: Display, Vertices Simplification, Update Neighbours, Measure Distance, Change Density, FAB mode buttons
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
- `handleMidpointCreate()` — inserts midpoint between two selected adjacent vertices
- `switchToCountyLayer()` / `switchToSubCountyLayer()` — layer switching
- `nextPolygonIds(county, count)` — generates `count` gap-filling IDs for a county in format `{County}_{NNN}`, scanning current polygons and filling lowest available numbers first
- `handleSimplification()` — removes all collinear degree-2 vertices across every polygon; saves undo snapshot first
- `handleUpdateNeighbours()` — rebuilds the adjacency graph and updates each polygon's `neighbours` field
- `toggleMeasureMode()` — activates/deactivates the Measure Distance tool; blocks `MouseHandler` while active
- `setupMeasureMouseHandlers()` — attaches independent canvas listeners for measure-mode click/drag/remove interactions; Escape exits measure mode
- `toggleStreetLayer()` — shows/hides the procedural street map overlay and redraws

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

Draws polygons, vertices, and selection highlights on the HTML5 canvas. Also draws the street layer as a background layer (below the grid and polygons) when active.

| Method | Purpose |
|---|---|
| `draw(polygons, selected, ...)` | Full canvas redraw — draws street layer, then grid, then polygons |
| `setStreetLayer(streetLayer)` | Attaches a `StreetLayer` instance to be drawn as background |
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
- **`blocked` flag** — when `true` (set by `toggleMeasureMode`), `MouseHandler` ignores all events so the measure tool can own the canvas

---

### `HistoryManager.js` — Undo/Redo

Stores deep copies of polygon state. Key methods:
- `saveToHistory(polygons, description)` — snapshot current state
- `undo(currentPolygons)` / `redo(currentPolygons)` — navigate history
- `createCheckpoint(polygons, name)` — named restore point
- `getHistoryStats()` — returns total states, current position

---

### `MeasureTool.js` — Distance Measurement

Google-Maps-style polyline distance tool. Scale: **8.01 data units = 1 km**.

| Method | Purpose |
|---|---|
| `toggle()` | Activates/deactivates tool; clears points on deactivation |
| `addPoint(x, y)` | Appends a measurement point in data coordinates |
| `movePoint(index, x, y)` | Drags an existing measurement point |
| `removePoint(index)` | Removes a point (clicking its circle) |
| `findPointAt(dataX, dataY, scale)` | Returns index of nearest point within `HIT_RADIUS_PX` (10 px) |
| `segmentDistanceM(i)` | Distance in metres for the segment ending at point `i` |
| `totalDistanceM()` | Accumulated total distance in metres |
| `formatDistance(metres)` | Human-readable string (`"3.45 km"` or `"340 m"`) |

**Interaction (handled in `PolygonEditor.setupMeasureMouseHandlers`):**
- Click empty canvas → add point
- Click circle → remove point
- Drag circle → move point
- Escape → exit measure mode

---

### `PolygonSimplifier.js` — Vertex Simplification

Removes geometrically redundant (collinear, degree-2) vertices from all polygons without changing any polygon boundary shape.

**A vertex is removable when all three conditions hold:**
1. Degree = 2 — exactly two distinct neighbours across all rings
2. Collinear — lies exactly on the edge `prev → next`
3. Every ring containing it has ≥ 4 unique vertices (removal leaves a valid polygon)

| Method | Purpose |
|---|---|
| `simplify(polygons)` | Removes all removable vertices in-place; returns `{ polygons, removedCount }` |

Triggered from the toolbar via `PolygonEditor.handleSimplification()`, which saves an undo snapshot first.

---

### `StreetLayer.js` — Procedural Street Map Overlay

Generates and renders a procedural Bristol/London-style street network as a canvas background layer. Scale: **8.01 data units = 1 km** (same as `MeasureTool`).

**Algorithm:**
- Three overlapping irregular grids at independent orientations (`ang0`, `ang0+28..50°`, `ang1+22..40°`)
- Variable block sizes (tiny / normal / large distribution)
- Hierarchical node snapping: secondary streets snap to main road nodes; local streets snap to main + secondary nodes — creates T-junctions
- Catmull-Rom splines with per-layer bend: main (0.018 km), secondary (0.038 km), local (0.060 km)
- Liang-Barsky clipping to the data bounding box
- Seeded PRNG (Mulberry32) and bilinear value noise for reproducibility

| Method | Purpose |
|---|---|
| `generate(bounds, seed)` | Generates the street network for the given data bounding box |
| `draw(ctx, geometryOps)` | Renders streets on the canvas (local → secondary → main, light to dark) |
| `toggle()` | Toggles visibility; returns new state |
| `isVisible()` | Returns current visibility |

Street widths (screen pixels): main = 2.4, secondary = 1.3, local = 0.7.

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

Builds and queries an adjacency graph from shared edges between polygons. Two polygons are adjacent if their shared boundary length exceeds `lengthTolerance = 1e-4`.

| Method | Purpose |
|---|---|
| `buildAdjacencyList(polygons)` | Scans all polygon pairs, computes shared boundary length, stores adjacencies as sorted arrays |
| `getNeighbors(id)` | Returns list of adjacent polygon IDs |
| `areAdjacent(id1, id2)` | Returns true if two polygons share an edge |
| `getAdjacencyList()` / `getStatistics()` | Inspection utilities |

Used by `PolygonEditor.handleUpdateNeighbours()` to populate each polygon's `neighbours` field.

---

### `OverlapDetection.js` — Overlap Check

After edits, checks whether any polygon now overlaps another. Distinguishes true interior overlap from shared boundary edges. Flags overlapping polygons visually.

---

### `UIController.js` — UI Wiring

Manages button states (enabled/disabled), status messages, mode labels, and polygon dropdown population. County and polygon selectors are hidden elements kept for JS compatibility; visible layer/mode buttons are handled directly in `app.js` and `PolygonEditor.js`.

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
    → StreetLayer.generate(bounds) — builds procedural street network
    → Renderer draws street layer (background) + all polygons on canvas

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

User clicks Vertices Simplification
    → HistoryManager.saveState() (pre-snapshot)
    → PolygonSimplifier.simplify(polygons) removes all collinear degree-2 vertices
    → Renderer redraws

User clicks Update Neighbours
    → AdjacencyGraph.buildAdjacencyList(polygons)
    → Each polygon's neighbours field updated in-place

User clicks Measure Dist (or presses Escape to exit)
    → MeasureTool.toggle() activates/deactivates
    → MouseHandler.blocked = true while active
    → Click: add point / click circle: remove / drag circle: move
    → measureInfo panel shows running total distance

User clicks Street Map
    → StreetLayer.toggle() flips visibility
    → Renderer redraws (street layer drawn below grid on next frame)

User clicks Export CSV
    → DataManager.exportToCSV(polygons) → triggers file download or POST /save_csv
    → District_Ward column written from polygon.districtWard for each polygon

User enters Redistricting mode → selects a Council
    → AppMode.set('redistricting') hides Layer/Edit/View controls, shows redistricting panel
    → canvas renders plain outlines + bold county boundary overlay
    → councilSelect change → PolygonEditor.districtFilter set → only district polygons visible
    → renderStats() computes Total Population, Allocated Seat, Quota, Boundary
    → window._currentCouncilQuota cached for WardManager.getQuota()

User creates a Ward
    → presses C (or clicks "Create new ward") → openCreateMode()
    → clicks polygons on canvas → WardManager.togglePolygon(id) adds/removes from draft
    → Draft electorate + Variance update live (✅ tick appears when within ±20%)
    → presses C (or clicks Create) → ward saved with name/district/color/polygonIds
    → polygon.districtWard set on each assigned polygon
    → Created/Remaining counts update in council stats header

User reloads a CSV with existing ward assignments
    → WardManager.loadFromPolygons(polygons) scans districtWard column
    → Groups by (district, districtWard), assigns colors by per-district rotation
    → savedWards rebuilt; renderWardsList() shows wards for currently selected district
```

---

## Key Constraints

- **Vertex hierarchy**: FIXED > CROSS_COUNTY > SAME_COUNTY > ORDINARY. All operations check via `VertexClassifier.isProtected()` — never directly.
- **Fixed county vertices**: Outer boundary vertices (from simplified county outline) cannot be deleted, moved, or used as midpoint/split anchors.
- **Cross-county vertices**: Vertices shared between different counties are equally protected — they may not appear in the fixed set if simplified away, but `VertexClassifier` catches them by scanning county membership.
- **Shared vertex sync**: When a SAME_COUNTY shared vertex is moved, all polygons sharing that vertex are updated simultaneously.
- **Gap absorption**: Voronoi split gaps are absorbed server-side (Python) into the adjacent district with the longest shared boundary — no gap polygons are ever emitted to the frontend.
- **Server required**: Split and Combine features require the Python server (`uvicorn`) to be running. Vertex editing, simplification, measure, and street layer work offline.
- **Input format**: CSV must have a `geometry` column (WKT `POLYGON (...)`) and a `County` column. `Shape_ID` and `Parent` columns are preserved and carried through all operations.
- **ID format**: `{County}_{NNN}` — three-digit zero-padded, gap-filled from 001 per county.
- **Keyboard guards**: Shortcuts (`Delete`, `M`, `C`, `1`, `2`, arrows) do not fire when an `<input>`, `<textarea>`, or `<select>` element is focused.
- **Scale constant**: Both `MeasureTool` and `StreetLayer` use `8.01 data units = 1 km`.
- **Redistricting C key**: In redistricting mode, `C` is intercepted before all other shortcuts. Behaviour: not in create mode + no ward selected → open create panel; not in create mode + ward selected → edit that ward; in create mode → confirm and save the ward.
- **Ward district scoping**: `savedWards` entries carry a `district` field. `renderWardsList()` and the canvas overlay both filter to the active `districtFilter`, so wards from other councils are never displayed or rendered.
- **Quota self-sufficiency**: `WardManager.getQuota()` uses `window._currentCouncilQuota` (set by `renderStats`) but falls back to computing the quota directly from the polygon data if the cached value is 0 — variance can never get stuck at −100%.
- **Ward name preservation**: On edit-confirm, the original ward name is reused (stored in `editingIndex._name`); the auto-numbered `Ward N` logic only runs for newly created wards.
- **Required CSV columns**: `County`, `Shape_ID`, `geometry`, `Population_Density`, `County_Type` (validated on load). `District` and `District_Ward` are optional but required for redistricting features.
