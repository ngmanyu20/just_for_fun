@echo off
setlocal
cd /d "%~dp0"

echo Regenerating lean shape CSVs (scripts\build_lean_shapes.py) -- same step Render runs on deploy...
python scripts\build_lean_shapes.py
if errorlevel 1 (
  echo build_lean_shapes.py failed -- see above. Not starting the server.
  exit /b 1
)

echo Starting local server for "Result Webpage" on http://localhost:8080 ...
echo (data/ must be served from this folder, not from election-site/, or fetches will fail.)
echo (Uses serve_no_cache.py instead of plain http.server so browsers never cache stale JS/CSS.)

start "Election Site Server" cmd /k "python serve_no_cache.py 8080"

timeout /t 2 /nobreak >nul

start "" "http://localhost:8080/election-site/index.html"

endlocal
