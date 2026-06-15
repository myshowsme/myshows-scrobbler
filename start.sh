#!/bin/bash

echo ""
echo "========================================"
echo "  MyShows Scrobbler"
echo "========================================"
echo ""

# Check Node.js
echo "[1/4] Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo ""
    echo "Node.js not found!"
    echo ""
    echo "Install Node.js 20+ from https://nodejs.org"
    echo ""
    exit 1
fi

NODE_VERSION=$(node --version)
echo "Found: $NODE_VERSION"

NODE_MAJOR=$(echo $NODE_VERSION | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo ""
    echo "Node.js 20 or higher required!"
    echo "Your version: $NODE_VERSION"
    echo ""
    exit 1
fi

echo ""
echo "[2/4] Checking Vite+..."
if ! command -v vp &> /dev/null; then
    echo ""
    echo "Vite+ CLI not found!"
    echo ""
    echo "Install it with: curl -fsSL https://vite.plus | bash"
    echo ""
    exit 1
fi
echo "Found: $(vp --version)"

# Install dependencies
echo ""
echo "[3/4] Checking dependencies..."
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    vp install
    if [ $? -ne 0 ]; then
        echo ""
        echo "Failed to install dependencies!"
        exit 1
    fi
    echo "Dependencies installed"
else
    echo "Dependencies found"
fi

# Start server
echo ""
echo "[4/4] Starting server..."
echo ""
echo "========================================"
echo "  Web UI: http://localhost:3000"
echo "  Press Ctrl+C to stop"
echo "========================================"
echo ""

vp run start:ui
