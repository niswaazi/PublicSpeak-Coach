@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
  echo Python 3.13 is required. Install it from python.org, then run this file again.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating the Python 3.13 environment...
  py -3.13 -m venv .venv
  if errorlevel 1 goto setup_failed
)

".venv\Scripts\python.exe" -m pip show fastapi uvicorn mediapipe >nul 2>nul
if errorlevel 1 (
  echo Installing app dependencies...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto setup_failed
)

echo.
echo PublicSpeak Coach is starting at http://127.0.0.1:8000
echo Keep this window open while using the app. Press Ctrl+C to stop.
echo.
".venv\Scripts\python.exe" -m uvicorn server:app --host 127.0.0.1 --port 8000
if errorlevel 1 goto server_failed
exit /b 0

:setup_failed
echo.
echo Setup failed. Check your internet connection and Python 3.13 installation.
pause
exit /b 1

:server_failed
echo.
echo The server did not start. Port 8000 may already be in use.
pause
exit /b 1
