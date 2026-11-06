@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Python launcher py.exe not found. Install Python 3.10+ and retry.
  pause
  exit /b 1
)
py -3 tools\ontos_memory.py --db private\ontos-memory.sqlite3 init
if errorlevel 1 (
  echo Initialization failed.
  pause
  exit /b 1
)
echo Ready. See docs\ARCHITECTURE-MEMORY.md for import and search.
pause