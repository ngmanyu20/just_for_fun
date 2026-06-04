# geometry_core.py
import numpy as np
from shapely.geometry import shape, mapping, Polygon, MultiPolygon, Point
from shapely.ops import unary_union, snap
from scipy.spatial import Voronoi


# -----------------------------
# Random points inside polygon
# -----------------------------
def random_points_in_polygon(polygon: Polygon, num_points: int):
    minx, miny, maxx, maxy = polygon.bounds
    points = []
    max_iter = num_points * 400
    it = 0

    while len(points) < num_points and it < max_iter:
        it += 1
        x = minx + np.random.random() * (maxx - minx)
        y = miny + np.random.random() * (maxy - miny)
        p = Point(x, y)
        if polygon.contains(p):
            points.append(p)

    if len(points) < num_points:
        raise RuntimeError("Could not generate enough interior seed points")

    return points


# -----------------------------
# Finite Voronoi regions
# -----------------------------
def voronoi_finite_polygons_2d(vor, radius=None):
    if vor.points.shape[1] != 2:
        raise ValueError("Requires 2D input")

    new_regions = []
    new_vertices = vor.vertices.tolist()
    center = vor.points.mean(axis=0)

    if radius is None:
        radius = np.ptp(vor.points, axis=0).max() * 2

    all_ridges = {}
    for (p1, p2), (v1, v2) in zip(vor.ridge_points, vor.ridge_vertices):
        all_ridges.setdefault(p1, []).append((p2, v1, v2))
        all_ridges.setdefault(p2, []).append((p1, v1, v2))

    for p1, region_idx in enumerate(vor.point_region):
        vertices = vor.regions[region_idx]
        if all(v >= 0 for v in vertices):
            new_regions.append(vertices)
            continue

        ridges = all_ridges[p1]
        new_region = [v for v in vertices if v >= 0]

        for p2, v1, v2 in ridges:
            if v2 < 0:
                v1, v2 = v2, v1
            if v1 >= 0:
                continue

            t = vor.points[p2] - vor.points[p1]
            t /= np.linalg.norm(t)
            n = np.array([-t[1], t[0]])

            midpoint = vor.points[[p1, p2]].mean(axis=0)
            direction = np.sign(np.dot(midpoint - center, n)) * n
            far_point = vor.vertices[v2] + direction * radius

            new_region.append(len(new_vertices))
            new_vertices.append(far_point.tolist())

        vs = np.asarray([new_vertices[v] for v in new_region])
        c = vs.mean(axis=0)
        angles = np.arctan2(vs[:, 1] - c[1], vs[:, 0] - c[0])
        new_region = [v for _, v in sorted(zip(angles, new_region))]

        new_regions.append(new_region)

    return new_regions, np.asarray(new_vertices)


# -----------------------------
# Helper: explode MultiPolygon to list of Polygons
# -----------------------------
def _explode_to_polygons(geom):
    """Return list[Polygon] from Polygon/MultiPolygon; ignore empties."""
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type == "MultiPolygon":
        return [g for g in geom.geoms if not g.is_empty]
    # rare: GeometryCollection
    out = []
    try:
        for g in geom.geoms:
            out.extend(_explode_to_polygons(g))
    except Exception:
        pass
    return out


# -----------------------------
# Core splitter with gap filling
# -----------------------------
def split_polygon_geojson(
    geometry_geojson: dict,
    num_districts: int,
    seed: int = 42,
    min_cell_area: float = 0.0,
    include_gaps: bool = True,
    gap_area_tol: float = 0.0,
):
    """
    Input: GeoJSON geometry (Polygon only)
    Output: GeoJSON FeatureCollection

    New behavior:
      - If include_gaps=True, compute uncovered area of the input polygon after
        unioning returned cells; return uncovered area as additional 'gap' feature(s).
      - This eliminates white areas by creating gap polygons
    """
    np.random.seed(seed)

    polygon = shape(geometry_geojson)
    if not isinstance(polygon, Polygon):
        raise ValueError("Only Polygon geometries are supported")

    # Voronoi (via qhull) needs at least 3 seed points in 2D.
    # Generate extra seeds when num_districts < 3, then merge excess cells back down.
    num_seeds = max(num_districts, 3)
    seed_points = random_points_in_polygon(polygon, num_seeds)
    pts = np.array([[p.x, p.y] for p in seed_points])

    vor = Voronoi(pts)
    regions, vertices = voronoi_finite_polygons_2d(vor)

    minx, miny, maxx, maxy = polygon.bounds
    bbox = Polygon([
        (minx, miny), (minx, maxy),
        (maxx, maxy), (maxx, miny)
    ])

    # --- build clipped Voronoi cells ---
    cells = []
    for region in regions:
        cell = Polygon(vertices[region])
        cell = cell.intersection(bbox).intersection(polygon)
        if cell.is_empty:
            continue
        cell = cell.buffer(0)
        if cell.is_empty:
            continue
        # keep only polygonal
        if cell.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        # optional area filter
        if min_cell_area and cell.area <= min_cell_area:
            continue
        cells.append(cell)

    # --- Merge excess cells when num_seeds > num_districts (e.g. num_districts=2) ---
    while len(cells) > num_districts:
        # Find the pair of cells sharing the longest boundary; merge the smaller into the larger
        best_i, best_j, best_len = None, None, -1.0
        for i in range(len(cells)):
            for j in range(i + 1, len(cells)):
                try:
                    shared = cells[i].boundary.intersection(cells[j].boundary)
                    length = shared.length if not shared.is_empty else 0.0
                except Exception:
                    length = 0.0
                if length > best_len:
                    best_len, best_i, best_j = length, i, j
        if best_i is None:
            # No shared boundary found — just drop the last cell
            cells.pop()
        else:
            merged = cells[best_i].union(cells[best_j]).buffer(0)
            cells[best_i] = merged
            cells.pop(best_j)

    # --- Absorb uncovered gap areas into the district with the longest shared boundary ---
    # Runs in passes: a union that produces a MultiPolygon (gap touches cell only at a
    # corner) re-queues the disconnected smaller pieces for the next pass so no area
    # is silently discarded.
    if include_gaps and cells:
        if gap_area_tol <= 0:
            gap_area_tol = max(1e-12, polygon.area * 1e-10)

        MAX_PASSES = 5
        for _pass in range(MAX_PASSES):
            covered = unary_union(cells).buffer(0)
            missing = polygon.difference(covered).buffer(0)
            pending = [g for g in _explode_to_polygons(missing) if g.area > gap_area_tol]
            if not pending:
                break

            for gap in pending:
                best_idx = None
                best_length = -1.0
                for i, cell in enumerate(cells):
                    try:
                        shared = gap.boundary.intersection(cell.boundary)
                        length = shared.length if not shared.is_empty else 0.0
                    except Exception:
                        length = 0.0
                    if length > best_length:
                        best_length = length
                        best_idx = i
                # Fallback: no shared boundary (gap touches only at a corner) — use nearest centroid
                if best_idx is None or best_length == 0.0:
                    gap_centroid = gap.centroid
                    best_idx = min(
                        range(len(cells)),
                        key=lambda i: gap_centroid.distance(cells[i].centroid)
                    )
                merged = cells[best_idx].union(gap).buffer(0)
                if not merged.is_empty and merged.geom_type == "Polygon":
                    cells[best_idx] = merged
                elif not merged.is_empty and merged.geom_type == "MultiPolygon":
                    # Gap only touched this cell at a corner → union is disconnected.
                    # Keep the largest piece as the updated cell; the smaller pieces will
                    # be re-queued automatically in the next pass.
                    cells[best_idx] = max(merged.geoms, key=lambda g: g.area)

    # --- emit GeoJSON features (districts only — no gap features) ---
    features = []

    for i, cell in enumerate(cells, start=1):
        features.append({
            "type": "Feature",
            "properties": {
                "subdivision_id": i,
                "kind": "district"
            },
            "geometry": mapping(cell)
        })

    return {
        "type": "FeatureCollection",
        "features": features
    }


