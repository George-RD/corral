#!/usr/bin/env bash
# Installs corral by symlinking this repository's extension into OMP.
# ./install.sh              user-level (~/.omp/agent/extensions)
# ./install.sh --project    project-level (./.omp/extensions)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/corral.ts"
if [[ "${1:-}" == "--project" ]]; then
  DEST_DIR="$(pwd)/.omp/extensions"
else
  DEST_DIR="$HOME/.omp/agent/extensions"
fi
mkdir -p "$DEST_DIR"
DEST="$DEST_DIR/corral.ts"
if [[ -L "$DEST" || -e "$DEST" ]]; then rm -f "$DEST"; fi
ln -s "$SRC" "$DEST"
echo "corral installed: $DEST -> $SRC"
