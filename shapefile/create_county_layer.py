"""
Create county-level merged polygons from sub-county CSV
Uses Shapely to properly merge geometries
"""

from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely import wkt
import csv

def load_csv(filepath):
    """Load the sub-county CSV file"""
    rows = []
    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    return rows

def merge_county_polygons_by_county(rows):
    """Merge all sub-county polygons by county"""

    # Group by County column
    counties = {}

    for row in rows:
        county_name = row.get('County', '')
        shape_value = row.get('Shape', '')
        wkt_str = row['geometry']

        try:
            # Parse WKT to Shapely polygon
            polygon = wkt.loads(wkt_str)

            if county_name not in counties:
                counties[county_name] = {
                    'polygons': [],
                    'shape': shape_value  # Store the Shape value from first polygon
                }

            counties[county_name]['polygons'].append(polygon)
        except Exception as e:
            print(f"Error parsing polygon for {county_name}: {e}")
            continue

    # Merge polygons for each county
    merged_counties = []

    for county_name, county_data in counties.items():
        polygons = county_data['polygons']
        shape_value = county_data['shape']

        print(f"Merging {len(polygons)} polygons for {county_name}...")

        # Use unary_union to merge all polygons
        merged = unary_union(polygons)

        # Convert back to WKT
        wkt_str = merged.wkt

        merged_counties.append({
            'County': county_name,
            'Parent': county_name,
            'Shape': shape_value,
            'geometry': wkt_str
        })

    return merged_counties

def main():
    input_file = r'test\stage1_subdivided_synced_polygons.csv'
    output_file = r'test\county_layer.csv'

    print(f"Loading {input_file}...")
    rows = load_csv(input_file)

    # Get unique counties (use County column)
    counties_found = set()
    for row in rows:
        county = row.get('County', '')
        if county:
            counties_found.add(county)

    print(f"Found {len(rows)} sub-county polygons")
    print(f"Counties: {sorted(counties_found)}")

    print("\nMerging polygons by county...")
    county_rows = merge_county_polygons_by_county(rows)

    print(f"\nCreated {len(county_rows)} county polygons")

    # Save county layer (matching sub-county CSV format for easy switching)
    with open(output_file, 'w', newline='', encoding='utf-8') as f:
        # Use same format as input file for compatibility
        fieldnames = ['', 'County', 'Shape_ID', 'Shape', 'geometry']
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        # Write county polygons with empty index and Shape_ID
        for idx, county_row in enumerate(county_rows):
            writer.writerow({
                '': str(idx),
                'County': county_row['County'],
                'Shape_ID': '',  # Empty for county-level (used to identify county vs sub-county)
                'Shape': county_row['Shape'],
                'geometry': county_row['geometry']
            })

    print(f"Saved county layer to {output_file}")
    print(f"\nWorkflow:")
    print(f"  1. Sub-county view: Load {input_file} ({len(rows)} polygons)")
    print(f"  2. County view: Load {output_file} ({len(county_rows)} polygons)")
    print(f"  3. Toggle between layers in the browser")

if __name__ == '__main__':
    main()