# -----------------------------
# SVG-based polygon splitter
# -----------------------------
def split_polygon_by_svg(
    geometry_geojson: dict,
    svg_content: str,
    target_count: int = 50,
    anchor_x: float = None,
    anchor_y: float = None,
    data_width: float = None,
    svg_w: float = None,
    svg_h: float = None,
    min_area_fraction: float = 0.0001,
):
    """
    Split a polygon using enclosed blocks extracted from an SVG street network.

    SVG polygons are transformed to data coordinates, clipped to the target polygon,
    and returned as GeoJSON features. Uncovered areas (where the SVG doesn't reach)
    are also returned as separate 'blank' features so no area is lost.

    Coordinate mapping (two modes):
      - If SvgLayer alignment params are supplied, uses the same transform as SvgLayer.js:
          SVG (0,0)       → data (anchor_x, anchor_y + dataHeight)   [NW corner]
          SVG (svg_w,svg_h) → data (anchor_x+data_width, anchor_y)   [SE corner]
      - Otherwise auto-fits the SVG bounding box to the polygon bounding box (with Y flip).
    """
    import os as _os, sys as _sys
    _root = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
    if _root not in _sys.path:
        _sys.path.insert(0, _root)
    from svg_polygonize.svg_street_polygonizer import (
        extract_linestrings_from_string,
        build_polygons,
        reduce_polygons,
    )

    target_polygon = shape(geometry_geojson)
    if not isinstance(target_polygon, Polygon):
        raise ValueError("Only Polygon geometries are supported")

    lines = extract_linestrings_from_string(svg_content)
    if not lines:
        raise ValueError("No street elements found in SVG")

    svg_polys = build_polygons(lines)
    if not svg_polys:
        raise ValueError("No enclosed polygons found in the SVG street network")

    svg_polys = reduce_polygons(svg_polys, target_count=target_count)

    # reduce_polygons may return MultiPolygon when isolated blocks are merged —
    # flatten everything to simple Polygons before proceeding.
    flat_svg_polys: list[Polygon] = []
    for p in svg_polys:
        flat_svg_polys.extend(_explode_to_polygons(p))

    # Build coordinate transform: SVG pixel → data coordinates
    use_alignment = all(v is not None for v in [anchor_x, anchor_y, data_width, svg_w, svg_h])

    if use_alignment:
        # Mirrors SvgLayer.js draw():
        #   tl = dataToScreen(anchorX, anchorY + dataHeight)  ← SVG top-left
        #   br = dataToScreen(anchorX + dataWidth, anchorY)   ← SVG bottom-right
        # So anchor_y is the south (minY) of the SVG in data space.
        scale = data_width / svg_w
        data_height = data_width * (svg_h / svg_w)

        def svg_to_data(x, y):
            return (anchor_x + x * scale, anchor_y + scale * (svg_h - y))
    else:
        # Auto-fit: map SVG polygon bounding box → target polygon bounding box, flipping Y
        all_coords = []
        for p in flat_svg_polys:
            all_coords.extend(p.exterior.coords)
        xs = [c[0] for c in all_coords]
        ys = [c[1] for c in all_coords]
        svg_minx, svg_maxx = min(xs), max(xs)
        svg_miny, svg_maxy = min(ys), max(ys)
        poly_minx, poly_miny, poly_maxx, poly_maxy = target_polygon.bounds
        sx = (poly_maxx - poly_minx) / (svg_maxx - svg_minx) if svg_maxx != svg_minx else 1.0
        sy = (poly_maxy - poly_miny) / (svg_maxy - svg_miny) if svg_maxy != svg_miny else 1.0

        def svg_to_data(x, y):
            # SVG Y min (top) → poly Y max (north); SVG Y max (bottom) → poly Y min (south)
            return (
                poly_minx + (x - svg_minx) * sx,
                poly_maxy - (y - svg_miny) * sy,
            )

    min_area = target_polygon.area * min_area_fraction
    clipped_pieces = []

    for svg_poly in flat_svg_polys:
        try:
            new_exterior = [svg_to_data(x, y) for x, y in svg_poly.exterior.coords]
            new_interiors = [
                [svg_to_data(x, y) for x, y in ring.coords]
                for ring in svg_poly.interiors
            ]
            transformed = Polygon(new_exterior, new_interiors)
            if not transformed.is_valid:
                transformed = transformed.buffer(0)
            if transformed.is_empty:
                continue
            clipped = transformed.intersection(target_polygon)
            if clipped.is_empty:
                continue
            clipped = clipped.buffer(0)
            for piece in _explode_to_polygons(clipped):
                if piece.area > min_area:
                    clipped_pieces.append(piece)
        except Exception:
            continue

    if not clipped_pieces:
        raise ValueError("No SVG polygons overlapped with the target polygon after coordinate transform")

    # Compute uncovered (blank) areas — kept as separate polygons, never silently dropped
    covered = unary_union(clipped_pieces).buffer(0)
    remainder = target_polygon.difference(covered).buffer(0)
    blank_min_area = target_polygon.area * 1e-6
    blank_pieces = [p for p in _explode_to_polygons(remainder) if p.area > blank_min_area]

    features = []
    for i, piece in enumerate(clipped_pieces, start=1):
        features.append({
            "type": "Feature",
            "properties": {"subdivision_id": i, "kind": "svg_block"},
            "geometry": mapping(piece),
        })
    for j, blank in enumerate(blank_pieces, start=1):
        features.append({
            "type": "Feature",
            "properties": {"subdivision_id": len(clipped_pieces) + j, "kind": "blank"},
            "geometry": mapping(blank),
        })

    return {"type": "FeatureCollection", "features": features}


