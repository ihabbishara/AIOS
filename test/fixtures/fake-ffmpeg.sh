#!/bin/sh
# Mimics: ffmpeg -y -i <in> ... <out>  — copies input to the LAST argument.
in=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-i" ]; then in="$a"; fi
  prev="$a"
  out="$a"
done
cp "$in" "$out"
