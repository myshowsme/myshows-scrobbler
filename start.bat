@echo off
chcp 65001 >nul
title MyShows Scrobbler

echo.
echo ========================================
echo   MyShows Scrobbler
echo ========================================
echo.

REM Check Node.js
echo [1/4] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo Node.js not found!
    echo.
    echo Install Node.js 20+ from https://nodejs.org
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo Found: %NODE_VERSION%

echo.
echo [2/4] Checking Vite+...
vp --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo Vite+ CLI not found!
    echo.
    echo Install it with:
    echo powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://vite.plus/ps1 ^| iex"
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('vp --version') do set VP_VERSION=%%i
echo Found: %VP_VERSION%

REM Install dependencies
echo.
echo [3/4] Checking dependencies...
if not exist node_modules (
    echo Installing dependencies...
    call vp install
    if errorlevel 1 (
        echo.
        echo Failed to install dependencies!
        pause
        exit /b 1
    )
    echo Dependencies installed
) else (
    echo Dependencies found
)

REM Start server
echo.
echo [4/4] Starting server...
echo.
echo ========================================
echo   Web UI: http://localhost:3000
echo   Press Ctrl+C to stop
echo ========================================
echo.

call vp run start:ui

pause