# -----------------------------
# Simplify OSM split cells (shared-edge RDP + non-shared greedy)
# -----------------------------
def _simplify_osm_cells(cells, target_polygon, epsilon):
    """Simplify OSM district boundaries using a degree-based greedy rule.

    For each vertex V (index > 0 in any ring):
      - Degree >= 3  (T-junction: linked to 3+ distinct neighbours): keep
      - Fixed county vertex (on target_polygon boundary): keep
      - Degree == 2 AND Euclidean distance to previous kept vertex >= epsilon: keep
      - Otherwise: remove from ALL rings containing V simultaneously

    Shared runs (degree-2 vertices shared by exactly 2 cells) are processed in
    a canonical direction so both cells produce the identical removal decision.
    Non-shared degree-2 vertices are handled per-ring with the same distance rule.
    """
    import math as _math
    from collections import defaultdict

    _PREC = 4

    def _key(x, y):
        return (round(x, _PREC), round(y, _PREC))

    # --- Build rings (no closing duplicate) ---
    rings = []
    for cell in cells:
        cr = [[(x, y) for x, y in list(cell.exterior.coords)[:-1]]]
        for h in cell.interiors:
            cr.append([(x, y) for x, y in list(h.coords)[:-1]])
        rings.append(cr)

    # vertex_map: key → set of (ci, ri) rings containing it
    vertex_map = defaultdict(set)
    for ci, cr in enumerate(rings):
        for ri, ring in enumerate(cr):
            for pt in ring:
                vertex_map[_key(*pt)].add((ci, ri))

    # neighbor_map: key → set of adjacent vertex keys (across ALL rings)
    neighbor_map = defaultdict(set)
    for ci, cr in enumerate(rings):
        for ri, ring in enumerate(cr):
            n = len(ring)
            for i in range(n):
                k = _key(*ring[i])
                neighbor_map[k].add(_key(*ring[(i - 1) % n]))
                neighbor_map[k].add(_key(*ring[(i + 1) % n]))

    # Fixed county vertices — never removed
    fixed = set()
    for c in list(target_polygon.exterior.coords)[:-1]:
        fixed.add(_key(*c))
    for h in target_polygon.interiors:
        for c in list(h.coords)[:-1]:
            fixed.add(_key(*c))

    # Junctions: degree >= 3 → always kept (T/X road intersections)
    junctions = {k for k, nbrs in neighbor_map.items() if len(nbrs) >= 3}
    protected = junctions | fixed   # removal is forbidden

    # ── Pass 1: shared boundary runs ─────────────────────────────────────────
    # Each maximal run of non-protected vertices shared between exactly two rings
    # is scanned in a canonical direction so both rings get the same removal set.
    remove = set()
    processed_pairs = set()

    for ci, cr in enumerate(rings):
        for ri, ring in enumerate(cr):
            n = len(ring)

            neighbor_rings = set()
            for pt in ring:
                k = _key(*pt)
                if k not in protected:
                    for other in vertex_map[k]:
                        if other != (ci, ri):
                            neighbor_rings.add(other)

            for (cj, rj) in neighbor_rings:
                pair = tuple(sorted([(ci * 100000 + ri), (cj * 100000 + rj)]))
                if pair in processed_pairs:
                    continue
                processed_pairs.add(pair)

                nb_keys = {_key(*pt) for pt in rings[cj][rj]}

                def _in_run(idx):
                    k2 = _key(*ring[idx % n])
                    return k2 not in protected and k2 in nb_keys

                start = next((i for i in range(n) if not _in_run(i)), None)
                if start is None:
                    continue   # entire ring shared — skip (rare)

                i2 = 0
                while i2 < n:
                    idx = (start + i2) % n
                    if _in_run(idx):
                        run_idx = [idx]
                        j = i2 + 1
                        while j < n and _in_run((start + j) % n):
                            run_idx.append((start + j) % n)
                            j += 1

                        # Crucial guard: both rings keep >= 3 vertices after removal
                        if n - len(run_idx) < 3 or len(rings[cj][rj]) - len(run_idx) < 3:
                            i2 = j
                            continue

                        pts = [ring[ii] for ii in run_idx]

                        # Anchor points (protected vertices bounding the run)
                        prev_anc = ring[(run_idx[0] - 1) % n]
                        next_anc = ring[(run_idx[-1] + 1) % n]

                        # Canonical direction: always scan from smaller key → larger key
                        if _key(*prev_anc) > _key(*next_anc):
                            pts = list(reversed(pts))
                            scan_anchor = next_anc
                        else:
                            scan_anchor = prev_anc

                        # Greedy proximity removal from scan_anchor
                        last_kept = scan_anchor
                        for p in pts:
                            pk = _key(*p)
                            if pk in fixed:
                                last_kept = p
                            elif _math.hypot(p[0] - last_kept[0], p[1] - last_kept[1]) >= epsilon:
                                last_kept = p
                            else:
                                remove.add(pk)

                        i2 = j
                    else:
                        i2 += 1

    # ── Rebuild rings ─────────────────────────────────────────────────────────
    result = []
    for ci, cr in enumerate(rings):
        new_rings = []
        for ri, ring in enumerate(cr):
            n = len(ring)
            if n < 3:
                new_rings.append(ring + [ring[0]])
                continue

            new_ring = []
            for pt in ring:
                k = _key(*pt)
                # Vertices removed by Pass 1 (shared runs)
                if k in remove:
                    continue
                # Protected vertex — always keep
                if k in protected:
                    new_ring.append(pt)
                    continue
                # Pass 2: non-protected, non-shared vertex — proximity rule
                # (degree-2, in exactly 1 ring)
                if new_ring and len(vertex_map[k]) == 1:
                    if len(new_ring) >= 3 and _math.hypot(pt[0] - new_ring[-1][0], pt[1] - new_ring[-1][1]) < epsilon:
                        continue
                new_ring.append(pt)

            if len(new_ring) < 3:
                new_ring = list(ring)   # safety revert
            new_rings.append(new_ring + [new_ring[0]])

        try:
            ext = new_rings[0]
            holes = new_rings[1:] if len(new_rings) > 1 else []
            p = Polygon(ext, holes)
            if not p.is_valid:
                p = p.buffer(0)
            result.append(p if not p.is_empty else cells[ci])
        except Exception:
            result.append(cells[ci])

    return result


