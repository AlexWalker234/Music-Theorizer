#!/bin/sh
# Builds the desktop app for Windows, macOS and Linux into desktop/dist.
# Needs Go 1.22+. Run from anywhere: sh desktop/build.sh
set -e
cd "$(dirname "$0")"
rm -rf web dist && mkdir -p web dist
cp ../index.html web/ && cp -r ../css ../js web/
export CGO_ENABLED=0
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w -H windowsgui" -o "dist/Music Theorizer.exe" .
GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o "dist/music-theorizer-mac-apple-silicon" .
GOOS=darwin  GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o "dist/music-theorizer-mac-intel" .
GOOS=linux   GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o "dist/music-theorizer-linux" .
rm -rf web
ls -la dist
