#!/usr/bin/env python3
"""
city_to_svg.py  --  Export a full city road network as SVG from OpenStreetMap.

Replicates the city-roads pipeline (github.com/anvaka/city-roads) but runs
entirely from the command line -- no browser, no viewport clipping.

Usage:
    python city_to_svg.py "London"
    python city_to_svg.py "Tokyo" --filter roads_strict
    python city_to_svg.py "New York City" -o nyc.svg --bg-color "#1a1a2e" --stroke-color "#e94560"

Requires only the Python standard library (no pip installs needed).
"""

import argparse
import json
import math
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Windows sometimes lacks the full CA bundle -- create an unverified context
# for these read-only public API calls (Nominatim + Overpass).
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE


# -- Overpass API backends (mirrors postData.js) --------------------------------
OVERPASS_BACKENDS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.ru/cgi/interpreter",
]

# -- Road/way filters (mirrors Query.js) ----------------------------------------
WAY_FILTERS = {
    "all":          "way",
    "roads":        "way[highway]",
    "roads_basic":  'way[highway~"^(motorway|primary|secondary|tertiary)|residential"]',
    "roads_strict": 'way[highway~"^(((motorway|trunk|primary|secondary|tertiary)(_link)?)'
                    '|unclassified|residential|living_street|pedestrian|service|track)$"][area!=yes]',
    "buildings":    "way[building]",
}


# ==============================================================================
# STEP 1 -- Find city boundary via Nominatim  (mirrors findBoundaryByName.js)
# ==============================================================================

def nominatim_search(city_name: str, auto: bool = False) -> dict:
    """
    Search Nominatim for city_name and return the chosen boundary.

    If Nominatim returns multiple results AND auto=False, the user is shown
    a numbered list and asked to pick one (mirrors the web app's suggestion UI).
    If auto=True, the top result is used without prompting (good for batch use).
    """
    url = (
        "https://nominatim.openstreetmap.org/search"
        f"?format=json&q={urllib.parse.quote(city_name)}&limit=10"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "city-roads-python/1.0"})

    print(f"[*] Searching Nominatim for: {city_name!r}")
    try:
        with urllib.request.urlopen(req, timeout=30, context=_SSL_CTX) as resp:
            results = json.loads(resp.read())
    except Exception as exc:
        raise RuntimeError(f"Nominatim request failed: {exc}") from exc

    if not results:
        raise ValueError(f"No Nominatim results for {city_name!r}")

    # Build a structured list of candidates (relations/ways only — need an area id)
    candidates = []
    for row in results:
        osm_type = row.get("osm_type")
        osm_id   = int(row.get("osm_id", 0))

        if osm_type == "relation":
            area_id = osm_id + 3_600_000_000
        elif osm_type == "way":
            area_id = osm_id + 2_400_000_000
        else:
            area_id = None

        candidates.append({
            "area_id":  area_id,
            "name":     row.get("display_name", city_name),
            "type":     row.get("type", ""),
            "osm_type": osm_type,
            "osm_id":   osm_id,
            "bbox":     row.get("boundingbox"),   # [south, north, west, east]
            "lat":      float(row.get("lat", 0)),
            "lon":      float(row.get("lon", 0)),
        })

    if not candidates:
        raise ValueError(f"Could not extract a usable boundary for {city_name!r}")

    # Only one result — no need to ask
    if len(candidates) == 1 or auto:
        chosen = candidates[0]
        print(f"[+] Using: {chosen['name']}")
        print(f"    osm_type={chosen['osm_type']}  area_id={chosen['area_id']}")
        return chosen

    # Multiple results -- show them and let the user pick (mirrors web app UI)
    print()
    print(f"  Multiple matches found for {city_name!r}:")
    print()
    for i, c in enumerate(candidates, start=1):
        tag = f"({c['type']})" if c["type"] else ""
        print(f"  {i}. {c['name']} {tag}")
    print()

    while True:
        try:
            raw = input(f"  Pick a number [1-{len(candidates)}] (default=1): ").strip()
            if raw == "":
                choice = 1
            else:
                choice = int(raw)
            if 1 <= choice <= len(candidates):
                break
            print(f"  Please enter a number between 1 and {len(candidates)}.")
        except (ValueError, EOFError):
            choice = 1
            break

    chosen = candidates[choice - 1]
    print()
    print(f"[+] Selected: {chosen['name']}")
    print(f"    osm_type={chosen['osm_type']}  area_id={chosen['area_id']}")
    return chosen


# ==============================================================================
# STEP 2 -- Build Overpass query  (mirrors LoadOptions.getQueryTemplate())
# ==============================================================================

def build_overpass_query(boundary: dict, way_filter: str) -> str:
    timeout = 900
    maxsize = 1_073_741_824   # 1 GiB

    if boundary["area_id"]:
        return (
            f"[timeout:{timeout}][maxsize:{maxsize}][out:json];\n"
            f"area({boundary['area_id']});\n"
            f"(._; )->.area;\n"
            f"({way_filter}(area.area); node(w););\n"
            f"out skel;"
        )
    else:
        # bbox fallback -- Overpass wants south,west,north,east
        bb = boundary["bbox"]            # [south, north, west, east]
        bbox_str = f"{bb[0]},{bb[2]},{bb[1]},{bb[3]}"
        return (
            f"[timeout:{timeout}][maxsize:{maxsize}][bbox:{bbox_str}][out:json];\n"
            f"({way_filter}; node(w););\n"
            f"out skel;"
        )