# -----------------------------
# Gap distribution helpers
# -----------------------------
def _safe_merge(cells, idx, piece):
    """Union piece into cells[idx], always keeping a simple Polygon.

    When the union is disconnected (MultiPolygon), keep the piece that contains
    the original cell's centroid so we never swap the cell body for a distant
    gap slice — which would create a floating island polygon inside another cell.
    """
    try:
        orig_centroid = cells[idx].centroid
        merged = cells[idx].union(piece).buffer(0)
        if merged.is_empty:
            return
        if merged.geom_type == 'Polygon':
            cells[idx] = merged
        elif merged.geom_type == 'MultiPolygon':
            # Keep whichever piece still contains the original cell centroid.
            for geom in sorted(merged.geoms, key=lambda g: g.area, reverse=True):
                if geom.distance(orig_centroid) < 1e-8:
                    cells[idx] = geom
                    return
            # Fallback: centroid not found in any piece — keep largest
            cells[idx] = max(merged.geoms, key=lambda g: g.area)
    except Exception:
        pass


def _distribute_gap_voronoi(gap, cells, gap_area_tol):
    """
    Partition gap G among all cells that share a boundary with it.

    For 0 border cells  → nearest-centroid fallback (isolated gap).
    For 1 border cell   → entire gap goes to that cell (no tail risk).
    For >= 2 border cells → Voronoi partition seeded from each shared segment:
        - Sample SAMPLES evenly-spaced points along every shared segment.
        - Tag each seed with its owning cell.
        - Build a Voronoi diagram via Shapely/GEOS (handles collinear seeds).
        - Clip each Voronoi region to G; assign the piece to its nearest seed owner.
        - Union all pieces for the same owner into that cell.

    Uses shapely.ops.voronoi_diagram (GEOS-backed) instead of the scipy-based
    voronoi_finite_polygons_2d because the scipy helper breaks when all shared
    segments lie on the same line (collinear seeds → zero cross-product →
    infinite rays not extended → wrong/empty regions).

    Guarantees:
        No gaps   - Voronoi is a complete partition; clipped to G it covers G exactly.
        No dupes  - Voronoi cells are disjoint; pieces added to different cells stay disjoint.
        No tails  - each cell receives only the slice of G adjacent to its own boundary.
    """
    from collections import defaultdict
    from shapely.ops import voronoi_diagram as _shp_voronoi
    from shapely.geometry import MultiPoint
    import math as _math

    MIN_SHARED = 1e-8   # minimum shared length to count as a real border
    SAMPLES = 10        # seed points sampled per shared segment

    # --- find border cells -------------------------------------------------
    border = []   # (cell_index, shared_segment, shared_length)
    for i, cell in enumerate(cells):
        try:
            shared = gap.boundary.intersection(cell.boundary)
            L = shared.length if not shared.is_empty else 0.0
        except Exception:
            L = 0.0
        if L > MIN_SHARED:
            border.append((i, shared, L))

    # --- 0 borders: isolated gap → nearest centroid ------------------------
    if not border:
        gc = gap.centroid
        idx = min(range(len(cells)), key=lambda i: gc.distance(cells[i].centroid))
        _safe_merge(cells, idx, gap)
        return

    # --- 1 border: entire gap belongs to that cell -------------------------
    if len(border) == 1:
        _safe_merge(cells, border[0][0], gap)
        return

    # --- >= 2 borders: Voronoi distribution --------------------------------
    seeds = []        # list of (x, y)
    seed_owners = []  # parallel list of cell indices

    for cell_idx, seg, _ in border:
        for k in range(SAMPLES):
            t = (k + 0.5) / SAMPLES
            try:
                pt = seg.interpolate(t, normalized=True)
                seeds.append((pt.x, pt.y))
                seed_owners.append(cell_idx)
            except Exception:
                pass

    if len(set(seed_owners)) < 2 or len(seeds) < 4:
        best = max(border, key=lambda x: x[2])[0]
        _safe_merge(cells, best, gap)
        return

    try:
        # shapely.ops.voronoi_diagram uses GEOS which handles collinear seeds correctly.
        # envelope=gap.envelope ensures all Voronoi regions cover the full gap bbox.
        pts_geom = MultiPoint(seeds)
        vor_polys = _shp_voronoi(pts_geom, envelope=gap.envelope)

        pieces = defaultdict(list)
        for region in vor_polys.geoms:
            piece = region.intersection(gap).buffer(0)
            if piece.is_empty:
                continue

            # Assign to the cell whose seed point is nearest the piece centroid.
            # This is robust: each Voronoi region is by construction around its
            # nearest seed, so the region representative point is nearest that seed.
            rep = piece.representative_point()
            best_owner, best_dist = None, float('inf')
            for si, (sx, sy) in enumerate(seeds):
                d = _math.hypot(rep.x - sx, rep.y - sy)
                if d < best_dist:
                    best_dist, best_owner = d, seed_owners[si]

            if best_owner is not None:
                for p in _explode_to_polygons(piece):
                    if p.area > gap_area_tol:
                        pieces[best_owner].append(p)

        orphans = []   # pieces that became disconnected after merge (ring-gap edge case)
        for owner, ps in pieces.items():
            gap_slice = unary_union(ps).buffer(0)
            if gap_slice.is_empty:
                continue
            merged = cells[owner].union(gap_slice).buffer(0)
            if merged.is_empty:
                continue
            if merged.geom_type == 'Polygon':
                cells[owner] = merged
            elif merged.geom_type == 'MultiPolygon':
                # The gap slice is topologically disconnected from the cell body
                # (happens for ring-shaped gaps where Voronoi assigns a far arc).
                # Keep the largest connected body as the updated cell; queue the
                # remaining pieces for re-assignment in the orphan pass below.
                sorted_geoms = sorted(merged.geoms, key=lambda g: g.area, reverse=True)
                cells[owner] = sorted_geoms[0]
                for orphan in sorted_geoms[1:]:
                    orphans.append(orphan)

        # Orphan pass: assign each disconnected piece to the nearest cell
        # by centroid distance.  One level of fallback is enough because orphans
        # are small slivers that typically border the cell they are assigned to.
        for orphan in orphans:
            oc = orphan.centroid
            best_idx = min(range(len(cells)),
                           key=lambda i: oc.distance(cells[i].centroid))
            _safe_merge(cells, best_idx, orphan)

    except Exception:
        # Voronoi failed → winner-takes-all fallback
        best = max(border, key=lambda x: x[2])[0]
        _safe_merge(cells, best, gap)


