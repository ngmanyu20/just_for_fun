"""
SVG Street Polygonizer v2
=========================
Improvements over v1:
  A. Pre-processing: simplify & deduplicate LineStrings before noding
     (eliminates city-roads duplicate-coordinate slivers)
  B. Post-polygonize sliver filter: remove tiny polygons by area AND
     Polsby-Popper compactness score
  C. Merge criterion changed from polygon-area to shared-boundary-length:
     merges happen across alleys/connectors first, arterials last,
     producing human-recognisable street-aligned districts

Algorithm still mirrors PostGIS: ST_Node + ST_Polygonize
"""

import xml.etree.ElementTree as ET
import re
import sys
import colorsys
import math
import heapq
import argparse
from typing import Iterator

from shapely.geometry import LineString, MultiLineString, Polygon, MultiPolygon
from shapely.ops import unary_union, polygonize
from shapely.strtree import STRtree
import svgpathtools


# ---------------------------------------------------------------------------
# SVG namespace helpers
# ---------------------------------------------------------------------------

SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)
ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")

STREET_TAGS = {
    f"{{{SVG_NS}}}path",
    f"{{{SVG_NS}}}line",
    f"{{{SVG_NS}}}polyline",
    f"{{{SVG_NS}}}polygon",
    "path", "line", "polyline", "polygon",
}


# ---------------------------------------------------------------------------
# Path / element → list of (x, y) points
# ---------------------------------------------------------------------------

CURVE_STEPS = 20

