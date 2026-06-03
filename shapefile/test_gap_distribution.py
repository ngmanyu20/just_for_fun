"""
Simulation: old winner-takes-all vs new Voronoi gap distribution.

Three scenarios of increasing realism:
  1. Symmetric corridor – 5 equal cells, gap borders all equally
  2. Asymmetric corridor – 2 cells with 7:3 share of the gap boundary
  3. Realistic boundary strip – irregular target polygon, 6 OSM-style inner cells
     leaving a thin irregular strip around the perimeter (closest to the real bug)

Metrics checked per scenario:
  - remaining_gap  : area of target not covered after absorption  (must be ~0)
  - overlap_area   : total pairwise cell intersection area         (must be ~0)
  - min_IQ         : worst isoperimetric quotient across all cells
                     IQ = 4π·A/P²  →  1 = circle, ~0 = thin tail
  - max_elongation : max(perimeter² / area) across cells           (lower = better)
"""

import sys
import os
import copy
import math

import numpy as np
from shapely.geometry import Polygon
from shapely.ops import unary_union

# ── import the functions under test ────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geometry_core import _distribute_gap_voronoi, _explode_to_polygons


# ── helpers ─────────────────────────────────────────────────────────────────

def isoperimetric_quotient(poly):
    """4π·A / P² — 1.0 for a circle, approaches 0 for a thin strip."""
    if poly.is_empty or poly.area == 0 or poly.length == 0:
        return 0.0
    return 4 * math.pi * poly.area / (poly.length ** 2)


def elongation(poly):
    """P² / A — a thin tail makes this very large."""
    if poly.is_empty or poly.area == 0:
        return float('inf')
    return poly.length ** 2 / poly.area


def remaining_gap(cells, target):
    covered = unary_union(cells).buffer(0)
    return target.difference(covered).buffer(0).area


def total_overlap(cells):
    total = 0.0
    for i in range(len(cells)):
        for j in range(i + 1, len(cells)):
            try:
                total += cells[i].intersection(cells[j]).area
            except Exception:
                pass
    return total


def winner_takes_all(gap, cells, gap_area_tol=1e-12):
    """Original approach: entire gap → cell with longest shared boundary."""
    best_idx, best_len = None, -1.0
    for i, cell in enumerate(cells):
        try:
            shared = gap.boundary.intersection(cell.boundary)
            L = shared.length if not shared.is_empty else 0.0
        except Exception:
            L = 0.0
        if L > best_len:
            best_len, best_idx = L, i
    if best_idx is None or best_len == 0.0:
        gc = gap.centroid
        best_idx = min(range(len(cells)), key=lambda i: gc.distance(cells[i].centroid))
    merged = cells[best_idx].union(gap).buffer(0)
    if not merged.is_empty:
        if merged.geom_type == 'Polygon':
            cells[best_idx] = merged
        elif merged.geom_type == 'MultiPolygon':
            cells[best_idx] = max(merged.geoms, key=lambda g: g.area)


def run_scenario(label, target, base_cells):
    """
    Compute all gap pieces from (target - cells), then distribute them using
    both old and new approaches.  Mirrors exactly what split_polygon_by_osm does.
    """
    tol = max(1e-12, target.area * 1e-10)
    covered0 = unary_union(base_cells).buffer(0)
    all_gaps = [g for g in _explode_to_polygons(target.difference(covered0).buffer(0))
                if g.area > tol]

    total_gap_area = sum(g.area for g in all_gaps)
    gap_pct = 100.0 * total_gap_area / target.area
    n_gaps = len(all_gaps)
    n_border = sum(
        1 for g in all_gaps
        for c in base_cells
        if g.boundary.intersection(c.boundary).length > 1e-8
    )

    # deep-copy by rebuilding polygons so both branches start from identical state
    def copy_cells(src):
        return [
            Polygon(list(c.exterior.coords),
                    [list(h.coords) for h in c.interiors])
            for c in src
        ]

    def run_passes(cells_work, gap_fn, max_passes=2):
        """Mirror the Stage-2 loop in split_polygon_by_osm exactly."""
        for _ in range(max_passes):
            covered = unary_union(cells_work).buffer(0)
            pending = [g for g in _explode_to_polygons(target.difference(covered).buffer(0))
                       if g.area > tol]
            if not pending:
                break
            for g in pending:
                gap_fn(g, cells_work, tol)

    # ── old: winner-takes-all on every gap piece ───────────────────────────
    cells_old = copy_cells(base_cells)
    run_passes(cells_old, winner_takes_all)

    iq_old    = [isoperimetric_quotient(c) for c in cells_old]
    elong_old = [elongation(c) for c in cells_old]
    gap_old   = remaining_gap(cells_old, target)
    ovlp_old  = total_overlap(cells_old)

    # ── new: Voronoi distribution on every gap piece ───────────────────────
    cells_new = copy_cells(base_cells)
    run_passes(cells_new, _distribute_gap_voronoi)

    iq_new    = [isoperimetric_quotient(c) for c in cells_new]
    elong_new = [elongation(c) for c in cells_new]
    gap_new   = remaining_gap(cells_new, target)
    ovlp_new  = total_overlap(cells_new)

    # ── report ─────────────────────────────────────────────────────────────
    WIDTH = 62
    print("=" * WIDTH)
    print(f"  {label}")
    print("=" * WIDTH)
    print(f"  Gap area : {total_gap_area:.4f}  ({gap_pct:.1f}% of target)  |  {n_gaps} gap piece(s), {n_border} border-cell contacts")
    print()
    print(f"  {'Metric':<28} {'OLD':>12}  {'NEW':>12}")
    print(f"  {'-'*28} {'-'*12}  {'-'*12}")
    print(f"  {'Remaining gap area':<28} {gap_old:>12.2e}  {gap_new:>12.2e}")
    print(f"  {'Overlap area':<28} {ovlp_old:>12.2e}  {ovlp_new:>12.2e}")
    print(f"  {'Min IQ (worst cell)':<28} {min(iq_old):>12.4f}  {min(iq_new):>12.4f}")
    print(f"  {'Max elongation (worst)':<28} {max(elong_old):>12.1f}  {max(elong_new):>12.1f}")

    iq_ratio = min(iq_new) / max(min(iq_old), 1e-9)
    elong_ratio = max(elong_old) / max(max(elong_new), 1e-9)
    print()
    print(f"  IQ improvement:         {iq_ratio:.1f}x  (higher is better)")
    print(f"  Elongation reduction:   {elong_ratio:.1f}x  (higher is better)")

    # ── assertions ─────────────────────────────────────────────────────────
    errors = []
    if gap_new > 1e-6:
        errors.append(f"remaining gap = {gap_new:.2e}  (expected < 1e-6)")
    if ovlp_new > 1e-6:
        errors.append(f"overlap area = {ovlp_new:.2e}  (expected < 1e-6)")
    if min(iq_new) <= min(iq_old):
        errors.append(f"IQ not improved: new={min(iq_new):.4f} old={min(iq_old):.4f}")
    if max(elong_new) >= max(elong_old):
        errors.append(f"elongation not reduced: new={max(elong_new):.1f} old={max(elong_old):.1f}")

    if errors:
        print()
        for e in errors:
            print(f"  FAIL: {e}")
    else:
        print()
        print("  PASS: no gap, no overlap, shape quality improved")

    return len(errors) == 0


