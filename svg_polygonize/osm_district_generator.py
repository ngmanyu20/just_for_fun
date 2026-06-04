"""
OSM District Generator
======================
Downloads OSM street data for a named place, uses road-type hierarchy to
define district boundaries (arterials only), then uses momepy.enclosures()
to produce clean, human-readable district polygons.

Replaces the SVG-parsing approach: no SVG input needed.
Output: an SVG file of coloured district polygons.

Usage:
    python osm_district_generator.py "Manchester City Centre, UK" output.svg
    python osm_district_generator.py "Manchester City Centre, UK" output.svg --secondary
"""

import argparse
import colorsys
import os
import sys
import time

import pandas as pd
import geopandas as gpd
import momepy
import osmnx as ox
from shapely.geometry import Polygon, MultiPolygon, GeometryCollection, box
from shapely.ops import unary_union, voronoi_diagram
from shapely.validation import make_valid

# ---------------------------------------------------------------------------
# osmnx runtime configuration
# ---------------------------------------------------------------------------
# On Render the repo filesystem is read-only; redirect the osmnx cache to /tmp
# so downloaded street networks are cached for the lifetime of the instance.
# On localhost the default cache location is used.
_IS_RENDER = bool(os.environ.get('RENDER'))
if _IS_RENDER:
    _cache_dir = '/tmp/osmnx_cache'
    os.makedirs(_cache_dir, exist_ok=True)
    ox.settings.cache_folder = _cache_dir

ox.settings.use_cache = True
ox.settings.timeout = 180  # 3-minute per-request timeout (default is 180 s in newer osmnx)


# ---------------------------------------------------------------------------
# Road hierarchy
# ---------------------------------------------------------------------------

# These roads form the OUTER BOUNDARIES of districts.
# Using only these means districts will be large, arterial-bounded zones.
PRIMARY_TYPES = {
    "motorway", "motorway_link",
    "trunk", "trunk_link",
    "primary", "primary_link",
    "secondary", "secondary_link",
}

# Tier 2: optionally subdivide within districts (road_tier >= 2).
SECONDARY_TYPES = {
    "tertiary", "tertiary_link",
}

# Tier 3: fine-grained city-block subdivision (road_tier >= 3).
TERTIARY_TYPES = {
    "unclassified", "residential",
}

