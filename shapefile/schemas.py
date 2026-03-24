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
