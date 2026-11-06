#!/bin/sh
# Starts the Music Theorizer AI helper. Leave the terminal open while you use the app.
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || { echo "Run sh setup.sh first."; exit 1; }
exec .venv/bin/python server.py "$@"
