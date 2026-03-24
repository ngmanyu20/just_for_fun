# app.py
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from schemas import SplitRequest, MergeRequest
from geometry_core import split_polygon_geojson, merge_polygons_geojson
import os


class SaveCSVRequest(BaseModel):
    filename: str
    content: str

app = FastAPI(title="Polygon Geometry Engine")

# Get the directory where this script is located
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Mount static files (js, css, etc.)
app.mount("/js", StaticFiles(directory=os.path.join(BASE_DIR, "js")), name="js")
app.mount("/csv_input", StaticFiles(directory=os.path.join(BASE_DIR, "csv_input")), name="csv_input")

# Allow legacy /shapefile path URL for direct file tempo
app.mount("/shapefile", StaticFiles(directory=BASE_DIR), name="shapefile")

@app.get("/csv_files")
async def list_csv_files():
    csv_dir = os.path.join(BASE_DIR, 'csv_input')
    os.makedirs(csv_dir, exist_ok=True)
    files = [f for f in sorted(os.listdir(csv_dir)) if f.lower().endswith('.csv') and os.path.isfile(os.path.join(csv_dir, f))]
    return {'files': files}

# Serve the main HTML file at the root
@app.get("/")
async def read_root():
    """Serve the main HTML file"""
    return FileResponse(os.path.join(BASE_DIR, "index.html"))

# Optional: Serve other HTML files
@app.get("/main")
async def read_main():
    """Serve the main_html.html file"""
    return FileResponse(os.path.join(BASE_DIR, "main_html.html"))

@app.get("/examples")
async def read_examples():
    """Serve the example_usage.html file"""
    return FileResponse(os.path.join(BASE_DIR, "example_usage.html"))


@app.post("/split")
def split_polygon(req: SplitRequest):
    if req.num_districts < 2:
        raise HTTPException(status_code=400, detail="num_districts must be >= 2")

    try:
        result = split_polygon_geojson(
            geometry_geojson=req.geometry,
            num_districts=req.num_districts,
            seed=req.seed,
            min_cell_area=req.min_cell_area or 0.0,
            include_gaps=True if req.include_gaps is None else req.include_gaps,
            gap_area_tol=req.gap_area_tol or 0.0,
        )
        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/merge")
def merge_polygons(req: MergeRequest):
    """
    Merge multiple polygons into a single polygon using Shapely's unary_union.
    Order-independent, topologically correct merging.
    """
    try:
        result = merge_polygons_geojson(
            features=req.features,
            snap_tol=req.snap_tol or 0.0,
            require_single=True if req.require_single is None else req.require_single
        )
        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/merge-county")
async def merge_county(request: dict):
    """
    Merge sub-county polygons into a single county boundary
    Compatible with the LayerManager.js format

    Request: { "county": "NC1", "polygons": [{"geometry": "POLYGON(...)"}, ...] }
    Response: { "county": "NC1", "exterior": [[x,y],...], "holes": [...], "vertex_count": N }
    """
    from shapely import wkt
    from shapely.ops import unary_union

    try:
        county_name = request.get('county', 'Unknown')
        polygon_data = request.get('polygons', [])

        if not polygon_data:
            raise HTTPException(status_code=400, detail='No polygons provided')

        # Parse WKT polygons
        polygons = []
        for poly_data in polygon_data:
            geometry_wkt = poly_data.get('geometry', '')
            poly = wkt.loads(geometry_wkt)
            if poly.is_valid:
                polygons.append(poly)
            else:
                poly = poly.buffer(0)
                if poly.is_valid:
                    polygons.append(poly)

        if not polygons:
            raise HTTPException(status_code=400, detail='No valid polygons to merge')

        # Merge using unary_union
        merged = unary_union(polygons)

        # Handle MultiPolygon
        if merged.geom_type == 'MultiPolygon':
            merged = max(merged.geoms, key=lambda p: p.area)

        # Simplify
        SIMPLIFY_TOLERANCE = 0.001
        if SIMPLIFY_TOLERANCE > 0:
            simplified = merged.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)
            if simplified.is_valid:
                merged = simplified

        # Extract coordinates
        exterior = [[round(x, 6), round(y, 6)] for x, y in merged.exterior.coords]
        holes = [[[round(x, 6), round(y, 6)] for x, y in interior.coords]
                 for interior in merged.interiors]

        return {
            'county': county_name,
            'exterior': exterior,
            'holes': holes,
            'vertex_count': len(exterior),
            'hole_count': len(holes)
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post('/save_csv')
async def save_csv(req: SaveCSVRequest):
    # Ensure no path traversal (safe-write in csv_input only)
    if '..' in req.filename or req.filename.startswith('/') or req.filename.startswith('\\'):
        raise HTTPException(status_code=400, detail='Invalid filename')

    csv_dir = os.path.join(BASE_DIR, 'csv_input')
    os.makedirs(csv_dir, exist_ok=True)

    safe_filename = os.path.basename(req.filename)
    target_path = os.path.join(csv_dir, safe_filename)

    try:
        with open(target_path, 'w', encoding='utf-8') as f:
            f.write(req.content)

        return {'success': True, 'path': f'/csv_input/{safe_filename}'}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
