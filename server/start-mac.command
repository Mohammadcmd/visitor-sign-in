#!/bin/bash
# Visitor Sign-In on this Mac: double-click to start it, and keep this window open.
# Needs Node.js 22 or newer from https://nodejs.org/ (the LTS installer).
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1; then echo "Install Node.js from https://nodejs.org/ first, then double-click this again."; read -r; exit 1; fi
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --disable-warning=ExperimentalWarning server/visitor-server.mjs "$@"