# -----------------------------
# OSM-based polygon splitter
# -----------------------------
def split_polygon_by_osm(
    geometry_geojson: dict,
    north: float,
    south: float,
    east: float,
    west: float,
    road_tier: int = 1,
):
    """
    Split a polygon using OSM-derived enclosures as district boundaries.

    Downloads OSM road data for the given WGS84 bounding box, uses momepy
    enclosures to create district zones, transforms UTM→data coordinates
    (no Y-flip: UTM northing and data Y both increase upward), clips each
    zone against the target polygon, then runs multi-pass gap absorption so
    the entire polygon is covered without any blank gaps.

    Input : GeoJSON Polygon geometry + WGS84 bounding box
    Output: GeoJSON FeatureCollection of district polygons
    """
    import os as _os, sys as _sys
    _root = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
    if _root not in _sys.path:
        _sys.path.insert(0, _root)

    import geopandas as gpd
    from shapely.geometry import box as shapely_box
    from shapely.affinity import affine_transform
    from svg_polygonize.osm_district_generator import download_network, generate_enclosures

    target_polygon = shape(geometry_geojson)
    if not isinstance(target_polygon, Polygon):
        raise ValueError("Only Polygon geometries are supported")

    # download_network accepts "N,S,E,W" string as bbox
    place = f"{north},{south},{east},{west}"
    major, minor, tertiary, edges = download_network(place, road_tier)
    if major.empty:
        raise ValueError("No major roads found in the specified bounding box")

    # Build the projected UTM bbox so gap-fill covers the exact requested rectangle
    raw_bbox = shapely_box(west, south, east, north)
    bbox_gdf = gpd.GeoDataFrame(geometry=[raw_bbox], crs="EPSG:4326")
    bbox_gdf = bbox_gdf.to_crs(major.crs)
    bbox_proj = shapely_box(*bbox_gdf.geometry.iloc[0].bounds)

    enc = generate_enclosures(major, minor, tertiary, edges, bbox_poly=bbox_proj, road_tier=road_tier)
    if enc.empty:
        raise ValueError("No enclosures generated from OSM data")

    # Build coordinate transform: UTM → data
    # UTM northing increases northward (Y-up), same as data Y → no Y-flip
    utm_minx, utm_miny, utm_maxx, utm_maxy = enc.total_bounds
    poly_minx, poly_miny, poly_maxx, poly_maxy = target_polygon.bounds

    sx = (poly_maxx - poly_minx) / (utm_maxx - utm_minx) if utm_maxx != utm_minx else 1.0
    sy = (poly_maxy - poly_miny) / (utm_maxy - utm_miny) if utm_maxy != utm_miny else 1.0
    xoff = poly_minx - utm_minx * sx
    yoff = poly_miny - utm_miny * sy

    min_area = target_polygon.area * 0.0001
    cells = []

    for geom in enc.geometry:
        try:
            transformed = affine_transform(geom, [sx, 0, 0, sy, xoff, yoff])
            if not transformed.is_valid:
                transformed = transformed.buffer(0)
            if transformed.is_empty:
                continue
            clipped = transformed.intersection(target_polygon)
            if clipped.is_empty:
                continue
            clipped = clipped.buffer(0)
            for piece in _explode_to_polygons(clipped):
                # Strict Polygon-only guard: MultiPolygon pieces are re-exploded
                # and non-polygon geometry types (lines, points from clipping) dropped.
                if piece.geom_type == 'Polygon' and piece.area >= min_area:
                    cells.append(piece)
        except Exception:
            continue

    if not cells:
        raise ValueError("No OSM enclosures overlapped with the target polygon after coordinate transform")

    _EPSILON = 150.0 * 8.01 / 1000.0
    _count_exterior = lambda lst: sum(len(list(c.exterior.coords)) for c in lst if hasattr(c, 'exterior'))

    def _log_coverage(cells, target, label):
        # Primary metric (same as before): union vs target
        covered = unary_union(cells).buffer(0)
        gap_area = target.difference(covered).buffer(0).area
        pct = 100.0 * (1.0 - gap_area / target.area) if target.area > 0 else 100.0

        # detect_gaps.py metric: find holes *inside* the union that are
        # not covered by any individual cell — these are the visible white gaps.
        # hull.difference(union) = all uncovered area inside convex hull
        # interior = pieces that do NOT touch the hull boundary
        hull = covered.convex_hull
        hull_bnd = hull.boundary
        all_missing = hull.difference(covered).buffer(0)
        n_holes, hole_area = 0, 0.0
        for _g in _explode_to_polygons(all_missing):
            if _g.area <= gap_area_tol:
                continue
            try:
                _touches = _g.boundary.intersection(hull_bnd).length > 1e-6
            except Exception:
                _touches = True
            if not _touches:          # fully surrounded → real visible hole
                n_holes += 1
                hole_area += _g.area

        n_empty = sum(1 for c in cells if c.is_empty or c.area < 1e-15)
        print(f"[OSM {label}] coverage={pct:.4f}%  gap={gap_area:.4e}  "
              f"holes={n_holes}  hole_area={hole_area:.4e}  "
              f"cells={len(cells)}  empty={n_empty}")

    gap_area_tol = max(1e-12, target_polygon.area * 1e-10)

    _log_coverage(cells, target_polygon, "after-clip")

    # ── Stage 1: Gap absorption with Voronoi distribution ────────────────────
    MAX_PASSES = 2
    for _pass in range(MAX_PASSES):
        covered = unary_union(cells).buffer(0)
        missing = target_polygon.difference(covered).buffer(0)
        pending = [g for g in _explode_to_polygons(missing) if g.area > gap_area_tol]
        if not pending:
            break
        print(f"[OSM Stage1] pass {_pass+1}: {len(pending)} gap(s), largest={max(g.area for g in pending):.4e}")
        for gap in pending:
            _distribute_gap_voronoi(gap, cells, gap_area_tol)

    _log_coverage(cells, target_polygon, "after-Stage1")

    # ── Stage 2: Simplify (150m rule) ────────────────────────────────────────
    _before = _count_exterior(cells)
    _simplify_error = None
    _after = _before
    try:
        cells = _simplify_osm_cells(cells, target_polygon, _EPSILON)
        _after = _count_exterior(cells)
        print(f"[OSM simplify] vertices before={_before} after={_after} removed={_before - _after} epsilon={_EPSILON:.4f}")
    except Exception as _e:
        import traceback as _tb
        _simplify_error = str(_e)
        print(f"[OSM simplify] FAILED — simplification skipped: {_e}")
        _tb.print_exc()

    _log_coverage(cells, target_polygon, "after-Stage2")

    # ── Stage 3: Post-simplification hole check (holes metric) ───────────────
    # Uses the same detect_gaps.py metric: interior holes in hull.difference(union)
    # NOT the coverage metric — coverage can show 100% while real visible holes
    # still exist (e.g. when overlapping cells hide a hole from unary_union).
    _prev_hole_area = float('inf')
    for _pass in range(10):
        _cov3 = unary_union(cells).buffer(0)
        _hull3 = _cov3.convex_hull
        _hull3_bnd = _hull3.boundary
        _all_missing3 = _hull3.difference(_cov3).buffer(0)
        # Only interior holes (fully surrounded — not touching hull boundary)
        pending = []
        for _g in _explode_to_polygons(_all_missing3):
            if _g.area <= gap_area_tol:
                continue
            try:
                _touches = _g.boundary.intersection(_hull3_bnd).length > 1e-6
            except Exception:
                _touches = True
            if not _touches:
                pending.append(_g)
        if not pending:
            break
        _total_hole = sum(g.area for g in pending)
        if _total_hole >= _prev_hole_area:
            break
        _prev_hole_area = _total_hole
        print(f"[OSM Stage3] pass {_pass+1}: {len(pending)} hole(s), total area={_total_hole:.4e}")
        for gap in pending:
            _distribute_gap_voronoi(gap, cells, gap_area_tol)

    _log_coverage(cells, target_polygon, "after-Stage3")

    # ── Stage 4: Remove nested polygons ──────────────────────────────────────
    # A cell entirely contained within another cell is a double-count artifact:
    # the outer cell already covers that area, so the inner cell adds nothing to
    # coverage but inflates the polygon count and confuses the renderer.
    # Fix: absorb any inner cell into its containing outer cell (merge as extension)
    # so no polygon is ever bounded entirely within another polygon.
    changed = True
    while changed:
        changed = False
        to_remove = []
        for i in range(len(cells)):
            if i in to_remove:
                continue
            for j in range(len(cells)):
                if i == j or j in to_remove:
                    continue
                try:
                    if cells[j].contains(cells[i]):
                        # cells[i] is entirely inside cells[j] — merge into cells[j]
                        merged = cells[j].union(cells[i]).buffer(0)
                        if not merged.is_empty and merged.geom_type == 'Polygon':
                            cells[j] = merged
                        to_remove.append(i)
                        changed = True
                        break
                except Exception:
                    pass
        if to_remove:
            cells = [c for k, c in enumerate(cells) if k not in to_remove]

    n_nested = sum(1 for _ in to_remove) if 'to_remove' in dir() else 0
    print(f"[OSM Stage4] nested polygons removed and absorbed: {len(cells)} cells remaining")

    # ── Pre-Stage5 validation: fix invalid cells before gap detection ─────────
    # make_valid() must run BEFORE Stage 5 so that any gaps it opens by removing
    # self-intersecting rings are immediately caught and filled by Stage 5.
    try:
        from shapely.validation import make_valid as _make_valid
        _has_make_valid = True
    except ImportError:
        _has_make_valid = False

    _n_pre_fixed = 0
    for _i in range(len(cells)):
        if cells[_i].is_valid and cells[_i].geom_type == 'Polygon':
            continue
        try:
            _fixed = _make_valid(cells[_i]) if _has_make_valid else cells[_i].buffer(0)
            if _fixed.geom_type == 'Polygon':
                cells[_i] = _fixed
            elif _fixed.geom_type == 'MultiPolygon':
                cells[_i] = max(_fixed.geoms, key=lambda g: g.area)
            else:
                _polys = [g for g in _explode_to_polygons(_fixed) if g.area >= min_area]
                if _polys:
                    cells[_i] = max(_polys, key=lambda g: g.area)
            _n_pre_fixed += 1
        except Exception:
            pass
    print(f"[OSM pre-validate] fixed {_n_pre_fixed} invalid/MultiPolygon cells")

    # ── Stage 5: Final gap detection and fill ────────────────────────────────
    # Same approach as detect_gaps.py: reference = convex_hull(union) so edge
    # gaps that drift slightly outside target_polygon are still caught.
    # Convergence check: stop as soon as total gap area stops decreasing.
    # Residual micro-gaps (floating-point artifacts) that survive Voronoi are
    # closed with a tiny outward buffer-snap on the nearest cell.
    _target_boundary = target_polygon.boundary
    _prev_gap_area5 = float('inf')
    for _pass in range(5):
        _union = unary_union(cells).buffer(0)
        _hull = _union.convex_hull
        _all_missing = _hull.difference(_union).buffer(0)
        _pending = [g for g in _explode_to_polygons(_all_missing) if g.area > gap_area_tol]
        if not _pending:
            break
        _total_gap = sum(g.area for g in _pending)
        # Stop if no progress (same gaps can't be fixed by Voronoi)
        if _total_gap >= _prev_gap_area5:
            # Last resort: for each residual gap find the cell with the longest
            # shared boundary (same criterion as Voronoi stage, not centroid distance)
            # and force-union the gap into it regardless of MultiPolygon result.
            for _gap in _pending:
                _best_i, _best_L = None, -1.0
                for _i, _cell in enumerate(cells):
                    try:
                        _L = _gap.boundary.intersection(_cell.boundary).length
                    except Exception:
                        _L = 0.0
                    if _L > _best_L:
                        _best_L, _best_i = _L, _i
                if _best_i is None:  # no shared boundary — fall back to centroid
                    _gc = _gap.centroid
                    _best_i = min(range(len(cells)),
                                  key=lambda _i: _gc.distance(cells[_i].centroid))
                try:
                    _snapped = cells[_best_i].union(_gap).buffer(0)
                    if not _snapped.is_empty:
                        if _snapped.geom_type == 'Polygon':
                            cells[_best_i] = _snapped
                        elif _snapped.geom_type == 'MultiPolygon':
                            # keep largest piece — residual is absorbed even if disconnected
                            cells[_best_i] = max(_snapped.geoms, key=lambda g: g.area)
                except Exception:
                    pass
            print(f"[OSM Stage5] pass {_pass+1}: no Voronoi progress — applied boundary snap fill")
            break
        _prev_gap_area5 = _total_gap
        _n_int = _n_bnd = 0
        for _gap in _pending:
            try:
                _touches = _gap.boundary.intersection(_target_boundary).length > 1e-6
            except Exception:
                _touches = True
            if _touches:
                _n_bnd += 1
            else:
                _n_int += 1
        print(f"[OSM Stage5] pass {_pass+1}: {len(_pending)} gap(s) "
              f"(interior={_n_int} boundary={_n_bnd}) total={_total_gap:.4e}")
        for _gap in _pending:
            _distribute_gap_voronoi(_gap, cells, gap_area_tol)

    _log_coverage(cells, target_polygon, "after-Stage5")

    # ── Strip interior rings ──────────────────────────────────────────────────
    # Gap merge operations (Voronoi, snap fill) can punch interior rings into
    # cells. These holes are covered by the union (detect_gaps reports 0 gaps)
    # but make individual cells look corrupt. Keep only the exterior ring.
    # Any area formerly in the holes is already covered by adjacent cells.
    _n_stripped = 0
    for _i in range(len(cells)):
        try:
            if list(cells[_i].interiors):
                cells[_i] = Polygon(cells[_i].exterior.coords)
                _n_stripped += 1
        except Exception:
            pass
    if _n_stripped:
        print(f"[OSM strip-holes] removed interior rings from {_n_stripped} cells")

    features = []
    for i, cell in enumerate(cells, start=1):
        features.append({
            "type": "Feature",
            "properties": {"subdivision_id": i, "kind": "district"},
            "geometry": mapping(cell),
        })

    return {
        "type": "FeatureCollection",
        "features": features,
        "simplify_stats": {
            "vertices_before": _before,
            "vertices_after": _after,
            "removed": _before - _after,
            "epsilon": round(_EPSILON, 4),
            "error": _simplify_error,
        },
    }


