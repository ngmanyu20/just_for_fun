# Python Geometry Service API Contract

This document defines the exact JSON format for the `/split` endpoint.

## Endpoint

```
POST http://localhost:8000/split
Content-Type: application/json
```

## Request Schema

The request body must match the `SplitRequest` schema defined in [schemas.py](schemas.py:6-9).

### Required Format

```json
{
  "geometry": {
    "type": "Polygon",
    "coordinates": [
      [
        [x1, y1],
        [x2, y2],
        [x3, y3],
        ...
        [x1, y1]
      ]
    ]
  },
  "num_districts": 10,
  "seed": 42
}
```

### Field Requirements

| Field | Type | Required | Validation | Default |
|-------|------|----------|------------|---------|
| `geometry` | Object | Yes | Must be valid GeoJSON Polygon geometry | - |
| `geometry.type` | String | Yes | Must be `"Polygon"` | - |
| `geometry.coordinates` | Array | Yes | Array of rings, outer ring must be closed | - |
| `num_districts` | Integer | Yes | Must be >= 2 | - |
| `seed` | Integer | No | Any integer for reproducibility | 42 |

### Geometry Requirements

1. **Type**: Must be `"Polygon"` (not `"MultiPolygon"`)
2. **Coordinates**: Array of linear rings
   - First ring = exterior boundary
   - Additional rings = holes (not yet supported)
3. **Closed ring**: First coordinate must equal last coordinate
   - Valid: `[[0,0], [10,0], [10,10], [0,10], [0,0]]` ✓
   - Invalid: `[[0,0], [10,0], [10,10], [0,10]]` ✗

### Example Requests

#### Minimal Request (Rectangle)

```json
{
  "geometry": {
    "type": "Polygon",
    "coordinates": [
      [
        [0, 0],
        [100, 0],
        [100, 50],
        [0, 50],
        [0, 0]
      ]
    ]
  },
  "num_districts": 5
}
```

#### With Custom Seed (Triangle)

```json
{
  "geometry": {
    "type": "Polygon",
    "coordinates": [
      [
        [50, 0],
        [100, 100],
        [0, 100],
        [50, 0]
      ]
    ]
  },
  "num_districts": 3,
  "seed": 12345
}
```

#### Complex Polygon

```json
{
  "geometry": {
    "type": "Polygon",
    "coordinates": [
      [
        [0, 0],
        [50, 10],
        [100, 0],
        [90, 50],
        [100, 100],
        [50, 90],
        [0, 100],
        [10, 50],
        [0, 0]
      ]
    ]
  },
  "num_districts": 8,
  "seed": 999
}
```

## Response Schema

The response matches the `SplitResponse` schema defined in [schemas.py](schemas.py:12-14).

### Success Response (200 OK)

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "subdivision_id": 1
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [x1, y1],
            [x2, y2],
            ...
            [x1, y1]
          ]
        ]
      }
    },
    {
      "type": "Feature",
      "properties": {
        "subdivision_id": 2
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [...]
      }
    }
  ]
}
```

### Response Structure

| Field | Type | Description |
|-------|------|-------------|
| `type` | String | Always `"FeatureCollection"` |
| `features` | Array | Array of GeoJSON Feature objects |
| `features[].type` | String | Always `"Feature"` |
| `features[].properties` | Object | Feature metadata |
| `features[].properties.subdivision_id` | Integer | District ID (1-indexed) |
| `features[].geometry` | Object | GeoJSON Polygon geometry |

### Error Responses

#### 400 Bad Request - Validation Error

```json
{
  "detail": "num_districts must be >= 2"
}
```

#### 422 Unprocessable Entity - Schema Error

```json
{
  "detail": [
    {
      "loc": ["body", "geometry"],
      "msg": "field required",
      "type": "value_error.missing"
    }
  ]
}
```

#### 500 Internal Server Error - Processing Error

```json
{
  "detail": "Could not generate enough interior seed points"
}
```

## Python Implementation Reference

The request is processed by [app.py](app.py:10-23):

```python
@app.post("/split")
def split_polygon(req: SplitRequest):
    if req.num_districts < 2:
        raise HTTPException(status_code=400, detail="num_districts must be >= 2")

    try:
        result = split_polygon_geojson(
            geometry_geojson=req.geometry,
            num_districts=req.num_districts,
            seed=req.seed
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
```

The actual splitting is done by [geometry_core.py](geometry_core.py:89-135):

```python
def split_polygon_geojson(geometry_geojson: dict,
                          num_districts: int,
                          seed: int = 42):
    """
    Input: GeoJSON geometry
    Output: GeoJSON FeatureCollection
    """
    # ... Voronoi subdivision logic ...
```

## Client Usage

### JavaScript (PolygonSplitter.js)

```javascript
const splitter = new PolygonSplitter('http://localhost:8000');

// Convert internal format to GeoJSON
const geometry = splitter.convertToGeoJSON(polygon);

// Prepare request
const payload = {
    geometry: geometry,
    num_districts: 10,
    seed: 42
};

// Send request
const featureCollection = await splitter.callSplitAPI(payload);
```

### cURL

```bash
curl -X POST http://localhost:8000/split \
  -H "Content-Type: application/json" \
  -d '{
    "geometry": {
      "type": "Polygon",
      "coordinates": [[[0,0],[100,0],[100,50],[0,50],[0,0]]]
    },
    "num_districts": 5,
    "seed": 42
  }'
```

### Python

```python
import requests

payload = {
    "geometry": {
        "type": "Polygon",
        "coordinates": [[[0, 0], [100, 0], [100, 50], [0, 50], [0, 0]]]
    },
    "num_districts": 5,
    "seed": 42
}

response = requests.post(
    "http://localhost:8000/split",
    json=payload
)

feature_collection = response.json()
```

## Testing

### Interactive API Documentation

FastAPI provides auto-generated interactive docs:

- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc

You can test the API directly in the browser.

### Example Test Cases

```javascript
// Test 1: Minimum districts
{ geometry: {...}, num_districts: 2 }  // Should succeed

// Test 2: Invalid districts
{ geometry: {...}, num_districts: 1 }  // Should fail (400)

// Test 3: Large polygon
{ geometry: {...}, num_districts: 20 }  // Should succeed

// Test 4: Different seeds
{ geometry: {...}, num_districts: 5, seed: 100 }
{ geometry: {...}, num_districts: 5, seed: 200 }
// Should produce different results

// Test 5: Same seed
{ geometry: {...}, num_districts: 5, seed: 42 }
{ geometry: {...}, num_districts: 5, seed: 42 }
// Should produce identical results
```

## Important Notes

1. **Do NOT modify this contract** without updating all three files:
   - [schemas.py](schemas.py) - Pydantic schemas
   - [geometry_core.py](geometry_core.py) - Core logic
   - [app.py](app.py) - FastAPI endpoint

2. **Ring closure is critical** - Client must ensure first point == last point

3. **Coordinate order** - GeoJSON uses `[longitude, latitude]` or `[x, y]` order

4. **Only Polygon supported** - MultiPolygon not yet implemented

5. **Seed affects randomness** - Same seed + same geometry = same result
