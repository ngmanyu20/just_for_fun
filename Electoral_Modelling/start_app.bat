@echo off
echo ========================================
echo Electoral Modelling - Starting Application
echo ========================================
echo.

REM This tool is fully client-side (no backend). We still need a plain HTTP
REM server because the browser's fetch() (used to load config.json and the
REM default CSV) is blocked by CORS when a page is opened directly via
REM file://. The server root is the PARENT of this folder so the app's
REM relative path to "Result Webpage\data\shapes\df_polygon.csv" resolves.

set PORT=8791
set PYTHON_PATH=E:\Store\Python\venv\Scripts\python.exe
set APP_DIR=%~dp0
set ROOT_DIR=%APP_DIR%..

if exist "%PYTHON_PATH%" (
    echo Using Python from virtual environment: %PYTHON_PATH%
) else (
    echo Virtual environment not found at %PYTHON_PATH%
    echo Falling back to system Python
    set PYTHON_PATH=python
)

"%PYTHON_PATH%" --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not available
    echo Please check your Python installation
    pause
    exit /b 1
)

echo [1/2] Starting static file server on http://localhost:%PORT%...
echo.

start "Electoral Modelling Server (Port %PORT%)" cmd /k ""%PYTHON_PATH%" -m http.server %PORT% --bind 127.0.0.1 --directory "%ROOT_DIR%""

echo Waiting for server to start...
timeout /t 2 /nobreak >nul

echo.
echo [2/2] Opening Electoral Modelling in browser...
echo.

start "" "http://localhost:%PORT%/Electoral_Modelling/index.html"

echo.
echo ========================================
echo Application Started Successfully!
echo ========================================
echo.
echo SERVER RUNNING:
echo - Application: http://localhost:%PORT%/Electoral_Modelling/index.html
echo.
echo IMPORTANT:
echo - Keep the server window open while using the app
echo - Close the window when you're done
echo.
pause
