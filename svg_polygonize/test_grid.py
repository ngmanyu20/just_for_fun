"""
Generate a synthetic grid-street SVG and run the polygonizer on it.
Useful for verifying the pipeline before using a real SVG.
"""

import os
from svg_street_polygonizer import polygonize_svg

GRID_SVG = "test_grid_streets.svg"

def make_grid_svg(rows: int = 4, cols: int = 4, spacing: int = 100, margin: int = 50) -> None:
    W = cols * spacing + 2 * margin
    H = rows * spacing + 2 * margin
    lines = []

    # Horizontal streets
    for r in range(rows + 1):
        y = margin + r * spacing
        lines.append(f'  <line x1="{margin}" y1="{y}" x2="{W - margin}" y2="{y}" stroke="black" stroke-width="2"/>')

    # Vertical streets
    for c in range(cols + 1):
        x = margin + c * spacing
        lines.append(f'  <line x1="{x}" y1="{margin}" x2="{x}" y2="{H - margin}" stroke="black" stroke-width="2"/>')

    svg = f"""<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <rect width="{W}" height="{H}" fill="white"/>
{chr(10).join(lines)}
</svg>"""

    with open(GRID_SVG, "w") as f:
        f.write(svg)
    print(f"Generated test SVG: {GRID_SVG}  ({rows}x{cols} grid → expect {rows*cols} polygons)")


if __name__ == "__main__":
    make_grid_svg(rows=4, cols=4)
    polygonize_svg(GRID_SVG)
