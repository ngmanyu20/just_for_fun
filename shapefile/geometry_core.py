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

    seed_points = random_points_in_polygon(polygon, num_districts)
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

    # --- OPTIONAL: add uncovered area ("white area") as new polygon(s) ---
    gap_geoms = []
    if include_gaps:
        covered = unary_union(cells).buffer(0) if cells else Polygon()
        missing = polygon.difference(covered).buffer(0)

        # If gap_area_tol not provided, use a tiny relative tolerance
        if gap_area_tol <= 0:
            gap_area_tol = max(1e-12, polygon.area * 1e-10)

        if not missing.is_empty and missing.area > gap_area_tol:
            gap_geoms = _explode_to_polygons(missing)

    # --- emit GeoJSON features ---
    features = []

    # districts
    for i, cell in enumerate(cells, start=1):
        features.append({
            "type": "Feature",
            "properties": {
                "subdivision_id": i,
                "kind": "district"
            },
            "geometry": mapping(cell)
        })

    # gaps
    for j, g in enumerate(gap_geoms, start=1):
        features.append({
            "type": "Feature",
            "properties": {
                "subdivision_id": len(cells) + j,
                "kind": "gap",
                "gap_id": j
            },
            "geometry": mapping(g)
        })

    return {
        "type": "FeatureCollection",
        "features": features
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

    # Use Shapely's unary_union for robust merging
    merged = unary_union(geoms).buffer(0)

    # Optional snapping to clean up tiny gaps
    if snap_tol and snap_tol > 0:
        merged = snap(merged, unary_union(geoms).boundary, snap_tol).buffer(0)

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
