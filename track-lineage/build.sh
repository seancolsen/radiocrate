#!/usr/bin/env bash
# Builds the track-lineage WASM binding and vendors the output into the frontend
# (mirroring frontend/vendor/querydown-js). Run this whenever src/lib.rs or the
# pinned polyglot-sql version changes; commit the regenerated vendor/ output.
#
#   ./build.sh
#
# Requires: wasm-pack + the wasm32-unknown-unknown target (rustup target add
# wasm32-unknown-unknown). Compiles polyglot-sql for wasm only — never touches
# the app's DuckDB build.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$here/../frontend/vendor/track-lineage"

cd "$here"
wasm-pack build --target web --release --out-dir pkg

mkdir -p "$dest"
# Only the files the frontend imports (the wasm-pack `files` set), not pkg/'s
# .gitignore or build scratch.
cp pkg/package.json \
   pkg/track_lineage.js \
   pkg/track_lineage.d.ts \
   pkg/track_lineage_bg.wasm \
   pkg/track_lineage_bg.wasm.d.ts \
   "$dest/"

echo "vendored -> $dest"
ls -la "$dest"