# ==============================================================================
# STEP 3 -- Fetch data from Overpass  (mirrors postData.js)
# ==============================================================================

def fetch_overpass(query: str) -> list:
    """
    Fetch OSM data from Overpass API.
    Tries GET first (works on overpass-api.de), falls back to POST for mirrors.
    """
    encoded   = urllib.parse.quote(query)
    post_body = urllib.parse.urlencode({"data": query}).encode("utf-8")
    post_hdrs = {"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"}
    ua_hdr    = {"User-Agent": "city-roads-python/1.0"}

    for i, backend in enumerate(OVERPASS_BACKENDS):
        host = backend.split("/")[2]
        print(f"[~]  Querying Overpass ({host})  [attempt {i + 1}/{len(OVERPASS_BACKENDS)}]")

        # Try GET first, then POST
        attempts = [
            urllib.request.Request(backend + "?data=" + encoded, headers=ua_hdr),
            urllib.request.Request(backend, data=post_body, headers={**ua_hdr, **post_hdrs}),
        ]
        last_exc = None
        for req in attempts:
            try:
                with urllib.request.urlopen(req, timeout=180, context=_SSL_CTX) as resp:
                    result = json.loads(resp.read())
                if "elements" not in result:
                    raise ValueError("Overpass response missing 'elements' key")
                print(f"[+]  Received {len(result['elements']):,} elements")
                return result["elements"]
            except Exception as exc:
                last_exc = exc

        print(f"[!]  Backend failed: {last_exc}")
        if i < len(OVERPASS_BACKENDS) - 1:
            time.sleep(3)

    raise RuntimeError("All Overpass backends failed -- check your internet connection.")


# ==============================================================================
# STEP 4 -- Mercator projection  (mirrors Grid.getProjector() in Grid.js)
#
#   d3-geo geoMercator().center([cx, cy]).scale(6371393)
#   The Grid negates y so it increases upward: y: -xyPoint[1]
# ==============================================================================

_MAX_LAT_RAD = 1.4844222297453324   # ≈ 85.05° -- Mercator limit

def _merc_y(lat_deg: float) -> float:
    lat_rad = max(-_MAX_LAT_RAD, min(_MAX_LAT_RAD, math.radians(lat_deg)))
    return math.log(math.tan(math.pi / 4 + lat_rad / 2))

def project(lon: float, lat: float, center_lon: float, center_lat: float,
            scale: float = 6_371_393) -> tuple[float, float]:
    """Return (x, y) in projected metres. y increases upward (Grid.js convention)."""
    x =  scale * math.radians(lon - center_lon)
    y =  scale * (_merc_y(lat) - _merc_y(center_lat))   # upward-positive
    return x, y


# ==============================================================================
# STEP 5 -- Generate SVG  (mirrors Grid.forEachWay + GridLayer)
#
# KEY DIFFERENCE FROM THE WEB APP:
#   We iterate every way in the dataset -- no camera, no viewport, no clipping.
#   The result is always the complete city regardless of zoom or pan.
# ==============================================================================

