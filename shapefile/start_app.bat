@echo off
echo ========================================
echo Polygon Editor - Starting Application
echo ========================================
echo.

REM Set the Python path (adjust if your virtual environment is in a different location)
set PYTHON_PATH=E:\Store\Python\venv\Scripts\python.exe

REM Check if the virtual environment Python exists
if exist "%PYTHON_PATH%" (
    echo Using Python from virtual environment: %PYTHON_PATH%
) else (
    echo Virtual environment not found at %PYTHON_PATH%
    echo Falling back to system Python
    set PYTHON_PATH=python
)

REM Verify Python is available
"%PYTHON_PATH%" --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not available
    echo Please check your Python installation
    pause
    exit /b 1
)

echo [1/2] Starting Application Server on http://localhost:8000...
echo.

REM Start the server in a new window using FastAPI (uvicorn)
start "Polygon Editor Server (Port 8000)" cmd /k ""%PYTHON_PATH%" -m uvicorn app:app --host 0.0.0.0 --port 8000"

echo Waiting for server to start...
timeout /t 3 /nobreak >nul

echo.
echo [2/2] Opening Polygon Editor in browser...
echo.

REM Open the application in default browser
start "" "http://localhost:8000/shapefile/index.html"

echo.
echo ========================================
echo Application Started Successfully!
echo ========================================
echo.
echo SERVER RUNNING:
echo - Application:    http://localhost:8000
echo - API Endpoints:  http://localhost:8000/merge-county
echo                   http://localhost:8000/split
echo.
echo IMPORTANT:
echo - Keep the server window open while using the app
echo - Close the window when you're done
echo.
echo Features Available:
echo - Split Polygon: Select a polygon and click Split
echo - Combine Polygons: Ctrl+Click multiple polygons and click Combine
echo - Delete Vertex: Shift+Click vertex, then press Delete/Backspace
echo - Replace Vertex: Shift+Click vertex, drag to adjacent vertex
echo - Create Midpoints: Shift+Click 2+ adjacent vertices, press M
echo.
pause
