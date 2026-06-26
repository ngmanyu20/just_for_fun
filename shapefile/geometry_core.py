# geometry_core.py
import numpy as np
from shapely.geometry import shape, mapping, Polygon, MultiPolygon, Point
from shapely.ops import unary_union, snap
from shapely.strtree import STRtree
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

    When the plain union produces a disconnected MultiPolygon (piece and cell
    touch only at a corner point, not along an edge), the old code discarded
    the piece — leaving a permanent gap.  Fix: expand piece by a tiny adaptive
    buffer (0.1 % of its perimeter) to convert point-contact to edge-overlap,
    then retry the union.  This fills the gap without any visible distortion.
    """
    try:
        orig_centroid = cells[idx].centroid
        merged = cells[idx].union(piece).buffer(0)
        if merged.is_empty:
            return
        if merged.geom_type == 'Polygon':
            cells[idx] = merged
            return
        # MultiPolygon — piece only touches cell at a corner.
        # Expand piece by a tiny adaptive amount to force edge overlap.
        try:
            buf_r = max(1e-9, piece.length * 1e-3)
            merged2 = cells[idx].union(piece.buffer(buf_r)).buffer(0)
            if merged2.geom_type == 'Polygon' and not merged2.is_empty:
                cells[idx] = merged2
                return
        except Exception:
            pass
        # Buffer fallback also failed: keep the sub-polygon containing orig centroid.
        for geom in sorted(merged.geoms, key=lambda g: g.area, reverse=True):
            if geom.distance(orig_centroid) < 1e-8:
                cells[idx] = geom
                return
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
    # STRtree prefilter: any cell that shares a boundary with the gap must have
    # a bbox overlapping the gap's bbox (shared points lie in both bboxes).
    # No false negatives → result is bit-exact identical to the linear scan.
    _ctree = STRtree(cells)
    border = []   # (cell_index, shared_segment, shared_length)
    for i in _ctree.query(gap):
        try:
            shared = gap.boundary.intersection(cells[i].boundary)
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


def _thin_osm_cells_anchored(cells, threshold_canvas):
    """
    Anchor-aware vertex thinning for a mesh of OSM-derived cells.

    Complexity: O(V) total, where V = sum of all ring vertex counts.
      - Snapped coordinates are pre-computed once per ring (no repeated rounding
        inside inner loops).
      - Each vertex is visited at most once in the main scan.
      - The anchor look-ahead is at most 10 steps (O(1) amortised per vertex).

    Shared-vertex consistency:
      When vertex V is removed from cell A, its snapped coordinate is added to
      the global removal_set.  Cell B (sharing that boundary) pre-marks V for
      removal before it even runs its distance checks, so later cells need
      progressively less work.  A final sweep (Phase 4) catches any vertices
      that were added to removal_set by cells processed *after* the cell that
      originally contained them.

    Junction vertices (degree >= 3, i.e. shared by 3+ cells) are never removed.
    """
    from collections import Counter

    if not cells or threshold_canvas <= 0:
        return list(cells)

    SNAP = 4  # decimal places for coordinate snapping

    def _s(c):
        return (round(c[0], SNAP), round(c[1], SNAP))

    # ── Phase 1: open rings + degree map ─────────────────────────────────────
    degree     = Counter()
    open_rings = []
    for cell in cells:
        pts = list(cell.exterior.coords)[:-1] if isinstance(cell, Polygon) else None
        open_rings.append(pts)
        if pts:
            for p in pts:
                degree[_s(p)] += 1

    # ── Phase 2: pre-compute snapped coords and anchor flags per ring ─────────
    # Done once so inner loops only do list indexing, no rounding.
    ring_snaps   = []
    ring_anchors = []
    for ring in open_rings:
        if ring is None:
            ring_snaps.append(None)
            ring_anchors.append(None)
        else:
            snaps = [_s(v) for v in ring]
            ring_snaps.append(snaps)
            ring_anchors.append([degree[s] >= 3 for s in snaps])

    # ── Phase 3: process rings in order, building removal_set ────────────────
    # removal_set grows as we process cells; later cells skip already-decided
    # vertices immediately (no distance check needed).
    min_d2      = threshold_canvas * threshold_canvas
    removal_set = set()          # snapped coords of vertices decided to remove
    all_to_rm   = []             # per-ring: set of local vertex indices to remove

    for ring, snaps, anchors in zip(open_rings, ring_snaps, ring_anchors):
        if ring is None:
            all_to_rm.append(None)
            continue

        n         = len(ring)
        to_rm     = set()

        # Pre-mark vertices already decided by earlier rings
        for vi in range(n):
            if snaps[vi] in removal_set:
                to_rm.add(vi)

        i = 0
        while i < n:
            if i in to_rm:          # skip already-removed origin candidates
                i += 1
                continue

            origin   = ring[i]
            max_look = min(10, n - i - 1)

            # Find next anchor, skipping pre-removed vertices
            anchor_j = None
            for j in range(1, max_look + 1):
                vi = i + j
                if vi in to_rm:
                    continue        # already removed — don't count as anchor
                if anchors[vi]:
                    anchor_j = j
                    break

            if anchor_j is not None:
                # Thin vertices between origin and anchor
                for j in range(1, anchor_j):
                    vi = i + j
                    if vi in to_rm:
                        continue    # already removed — skip
                    v  = ring[vi]
                    dx = v[0] - origin[0]
                    dy = v[1] - origin[1]
                    if dx * dx + dy * dy >= min_d2:
                        break       # far enough — keep this and the rest
                    to_rm.add(vi)
                    removal_set.add(snaps[vi])
                i += anchor_j       # always advance to the anchor

            else:
                # No anchor in window — thin and advance to first far vertex
                advanced = False
                for j in range(1, max_look + 1):
                    vi = i + j
                    if vi in to_rm:
                        continue    # already removed — keep scanning for far vertex
                    v  = ring[vi]
                    dx = v[0] - origin[0]
                    dy = v[1] - origin[1]
                    if dx * dx + dy * dy >= min_d2:
                        i        = vi
                        advanced = True
                        break
                    to_rm.add(vi)
                    removal_set.add(snaps[vi])
                if not advanced:
                    i += max_look + 1

        all_to_rm.append(to_rm)

    # ── Phase 4: second sweep — apply late removal_set entries ───────────────
    # Vertices added to removal_set by *later* rings must also be removed from
    # rings that were processed earlier (ensuring full shared-vertex consistency).
    for snaps, to_rm in zip(ring_snaps, all_to_rm):
        if snaps is None or to_rm is None:
            continue
        for vi, s in enumerate(snaps):
            if s in removal_set:
                to_rm.add(vi)

    # ── Phase 5: rebuild cells ───────────────────────────────────────────────
    new_cells = []
    for cell, ring, to_rm in zip(cells, open_rings, all_to_rm):
        if ring is None or to_rm is None:
            new_cells.append(cell)
            continue

        n    = len(ring)
        kept = [ring[k] for k in range(n) if k not in to_rm]

        if len(kept) < 3:
            new_cells.append(cell)  # ring collapsed — keep original
            continue

        kept.append(kept[0])        # re-close
        try:
            nc = Polygon(kept)
            if not nc.is_valid:
                nc = nc.buffer(0)
            new_cells.append(nc if (nc.is_valid and not nc.is_empty) else cell)
        except Exception:
            new_cells.append(cell)

    return new_cells


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
    simplify_spacing: float | None = 150.0,
    data_source: str = "osm",
    min_area_km2: float | None = None,
    preloaded_waterways=None,
):
    """
    Split a polygon using road-network enclosures as district boundaries.

    data_source="osm"      — download via Overpass API (global coverage)
    data_source="os_roads" — read from local OS Open Roads GeoPackage (UK only,
                             requires shapefile/os_data/oproad_gb.gpkg)

    Downloads/loads road data for the given WGS84 bounding box, uses momepy
    enclosures to create district zones, transforms projected→data coordinates,
    clips each zone against the target polygon, then runs multi-pass gap
    absorption so the entire polygon is covered without any blank gaps.

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
    from svg_polygonize.osm_district_generator import download_network, generate_enclosures  # noqa: E501

    import gc as _gc

    target_polygon = shape(geometry_geojson)
    if not isinstance(target_polygon, Polygon):
        raise ValueError("Only Polygon geometries are supported")

    if data_source == "os_roads":
        from os_roads import load_os_network
        print(f"  [UK mode] Loading OS Open Roads (tier {road_tier})")
        major, minor, tertiary, edges, waterways = load_os_network(
            north, south, east, west, road_tier,
            preloaded_waterways=preloaded_waterways,
        )
    else:
        # download_network accepts "N,S,E,W" string as bbox
        place = f"{north},{south},{east},{west}"
        major, minor, tertiary, edges, waterways = download_network(place, road_tier)

    if major.empty:
        raise ValueError("No major roads found in the specified bounding box")

    # Build the projected UTM bbox so gap-fill covers the exact requested rectangle
    raw_bbox = shapely_box(west, south, east, north)
    bbox_gdf = gpd.GeoDataFrame(geometry=[raw_bbox], crs="EPSG:4326")
    bbox_gdf = bbox_gdf.to_crs(major.crs)
    bbox_proj = shapely_box(*bbox_gdf.geometry.iloc[0].bounds)

    enc = generate_enclosures(major, minor, tertiary, edges, bbox_poly=bbox_proj, road_tier=road_tier, waterways=waterways)
    if enc.empty:
        raise ValueError("No enclosures generated from OSM data")

    # Free road data — no longer needed once enclosures are built
    del major, minor, tertiary, edges, waterways, bbox_gdf, raw_bbox
    _gc.collect()

    # Build coordinate transform: UTM → data
    # UTM northing increases northward (Y-up), same as data Y → no Y-flip
    #
    # Use the geographic bbox (N/S/E/W) projected to UTM as the transform
    # reference, NOT enc.total_bounds.  OS Roads bbox queries return entire
    # road links even when only a small part intersects the bbox (e.g. the
    # M1 motorway can push enc.total_bounds ~15 km beyond the actual area),
    # producing a false stretch ratio that maps enclosures into only a thin
    # band of the data polygon and leaves the centre empty.
    _geo_ref = gpd.GeoDataFrame(
        geometry=[shapely_box(west, south, east, north)], crs="EPSG:4326"
    ).to_crs(enc.crs)
    utm_minx, utm_miny, utm_maxx, utm_maxy = _geo_ref.geometry.iloc[0].bounds
    poly_minx, poly_miny, poly_maxx, poly_maxy = target_polygon.bounds

    sx = (poly_maxx - poly_minx) / (utm_maxx - utm_minx) if utm_maxx != utm_minx else 1.0
    sy = (poly_maxy - poly_miny) / (utm_maxy - utm_miny) if utm_maxy != utm_miny else 1.0

    # Diagnostic: log the raw per-axis scales before correction
    _data_w   = poly_maxx - poly_minx
    _data_h   = poly_maxy - poly_miny
    _utm_w_km = (utm_maxx - utm_minx) / 1000.0
    _utm_h_km = (utm_maxy - utm_miny) / 1000.0
    _raw_stretch = (sx / sy) if sy else float('inf')
    print(f"[OSM transform] data bbox: {_data_w:.3f} × {_data_h:.3f} units "
          f"({_data_w/_data_h:.3f}:1 aspect)")
    print(f"[OSM transform] UTM bbox:  {_utm_w_km:.2f} × {_utm_h_km:.2f} km "
          f"({_utm_w_km/_utm_h_km:.3f}:1 aspect)")
    print(f"[OSM transform] raw sx={sx:.5f}  sy={sy:.5f}  stretch={_raw_stretch:.3f}"
          + (f"  ← correcting to uniform scale" if abs(_raw_stretch - 1.0) > 0.02 else "  ← OK"))

    # Use a single uniform scale factor so every OSM block keeps its real-world
    # proportions regardless of whether the data polygon is conformal.
    # max(sx, sy) is chosen so the enclosures cover the full data polygon in
    # both dimensions; any overhang is clipped by target_polygon below.
    # Centre the UTM bounding box onto the data polygon centre so the clipping
    # is symmetric and gap-fill has equal work on all sides.
    s = max(sx, sy)
    _cx_utm  = (utm_minx + utm_maxx) / 2.0
    _cy_utm  = (utm_miny + utm_maxy) / 2.0
    _cx_data = (poly_minx + poly_maxx) / 2.0
    _cy_data = (poly_miny + poly_maxy) / 2.0
    xoff = _cx_data - _cx_utm * s
    yoff = _cy_data - _cy_utm * s

    # s² converts km² to data-units² accurately for this polygon's actual scale.
    _s2 = s * s * 1e6   # (data-units/m)² × 1e6 m²/km² = data-units²/km²
    # Floor: prevents near-zero threshold for very small polygons.
    # Cap: prevents threshold growing with union size (multi-polygon splits)
    # so city enclosures inside a large union are not discarded.
    # Cap = 7.58 km² reference in data units²
    _min_area_cap = 7.58 * _s2 * 0.0001
    if min_area_km2 is not None:
        min_area = min_area_km2 * _s2
        print(f"[OSM min_area] user override: {min_area_km2} km² → {min_area:.5f} data units²")
    else:
        min_area = min(max(7.58 * 0.0001, target_polygon.area * 0.0001), _min_area_cap)
    cells = []

    for geom in enc.geometry:
        try:
            transformed = affine_transform(geom, [s, 0, 0, s, xoff, yoff])
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

    # Free the enclosure GeoDataFrame — cells list holds all we need
    del enc
    _gc.collect()


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

        # Overlap metric: if sum(cell areas) > union area, cells overlap.
        # overlap_area > 0 means duplicate/overlapping polygons exist.
        sum_areas   = sum(c.area for c in cells if not c.is_empty)
        overlap_area = max(0.0, sum_areas - covered.area)

        n_empty = sum(1 for c in cells if c.is_empty or c.area < 1e-15)
        print(f"[OSM {label}] coverage={pct:.4f}%  gap={gap_area:.4e}  "
              f"overlap={overlap_area:.4e}  "
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
    _gc.collect()

    # ── Stage 3: Post-clip hole check ────────────────────────────────────────
    # Detect ALL uncovered area inside target_polygon — including gaps that touch
    # the polygon boundary, which the old hull.difference() approach missed.
    _prev_hole_area = float('inf')
    for _pass in range(10):
        _cov3 = unary_union(cells).buffer(0)
        _all_missing3 = target_polygon.difference(_cov3).buffer(0)
        pending = [g for g in _explode_to_polygons(_all_missing3) if g.area > gap_area_tol]
        if not pending:
            break
        _total_hole = sum(g.area for g in pending)
        if _total_hole >= _prev_hole_area:
            break
        _prev_hole_area = _total_hole
        print(f"[OSM Stage3] pass {_pass+1}: {len(pending)} gap(s), total area={_total_hole:.4e}")
        for gap in pending:
            _distribute_gap_voronoi(gap, cells, gap_area_tol)

    _log_coverage(cells, target_polygon, "after-Stage3")
    _gc.collect()

    # ── Stage 4: Remove nested polygons ──────────────────────────────────────
    # A cell whose area is ≥90% covered by another cell is effectively nested —
    # it contributes no unique coverage but creates a visible inner boundary.
    # Use intersection-area rather than exact contains() so floating-point gaps
    # at shared edges don't cause genuine nested cells to be missed.
    changed = True
    while changed:
        changed = False
        to_remove = set()
        _s4_tree = STRtree(cells)
        for i in range(len(cells)):
            if i in to_remove:
                continue
            for j in _s4_tree.query(cells[i]):
                if i == j or j in to_remove or i in to_remove:
                    continue
                try:
                    ix = cells[j].intersection(cells[i])
                    if ix.area >= cells[i].area * 0.9:
                        # cells[i] is nested inside cells[j]: absorb it
                        _safe_merge(cells, j, cells[i])
                        to_remove.add(i)
                        changed = True
                        break
                except Exception:
                    pass
        if to_remove:
            cells = [c for k, c in enumerate(cells) if k not in to_remove]

    print(f"[OSM Stage4] nested polygons removed and absorbed: {len(cells)} cells remaining")
    _gc.collect()

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
    # Use target_polygon as reference so boundary-touching gaps are detected.
    # Convergence check: stop as soon as total gap area stops decreasing.
    # Residual micro-gaps (floating-point artifacts) that survive Voronoi are
    # closed with a boundary-snap on the nearest cell.
    _prev_gap_area5 = float('inf')
    for _pass in range(5):
        _union = unary_union(cells).buffer(0)
        _all_missing = target_polygon.difference(_union).buffer(0)
        _pending = [g for g in _explode_to_polygons(_all_missing) if g.area > gap_area_tol]
        if not _pending:
            break
        _total_gap = sum(g.area for g in _pending)
        # Stop if no progress (same gaps can't be fixed by Voronoi)
        if _total_gap >= _prev_gap_area5:
            # Last resort: for each residual gap find the cell with the longest
            # shared boundary (same criterion as Voronoi stage, not centroid distance)
            # and force-union the gap into it regardless of MultiPolygon result.
            _s5_noprog_tree = STRtree(cells)
            for _gap in _pending:
                _best_i, _best_L = None, -1.0
                for _i in _s5_noprog_tree.query(_gap):
                    try:
                        _L = _gap.boundary.intersection(cells[_i].boundary).length
                    except Exception:
                        _L = 0.0
                    if _L > _best_L:
                        _best_L, _best_i = _L, _i
                if _best_i is None:  # no shared boundary — fall back to centroid
                    _gc = _gap.centroid
                    _best_i = min(range(len(cells)),
                                  key=lambda _i: _gc.distance(cells[_i].centroid))
                try:
                    _gap_buf = _gap.buffer(max(1e-9, _gap.length * 1e-3))
                    _snapped = cells[_best_i].union(_gap_buf).buffer(0)
                    if not _snapped.is_empty:
                        if _snapped.geom_type == 'Polygon':
                            cells[_best_i] = _snapped
                        elif _snapped.geom_type == 'MultiPolygon':
                            cells[_best_i] = max(_snapped.geoms, key=lambda g: g.area)
                except Exception:
                    pass
            print(f"[OSM Stage5] pass {_pass+1}: no Voronoi progress — applied boundary snap fill")
            break
        _prev_gap_area5 = _total_gap
        print(f"[OSM Stage5] pass {_pass+1}: {len(_pending)} gap(s) total={_total_gap:.4e}")
        for _gap in _pending:
            _distribute_gap_voronoi(_gap, cells, gap_area_tol)

    _log_coverage(cells, target_polygon, "after-Stage5")

    # ── Stage 6: connectivity-based floating island absorption ───────────────
    # Every legitimate district cell must be reachable from the target polygon
    # boundary through a chain of shared edges (boundary → cell A → cell B …).
    # The old Stage 6 only caught cells with ZERO neighbours. Floating CLUSTERS
    # (cells that share edges with each other but whose entire group is
    # disconnected from the boundary) were missed because each cell in the
    # cluster does have neighbours — just not boundary-touching ones.
    #
    # Algorithm: BFS from all cells that touch the target polygon boundary.
    # Any cell not reached by the BFS is a floating island (possibly part of a
    # disconnected cluster). Merge each floating cell into the nearest
    # boundary-connected (anchored) cell by centroid distance.
    # Repeat until the cell list stabilises.
    _tgt_bnd6 = target_polygon.boundary
    _iso_total = 0
    _iso_passes = 0

    while _iso_passes < 8:
        _iso_passes += 1
        n6 = len(cells)

        # ── Build edge-sharing adjacency using STRtree spatial index ─────
        # STRtree prefilter: two cells can only share a boundary if their bboxes
        # overlap. Same correctness guarantee as the O(N²) scan — no false negatives.
        _adj6 = [set() for _ in range(n6)]
        _touches_tgt = [False] * n6
        _tree6 = STRtree(cells)
        for _i in range(n6):
            try:
                if cells[_i].boundary.intersection(_tgt_bnd6).length > 1e-8:
                    _touches_tgt[_i] = True
            except Exception:
                pass
            for _j in _tree6.query(cells[_i]):
                if _j <= _i:
                    continue
                try:
                    if cells[_j].boundary.intersection(cells[_i].boundary).length > 1e-8:
                        _adj6[_i].add(_j)
                        _adj6[_j].add(_i)
                except Exception:
                    pass

        # ── BFS from boundary-touching seeds ─────────────────────────────
        from collections import deque as _deque
        _anchored = set(i for i in range(n6) if _touches_tgt[i])
        _queue6   = _deque(_anchored)
        while _queue6:
            _cur = _queue6.popleft()
            for _nb in _adj6[_cur]:
                if _nb not in _anchored:
                    _anchored.add(_nb)
                    _queue6.append(_nb)

        _floating = [i for i in range(n6) if i not in _anchored]
        if not _floating:
            break  # all cells are reachable from boundary — done

        print(f"[OSM Stage6] pass {_iso_passes}: {len(_floating)} floating cell(s) "
              f"not reachable from boundary — absorbing into nearest anchored cell")

        # Merge each floating cell into the nearest anchored cell
        _to_remove = set()
        for _fi in _floating:
            _cc = cells[_fi].centroid
            _best = min(
                (_a for _a in _anchored if _a not in _to_remove),
                key=lambda _a: _cc.distance(cells[_a].centroid),
                default=None,
            )
            if _best is not None:
                _safe_merge(cells, _best, cells[_fi])
                _to_remove.add(_fi)
                _iso_total += 1

        cells = [c for _k, c in enumerate(cells) if _k not in _to_remove]

    if _iso_total:
        print(f"[OSM Stage6] absorbed {_iso_total} floating cell(s) total, "
              f"{len(cells)} cells remaining")

    # ── Strip interior rings ──────────────────────────────────────────────────
    # Voronoi/snap gap-fill can punch interior rings into cells. We must NOT
    # strip holes that are already covered by another cell — those holes are
    # legitimate topological boundaries. Stripping them makes the cell expand
    # to fill the hole and immediately overlap the inner neighbour (the source
    # of the large overlap jump seen in the logs after this step).
    # Rule: only strip a hole if the union of ALL cells covers < 1% of that
    # hole (i.e. it is genuinely empty — no other cell sits inside it).
    _union_for_holes = unary_union(cells).buffer(0)
    _n_stripped = 0
    _n_kept = 0
    for _i in range(len(cells)):
        try:
            _ints = list(cells[_i].interiors)
            if not _ints:
                continue
            keep_rings = []
            strip_count = 0
            for _ring in _ints:
                _hole_poly = Polygon(_ring)
                # cells[_i] does not cover its own hole, so this measures
                # coverage purely from other cells.
                try:
                    _covered = _union_for_holes.intersection(_hole_poly).area
                except Exception:
                    _covered = 0.0
                if _covered > _hole_poly.area * 0.01:
                    keep_rings.append(_ring)   # another cell fills this — keep boundary
                    _n_kept += 1
                else:
                    strip_count += 1           # genuinely empty hole — fill it
            if strip_count:
                cells[_i] = Polygon(cells[_i].exterior.coords, keep_rings)
                _n_stripped += 1
        except Exception:
            pass
    print(f"[OSM strip-holes] stripped empty holes from {_n_stripped} cells, "
          f"kept {_n_kept} occupied hole boundaries")
    _log_coverage(cells, target_polygon, "after-strip-holes")

    # ── Final vertex thinning: anchor-aware (canvas coords) ──────────────────
    # Preserves junction vertices (shared by 3+ cells) and removes only
    # the cluster of over-dense vertices between consecutive junctions.
    _log_coverage(cells, target_polygon, "PRE-thinning")
    if simplify_spacing is not None:
        # s is data-units per UTM metre; simplify_spacing is in metres
        _threshold_canvas = simplify_spacing * s
        # Scale threshold down for sparse-cell results (rural / gorge areas).
        # With few large cells the base threshold removes too many vertices,
        # collapsing shared edges into straight chords that cross neighbours
        # and produce the gap+overlap explosion seen in POST-thinning logs.
        # Formula: full threshold at ≥200 cells; scale linearly to 10% at ≤10.
        _n_cells = len(cells)
        if _n_cells < 200:
            _scale = max(0.1, _n_cells / 200.0)
            _threshold_canvas *= _scale
            print(f"[OSM thinning] {_n_cells} cells → threshold scaled to "
                  f"{_threshold_canvas:.4f} (×{_scale:.2f})")
        cells = _thin_osm_cells_anchored(cells, _threshold_canvas)
    _log_coverage(cells, target_polygon, "POST-thinning")

    # ── Stage 4b: Post-thinning overlap resolution ────────────────────────────
    # Thinning processes each cell independently. Two adjacent cells share a
    # boundary segment [v1..vN]. Cell A (left→right) may keep v3; cell B
    # (right→left) may keep v5. Phase 4 of the thinning only propagates
    # *removals* — it cannot add back vertices the other cell decided to keep.
    # Result: A's and B's simplified boundaries cross each other → overlap on
    # one side of the crossing, gap on the other side.
    # Fix: for each overlapping pair, trim the smaller cell (difference from the
    # larger cell). The overlap area stays with the larger cell — no new gap.
    _4b_total = 0
    _4b_pass  = 0
    _4b_changed = True
    while _4b_changed and _4b_pass < 4:
        _4b_changed = False
        _4b_pass += 1
        _s4b_tree = STRtree(cells)
        for _i in range(len(cells)):
            for _j in _s4b_tree.query(cells[_i]):
                if _j <= _i:
                    continue
                try:
                    _ovlp = cells[_i].intersection(cells[_j]).buffer(0)
                    if _ovlp.area <= 1e-10:
                        continue
                    # Trim the smaller cell; overlap area stays with the larger
                    if cells[_i].area >= cells[_j].area:
                        _loser, _winner = _j, _i
                    else:
                        _loser, _winner = _i, _j
                    _trimmed = cells[_loser].difference(cells[_winner]).buffer(0)
                    if _trimmed.is_empty:
                        continue
                    if _trimmed.geom_type == 'Polygon':
                        cells[_loser] = _trimmed
                    elif _trimmed.geom_type == 'MultiPolygon':
                        cells[_loser] = max(_trimmed.geoms, key=lambda g: g.area)
                    else:
                        continue
                    _4b_changed = True
                    _4b_total += 1
                except Exception:
                    pass
    if _4b_total:
        print(f"[OSM Stage4b] resolved {_4b_total} thinning overlap(s) in {_4b_pass} pass(es)")
    _log_coverage(cells, target_polygon, "after-Stage4b")

    # ── Stage 7: Pre-publish gap guarantee ───────────────────────────────────
    # Runs after vertex thinning and strip-holes. Catches micro-gaps opened
    # by simplification (each cell simplified independently → shared edges
    # drift slightly) and any hole that strip-holes exposed without a
    # covering neighbour.
    #
    # NO buffer on the gap — buffering expands the gap past the true edge
    # and the union absorbs area already owned by an adjacent cell, creating
    # the visible blue overlap duplicates.  Instead: try each candidate cell
    # (ranked by shared boundary length) with a plain union; if every
    # candidate produces a MultiPolygon (true corner-only contact) fall back
    # to shapely.snap() which nudges the gap to the cell boundary without
    # expanding it outward.
    _s7_union = unary_union(cells).buffer(0)
    _s7_missing = target_polygon.difference(_s7_union).buffer(0)
    _s7_pending = [g for g in _explode_to_polygons(_s7_missing) if g.area > 1e-12]
    if _s7_pending:
        from shapely.ops import snap as _shp_snap
        print(f"[OSM Stage7] {len(_s7_pending)} residual gap(s) — force-filling before publish")
        _s7_tree = STRtree(cells)
        for _gap7 in _s7_pending:
            # Rank candidate cells by shared boundary length with this gap
            _candidates7 = []
            for _i7 in _s7_tree.query(_gap7):
                try:
                    _L7 = _gap7.boundary.intersection(cells[_i7].boundary).length
                except Exception:
                    _L7 = 0.0
                if _L7 > 0:
                    _candidates7.append((_L7, _i7))
            _candidates7.sort(reverse=True)

            # Centroid fallback if no shared boundary found at all
            if not _candidates7:
                _cp7 = _gap7.centroid
                _fallback = min(range(len(cells)), key=lambda _ii: _cp7.distance(cells[_ii].centroid))
                _candidates7 = [(0.0, _fallback)]

            _filled7 = False
            for _, _ci7 in _candidates7:
                try:
                    _merged7 = cells[_ci7].union(_gap7).buffer(0)
                    if _merged7.is_empty:
                        continue
                    if _merged7.geom_type == 'Polygon':
                        cells[_ci7] = _merged7
                        _filled7 = True
                        break
                    # MultiPolygon: corner-touch only — try snap instead of buffer
                    _snapped_gap = _shp_snap(_gap7, cells[_ci7], tolerance=1e-6)
                    _merged7s = cells[_ci7].union(_snapped_gap).buffer(0)
                    if _merged7s.geom_type == 'Polygon' and not _merged7s.is_empty:
                        cells[_ci7] = _merged7s
                        _filled7 = True
                        break
                except Exception:
                    continue

            if not _filled7 and _candidates7:
                # All candidates produce MultiPolygon — keep largest piece
                _ci7 = _candidates7[0][1]
                try:
                    _merged7 = cells[_ci7].union(_gap7).buffer(0)
                    if not _merged7.is_empty:
                        cells[_ci7] = max(_merged7.geoms, key=lambda g: g.area) \
                            if _merged7.geom_type == 'MultiPolygon' else _merged7
                except Exception:
                    pass

        _log_coverage(cells, target_polygon, "after-Stage7")

    # ── Stage 8: Final connectivity guarantee ────────────────────────────────
    # Strip-holes and thinning run AFTER Stage 6's BFS check. Thinning can
    # simplify a shared edge out of existence, severing a cell from its
    # boundary-connected neighbours. Strip-holes can expand a cell across what
    # was a shared boundary, causing its former neighbours to become
    # disconnected. Neither case is caught by any earlier stage.
    # This is an exact repeat of Stage 6's BFS, run after all post-processing.
    _tgt_bnd8 = target_polygon.boundary
    _s8_total  = 0
    _s8_passes = 0
    while _s8_passes < 5:
        _s8_passes += 1
        _n8 = len(cells)

        _adj8        = [set() for _ in range(_n8)]
        _touches8    = [False] * _n8
        _tree8 = STRtree(cells)
        for _i8 in range(_n8):
            try:
                if cells[_i8].boundary.intersection(_tgt_bnd8).length > 1e-8:
                    _touches8[_i8] = True
            except Exception:
                pass
            for _j8 in _tree8.query(cells[_i8]):
                if _j8 <= _i8:
                    continue
                try:
                    if cells[_j8].boundary.intersection(cells[_i8].boundary).length > 1e-8:
                        _adj8[_i8].add(_j8)
                        _adj8[_j8].add(_i8)
                except Exception:
                    pass

        from collections import deque as _dq8
        _anch8  = set(i for i in range(_n8) if _touches8[i])
        _q8     = _dq8(_anch8)
        while _q8:
            _c8 = _q8.popleft()
            for _nb8 in _adj8[_c8]:
                if _nb8 not in _anch8:
                    _anch8.add(_nb8)
                    _q8.append(_nb8)

        _float8 = [i for i in range(_n8) if i not in _anch8]
        if not _float8:
            break

        print(f"[OSM Stage8] pass {_s8_passes}: {len(_float8)} cell(s) disconnected "
              f"from boundary after post-processing — absorbing")
        _rm8 = set()
        for _fi8 in _float8:
            _cc8  = cells[_fi8].centroid
            _best8 = min(
                (_a8 for _a8 in _anch8 if _a8 not in _rm8),
                key=lambda _a8: _cc8.distance(cells[_a8].centroid),
                default=None,
            )
            if _best8 is not None:
                _safe_merge(cells, _best8, cells[_fi8])
                _rm8.add(_fi8)
                _s8_total += 1
        cells = [c for _k8, c in enumerate(cells) if _k8 not in _rm8]

    if _s8_total:
        print(f"[OSM Stage8] absorbed {_s8_total} post-processing floater(s), "
              f"{len(cells)} cells remaining")
        _log_coverage(cells, target_polygon, "after-Stage8")

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
    simplify_spacing: float | None = 150.0,
    data_source: str = "osm",
    polygon_configs: list | None = None,
):
    """
    Union all input polygons into connected components and run ONE OSM pipeline
    per component.  Running a separate pipeline per input polygon causes visible
    seams/gaps at shared boundaries because road enclosures are generated
    independently and don't tile perfectly.  A single pipeline over the union
    produces a seamless continuous road-network split.

    Road tier and simplify spacing apply to the whole combined area (global
    road_tier / simplify_spacing from the request).  per-polygon min_area_km2
    is ignored in favour of auto-sizing from the combined polygon area.

    Each output Feature carries:
        properties.source_index   — index of the original polygon it overlaps
                                    most (0-based), for frontend compatibility
        properties.subdivision_id — 1-based integer across all output features
        properties.kind           — 'district'
    """
    import gc as _gc
    from shapely.ops import unary_union as _unary_union

    n = len(geometries_geojson)

    # Parse input geometries
    _shapes = []
    for g in geometries_geojson:
        _s = shape(g)
        if not _s.is_valid:
            _s = _s.buffer(0)
        _shapes.append(_s if not _s.is_empty else None)

    _valid = [_s for _s in _shapes if _s is not None]
    if not _valid:
        return {"type": "FeatureCollection", "features": []}

    # Union → list of connected components (usually one Polygon for adjacent inputs)
    _combined = _unary_union(_valid)
    if not _combined.is_valid:
        _combined = _combined.buffer(0)
    _components = (list(_combined.geoms)
                   if _combined.geom_type == "MultiPolygon"
                   else [_combined])

    print(f"[OSM multi] {n} input polygon(s) → {len(_components)} connected component(s) — single pipeline each")
    print(f"[OSM multi] geo bbox: N={north} S={south} E={east} W={west}")
    print(f"[OSM multi] tier={road_tier}  simplify={simplify_spacing}m")

    # UK mode: one waterway fetch for the full bbox, reused across all components
    _cached_waterways = None
    if data_source == "os_roads":
        from os_roads import fetch_waterways as _fetch_waterways
        print(f"[OSM multi] fetching waterway barriers (once for full bbox)…")
        _cached_waterways = _fetch_waterways(north, south, east, west)
        print(f"[OSM multi] waterway done — {len(_cached_waterways)} features")

    # --- Step 1: run pipeline per connected component, collect all districts ---
    _all_districts = []
    for _ci, _comp in enumerate(_components):
        print(f"[OSM multi] component {_ci+1}/{len(_components)}: {_comp.geom_type} "
              f"area={_comp.area:.1f} data-units²")
        try:
            _result = split_polygon_by_osm(
                geometry_geojson=mapping(_comp),
                north=north, south=south, east=east, west=west,
                road_tier=road_tier,
                simplify_spacing=simplify_spacing,
                data_source=data_source,
                min_area_km2=None,
                preloaded_waterways=_cached_waterways,
            )
            for _feat in _result.get("features", []):
                try:
                    _dg = shape(_feat["geometry"])
                    if not _dg.is_empty:
                        _all_districts.append(_dg)
                except Exception:
                    pass
        except Exception as _e:
            import traceback as _tb
            print(f"[OSM multi] component {_ci+1} pipeline failed: {_e}")
            _tb.print_exc()
            # fall through — fallback handled per-source below
        _gc.collect()

    print(f"[OSM multi] {len(_all_districts)} total districts from {len(_components)} component(s)")

    # --- Step 2: clip each OSM district against each original polygon boundary ---
    # (restores the county-split rule: any district that crosses a polygon
    #  boundary is split along it, not just assigned to the "best" polygon)
    output_features = []
    for _i, _s in enumerate(_shapes):
        if _s is None:
            continue
        _min_area = _s.area * 1e-8
        _pieces = []
        for _dist in _all_districts:
            try:
                _piece = _s.intersection(_dist).buffer(0)
                if _piece.is_empty or _piece.area < _min_area:
                    continue
                for _sub in _explode_to_polygons(_piece):
                    if _sub.area >= _min_area:
                        _pieces.append(_sub)
            except Exception:
                continue

        # Fallback: OSM didn't cover this polygon — return its original shape
        if not _pieces:
            _pieces = list(_explode_to_polygons(_s)) or [_s]

        for _sub_idx, _sub in enumerate(_pieces):
            output_features.append({
                "type": "Feature",
                "properties": {
                    "source_index": _i,
                    "subdivision_id": _sub_idx + 1,
                    "kind": "district",
                },
                "geometry": mapping(_sub),
            })

    return {"type": "FeatureCollection", "features": output_features}


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
