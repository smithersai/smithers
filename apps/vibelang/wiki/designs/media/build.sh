#!/bin/sh
# Assembles index.html: the live stylesheet verbatim + this design's extra CSS + body.html.
set -e
cd "$(dirname "$0")"
output=$(mktemp ./index.html.XXXXXX)
trap 'rm -f "$output"' EXIT
trap 'exit 1' HUP INT TERM
{
  printf '%s\n' '<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>Marketing media placements — vibelang.smithers.sh design</title><link rel="icon" href="media/icon.svg" type="image/svg+xml"><style>'
  cat ../refs/live-app.css
  printf '%s\n' '</style><style>'
  cat extra.css
  printf '%s\n' '</style></head><body>'
  cat body.html
  printf '%s\n' '</body></html>'
} > "$output"
chmod 0644 "$output"
mv -f "$output" index.html
