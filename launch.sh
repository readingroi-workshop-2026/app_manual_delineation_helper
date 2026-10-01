#!/usr/bin/env bash
# Run the surface viewer. Meant to be run on a remote host (e.g. cajal03)
# behind an ssh -L tunnel — see README.md.
#
# Usage: ./launch.sh [port]   (default port 8501)
set -e
cd "$(dirname "$0")"

PORT="${1:-8501}"

uv run app.py --port "$PORT" --no-open
