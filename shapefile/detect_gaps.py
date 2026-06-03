"""
detect_gaps.py
--------------
Given a CSV file with a WKT 'geometry' column, detect and optionally fix gap polygons.

Gaps are areas inside the convex hull of all cells not covered by any polygon:
  - INTERIOR : fully surrounded by cells (no contact with outer boundary)
  - BOUNDARY : touches the outer edge

Usage:
    python detect_gaps.py <csv_file>
    python detect_gaps.py <csv_file> --min-area 0.5
    python detect_gaps.py <csv_file> --county NC8
    python detect_gaps.py <csv_file> --fix                  # fill gaps and overwrite
    python detect_gaps.py <csv_file> --fix --out fixed.csv  # fill gaps and save to new file
"""

import sys
import csv
import argparse
import math

from shapely import wkt
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union


# ── geometry helpers ─────────────────────────────────────────────────────────

def explode_polygons(geom):
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == 'Polygon':
        return [geom]
    if geom.geom_type == 'MultiPolygon':
        return [g for g in geom.geoms if not g.is_empty]
    out = []
    for g in getattr(geom, 'geoms', []):
        out.extend(explode_polygons(g))
    return out


# ── I/O ──────────────────────────────────────────────────────────────────────

def load_csv(csv_path, county_filter=None):
    """Return (fieldnames, raw_rows, parsed_rows).
    parsed_rows: list of (row_index, shape_id, polygon) — only valid geometries.
    raw_rows   : original dicts list, index-aligned for writing back.
    """
    raw_rows = []
    parsed = []
    with open(csv_path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames[:]
        for row in reader:
            raw_rows.append(dict(row))
            if county_filter and row.get('County', '') != county_filter:
                continue
            geom_str = row.get('geometry', '').strip()
            if not geom_str:
                continue
            try:
                geom = wkt.loads(geom_str)
                if geom.is_empty:
                    continue
                if not geom.is_valid:
                    geom = geom.buffer(0)
                shape_id = row.get('Shape_ID') or row.get('Zone', '')
                row_idx = len(raw_rows) - 1
                parsed.append((row_idx, shape_id, geom))
            except Exception as e:
                sid = row.get('Shape_ID', '?')
                print(f"  [warn] Skipping {sid}: {e}")
    return fieldnames, raw_rows, parsed


def write_csv(csv_path, fieldnames, raw_rows):
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(raw_rows)


# ── detection ────────────────────────────────────────────────────────────────

def detect_gaps(parsed_rows, min_area=0.0):
    """Return list of (type_str, gap_polygon) sorted by area descending."""
    polys = [p for _, _, p in parsed_rows]
    if not polys:
        return []

    union = unary_union(polys).buffer(0)
    hull = union.convex_hull
    hull_boundary = hull.boundary

    all_gaps = hull.difference(union).buffer(0)
    result = []
    for gap in explode_polygons(all_gaps):
        if gap.area < min_area:
            continue
        try:
            shared = gap.boundary.intersection(hull_boundary)
            touches_hull = shared.length > 1e-6
        except Exception:
            touches_hull = True
        gtype = 'BOUNDARY' if touches_hull else 'INTERIOR'
        result.append((gtype, gap))

    result.sort(key=lambda x: -x[1].area)
    return result


def bordering_cells(gap, parsed_rows, min_shared=1e-6):
    result = []
    for row_idx, shape_id, cell in parsed_rows:
        try:
            shared = gap.boundary.intersection(cell.boundary)
            L = shared.length if not shared.is_empty else 0.0
        except Exception:
            L = 0.0
        if L > min_shared:
            result.append((row_idx, shape_id, L))
    result.sort(key=lambda x: -x[2])
    return result


# ── fix ──────────────────────────────────────────────────────────────────────

def fill_gaps(parsed_rows, gaps, gap_area_tol=1e-10):
    """
    For each gap, distribute it among all bordering cells proportionally
    to their shared boundary length (Voronoi-style via shapely).
    parsed_rows is mutated in-place: (row_idx, shape_id, polygon) tuples updated.
    Returns number of gaps successfully filled.
    """
    from collections import defaultdict
    try:
        from shapely.ops import voronoi_diagram as _shp_voronoi
        from shapely.geometry import MultiPoint
        _has_voronoi = True
    except ImportError:
        _has_voronoi = False

    # Build a mutable index: row_idx → list position in parsed_rows
    idx_map = {row_idx: i for i, (row_idx, _, _) in enumerate(parsed_rows)}

    filled = 0
    for gtype, gap in gaps:
        borders = bordering_cells(gap, parsed_rows)

        if not borders:
            # No shared boundary — nearest centroid
            gc = gap.centroid
            best_i = min(range(len(parsed_rows)),
                         key=lambda i: gc.distance(parsed_rows[i][2].centroid))
            _merge_into(parsed_rows, best_i, gap)
            filled += 1
            continue

        if len(borders) == 1:
            ri, sid, _ = borders[0]
            _merge_into(parsed_rows, idx_map[ri], gap)
            filled += 1
            continue

        # Multiple borders — try Voronoi partition, fall back to winner-takes-all
        if _has_voronoi:
            SAMPLES = 8
            seeds, seed_pos = [], []
            for ri, sid, _ in borders:
                i = idx_map[ri]
                cell = parsed_rows[i][2]
                try:
                    seg = gap.boundary.intersection(cell.boundary)
                    for k in range(SAMPLES):
                        t = (k + 0.5) / SAMPLES
                        pt = seg.interpolate(t, normalized=True)
                        seeds.append((pt.x, pt.y))
                        seed_pos.append(i)
                except Exception:
                    pass

            if len(set(seed_pos)) >= 2 and len(seeds) >= 4:
                try:
                    pts_geom = MultiPoint(seeds)
                    vor_polys = _shp_voronoi(pts_geom, envelope=gap.envelope)
                    pieces = defaultdict(list)
                    for region in vor_polys.geoms:
                        piece = region.intersection(gap).buffer(0)
                        if piece.is_empty:
                            continue
                        rep = piece.representative_point()
                        best_si, best_d = None, float('inf')
                        for si, (sx, sy) in enumerate(seeds):
                            d = math.hypot(rep.x - sx, rep.y - sy)
                            if d < best_d:
                                best_d, best_si = d, si
                        if best_si is not None:
                            for p in explode_polygons(piece):
                                if p.area > gap_area_tol:
                                    pieces[seed_pos[best_si]].append(p)
                    for owner_i, ps in pieces.items():
                        gap_slice = unary_union(ps).buffer(0)
                        if not gap_slice.is_empty:
                            _merge_into(parsed_rows, owner_i, gap_slice)
                    filled += 1
                    continue
                except Exception:
                    pass

        # Fallback: winner-takes-all
        ri, sid, _ = borders[0]
        _merge_into(parsed_rows, idx_map[ri], gap)
        filled += 1

    return filled


def _merge_into(parsed_rows, i, piece):
    row_idx, shape_id, cell = parsed_rows[i]
    try:
        orig_centroid = cell.centroid
        merged = cell.union(piece).buffer(0)
        if merged.is_empty:
            return
        if merged.geom_type == 'Polygon':
            parsed_rows[i] = (row_idx, shape_id, merged)
        elif merged.geom_type == 'MultiPolygon':
            for geom in sorted(merged.geoms, key=lambda g: g.area, reverse=True):
                if geom.distance(orig_centroid) < 1e-8:
                    parsed_rows[i] = (row_idx, shape_id, geom)
                    return
            parsed_rows[i] = (row_idx, shape_id, max(merged.geoms, key=lambda g: g.area))
    except Exception:
        pass


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Detect (and optionally fix) gap polygons in a CSV.')
    parser.add_argument('csv', help='Path to the CSV file')
    parser.add_argument('--min-area', type=float, default=0.0)
    parser.add_argument('--county', default=None)
    parser.add_argument('--fix', action='store_true',
                        help='Fill detected gaps and write corrected CSV')
    parser.add_argument('--out', default=None,
                        help='Output path for fixed CSV (default: overwrite input)')
    args = parser.parse_args()

    print(f"\nLoading: {args.csv}")
    if args.county:
        print(f"  Filter: County = {args.county!r}")

    fieldnames, raw_rows, parsed = load_csv(args.csv, county_filter=args.county)
    print(f"  Loaded {len(parsed)} polygons")

    if not parsed:
        print("  No polygons found.")
        return

    polys = [p for _, _, p in parsed]
    hull_area = unary_union(polys).buffer(0).convex_hull.area
    gaps = detect_gaps(parsed, min_area=args.min_area)

    total_gap_area = sum(g.area for _, g in gaps)
    n_interior = sum(1 for t, _ in gaps if t == 'INTERIOR')
    n_boundary = sum(1 for t, _ in gaps if t == 'BOUNDARY')
    coverage_pct = 100.0 * (1.0 - total_gap_area / hull_area) if hull_area > 0 else 100.0

    print(f"\n{'='*60}")
    print(f"  Coverage (vs convex hull): {coverage_pct:.4f}%")
    print(f"  Total gap area           : {total_gap_area:.4f}")
    print(f"  Interior gaps (surrounded): {n_interior}")
    print(f"  Boundary gaps (edge)      : {n_boundary}")
    print(f"{'='*60}")

    if gaps:
        print(f"\n  {'#':<4} {'Type':<10} {'Area':>12}  {'% of hull':>10}  Centroid               Bordering cells")
        print(f"  {'-'*4} {'-'*10} {'-'*12}  {'-'*10}  {'-'*22}  {'-'*30}")
        for i, (gtype, gap) in enumerate(gaps[:20], 1):
            cx, cy = gap.centroid.x, gap.centroid.y
            pct = 100.0 * gap.area / hull_area
            borders = bordering_cells(gap, parsed)
            border_str = ', '.join(f"{sid}({L:.1f})" for _, sid, L in borders[:3])
            if len(borders) > 3:
                border_str += f" +{len(borders)-3} more"
            print(f"  {i:<4} {gtype:<10} {gap.area:>12.4f}  {pct:>9.4f}%  ({cx:.2f}, {cy:.2f})  {border_str}")
        if len(gaps) > 20:
            print(f"\n  ... and {len(gaps) - 20} more (use --min-area to filter small ones)")
    else:
        print("\n  No gaps detected.")

    if not args.fix or not gaps:
        return

    # ── Fix: fill all gaps then write corrected CSV ───────────────────────────
    print(f"\n  Filling {len(gaps)} gap(s) ...")

    # Up to 3 passes (gaps filled in pass 1 may expose new tiny gaps)
    for _pass in range(3):
        remaining = detect_gaps(parsed, min_area=args.min_area)
        if not remaining:
            break
        n_filled = fill_gaps(parsed, remaining)
        print(f"  Pass {_pass+1}: filled {n_filled}/{len(remaining)} gap(s)")

    # Verify
    gaps_after = detect_gaps(parsed, min_area=args.min_area)
    area_after = sum(g.area for _, g in gaps_after)
    cov_after = 100.0 * (1.0 - area_after / hull_area) if hull_area > 0 else 100.0
    print(f"  After fix: {len(gaps_after)} gap(s) remaining, coverage={cov_after:.4f}%")

    # Write back: update geometry column for modified rows
    for row_idx, shape_id, new_geom in parsed:
        from shapely.wkt import dumps as wkt_dumps
        raw_rows[row_idx]['geometry'] = wkt_dumps(new_geom, rounding_precision=4)

    out_path = args.out or args.csv
    write_csv(out_path, fieldnames, raw_rows)
    print(f"  Saved: {out_path}")


if __name__ == '__main__':
    main()
