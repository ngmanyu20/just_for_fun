"""
build_lean_shapes.py -- generates the "join-only" shape CSVs the data layer
uses for pages that never render a map (the election overview, seat lists,
referendum authority/county rollups -- see election-site/js/data/shapes.js's
getShapeJoinIndex()).

Why this exists: shapes/df_polygon.csv, df_county.csv and df_constituency.csv
carry a `geometry` (WKT polygon) and `centroid` column that dominates their
file size (df_polygon.csv alone is ~8MB, almost entirely geometry text) even
though most pages only need the plain join columns (Shape_ID, Constituency,
District, ...) to group results -- not the shape to draw. Map-rendering pages
still read the original, unmodified files (via shapes.js's getShapeIndex())
and are untouched by this script.

Run this any time the source shapes/*.csv files change (they're regenerated
by the notebooks under shapefile/). It's also wired up as this site's Render
build command (see render.yaml) so a fresh deploy always regenerates the lean
files from whatever shapes/*.csv landed in that commit, instead of relying on
someone remembering to run it and commit the output.

Pure stdlib, no dependencies -- deliberately cheap enough to run on every
deploy.
"""

import csv
import sys
from pathlib import Path

DATA_ROOT = Path(__file__).resolve().parent.parent / "data"

# (source file, output file) -- output gets every column from the source
# EXCEPT `geometry`/`centroid`. Only files actually read by the join-only
# code path (shapes.js's getShapeJoinIndex()) need a lean counterpart.
SOURCES = [
    (DATA_ROOT / "shapes" / "df_polygon.csv", DATA_ROOT / "shapes" / "df_polygon_lean.csv"),
    (DATA_ROOT / "shapes" / "df_county.csv", DATA_ROOT / "shapes" / "df_county_lean.csv"),
    (DATA_ROOT / "shapes" / "df_constituency.csv", DATA_ROOT / "shapes" / "df_constituency_lean.csv"),
]

DROP_COLUMNS = {"geometry", "centroid"}


def build_lean_csv(src: Path, dest: Path) -> None:
    if not src.exists():
        raise FileNotFoundError(f"build_lean_shapes: source file missing: {src}")

    with src.open("r", encoding="utf-8-sig", newline="") as f_in:
        reader = csv.reader(f_in)
        header = next(reader)
        keep_idx = [i for i, col in enumerate(header) if col not in DROP_COLUMNS]
        lean_header = [header[i] for i in keep_idx]

        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("w", encoding="utf-8", newline="") as f_out:
            writer = csv.writer(f_out)
            writer.writerow(lean_header)
            row_count = 0
            for row in reader:
                writer.writerow([row[i] if i < len(row) else "" for i in keep_idx])
                row_count += 1

    src_size = src.stat().st_size
    dest_size = dest.stat().st_size
    saved_pct = 100 * (1 - dest_size / src_size) if src_size else 0
    print(
        f"  {src.name} -> {dest.name}: {row_count} rows, "
        f"{src_size / 1024:.0f}KB -> {dest_size / 1024:.0f}KB ({saved_pct:.0f}% smaller)"
    )


def main() -> int:
    print(f"build_lean_shapes: data root = {DATA_ROOT}")
    for src, dest in SOURCES:
        try:
            build_lean_csv(src, dest)
        except FileNotFoundError as exc:
            print(f"  SKIPPED: {exc}", file=sys.stderr)
            return 1
    print("build_lean_shapes: done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