def generate_svg(elements: list, boundary: dict, opts: dict) -> str:
    # -- Split elements into nodes and ways ------------------------------------
    print("[#]  Parsing nodes and ways...")
    raw_nodes: dict[int, tuple[float, float]] = {}   # id -> (lon, lat)
    ways: list[dict] = []

    for el in elements:
        t = el.get("type")
        if t == "node":
            raw_nodes[el["id"]] = (el["lon"], el["lat"])
        elif t == "way":
            ways.append(el)

    print(f"    nodes={len(raw_nodes):,}  ways={len(ways):,}")
    if not raw_nodes or not ways:
        raise ValueError("No usable road data returned -- try a different city name or filter.")

    # -- Centre of bounding box (for Mercator) ---------------------------------
    lons = [v[0] for v in raw_nodes.values()]
    lats = [v[1] for v in raw_nodes.values()]
    cx = (min(lons) + max(lons)) / 2
    cy = (min(lats) + max(lats)) / 2

    # -- Project every node ----------------------------------------------------
    print("[M]   Projecting coordinates (Mercator)...")
    proj: dict[int, tuple[float, float]] = {
        nid: project(lon, lat, cx, cy)
        for nid, (lon, lat) in raw_nodes.items()
    }

    # -- Projected bounding box ------------------------------------------------
    xs = [p[0] for p in proj.values()]
    ys = [p[1] for p in proj.values()]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    w = max_x - min_x
    h = max_y - min_y

    pad       = opts.get("padding",      20)
    svg_w     = w + pad * 2
    svg_h     = h + pad * 2

    # -- Build polyline elements -----------------------------------------------
    print("[>]   Building SVG polylines...")
    lines: list[str] = []
    skipped = 0

    for way in ways:
        node_ids = way.get("nodes", [])
        pts: list[str] = []

        for nid in node_ids:
            p = proj.get(nid)
            if p is None:
                continue
            # SVG: x increases right, y increases DOWN  ->  flip projected y
            sx = p[0] - min_x + pad
            sy = max_y - p[1] + pad
            pts.append(f"{sx:.2f},{sy:.2f}")

        if len(pts) >= 2:
            lines.append(f'    <polyline points="{" ".join(pts)}"/>')
        else:
            skipped += 1

    if skipped:
        print(f"    [!]  Skipped {skipped} ways with fewer than 2 resolved nodes")
    print(f"    Generated {len(lines):,} polylines")

    # -- Assemble SVG ----------------------------------------------------------
    stroke  = opts.get("stroke_color",  "#333333")
    bg      = opts.get("bg_color",      "#f7f2e8")
    sw      = opts.get("stroke_width",  0.5)
    title   = boundary["name"].split(",")[0]

    svg = "\n".join([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- Generator: city-roads-python',
        '     Data © OpenStreetMap contributors, ODbL 1.0. https://osm.org/copyright',
        f'     City: {title} -->',
        f'<svg xmlns="http://www.w3.org/2000/svg"',
        f'     viewBox="0 0 {svg_w:.2f} {svg_h:.2f}"',
        f'     width="{svg_w:.0f}" height="{svg_h:.0f}">',
        f'  <title>{title}</title>',
        f'  <rect width="100%" height="100%" fill="{bg}"/>',
        f'  <g stroke="{stroke}" fill="none" stroke-width="{sw}"',
         '     stroke-linecap="round" stroke-linejoin="round">',
        *lines,
        '  </g>',
        '</svg>',
    ])
    return svg


# ==============================================================================
# CLI
# ==============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Export a full city road network as SVG from OpenStreetMap.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Road filter presets (--filter):
  all            Every OSM way
  roads          Every tagged highway  [default]
  roads_basic    Motorway / primary / secondary / tertiary / residential
  roads_strict   Strict driveable roads (no paths, tracks, etc.)
  buildings      Building footprints instead of roads

Examples:
  python city_to_svg.py "London"
  python city_to_svg.py "Tokyo" --filter roads_strict
  python city_to_svg.py "Paris" -o paris_dark.svg --bg-color "#0d0d0d" --stroke-color "#ffffff"
  python city_to_svg.py "Singapore" --stroke-width 1 --padding 50
""")

    parser.add_argument("city",
        help='City name, e.g. "London" or "New York City"')
    parser.add_argument("--filter", "-f",
        choices=list(WAY_FILTERS), default="roads",
        metavar="FILTER",
        help="Way filter preset (see below). Default: roads")
    parser.add_argument("--output", "-o",
        help="Output filename. Default: <city_name>.svg")
    parser.add_argument("--stroke-color",  default="#333333",
        help="Road colour (hex). Default: #333333")
    parser.add_argument("--bg-color",      default="#f7f2e8",
        help="Background colour (hex). Default: #f7f2e8")
    parser.add_argument("--stroke-width",  type=float, default=0.5,
        help="Stroke width in SVG units. Default: 0.5")
    parser.add_argument("--padding",       type=int,   default=20,
        help="Padding in SVG units around the city. Default: 20")
    parser.add_argument("--auto", action="store_true",
        help="Skip the disambiguation prompt and always use the top Nominatim result.")

    args = parser.parse_args()

    output = args.output or (args.city.lower().replace(" ", "_") + ".svg")

    print()
    print("+======================================+")
    print("|   City Roads  --  Full SVG Exporter   |")
    print("+======================================+")
    print(f"  City:         {args.city}")
    print(f"  Filter:       {args.filter}  ({WAY_FILTERS[args.filter]})")
    print(f"  Output:       {output}")
    print(f"  Style:        stroke={args.stroke_color}  bg={args.bg_color}  width={args.stroke_width}")
    print()

    try:
        # 1. Nominatim lookup (with interactive disambiguation if multiple matches)
        boundary = nominatim_search(args.city, auto=args.auto)
        time.sleep(1)   # Nominatim usage policy: ≤1 req/s

        # 2. Overpass fetch
        way_filter = WAY_FILTERS[args.filter]
        query      = build_overpass_query(boundary, way_filter)
        elements   = fetch_overpass(query)

        # 3. Generate SVG
        opts = {
            "stroke_color":  args.stroke_color,
            "bg_color":      args.bg_color,
            "stroke_width":  args.stroke_width,
            "padding":       args.padding,
        }
        svg = generate_svg(elements, boundary, opts)

        # 4. Save
        with open(output, "w", encoding="utf-8") as fh:
            fh.write(svg)

        kb = len(svg.encode()) / 1024
        print()
        print(f"[+]  Saved -> {output}  ({kb:,.1f} KB)")

    except KeyboardInterrupt:
        print("\n[!]  Cancelled.")
        sys.exit(1)
    except Exception as exc:
        print(f"\n[ERROR]  {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
