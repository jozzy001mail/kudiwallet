#!/bin/sh
# KudiWallet — one-command setup: install, build the bundle, start the server.
set -e
cd "$(dirname "$0")"
npm install
npm run build
npm test
echo ""
echo "Starting KudiWallet on http://localhost:3000 (Bitcoin testnet)"
npm start
