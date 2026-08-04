@echo off
setlocal
cd /d "%~dp0"

echo Regenerating lean shape CSVs (scripts\build-lean-shapes.mjs) -- same step Render runs on deploy...
node scripts\build-lean-shapes.mjs
if errorlevel 1 (
  echo build-lean-shapes.mjs failed -- see above. Not starting the server.
  exit /b 1
)

echo Starting local server for "Result Webpage" on http://localhost:8080 ...
echo (data/ must be served from this folder, not from election-site/, or fetches will fail.)
echo (Uses serve_no_cache.py instead of plain http.server so browsers never cache stale JS/CSS.)

start "Election Site Server" cmd /k "python serve_no_cache.py 8080"

timeout /t 2 /nobreak >nul

start "" "http://localhost:8080/election-site/index.html"

endlocal