_CURVE_CMD_RE = re.compile(r"[CcSsQqTtAa]")
_NUM_RE = re.compile(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")


def _parse_ml_path(d: str) -> list[list[tuple[float, float]]]:
    """Fast parser for paths that contain only M/m/L/l/Z/z commands."""
    polylines: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    cx = cy = 0.0

    i = 0
    cmd = "M"
    while i < len(d):
        ch = d[i]
        if ch.isalpha():
            cmd = ch
            i += 1
            continue
        if ch in " ,\t\n\r":
            i += 1
            continue
        if ch in "Zz":
            if len(current) >= 2:
                polylines.append(current)
            current = []
            i += 1
            continue

        m1 = _NUM_RE.match(d, i)
        if not m1:
            i += 1
            continue
        x = float(m1.group())
        i = m1.end()
        while i < len(d) and d[i] in " ,\t\n\r":
            i += 1
        m2 = _NUM_RE.match(d, i)
        if not m2:
            continue
        y = float(m2.group())
        i = m2.end()

        if cmd in "Mm":
            if cmd == "m":
                x += cx
                y += cy
            if len(current) >= 2:
                polylines.append(current)
            current = [(x, y)]
            cmd = "l" if cmd == "m" else "L"
        elif cmd in "Ll":
            if cmd == "l":
                x += cx
                y += cy
            if current:
                current.append((x, y))
            else:
                current = [(cx, cy), (x, y)]

        cx, cy = x, y

    if len(current) >= 2:
        polylines.append(current)
    return polylines


def _complex_to_xy(c: complex) -> tuple[float, float]:
    return (c.real, c.imag)


def _approx_segment(seg, steps: int = CURVE_STEPS) -> list[tuple[float, float]]:
    return [_complex_to_xy(seg.point(t / steps)) for t in range(steps + 1)]


def path_to_polylines(d_attr: str) -> list[list[tuple[float, float]]]:
    if _CURVE_CMD_RE.search(d_attr):
        try:
            paths = svgpathtools.parse_path(d_attr)
        except Exception:
            return []

        polylines: list[list[tuple[float, float]]] = []
        current: list[tuple[float, float]] = []

        for seg in paths:
            pts = _approx_segment(seg)
            if not current:
                current.extend(pts)
            else:
                start = _complex_to_xy(seg.start)
                if abs(current[-1][0] - start[0]) > 1e-4 or abs(current[-1][1] - start[1]) > 1e-4:
                    if len(current) >= 2:
                        polylines.append(current)
                    current = list(pts)
                else:
                    current.extend(pts[1:])

        if len(current) >= 2:
            polylines.append(current)
        return polylines

    return _parse_ml_path(d_attr)


def line_element_to_points(elem: ET.Element) -> list[tuple[float, float]]:
    try:
        x1 = float(elem.get("x1", 0))
        y1 = float(elem.get("y1", 0))
        x2 = float(elem.get("x2", 0))
        y2 = float(elem.get("y2", 0))
        return [(x1, y1), (x2, y2)]
    except (TypeError, ValueError):
        return []


def points_attr_to_list(points_str: str) -> list[tuple[float, float]]:
    nums = re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", points_str)
    coords = list(map(float, nums))
    return list(zip(coords[::2], coords[1::2]))


# ---------------------------------------------------------------------------
# Apply SVG transform matrices
# ---------------------------------------------------------------------------

def parse_transform(transform_str: str) -> list[list[float]]:
    if not transform_str:
        return [[1, 0, 0], [0, 1, 0]]

    m = re.search(r"matrix\(([^)]+)\)", transform_str)
    if m:
        vals = list(map(float, re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", m.group(1))))
        if len(vals) == 6:
            return [[vals[0], vals[2], vals[4]], [vals[1], vals[3], vals[5]]]

    m = re.search(r"translate\(([^)]+)\)", transform_str)
    if m:
        vals = list(map(float, re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", m.group(1))))
        tx, ty = (vals[0], vals[1]) if len(vals) >= 2 else (vals[0], 0)
        return [[1, 0, tx], [0, 1, ty]]

    m = re.search(r"scale\(([^)]+)\)", transform_str)
    if m:
        vals = list(map(float, re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", m.group(1))))
        sx, sy = (vals[0], vals[1]) if len(vals) >= 2 else (vals[0], vals[0])
        return [[sx, 0, 0], [0, sy, 0]]

    return [[1, 0, 0], [0, 1, 0]]


def apply_transform(pts: list[tuple[float, float]], mat: list[list[float]]) -> list[tuple[float, float]]:
    a, c, e = mat[0]
    b, d, f = mat[1]
    return [(a * x + c * y + e, b * x + d * y + f) for x, y in pts]


def build_parent_map(root: ET.Element) -> dict[ET.Element, ET.Element]:
    return {child: parent for parent in root.iter() for child in parent}


def get_element_transform(elem: ET.Element, parent_map: dict[ET.Element, ET.Element]) -> list[list[float]]:
    chain: list[list[float]] = []
    own = elem.get("transform", "")
    if own:
        chain.append(parse_transform(own))

    node = elem
    while node in parent_map:
        node = parent_map[node]
        t = node.get("transform", "")
        if t:
            chain.append(parse_transform(t))

    return chain


def compose_transforms(chain: list[list[float]]) -> list[list[float]]:
    result = [[1, 0, 0], [0, 1, 0]]
    for m in reversed(chain):
        a1, c1, e1 = result[0]
        b1, d1, f1 = result[1]
        a2, c2, e2 = m[0]
        b2, d2, f2 = m[1]
        result = [
            [a1*a2 + c1*b2, a1*c2 + c1*d2, a1*e2 + c1*f2 + e1],
            [b1*a2 + d1*b2, b1*c2 + d1*d2, b1*e2 + d1*f2 + f1],
        ]
    return result


# ---------------------------------------------------------------------------
# Collect all street line segments from SVG
# ---------------------------------------------------------------------------

# FIX A: simplification tolerance — removes near-duplicate coords from
# city-roads paths (which repeat every endpoint twice) and reduces vertex
# density from floating-point-precise OSM data.
SIMPLIFY_TOLERANCE = 0.5   # SVG user units; tune if geometry looks distorted
MIN_SEGMENT_LENGTH = 1.0   # discard micro-segments shorter than this


def _deduplicate_polyline(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Remove consecutive identical (or near-identical) points."""
    if not pts:
        return pts
    out = [pts[0]]
    for x, y in pts[1:]:
        px, py = out[-1]
        if abs(x - px) > 1e-6 or abs(y - py) > 1e-6:
            out.append((x, y))
    return out


def iter_street_elements(root: ET.Element) -> Iterator[ET.Element]:
    for elem in root.iter():
        if elem.tag in STREET_TAGS:
            yield elem


def extract_linestrings(svg_path: str) -> list[LineString]:
    tree = ET.parse(svg_path)
    root = tree.getroot()
    parent_map = build_parent_map(root)
    linestrings: list[LineString] = []

    for elem in iter_street_elements(root):
        tag = elem.tag.split("}")[-1]
        raw_polylines: list[list[tuple[float, float]]] = []

        if tag == "path":
            d = elem.get("d", "")
            if d:
                raw_polylines = path_to_polylines(d)
        elif tag == "line":
            pts = line_element_to_points(elem)
            if pts:
                raw_polylines = [pts]
        elif tag in ("polyline", "polygon"):
            pts_str = elem.get("points", "")
            if pts_str:
                pts = points_attr_to_list(pts_str)
                if tag == "polygon" and pts:
                    pts.append(pts[0])
                if pts:
                    raw_polylines = [pts]

        if raw_polylines:
            chain = get_element_transform(elem, parent_map)
            mat = compose_transforms(chain) if chain else [[1, 0, 0], [0, 1, 0]]

            for poly in raw_polylines:
                transformed = apply_transform(poly, mat)
                # FIX A: remove duplicate consecutive coords before building LineString
                transformed = _deduplicate_polyline(transformed)
                if len(transformed) < 2:
                    continue
                ls = LineString(transformed)
                if ls.length <= MIN_SEGMENT_LENGTH:
                    continue
                # FIX A: simplify to reduce vertex density and merge near-parallel micro-paths
                ls = ls.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)
                if ls.is_empty or ls.length <= MIN_SEGMENT_LENGTH:
                    continue
                linestrings.append(ls)

    return linestrings


# ---------------------------------------------------------------------------
# Polygonize
# ---------------------------------------------------------------------------

# FIX B: filter slivers after polygonize
MIN_POLYGON_AREA = 10.0          # SVG units²; removes tiny junction triangles
MIN_POLSBY_POPPER = 0.02         # 0 = needle, 1 = circle; removes sliver shapes


def polsby_popper(polygon: Polygon) -> float:
    """Isoperimetric quotient: 1 for a circle, approaches 0 for slivers."""
    if polygon.length == 0:
        return 0.0
    return 4 * math.pi * polygon.area / (polygon.length ** 2)


def build_polygons(linestrings: list[LineString]) -> list[Polygon]:
    """Node all lines at intersections, then extract all enclosed polygons."""
    if not linestrings:
        return []

    print(f"  Collected {len(linestrings)} line segments")

    merged = unary_union(linestrings)
    print("  Noding complete")

    raw = list(polygonize(merged))
    print(f"  Polygonized: {len(raw)} raw polygons")

    # FIX B: remove slivers by area and compactness
    filtered = [
        p for p in raw
        if p.area >= MIN_POLYGON_AREA and polsby_popper(p) >= MIN_POLSBY_POPPER
    ]
    print(f"  After sliver filter: {len(filtered)} polygons remain")

    return filtered


# ---------------------------------------------------------------------------
# Polygon reduction — hybrid: area-heap pop + shared-boundary-length neighbour
# ---------------------------------------------------------------------------

def reduce_polygons(
    polygons: list[Polygon],
    target_count: int = 200,
    max_area_fraction: float = 0.02,
) -> list[Polygon]:
    """Merge adjacent polygons until len(result) <= target_count.

    Hybrid strategy (FIX C):
      - Pop the smallest polygon from a min-area heap (same as v1 — stable,
        no isolated-polygon / MultiPolygon explosions).
      - Choose WHICH neighbour to merge with by shortest shared boundary first.
        Short shared edge → minor alley / connector → safe to consume.
        Long shared edge → arterial road → preserved as district boundary.

    Merge rejected only when combined area > max_area_fraction * total.
    """
    if len(polygons) <= target_count:
        return list(polygons)

    total_area = sum(p.area for p in polygons)
    max_area = total_area * max_area_fraction
    print(f"  Total area: {total_area:.1f}  max polygon area: {max_area:.1f}")

    print(f"  Building adjacency graph ({len(polygons)} polygons)...")
    polys: list[Polygon] = list(polygons)
    tree = STRtree(polys)
    adj: list[set[int]] = [set() for _ in polys]
    # shared_edge[(min(i,j), max(i,j))] = length of shared boundary
    shared_edge: dict[tuple[int, int], float] = {}

    for i, p in enumerate(polys):
        p_buf = p.buffer(0.01)
        for j in tree.query(p_buf):
            if j > i and p_buf.intersects(polys[j]):
                boundary = p.intersection(polys[j])
                # Only treat as adjacent if they share an actual edge (not just a corner point)
                if boundary.length > 0:
                    adj[i].add(j)
                    adj[j].add(i)
                    shared_edge[(i, j)] = boundary.length

    active: set[int] = set(range(len(polys)))
    # Area-based heap — same stability guarantee as v1
    heap: list[tuple[float, int]] = [(p.area, i) for i, p in enumerate(polys)]
    heapq.heapify(heap)

    print(f"  Merging {len(polys)} → {target_count} polygons...")
    consecutive_fails = 0

    def connect_isolated(active: set[int]) -> None:
        """Wire any polygon with no active neighbours to its spatially nearest peer."""
        remaining = list(active)
        geoms = [polys[i] for i in remaining]
        rtree = STRtree(geoms)
        local = {gi: li for li, gi in enumerate(remaining)}
        isolated = [gi for gi in remaining if not (adj[gi] & active)]
        if not isolated:
            return
        print(f"    Connecting {len(isolated)} isolated polygon(s) to nearest neighbour...")
        for gi in isolated:
            li = local[gi]
            nearby = rtree.query(geoms[li].buffer(1e9))
            nearby = [j for j in nearby if j != li]
            if not nearby:
                continue
            nj = min(nearby, key=lambda j: geoms[li].distance(geoms[j]))
            gj = remaining[nj]
            adj[gi].add(gj)
            adj[gj].add(gi)
            key = (min(gi, gj), max(gi, gj))
            if key not in shared_edge:
                shared_edge[key] = 0.0

    while len(active) > target_count:
        # Drain stale area-heap entries
        while heap and heap[0][1] not in active:
            heapq.heappop(heap)
        if not heap:
            break

        _, idx = heapq.heappop(heap)
        if idx not in active:
            continue

        p = polys[idx]

        # FIX C: sort neighbours by shared boundary length (shortest first)
        nb_candidates = sorted(
            (shared_edge.get((min(idx, j), max(idx, j)), float("inf")), j)
            for j in adj[idx] if j in active
        )

        merged = None
        nb_used: int | None = None
        for _, nb in nb_candidates:
            if p.area + polys[nb].area > max_area:
                continue
            candidate = unary_union([p, polys[nb]])
            # Only accept clean Polygon results — MultiPolygon means a bowtie/gap
            if isinstance(candidate, Polygon) and candidate.is_valid and not candidate.is_empty:
                merged = candidate
                nb_used = nb
                break

        if merged is None:
            heapq.heappush(heap, (p.area * 1e9, idx))
            consecutive_fails += 1
            if consecutive_fails > len(active):
                max_area *= 2
                print(f"    Stuck at {len(active)} polygons — doubling max area to {max_area:.1f}")
                connect_isolated(active)
                consecutive_fails = 0
                heap = [(polys[i].area, i) for i in active]
                heapq.heapify(heap)
            continue

        consecutive_fails = 0
        new_i = len(polys)
        polys.append(merged)
        adj.append(set())

        new_nbrs = (adj[idx] | adj[nb_used]) - {idx, nb_used}
        new_nbrs &= active
        adj[new_i] = new_nbrs
        for nb in new_nbrs:
            adj[nb].discard(idx)
            adj[nb].discard(nb_used)
            adj[nb].add(new_i)
            # Update shared boundary length for the new merged polygon
            boundary = merged.intersection(polys[nb])
            key = (min(new_i, nb), max(new_i, nb))
            shared_edge[key] = boundary.length

        active.discard(idx)
        active.discard(nb_used)
        active.add(new_i)
        heapq.heappush(heap, (merged.area, new_i))

        remaining = len(active)
        if remaining % 2000 == 0:
            print(f"    {remaining} polygons remaining...")

    print(f"  Reduced to {len(active)} polygons")
    return [polys[i] for i in active]


# ---------------------------------------------------------------------------
# Color generation
# ---------------------------------------------------------------------------

def hsl_colors(n: int, saturation: float = 0.55, lightness: float = 0.65) -> list[str]:
    colors = []
    for i in range(n):
        h = i / max(n, 1)
        r, g, b = colorsys.hls_to_rgb(h, lightness, saturation)
        colors.append(f"#{int(r*255):02x}{int(g*255):02x}{int(b*255):02x}")
    return colors


# ---------------------------------------------------------------------------
# Write output SVG
# ---------------------------------------------------------------------------

def get_svg_dimensions(root: ET.Element) -> tuple[float, float]:
    vb = root.get("viewBox", "")
    if vb:
        parts = re.findall(r"[-+]?\d*\.?\d+", vb)
        if len(parts) == 4:
            return float(parts[2]), float(parts[3])

    w = root.get("width", "800")
    h = root.get("height", "600")
    w = float(re.findall(r"[\d.]+", w)[0]) if w else 800
    h = float(re.findall(r"[\d.]+", h)[0]) if h else 600
    return w, h


def polygon_to_svg_points(polygon: Polygon) -> str:
    coords = list(polygon.exterior.coords)
    return " ".join(f"{x:.2f},{y:.2f}" for x, y in coords)


def write_output_svg(
    input_svg_path: str,
    output_svg_path: str,
    polygons: list[Polygon],
    fill_opacity: float = 1.0,
) -> None:
    with open(input_svg_path, encoding="utf-8") as f:
        original = f.read()

    svg_tag_m = re.search(r"<svg\b[^>]*>", original, re.DOTALL)
    if not svg_tag_m:
        raise ValueError("No <svg> opening tag found")
    svg_open_tag = svg_tag_m.group()

    bg_rect_m = re.search(r"<rect\b[^>]*/?>(?:</rect>)?", original, re.DOTALL)
    bg_rect = bg_rect_m.group() if bg_rect_m else ""

    colors = hsl_colors(len(polygons))

    with open(output_svg_path, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n')
        f.write(svg_open_tag + "\n")
        if bg_rect:
            f.write(bg_rect + "\n")
        f.write('<g id="street-polygons">\n')
        for i, geom in enumerate(polygons):
            if geom.is_empty or not geom.is_valid:
                continue
            color = colors[i % len(colors)]
            parts = list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]
            for part in parts:
                pts_str = polygon_to_svg_points(part)
                f.write(
                    f'<polygon points="{pts_str}" fill="{color}" fill-opacity="{fill_opacity}"/>\n'
                )
        f.write("</g>\n")
        f.write("</svg>\n")
    print(f"  Output written to: {output_svg_path}")


# ---------------------------------------------------------------------------
# String-input variant (for embedding in other tools)
# ---------------------------------------------------------------------------

def extract_linestrings_from_string(svg_content: str) -> list[LineString]:
    root = ET.fromstring(svg_content)
    parent_map = build_parent_map(root)
    linestrings: list[LineString] = []

    for elem in iter_street_elements(root):
        tag = elem.tag.split("}")[-1]
        raw_polylines: list[list[tuple[float, float]]] = []

        if tag == "path":
            d = elem.get("d", "")
            if d:
                raw_polylines = path_to_polylines(d)
        elif tag == "line":
            pts = line_element_to_points(elem)
            if pts:
                raw_polylines = [pts]
        elif tag in ("polyline", "polygon"):
            pts_str = elem.get("points", "")
            if pts_str:
                pts = points_attr_to_list(pts_str)
                if tag == "polygon" and pts:
                    pts.append(pts[0])
                if pts:
                    raw_polylines = [pts]

        if raw_polylines:
            chain = get_element_transform(elem, parent_map)
            mat = compose_transforms(chain) if chain else [[1, 0, 0], [0, 1, 0]]
            for poly in raw_polylines:
                transformed = apply_transform(poly, mat)
                transformed = _deduplicate_polyline(transformed)
                if len(transformed) < 2:
                    continue
                ls = LineString(transformed)
                if ls.length <= MIN_SEGMENT_LENGTH:
                    continue
                ls = ls.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)
                if ls.is_empty or ls.length <= MIN_SEGMENT_LENGTH:
                    continue
                linestrings.append(ls)

    return linestrings


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def polygonize_svg(input_path: str, output_path: str, size: int = 200) -> None:
    print(f"Input:  {input_path}")
    print(f"Output: {output_path}")
    print(f"Target polygon count: {size}")
    print()

    print("Step 1: Extracting street line segments...")
    lines = extract_linestrings(input_path)
    if not lines:
        print("  No street elements found. Check that the SVG has <path>, <line>, or <polyline> elements.")
        return

    print()
    print("Step 2: Noding and polygonizing...")
    polygons = build_polygons(lines)
    if not polygons:
        print("  No polygons formed. The street network may not have enough closed loops.")
        return

    print()
    print("Step 3: Reducing polygon count...")
    polygons = reduce_polygons(polygons, target_count=size)

    print()
    print("Step 4: Writing output SVG...")
    write_output_svg(input_path, output_path, polygons)

    print()
    print(f"Done. {len(polygons)} polygons written.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Convert an SVG street map into filled block polygons (v2)."
    )
    parser.add_argument("input",  help="Input SVG file")
    parser.add_argument("output", help="Output SVG file")
    parser.add_argument(
        "--size", type=int, default=200,
        help="Target number of output polygons (default: 200)",
    )
    args = parser.parse_args()
    polygonize_svg(args.input, args.output, size=args.size)
