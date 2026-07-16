#!/usr/bin/env bash
# Installs corral by symlinking this repository's extension into OMP.
# ./install.sh              user-level (~/.omp/agent/extensions)
# ./install.sh --project    project-level (./.omp/extensions)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/corral.ts"
if [[ "${1:-}" == "--project" ]]; then
  DEST_DIR="$(pwd)/.omp/extensions"
  SKILL_DEST_DIR="$(pwd)/.omp/skills/corral"
else
  DEST_DIR="$HOME/.omp/agent/extensions"
  SKILL_DEST_DIR="$HOME/.omp/agent/skills/corral"
fi
mkdir -p "$DEST_DIR"
DEST="$DEST_DIR/corral.ts"
if [[ -L "$DEST" || -e "$DEST" ]]; then rm -f "$DEST"; fi
ln -s "$SRC" "$DEST"
echo "corral installed: $DEST -> $SRC"

SKILL_SRC="$SCRIPT_DIR/SKILL.md"
mkdir -p "$SKILL_DEST_DIR"
SKILL_DEST="$SKILL_DEST_DIR/SKILL.md"
if [[ -L "$SKILL_DEST" || -e "$SKILL_DEST" ]]; then rm -f "$SKILL_DEST"; fi
ln -s "$SKILL_SRC" "$SKILL_DEST"
echo "corral skill installed: $SKILL_DEST -> $SKILL_SRC"
