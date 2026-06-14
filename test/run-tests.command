#!/bin/bash
# Lance le harnais de test Promptimizer (double-clic macOS). N'écrit jamais dans ~/.claude.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "node introuvable dans le PATH." >&2
  exit 1
fi

node "$HERE/run-tests.js"
CODE=$?
echo ""
echo "(Entrée pour fermer)"
read -r _ || true
exit "$CODE"
