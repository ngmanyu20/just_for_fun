"""
Tests for geometry_core.split_polygon_geojson gap absorption logic.
Run with: python test_geometry_core.py
"""
import sys
from shapely.geometry import shape, Polygon
from shapely.ops import unary_union
from geometry_core import split_polygon_geojson


def make_geojson(polygon: Polygon) -> dict:
    coords = list(polygon.exterior.coords)
    return {"type": "Polygon", "coordinates": [[[x, y] for x, y in coords]]}


def check_result(label, result, input_polygon, num_districts):
    features = result.get("features", [])
    kinds = [f["properties"].get("kind") for f in features]

    # 1. No gap features emitted
    gap_count = kinds.count("gap")
    assert gap_count == 0, f"[{label}] Expected 0 gap features, got {gap_count}"

    # 2. Correct number of district features
    district_count = kinds.count("district")
    assert district_count == num_districts, (
        f"[{label}] Expected {num_districts} districts, got {district_count}"
    )

    # 3. All features are valid polygons
    for i, f in enumerate(features):
        geom = shape(f["geometry"])
        assert not geom.is_empty, f"[{label}] Feature {i} is empty"
        assert geom.is_valid, f"[{label}] Feature {i} is invalid: {geom}"

    # 4. Union of all districts covers (≥99.9%) of original polygon area
    union = unary_union([shape(f["geometry"]) for f in features]).buffer(0)
    input_area = input_polygon.area
    covered_area = union.intersection(input_polygon).area
    coverage = covered_area / input_area if input_area > 0 else 0
    assert coverage >= 0.999, (
        f"[{label}] Coverage only {coverage:.4%} — gaps not fully absorbed"
    )

    # 5. No district exceeds the original polygon boundary significantly
    overshoot = union.difference(input_polygon.buffer(1e-6)).area
    assert overshoot < input_area * 0.001, (
        f"[{label}] Districts overshoot input polygon by {overshoot:.4f}"
    )

    print(f"  PASS  {label}  ({district_count} districts, {coverage:.4%} coverage)")
    return features


def test_simple_square():
    poly = Polygon([(0,0),(100,0),(100,100),(0,100)])
    result = split_polygon_geojson(make_geojson(poly), num_districts=4, seed=1)
    check_result("simple_square_4", result, poly, 4)


def test_simple_square_8():
    poly = Polygon([(0,0),(100,0),(100,100),(0,100)])
    result = split_polygon_geojson(make_geojson(poly), num_districts=8, seed=42)
    check_result("simple_square_8", result, poly, 8)


def test_irregular_polygon():
    # L-shaped polygon — more likely to produce Voronoi gaps
    poly = Polygon([
        (0,0),(60,0),(60,40),(100,40),(100,100),(0,100)
    ])
    result = split_polygon_geojson(make_geojson(poly), num_districts=5, seed=7)
    check_result("l_shape_5", result, poly, 5)


def test_narrow_rectangle():
    # Very narrow — Voronoi often leaves slivers at ends
    poly = Polygon([(0,0),(200,0),(200,10),(0,10)])
    result = split_polygon_geojson(make_geojson(poly), num_districts=6, seed=3)
    check_result("narrow_rect_6", result, poly, 6)


def test_concave_polygon():
    # Concave (star notch shape) — harder for Voronoi to fill cleanly
    poly = Polygon([
        (0,0),(100,0),(100,100),(60,60),(50,100),(40,60),(0,100)
    ])
    result = split_polygon_geojson(make_geojson(poly), num_districts=4, seed=99)
    check_result("concave_4", result, poly, 4)


def test_many_districts():
    poly = Polygon([(0,0),(100,0),(100,100),(0,100)])
    result = split_polygon_geojson(make_geojson(poly), num_districts=15, seed=21)
    check_result("square_15_districts", result, poly, 15)


def test_minimum_two_districts():
    poly = Polygon([(0,0),(100,0),(100,100),(0,100)])
    result = split_polygon_geojson(make_geojson(poly), num_districts=2, seed=5)
    check_result("min_2_districts", result, poly, 2)


def test_no_gaps_flag():
    # include_gaps=False — old behaviour, just check it still works and no crash
    poly = Polygon([(0,0),(100,0),(100,100),(0,100)])
    result = split_polygon_geojson(make_geojson(poly), num_districts=4, seed=1, include_gaps=False)
    features = result.get("features", [])
    for f in features:
        assert shape(f["geometry"]).is_valid
    print(f"  PASS  no_gaps_flag  ({len(features)} features, no crash)")


if __name__ == "__main__":
    print("Running geometry_core tests...\n")
    tests = [
        test_simple_square,
        test_simple_square_8,
        test_irregular_polygon,
        test_narrow_rectangle,
        test_concave_polygon,
        test_many_districts,
        test_minimum_two_districts,
        test_no_gaps_flag,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except Exception as e:
            print(f"  FAIL  {t.__name__}: {e}")
            failed += 1

    print(f"\n{len(tests) - failed}/{len(tests)} tests passed.")
    sys.exit(1 if failed > 0 else 0)
