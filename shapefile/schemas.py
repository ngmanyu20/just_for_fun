# schemas.py
from pydantic import BaseModel
from typing import Optional, Dict, Any, List


class SplitRequest(BaseModel):
    geometry: Dict[str, Any]   # GeoJSON geometry
    num_districts: int
    seed: Optional[int] = 42

    # NEW: gap handling to eliminate white areas
    include_gaps: Optional[bool] = True
    gap_area_tol: Optional[float] = 0.0

    # NEW: optional filtering of microscopic slivers
    min_cell_area: Optional[float] = 0.0


class SplitResponse(BaseModel):
    type: str
    features: list


class MergeRequest(BaseModel):
    features: List[Dict[str, Any]]   # GeoJSON Features
    snap_tol: Optional[float] = 1e-6
    require_single: Optional[bool] = True


class SvgSplitRequest(BaseModel):
    geometry: Dict[str, Any]         # GeoJSON Polygon geometry
    svg_content: str                 # SVG file content as text
    target_count: int = 50           # target number of output polygons
    # Optional SvgLayer alignment params (from SvgLayer.js anchor/dataWidth)
    anchor_x: Optional[float] = None
    anchor_y: Optional[float] = None
    data_width: Optional[float] = None
    svg_w: Optional[float] = None
    svg_h: Optional[float] = None
    min_area_fraction: float = 0.0001


class OsmSplitRequest(BaseModel):
    geometry: Dict[str, Any]         # GeoJSON Polygon geometry
    north: float                     # bounding box in WGS84
    south: float
    east: float
    west: float
    road_tier: int = 1               # 1=major only, 2=+tertiary, 3=+residential/unclassified
    simplify_spacing: Optional[float] = 150.0  # min vertex spacing in metres; None = disabled
    data_source: str = "osm"         # "osm" = Overpass API, "os_roads" = OS Open Roads (UK only)


class PolygonSplitConfig(BaseModel):
    road_tier: int = 1               # 1=major only, 2=+tertiary, 3=+residential
    simplify_spacing: Optional[float] = 150.0  # min vertex spacing in metres; None = disabled
    min_area_km2: Optional[float] = None       # min enclosure area to keep; None = auto


class OsmMultiSplitRequest(BaseModel):
    geometries: List[Dict[str, Any]] # List of GeoJSON Polygon geometries
    north: float
    south: float
    east: float
    west: float
    road_tier: int = 1               # 1=major only, 2=+tertiary, 3=+residential/unclassified
    simplify_spacing: Optional[float] = 150.0  # min vertex spacing in metres; None = disabled
    data_source: str = "osm"         # "osm" = Overpass API, "os_roads" = OS Open Roads (UK only)
    polygon_configs: Optional[List[PolygonSplitConfig]] = None  # per-polygon overrides