# ── scenario builders ────────────────────────────────────────────────────────

def scenario_symmetric_corridor():
    """
    10x5 rectangle. Five 2x4 cells cover [0,10]x[1,5].
    Gap = 10x1 strip at y in [0,1] — touches all 5 cells equally (2 units each).
    Old: first cell absorbs entire strip → 10x1 tail appended to a 2x4 body.
    New: each cell gets its 2x1 slice.
    """
    target = Polygon([(0,0),(10,0),(10,5),(0,5)])
    cells  = [Polygon([(i*2,1),((i+1)*2,1),((i+1)*2,5),(i*2,5)]) for i in range(5)]
    return "Scenario 1 - Symmetric corridor gap (5 equal cells)", target, cells


def scenario_asymmetric_corridor():
    """
    10x5 rectangle. Cell A covers x in [0,7], cell B covers x in [7,10].
    Gap = 10x1 strip at y in [0,1] — A has 7 units of contact, B has 3.
    Old: A wins, absorbs all 10 units of corridor.
    New: A gets ~7 units, B gets ~3 units.
    """
    target = Polygon([(0,0),(10,0),(10,5),(0,5)])
    cell_a = Polygon([(0,1),(7,1),(7,5),(0,5)])
    cell_b = Polygon([(7,1),(10,1),(10,5),(7,5)])
    cells  = [cell_a, cell_b]
    return "Scenario 2 - Asymmetric corridor gap (7:3 contact ratio)", target, cells


def scenario_realistic_boundary_strip():
    """
    Irregular (dodecagonal) target polygon.
    Six inner cells cover a shrunk-by-0.9 version of the target, leaving
    an irregular strip (~27% of area) around the full perimeter — closest
    to the real OSM boundary-gap problem shown in the screenshot.
    Multiple gap pieces are all distributed (mirrors the real Stage-2 loop).
    """
    np.random.seed(42)
    angles = np.linspace(0, 2*np.pi, 12, endpoint=False)
    radii  = 5 + np.random.uniform(-0.3, 0.3, 12)
    pts    = [(r*np.cos(a)*2, r*np.sin(a)) for r, a in zip(radii, angles)]
    target = Polygon(pts)

    inner  = target.buffer(-0.9)
    minx, miny, maxx, maxy = inner.bounds
    n, w   = 6, (maxx - minx) / 6
    cells  = []
    for i in range(n):
        slab = Polygon([
            (minx + i*w,     miny - 2),
            (minx + (i+1)*w, miny - 2),
            (minx + (i+1)*w, maxy + 2),
            (minx + i*w,     maxy + 2),
        ])
        piece = inner.intersection(slab).buffer(0)
        for p in _explode_to_polygons(piece):
            if p.area > 0.01:
                cells.append(p)

    return "Scenario 3 - Irregular boundary strip (realistic OSM)", target, cells


# ── main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    scenarios = [
        scenario_symmetric_corridor(),
        scenario_asymmetric_corridor(),
        scenario_realistic_boundary_strip(),
    ]

    results = []
    for label, target, cells in scenarios:
        ok = run_scenario(label, target, cells)
        results.append((label, ok))

    print()
    print("=" * 62)
    print("  SUMMARY")
    print("=" * 62)
    for label, ok in results:
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}]  {label}")
    print("=" * 62)

    if not all(ok for _, ok in results):
        sys.exit(1)
