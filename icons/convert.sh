#!/bin/bash
# Convert SVG icons to PNG format for different sizes using rsvg-convert.
# rsvg-convert can be installed via package managers (e.g., `brew install librsvg`).
# Usage: ./convert.sh <input-svg>

INPUT=$1

if [ -z "$INPUT" ]; then
  echo "Usage: $0 <input-svg>"
  exit 1
fi

cd "$(dirname "$0")"

rsvg-convert -w 128 -h 128 $INPUT -o icon128.png 
rsvg-convert -w 48 -h 48 $INPUT -o icon48.png
rsvg-convert -w 16 -h 16 $INPUT -o icon16.png
