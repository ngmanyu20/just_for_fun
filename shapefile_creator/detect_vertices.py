from PIL import Image
import json

def detect_vertices(png_path, target_rgb=(237, 28, 36)):
    img = Image.open(png_path).convert("RGB")
    matches = []
    width, height = img.size
    for y in range(height):
        for x in range(width):
            if img.getpixel((x, y)) == target_rgb:
                matches.append([x, y])
    return matches

coords = detect_vertices("Draft2_redplot.png")
with open("vertices.json", "w") as f:
    json.dump(coords, f)
print(f"Found {len(coords)} vertices -> saved to vertices.json")
