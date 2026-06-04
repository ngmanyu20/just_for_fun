"""
Diagnose gap coverage for OSM split:
  N=51.5787, S=51.3986, E=0.0692, W=-0.2202  (London area)

Runs the pipeline step-by-step and prints coverage % after each stage
so we can see exactly where gaps appear and why they are not filled.
"""
import sys
import os
import math

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import geopandas as gpd
from shapely.geometry import shape, box as shapely_box, mapping
from shapely.affinity import affine_transform
from shapely.ops import unary_union

from geometry_core import (
    _explode_to_polygons,
    _distribute_gap_voronoi,
    _simplify_osm_cells,
)

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _root not in sys.path:
    sys.path.insert(0, _root)
from svg_polygonize.osm_district_generator import download_network, generate_enclosures


# ── target polygon: bounding box of the requested area ───────────────────────
N, S, E, W = 51.5787, 51.3986, 0.0692, -0.2202

# We use the full bbox as the "target polygon" in data space.
# After UTM transform the target IS the polygon.
# For a realistic test we keep the full bbox as both the OSM query area
# and the target polygon (same as what split_polygon_by_osm does internally).

place = f"{N},{S},{E},{W}"
print(f"Downloading OSM network for {place} ...")
major, minor, tertiary, edges = download_network(place, road_tier=1)
if major.empty:
    print("ERROR: no major roads found")
    sys.exit(1)
print(f"  Roads downloaded. CRS: {major.crs}")

# projected bbox
raw_bbox = shapely_box(W, S, E, N)
bbox_gdf = gpd.GeoDataFrame(geometry=[raw_bbox], crs="EPSG:4326")
bbox_gdf = bbox_gdf.to_crs(major.crs)
bbox_proj = shapely_box(*bbox_gdf.geometry.iloc[0].bounds)

print("Generating enclosures ...")
enc = generate_enclosures(major, minor, tertiary, edges, bbox_poly=bbox_proj, road_tier=1)
if enc.empty:
    print("ERROR: no enclosures generated")
    sys.exit(1)
print(f"  {len(enc)} enclosures generated")

# ── coordinate transform: UTM → data (unit square of bbox) ───────────────────
utm_minx, utm_miny, utm_maxx, utm_maxy = enc.total_bounds

# Target polygon in data space = the WGS84 bounding box mapped to [W,E] x [S,N]
poly_minx, poly_miny, poly_maxx, poly_maxy = W, S, E, N
target_polygon = shapely_box(poly_minx, poly_miny, poly_maxx, poly_maxy)

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
            if piece.geom_type == 'Polygon' and piece.area >= min_area:
                cells.append(piece)
    except Exception:
        continue

print(f"  {len(cells)} cells after clip")


def coverage(cells, target):
    covered = unary_union(cells).buffer(0)
    gap = target.difference(covered).buffer(0)
    pct = 100.0 * (1.0 - gap.area / target.area)
    gap_pieces = [g for g in _explode_to_polygons(gap) if g.area > target.area * 1e-10]
    return pct, gap_pieces


def gap_summary(cells, target, label):
    pct, gaps = coverage(cells, target)
    sizes = sorted([g.area for g in gaps], reverse=True)
    print(f"\n[{label}]")
    print(f"  Coverage : {pct:.4f}%")
    print(f"  Gap pieces (>{target.area*1e-10:.2e}): {len(gaps)}")
    if sizes:
        print(f"  Largest gap  : {sizes[0]:.6f}  ({100*sizes[0]/target.area:.4f}% of target)")
        print(f"  Top-5 gaps   : {[f'{s:.4e}' for s in sizes[:5]]}")
    return pct, gaps


# ── After clip ───────────────────────────────────────────────────────────────
gap_summary(cells, target_polygon, "After clip (before any processing)")

# ── Stage 1: Voronoi gap absorption ──────────────────────────────────────────
_EPSILON = 150.0 * 8.01 / 1000.0
gap_area_tol = max(1e-12, target_polygon.area * 1e-10)
MAX_PASSES = 2

for _pass in range(MAX_PASSES):
    covered = unary_union(cells).buffer(0)
    missing = target_polygon.difference(covered).buffer(0)
    pending = [g for g in _explode_to_polygons(missing) if g.area > gap_area_tol]
    if not pending:
        break
    print(f"  Stage 1 pass {_pass+1}: {len(pending)} gap(s) to fill")
    for gap in pending:
        _distribute_gap_voronoi(gap, cells, gap_area_tol)

gap_summary(cells, target_polygon, "After Stage 1 (Voronoi gap absorption)")

# ── Stage 2: Simplification ───────────────────────────────────────────────────
_count_exterior = lambda lst: sum(len(list(c.exterior.coords)) for c in lst if hasattr(c, 'exterior'))
before_v = _count_exterior(cells)
try:
    cells = _simplify_osm_cells(cells, target_polygon, _EPSILON)
    after_v = _count_exterior(cells)
    print(f"\n[Stage 2 simplify] vertices {before_v} -> {after_v}, removed {before_v - after_v}")
except Exception as e:
    print(f"\n[Stage 2 simplify] FAILED: {e}")
    import traceback; traceback.print_exc()

pct_post_simp, gaps_post_simp = gap_summary(cells, target_polygon, "After Stage 2 (simplification)")

# ── Analyse what gaps simplification opened ───────────────────────────────────
if gaps_post_simp:
    print(f"\n  Investigating {len(gaps_post_simp)} gap(s) opened by simplification ...")
    for i, gap in enumerate(gaps_post_simp[:5]):
        # How many cells border this gap?
        border_cells = []
        for j, cell in enumerate(cells):
            try:
                shared = gap.boundary.intersection(cell.boundary)
                L = shared.length if not shared.is_empty else 0.0
            except Exception:
                L = 0.0
            if L > 1e-8:
                border_cells.append((j, L))
        border_cells.sort(key=lambda x: -x[1])
        print(f"  Gap {i}: area={gap.area:.4e}  border_cells={len(border_cells)}  top_contacts={[f'{L:.4f}' for _,L in border_cells[:3]]}")

# ── Stage 3: Post-simplification gap refill (convergence loop) ───────────────
_prev_gap_area = float('inf')
for _pass in range(10):
    covered = unary_union(cells).buffer(0)
    missing = target_polygon.difference(covered).buffer(0)
    pending = [g for g in _explode_to_polygons(missing) if g.area > gap_area_tol]
    if not pending:
        break
    _total_gap = sum(g.area for g in pending)
    if _total_gap >= _prev_gap_area:
        print(f"\n  Stage 3 pass {_pass+1}: no progress (area={_total_gap:.4e} >= prev={_prev_gap_area:.4e}), stopping")
        break
    _prev_gap_area = _total_gap
    print(f"\n  Stage 3 pass {_pass+1}: {len(pending)} gap(s), total area={_total_gap:.4e}")
    for gap in pending:
        _distribute_gap_voronoi(gap, cells, gap_area_tol)

gap_summary(cells, target_polygon, "After Stage 3 (post-simplification gap refill)")

# ── Final summary ─────────────────────────────────────────────────────────────
print("\n" + "="*60)
pct_final, gaps_final = coverage(cells, target_polygon)
print(f"  FINAL coverage : {pct_final:.6f}%")
print(f"  FINAL gap count: {len(gaps_final)}")
if gaps_final:
    print(f"  Largest remaining gap: {max(g.area for g in gaps_final):.4e}")
print("="*60)
