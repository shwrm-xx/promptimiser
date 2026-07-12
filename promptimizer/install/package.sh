#!/bin/bash
# Lanceur Linux — toute la logique est dans package.js (source de vérité unique cross-platform).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "ERREUR : 'node' introuvable dans le PATH. Installe Node.js (nodejs.org) puis relance." >&2
  echo "Appuie sur Entrée pour fermer." ; read -r _ ; exit 1
fi
exec node "$DIR/package.js" "$@"
