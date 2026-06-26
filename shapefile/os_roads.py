"""
OS Open Roads loader
====================
Reads the OS Open Roads GeoPackage (free from Ordnance Survey) and returns
(major, minor, tertiary, edges, waterways) GeoDataFrames in the same format
as osm_district_generator.download_network() so the rest of the pipeline
(generate_enclosures, split_polygon_by_osm) works unchanged.

Expected file location (override with OS_ROADS_PATH env var):
    shapefile/os_data/oproad_gb.gpkg

Download from:
    https://osdatahub.os.uk/downloads/open/OpenRoads
    Choose "GeoPackage" format. Extract and place oproad_gb.gpkg at the path above.
"""

import os
import geopandas as gpd
from pathlib import Path
from shapely.geometry import box as shapely_box

try:
    import osmnx as _ox
    _HAS_OX = True
except Exception:
    _HAS_OX = False

_DEFAULT_GPKG = Path(__file__).parent / "os_data" / "oproad_gb.gpkg"
_GPKG_PATH = Path(os.environ.get("OS_ROADS_PATH", str(_DEFAULT_GPKG)))
_LAYER = "road_link"

# OS Open Roads 'road_classification' values mapped to our tier system.
#
# The GeoPackage uses these actual values (confirmed from live data):
#   'Motorway', 'A Road', 'B Road'          → major (tier 1)
#   'Classified Unnumbered'                  → minor numbered roads below B-class (tier 2)
#   'Unclassified', 'Not Classified',
#   'Unknown'                                → local/unclassified streets (tier 3)
#
# The values we originally expected ('Minor Road', 'Local Road', etc.) come from
# a different OS product schema and do not appear in oproad_gb.gpkg.
_TIER1_CLS = {"Motorway", "A Road", "B Road"}
_TIER2_CLS = {"Classified Unnumbered"}
_TIER3_CLS = {"Unclassified", "Not Classified", "Unknown"}

_ALL_CLS = _TIER1_CLS | _TIER2_CLS | _TIER3_CLS


def is_available() -> bool:
    return _GPKG_PATH.exists()


def _check_available():
    if not is_available():
        raise FileNotFoundError(
            f"OS Open Roads GeoPackage not found at:\n  {_GPKG_PATH}\n\n"
            "To use UK mode:\n"
            "  1. Go to https://osdatahub.os.uk/downloads/open/OpenRoads\n"
            "  2. Download the GeoPackage format\n"
            "  3. Extract and place oproad_gb.gpkg at the path above\n"
            "     (or set the OS_ROADS_PATH environment variable)\n"
        )


def _utm_crs(lon: float, lat: float) -> str:
    zone = int((lon + 180) / 6) + 1
    return f"EPSG:{32600 + zone}" if lat >= 0 else f"EPSG:{32700 + zone}"


def _find_classification_col(roads: gpd.GeoDataFrame) -> str:
    """Return the road classification column name, handling OS format variants."""
    for candidate in ("road_classification", "roadClassification",
                      "road_function", "roadFunction", "class"):
        if candidate in roads.columns:
            return candidate
    return None


def fetch_waterways(north: float, south: float, east: float, west: float) -> "gpd.GeoDataFrame":
    """
    Fetch river/canal/stream barriers from OSM for a WGS84 bbox.
    Returns a GeoDataFrame in EPSG:4326 (not projected) so it can be reprojected
    to any target CRS later.  Returns an empty GDF if osmnx is unavailable or
    the request fails / times out.
    """
    if not _HAS_OX:
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")
    try:
        _ox.settings.timeout = 20   # don't hang longer than 20 s on Overpass
        wf = _ox.features_from_bbox(
            bbox=(west, south, east, north),
            tags={"waterway": ["river", "canal", "stream"],
                  "natural":  ["coastline"]},
        )
        wf = wf[wf.geometry.geom_type.isin(["LineString", "MultiLineString"])].copy()
        if len(wf) > 0:
            result = gpd.GeoDataFrame(geometry=wf.geometry.values, crs="EPSG:4326")
            print(f"  Downloaded {len(result)} waterway line barriers (OSM Overpass)")
            return result
    except Exception as _we:
        print(f"  Waterway fetch skipped: {_we}")
    return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")


