import http.server
import json
import os
import urllib.parse

from PIL import Image

PORT = 8080
VERTICES_FILE = "vertices.json"
PNG_FILE = "Draft2_redplot.png"
TARGET_RGB = (237, 28, 36)


def detect_vertices(png_path, target_rgb):
    img = Image.open(png_path).convert("RGB")
    matches = []
    for y in range(img.height):
        for x in range(img.width):
            if img.getpixel((x, y)) == target_rgb:
                matches.append([x, y])
    return matches


class Handler(http.server.SimpleHTTPRequestHandler):

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path == "/detect":
            if not os.path.exists(PNG_FILE):
                self.send_error(404, f"{PNG_FILE} not found in server directory")
                return
            print(f"[server] Running detection on {PNG_FILE}...")
            coords = detect_vertices(PNG_FILE, TARGET_RGB)
            with open(VERTICES_FILE, "w") as f:
                json.dump(coords, f)
            print(f"[server] {len(coords)} vertices saved to {VERTICES_FILE}")
            body = json.dumps(coords).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return

        # Everything else: serve as static file
        super().do_GET()

    def log_message(self, format, *args):
        print(f"[server] {self.address_string()} - {format % args}")


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f"[server] Serving at http://localhost:{PORT}")
    print(f"[server] GET /detect  → run detection and save {VERTICES_FILE}")
    http.server.test(HandlerClass=Handler, port=PORT, bind="127.0.0.1")
