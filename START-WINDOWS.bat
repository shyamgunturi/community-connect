@echo off
title Community Connect
cd /d "%~dp0"
echo.
echo  ==== Community Connect ====
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed. Download the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo  Node.js 20 or newer is required. Please install the current LTS from https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\better-sqlite3" (
  echo  Installing packages - first run only, this can take a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo  npm install failed. See README.md, section Troubleshooting.
    pause
    exit /b 1
  )
)
echo  Opening http://localhost:3000 in your browser...
start "" http://localhost:3000
echo  Press Ctrl+C in this window to stop the server.
echo.
call npm start
pause