def load_os_network(north: float, south: float, east: float, west: float,
                    road_tier: int = 1, preloaded_waterways=None):
    """
    Load OS Open Roads for a WGS84 bounding box.

    Returns (major, minor, tertiary, edges, waterways) matching the tuple
    returned by download_network() so generate_enclosures() works unchanged.

    All returned GeoDataFrames are in a local UTM CRS (metres).
    """
    _check_available()

    # Reproject WGS84 bbox → British National Grid (EPSG:27700) for file query
    wgs_bbox = gpd.GeoDataFrame(
        geometry=[shapely_box(west, south, east, north)], crs="EPSG:4326"
    )
    bng_bbox = wgs_bbox.to_crs("EPSG:27700").geometry.iloc[0]
    minx, miny, maxx, maxy = bng_bbox.bounds

    print(f"  Loading OS Open Roads ({_GPKG_PATH.name}) "
          f"bbox BNG: {minx:.0f},{miny:.0f} → {maxx:.0f},{maxy:.0f}")

    roads = gpd.read_file(_GPKG_PATH, layer=_LAYER, bbox=(minx, miny, maxx, maxy))

    if roads.empty:
        raise ValueError(
            "No OS Open Roads features found in the specified bounding box. "
            "Confirm the bbox is within Great Britain."
        )

    print(f"  Loaded {len(roads)} road links from OS Open Roads")

    # Reproject to local UTM so area/distance calculations use metres,
    # matching the CRS returned by osmnx's project_graph()
    lon_c = (west + east) / 2
    lat_c = (south + north) / 2
    utm_crs = _utm_crs(lon_c, lat_c)
    roads = roads.to_crs(utm_crs)

    cls_col = _find_classification_col(roads)
    if cls_col is None:
        print("  WARNING: could not find road classification column; treating all as A Road")
        print(f"  Available columns: {list(roads.columns)}")
        roads["_cls"] = "A Road"
        cls_col = "_cls"
    else:
        print(f"  Classification column: '{cls_col}'")

    cls = roads[cls_col]

    # Always print value counts so we can verify the tier split is working.
    _val_counts = cls.value_counts()
    print(f"  Road classification value counts:\n"
          + "\n".join(f"    {v!r}: {c}" for v, c in _val_counts.items()))

    major = roads[cls.isin(_TIER1_CLS)].copy()
    minor = (roads[cls.isin(_TIER2_CLS)].copy()
             if road_tier >= 2 else gpd.GeoDataFrame(geometry=[], crs=roads.crs))
    tertiary = (roads[cls.isin(_TIER3_CLS)].copy()
                if road_tier >= 3 else gpd.GeoDataFrame(geometry=[], crs=roads.crs))

    # Safety check — if major is still empty the GeoPackage uses an unknown schema.
    if major.empty and not roads.empty:
        _unique_vals = sorted(cls.dropna().unique())
        print(f"  WARNING: no roads matched TIER1 classes {_TIER1_CLS}")
        print(f"  Actual unique values in '{cls_col}': {_unique_vals}")
        print(f"  Update _TIER1_CLS/_TIER2_CLS/_TIER3_CLS in os_roads.py to match")

    # edges for Voronoi gap-fill seeding must match the tier being used as
    # barriers — using all roads regardless of tier makes every tier look
    # identical because the gap-fill seeds along local roads even when
    # momepy only used major roads as enclosure barriers.
    _active_cls = _TIER1_CLS.copy()
    if road_tier >= 2:
        _active_cls |= _TIER2_CLS
    if road_tier >= 3:
        _active_cls |= _TIER3_CLS
    edges = roads[cls.isin(_active_cls)].copy() if cls_col != "_cls" else roads.copy()
    # If edges is also empty after the remap (classification was remapped above),
    # fall back to all loaded roads for gap-fill seeding.
    if edges.empty:
        edges = roads.copy()

    # Waterways: river/canal lines from OSM act as district barriers.
    # If caller pre-fetched them (EPSG:4326 GDF), reproject and reuse.
    # Otherwise fetch now — one network call per polygon is the slow path.
    if preloaded_waterways is not None:
        if len(preloaded_waterways) > 0:
            waterways = preloaded_waterways.to_crs(roads.crs)
            print(f"  Using {len(waterways)} pre-fetched waterway barriers")
        else:
            waterways = gpd.GeoDataFrame(geometry=[], crs=roads.crs)
    else:
        wf_gdf = fetch_waterways(north, south, east, west)
        waterways = (wf_gdf.to_crs(roads.crs)
                     if len(wf_gdf) > 0
                     else gpd.GeoDataFrame(geometry=[], crs=roads.crs))

    print(f"  OS roads — major: {len(major)} | "
          f"minor: {len(minor)} | tertiary: {len(tertiary)} | "
          f"tier-edges (gap seeds): {len(edges)}")

    return major, minor, tertiary, edges, waterways