# -------------------------------------------------------
# Multi-polygon OSM split with boundary preservation
# -------------------------------------------------------
def split_polygons_by_osm_with_boundaries(
    geometries_geojson: list,
    north: float,
    south: float,
    east: float,
    west: float,
    road_tier: int = 1,
):
    """
    Run the OSM pipeline on the union of all input polygons, then clip each
    resulting OSM district against each original polygon boundary.

    This preserves every original boundary: OSM road enclosures provide the
    internal subdivision pattern, but pieces of each district are assigned to
    whichever original polygon they fall within.

    Each output Feature carries:
        properties.source_index  — index into geometries_geojson (0-based)
        properties.kind          — 'district'

    If no OSM district intersects a particular input polygon the original
    shape is returned as a single-piece fallback so no polygon disappears.
    """
    # Parse and repair input geometries
    original_shapes = []
    for g in geometries_geojson:
        s = shape(g)
        if not s.is_valid:
            s = s.buffer(0)
        if not s.is_empty:
            original_shapes.append(s)

    if not original_shapes:
        raise ValueError("No valid geometries provided")

    # Build the union for the OSM pipeline
    combined = unary_union(original_shapes).buffer(0)

    # Run OSM on the combined polygon
    osm_result = split_polygon_by_osm(
        geometry_geojson=mapping(combined),
        north=north,
        south=south,
        east=east,
        west=west,
        road_tier=road_tier,
    )

    if osm_result.get("type") != "FeatureCollection":
        raise ValueError("OSM pipeline did not return a FeatureCollection")

    osm_districts = [
        shape(f["geometry"])
        for f in osm_result["features"]
        if not shape(f["geometry"]).is_empty
    ]

    if not osm_districts:
        raise ValueError("OSM pipeline returned no districts")

    output_features = []
    for orig_idx, orig_shape in enumerate(original_shapes):
        min_area = orig_shape.area * 1e-8
        pieces = []

        for district in osm_districts:
            try:
                piece = orig_shape.intersection(district).buffer(0)
                if piece.is_empty or piece.area < min_area:
                    continue
                for sub in _explode_to_polygons(piece):
                    if sub.area >= min_area:
                        pieces.append(sub)
            except Exception:
                continue

        # Fallback: if OSM data didn't cover this polygon, keep original shape
        if not pieces:
            pieces = list(_explode_to_polygons(orig_shape)) or [orig_shape]

        for sub_idx, sub in enumerate(pieces):
            output_features.append({
                "type": "Feature",
                "properties": {
                    "source_index": orig_idx,
                    "subdivision_id": sub_idx + 1,
                    "kind": "district",
                },
                "geometry": mapping(sub),
            })

    return {
        "type": "FeatureCollection",
        "features": output_features,
    }


