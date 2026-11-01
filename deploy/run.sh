#!/usr/bin/env bash
# pm2 starts this wrapper so the engine yields to the other sites on the VPS.
# Environment variables come from server/.env (see .env.example).
set -euo pipefail

cd "$(dirname "$0")/../server"

# ionice is util-linux; skip it when the host does not have it (containers).
if command -v ionice >/dev/null 2>&1; then
	exec nice -n 10 ionice -c2 -n7 node --enable-source-maps dist/index.js
fi
exec nice -n 10 node --enable-source-maps dist/index.js
