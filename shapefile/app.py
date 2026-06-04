# app.py
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel
from schemas import SplitRequest, MergeRequest, SvgSplitRequest, OsmSplitRequest, OsmMultiSplitRequest
from geometry_core import split_polygon_geojson, merge_polygons_geojson, split_polygon_by_svg, split_polygon_by_osm, split_polygons_by_osm_with_boundaries
import gc
import os


class SaveCSVRequest(BaseModel):
    filename: str
    content: str

app = FastAPI(title="Polygon Geometry Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Prevent browser from caching JS/HTML files so code changes are always picked up
# without needing a hard refresh (Ctrl+Shift+R).
class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path.endswith('.js') or path.endswith('.html') or path == '/':
            response.headers['Cache-Control'] = 'no-store, must-revalidate'
            response.headers['Pragma'] = 'no-cache'
        return response

app.add_middleware(NoCacheMiddleware)

# Get the directory where this script is located
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# On Render the repo filesystem is read-only; user-uploaded CSVs must go to /tmp.
# On localhost, write alongside the committed CSV files so they show up immediately.
IS_RENDER = bool(os.environ.get('RENDER'))
TMP_CSV_DIR = '/tmp/csv_input' if IS_RENDER else os.path.join(BASE_DIR, 'csv_input')
os.makedirs(TMP_CSV_DIR, exist_ok=True)

# Mount static files (js, css, etc.)
app.mount("/js", StaticFiles(directory=os.path.join(BASE_DIR, "js")), name="js")

# NOTE: /csv_input is served by a custom route below (not StaticFiles) so that
# user-uploaded files saved to TMP_CSV_DIR are also reachable on Render.

# Allow legacy /shapefile path URL for direct file access
app.mount("/shapefile", StaticFiles(directory=BASE_DIR), name="shapefile")


@app.get("/csv_files")
async def list_csv_files():
    """List all available CSV files: committed ones from csv_input/ plus
    any user-uploaded files saved to TMP_CSV_DIR."""
    committed_dir = os.path.join(BASE_DIR, 'csv_input')
    files: set[str] = set()

    for d in [committed_dir, TMP_CSV_DIR]:
        if os.path.isdir(d):
            for f in os.listdir(d):
                if f.lower().endswith('.csv') and os.path.isfile(os.path.join(d, f)):
                    files.add(f)

    return {'files': sorted(files)}


@app.get("/csv_input/{filename}")
async def serve_csv(filename: str):
    """Serve a CSV file, checking TMP_CSV_DIR first (user uploads), then the
    committed csv_input/ directory (files shipped with the repo)."""
    if '..' in filename or filename.startswith('/') or filename.startswith('\\'):
        raise HTTPException(status_code=400, detail='Invalid filename')

    safe = os.path.basename(filename)

    # Prefer a freshly uploaded file over the committed one
    for directory in [TMP_CSV_DIR, os.path.join(BASE_DIR, 'csv_input')]:
        path = os.path.join(directory, safe)
        if os.path.isfile(path):
            return FileResponse(path, media_type='text/csv')

    raise HTTPException(status_code=404, detail=f'CSV file not found: {safe}')


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


@app.post("/split-svg")
def split_polygon_svg(req: SvgSplitRequest):
    import traceback
    try:
        result = split_polygon_by_svg(
            geometry_geojson=req.geometry,
            svg_content=req.svg_content,
            target_count=req.target_count,
            anchor_x=req.anchor_x,
            anchor_y=req.anchor_y,
            data_width=req.data_width,
            svg_w=req.svg_w,
            svg_h=req.svg_h,
            min_area_fraction=req.min_area_fraction,
        )
        return result
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/split-osm")
def split_polygon_osm(req: OsmSplitRequest):
    import traceback
    try:
        result = split_polygon_by_osm(
            geometry_geojson=req.geometry,
            north=req.north,
            south=req.south,
            east=req.east,
            west=req.west,
            road_tier=req.road_tier,
        )
        return result
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        gc.collect()


@app.post("/split-osm-multi")
def split_polygons_osm_multi(req: OsmMultiSplitRequest):
    """
    OSM-split multiple adjacent polygons while preserving their shared boundaries.
    Each OSM district is clipped by the original polygon boundaries and returned
    with a source_index property indicating which input polygon it belongs to.
    """
    import traceback
    try:
        result = split_polygons_by_osm_with_boundaries(
            geometries_geojson=req.geometries,
            north=req.north,
            south=req.south,
            east=req.east,
            west=req.west,
            road_tier=req.road_tier,
        )
        return result
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        gc.collect()


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

        # Fix truly invalid geometry only (self-intersecting rings, etc.)
        if not merged.is_valid:
            merged = merged.buffer(0)

        # Collect all parts (keep disconnected islands — don't drop the smaller ones)
        if merged.geom_type == 'MultiPolygon':
            geoms = list(merged.geoms)
        else:
            geoms = [merged]

        # Simplify each part individually
        SIMPLIFY_TOLERANCE = 0.001
        parts_data = []
        for geom in geoms:
            if SIMPLIFY_TOLERANCE > 0:
                simplified = geom.simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)
                if simplified.is_valid:
                    geom = simplified
            ext = [[round(x, 2), round(y, 2)] for x, y in geom.exterior.coords]
            holes = [[[round(x, 2), round(y, 2)] for x, y in interior.coords]
                     for interior in geom.interiors]
            parts_data.append({'exterior': ext, 'holes': holes})

        return {
            'county': county_name,
            'exterior': parts_data[0]['exterior'],   # backwards compat
            'holes':    parts_data[0]['holes'],       # backwards compat
            'parts':    parts_data,                   # all disconnected pieces
            'vertex_count': sum(len(p['exterior']) for p in parts_data),
            'hole_count':   sum(len(p['holes'])    for p in parts_data),
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post('/save_csv')
async def save_csv(req: SaveCSVRequest):
    """Save a CSV to TMP_CSV_DIR (writable on both localhost and Render)."""
    if '..' in req.filename or req.filename.startswith('/') or req.filename.startswith('\\'):
        raise HTTPException(status_code=400, detail='Invalid filename')

    safe_filename = os.path.basename(req.filename)
    target_path = os.path.join(TMP_CSV_DIR, safe_filename)

    try:
        with open(target_path, 'w', encoding='utf-8') as f:
            f.write(req.content)

        return {'success': True, 'path': f'/csv_input/{safe_filename}'}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