# -----------------------------
# Polygon merging with Shapely
# -----------------------------
def merge_polygons_geojson(features, snap_tol=1e-6, require_single=True):
    """
    Merge multiple GeoJSON polygon features into one polygon.

    - Order independent
    - Topology safe
    - Preserves shape and holes

    Args:
        features: List of GeoJSON Feature dicts with Polygon geometries
        snap_tol: Tolerance for snapping vertices (default 1e-6)
        require_single: If True, require result to be a single Polygon (default True)

    Returns:
        GeoJSON Feature dict with merged Polygon geometry
    """

    geoms = []
    for feat in features:
        g = shape(feat["geometry"])
        if not g.is_empty:
            geoms.append(g)

    if len(geoms) < 2:
        raise ValueError("Need at least two polygons to merge")

    # Repair each input polygon individually before unioning.
    # buffer(0) resolves self-intersecting rings and misassigned holes that would
    # cause GEOS to throw TopologyException during unary_union.
    fixed = []
    for g in geoms:
        if not g.is_valid:
            g = g.buffer(0)
        if not g.is_valid:
            try:
                from shapely.validation import make_valid
                g = make_valid(g)
            except Exception:
                pass
        if not g.is_empty:
            fixed.append(g)

    if len(fixed) < 2:
        raise ValueError("Not enough valid polygons to merge after geometry repair")

    # Use Shapely's unary_union for robust merging
    merged = unary_union(fixed).buffer(0)

    # Optional snapping to clean up tiny gaps
    if snap_tol and snap_tol > 0:
        merged = snap(merged, unary_union(fixed).boundary, snap_tol).buffer(0)

    if merged.is_empty:
        raise ValueError("Merge produced empty geometry")

    if require_single and merged.geom_type != "Polygon":
        raise ValueError(
            f"Merge produced {merged.geom_type}, not a single Polygon"
        )

    return {
        "type": "Feature",
        "properties": {
            "kind": "merged"
        },
        "geometry": mapping(merged)
    }