# Area filters per tier (min_m2, max_m2).
# Smaller tiers produce smaller enclosures so thresholds scale down.
_AREA_LIMITS = {
    1: (10_000,   5_000_000),   # 1 ha – 5 km²  (large districts)
    2: ( 5_000,   3_000_000),   # 0.5 ha – 3 km² (subdivided zones)
    3: (   500,   1_000_000),   # 500 m² – 1 km² (city blocks)
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalise_highway(val) -> str:
    """OSM highway tag can be a list; pick the most important value."""
    if isinstance(val, list):
        for tier in ["motorway", "trunk", "primary", "secondary",
                     "tertiary", "unclassified", "residential"]:
            if tier in val:
                return tier
        return val[0]
    return val or "unclassified"


def _is_float(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


def hsl_colors(n: int, saturation: float = 0.55, lightness: float = 0.65) -> list[str]:
    out = []
    for i in range(n):
        r, g, b = colorsys.hls_to_rgb(i / max(n, 1), lightness, saturation)
        out.append(f"#{int(r*255):02x}{int(g*255):02x}{int(b*255):02x}")
    return out


# ---------------------------------------------------------------------------
# Step 1 — download
# ---------------------------------------------------------------------------

def download_network(place: str, road_tier: int = 1, max_retries: int = 3):
    """
    Download OSM road network and classify edges by tier.

    road_tier=1  — primary/secondary only (large districts)
    road_tier=2  — + tertiary (smaller zones)
    road_tier=3  — + unclassified/residential (city blocks)

    Returns (major, minor, tertiary, edges) GeoDataFrames.
    minor and tertiary are empty GeoDataFrames when not used by the chosen tier.
    """
    print(f"  Downloading OSM network for: {place!r} (tier {road_tier})")

    last_err: Exception = RuntimeError("No attempts made")
    for attempt in range(max_retries):
        try:
            if "," in place and all(_is_float(p.strip()) for p in place.split(",")):
                parts = [float(p.strip()) for p in place.split(",")]
                north, south, east, west = parts
                G = ox.graph_from_bbox(
                    bbox=(west, south, east, north),
                    network_type="drive", retain_all=True,
                )
            else:
                G = ox.graph_from_place(place, network_type="drive", retain_all=True)

            G = ox.project_graph(G)
            _, edges = ox.graph_to_gdfs(G)
            del G   # free the NetworkX graph — GeoDataFrames are independent copies

            edges = edges.copy()
            edges["hw"] = edges["highway"].apply(_normalise_highway)

            major    = edges[edges["hw"].isin(PRIMARY_TYPES)].copy()
            minor    = edges[edges["hw"].isin(SECONDARY_TYPES)].copy() if road_tier >= 2 else gpd.GeoDataFrame()
            tertiary = edges[edges["hw"].isin(TERTIARY_TYPES)].copy()  if road_tier >= 3 else gpd.GeoDataFrame()

            print(f"  Total edges: {len(edges)} | "
                  f"tier-1 (major): {len(major)} | "
                  f"tier-2 (minor): {len(minor)} | "
                  f"tier-3 (local): {len(tertiary)}")
            return major, minor, tertiary, edges

        except Exception as e:
            last_err = e
            if attempt < max_retries - 1:
                wait = 10 * (attempt + 1)
                print(f"  Attempt {attempt + 1}/{max_retries} failed: {e}. "
                      f"Retrying in {wait}s...")
                time.sleep(wait)
            else:
                print(f"  All {max_retries} attempts failed. Last error: {e}")

    raise last_err


# ---------------------------------------------------------------------------
# Step 2 — enclosures
# ---------------------------------------------------------------------------

def generate_enclosures(
    major: gpd.GeoDataFrame,
    minor: gpd.GeoDataFrame,
    tertiary: gpd.GeoDataFrame,
    edges: gpd.GeoDataFrame,
    bbox_poly=None,
    road_tier: int = 1,
) -> gpd.GeoDataFrame:
    # Study-area limit: convex hull of the full network
    limit = gpd.GeoDataFrame(
        geometry=[unary_union(edges.geometry.values).convex_hull],
        crs=edges.crs,
    )

    print(f"  Running momepy.enclosures() (tier {road_tier})...")
    kwargs = dict(primary_barriers=major, limit=limit)
    additional = [df for df in (minor, tertiary) if len(df) > 0]
    if additional:
        kwargs["additional_barriers"] = additional   # momepy 0.9+ expects a list

    enc = momepy.enclosures(**kwargs)
    print(f"  {len(enc)} enclosures generated")

    # Drop degenerate / empty geometry
    enc = enc[enc.geometry.is_valid & ~enc.geometry.is_empty].copy()

    areas = enc.geometry.area

    MIN_AREA_M2, MAX_AREA_M2 = _AREA_LIMITS.get(road_tier, _AREA_LIMITS[1])
    enc = enc[(areas >= MIN_AREA_M2) & (areas <= MAX_AREA_M2)].copy()
    enc = enc.reset_index(drop=True)
    print(f"  {len(enc)} district-scale enclosures retained")

    # --- Fill gaps so the full bounding box is covered ----------------------
    # Any area inside the bbox but outside all enclosures (rivers, parks,
    # peripheral zones) is assigned to its nearest district via Voronoi.
    study_area = bbox_poly if bbox_poly is not None else unary_union(edges.geometry.values).convex_hull
    # Reproject study_area to the same CRS as enc (UTM)
    covered   = unary_union(enc.geometry.values)
    gap       = study_area.difference(covered)

    if not gap.is_empty and gap.area > 1000:
        print(f"  Filling {gap.area/1e6:.2f} km2 of gaps via Voronoi assignment...")
        centroids = list(enc.geometry.centroid.values)
        vd = voronoi_diagram(GeometryCollection(centroids), envelope=study_area)

        centroid_series = enc.geometry.centroid
        extra_geoms  = []   # gap pieces as NEW rows (same district colour)
        extra_owner  = []   # which district index owns each piece

        for vcell in vd.geoms:
            gap_piece = gap.intersection(vcell)
            if gap_piece.is_empty or gap_piece.area < 100:
                continue
            gap_piece = make_valid(gap_piece)
            # Explode MultiPolygons from intersection into individual parts
            parts = list(gap_piece.geoms) if isinstance(gap_piece, MultiPolygon) else [gap_piece]

            owner = None
            for idx in enc.index:
                if vcell.contains(centroid_series.at[idx]):
                    owner = idx
                    break
            if owner is None:
                continue
            for part in parts:
                if not part.is_empty and part.area > 100 and isinstance(part, Polygon):
                    extra_geoms.append(part)
                    extra_owner.append(owner)

        if extra_geoms:
            # Build new rows inheriting the owner district's attributes
            new_rows = []
            for geom, owner in zip(extra_geoms, extra_owner):
                row = enc.loc[owner].copy()
                row["geometry"] = geom
                new_rows.append(row)
            extra_gdf = gpd.GeoDataFrame(new_rows, crs=enc.crs)
            enc = pd.concat([enc, extra_gdf], ignore_index=True)

        still_uncovered = study_area.difference(unary_union(enc.geometry.values))
        pct = still_uncovered.area / study_area.area * 100
        print(f"  Coverage after gap-fill: {100-pct:.3f}% of bounding box")

    # --- Final validity pass ------------------------------------------------
    # make_valid() on every polygon; discard any that are still degenerate
    fixed = []
    for geom in enc.geometry:
        g = make_valid(geom)
        # make_valid can return GeometryCollection with mixed types — extract polygons
        if isinstance(g, GeometryCollection) and not isinstance(g, (Polygon, MultiPolygon)):
            polys = [p for p in g.geoms if isinstance(p, (Polygon, MultiPolygon))]
            g = unary_union(polys) if polys else None
        if g is None or g.is_empty:
            fixed.append(None)
        elif isinstance(g, MultiPolygon):
            fixed.append(max(g.geoms, key=lambda p: p.area))
        else:
            fixed.append(g)

    enc = enc.copy()
    enc["geometry"] = fixed
    enc = enc[enc.geometry.notna() & enc.geometry.is_valid & ~enc.geometry.is_empty].copy()
    print(f"  {len(enc)} valid polygons after final check")

    return enc


# ---------------------------------------------------------------------------
# Step 3 — write SVG
# ---------------------------------------------------------------------------

def write_svg(
    enc: gpd.GeoDataFrame,
    output_path: str,
    width: int = 1920,
    height: int = 1080,
    fill_opacity: float = 0.9,
    bbox_poly=None,          # projected UTM bbox — used for exact canvas mapping
) -> None:
    # Use the known bbox extents so the SVG canvas maps 1:1 to the requested area.
    # Fall back to enc.total_bounds if no bbox was supplied.
    if bbox_poly is not None:
        bminx, bminy, bmaxx, bmaxy = bbox_poly.bounds
    else:
        bminx, bminy, bmaxx, bmaxy = enc.total_bounds

    data_w = bmaxx - bminx
    data_h = bmaxy - bminy

    # No padding — fill the entire canvas so there are no white borders
    scale_x = width  / data_w
    scale_y = height / data_h
    # Use non-uniform scale to fill every pixel of the canvas
    # (slight distortion is acceptable; districts still look correct)

    def to_svg(x, y):
        px = (x - bminx) * scale_x
        py = height - (y - bminy) * scale_y   # flip y
        return px, py

    def pts_str(polygon: Polygon) -> str:
        return " ".join(
            f"{to_svg(x, y)[0]:.2f},{to_svg(x, y)[1]:.2f}"
            for x, y in polygon.exterior.coords
        )

    colors = hsl_colors(len(enc))
    written = 0

    with open(output_path, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n')
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" '
                f'viewBox="0 0 {width} {height}" width="{width}" height="{height}">\n')
        f.write(f'<rect width="{width}" height="{height}" fill="#f7f2e8"/>\n')
        f.write('<g id="districts" stroke="#2a2a2a" stroke-width="1.0">\n')

        for i, row in enumerate(enc.itertuples()):
            geom = row.geometry
            color = colors[i % len(colors)]
            parts = list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]
            for part in parts:
                if part.is_empty or not part.is_valid:
                    continue
                f.write(f'  <polygon points="{pts_str(part)}" '
                        f'fill="{color}" fill-opacity="{fill_opacity}"/>\n')
            written += 1

        f.write("</g>\n</svg>\n")

    print(f"  SVG written: {output_path}  ({written} districts)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def generate(place: str, output: str, road_tier: int = 1) -> None:
    print(f"\nPlace  : {place}")
    print(f"Output : {output}")
    print(f"Road tier: {road_tier}\n")

    print("Step 1 — downloading OSM network...")
    major, minor, tertiary, edges = download_network(place, road_tier)
    if major.empty:
        print("ERROR: no major roads found. Try a broader place name.")
        sys.exit(1)

    print("\nStep 2 — generating enclosures (momepy)...")
    bbox_proj = None
    if "," in place and all(_is_float(p.strip()) for p in place.split(",")):
        parts = [float(p.strip()) for p in place.split(",")]
        north, south, east, west = parts
        raw_bbox = box(west, south, east, north)
        bbox_gdf = gpd.GeoDataFrame(geometry=[raw_bbox], crs="EPSG:4326")
        bbox_gdf = bbox_gdf.to_crs(major.crs)
        bbox_proj = box(*bbox_gdf.geometry.iloc[0].bounds)
    enc = generate_enclosures(major, minor, tertiary, edges, bbox_poly=bbox_proj, road_tier=road_tier)
    if enc.empty:
        print("ERROR: no enclosures generated.")
        sys.exit(1)

    print("\nStep 3 — writing SVG...")
    write_svg(enc, output, bbox_poly=bbox_proj)

    print(f"\nDone.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Generate street-aligned district SVG from OSM data."
    )
    parser.add_argument("place",  help='Place name, e.g. "Manchester City Centre, UK"')
    parser.add_argument("output", help="Output SVG file path")
    parser.add_argument(
        "--tier", type=int, choices=[1, 2, 3], default=1,
        help="Road detail level: 1=major only (default), 2=+tertiary, 3=+residential/unclassified",
    )
    args = parser.parse_args()
    generate(args.place, args.output, road_tier=args.tier)
