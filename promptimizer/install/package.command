#!/bin/bash
# Génère une archive Promptimizer autonome (sans Git requis sur l'autre ordi).
# Double-clic → crée Promptimizer-YYYYMMDD.zip sur le Bureau.
set -u

PMZ_SRC="$(cd "$(dirname "$0")/.." && pwd)"   # .../promptimizer
REPO="$(cd "$PMZ_SRC/.." && pwd)"             # racine du dépôt source
DATE="$(date +%Y%m%d)"
ARCHIVE_NAME="Promptimizer-${DATE}"
WORK="$(mktemp -d)"
OUT="$WORK/$ARCHIVE_NAME"
DEST_ZIP="$HOME/Desktop/${ARCHIVE_NAME}.zip"

echo "── Promptimizer — packaging ──"
echo "Source  : $REPO"
echo "Archive : $DEST_ZIP"
echo

# Structure autonome :
#   Promptimizer-YYYYMMDD/
#     promptimizer/         (package Claude Code complet)
#     skills/promptimizer/  (skill globale Claude Code)
#     codex/                (delta Codex : AGENTS.md + pmz-codex + install-codex.command)
mkdir -p "$OUT/skills"

cp -R "$PMZ_SRC" "$OUT/"
if [ -d "$REPO/skills/promptimizer" ]; then
  cp -R "$REPO/skills/promptimizer" "$OUT/skills/"
fi
if [ -d "$REPO/codex" ]; then
  cp -R "$REPO/codex" "$OUT/"
fi

# Permissions + quarantine dans l'archive
chmod +x "$OUT/promptimizer/install/"*.command 2>/dev/null || true
chmod +x "$OUT/promptimizer/hooks/"*.js "$OUT/promptimizer/scripts/"*.js 2>/dev/null || true
chmod +x "$OUT/codex/install-codex.command" "$OUT/codex/pmz-codex" 2>/dev/null || true

# Zip (dossier de base = $ARCHIVE_NAME pour que l'extraction soit propre)
(cd "$WORK" && zip -qr "$DEST_ZIP" "$ARCHIVE_NAME")
rm -rf "$WORK"

if [ -f "$DEST_ZIP" ]; then
  echo "Archive créée : $DEST_ZIP"
  echo
  echo "Sur l'autre ordi :"
  echo "  1. Transfère le .zip et décompresse-le."
  echo "  2. Claude Code → double-clic : ${ARCHIVE_NAME}/promptimizer/install/install.command"
  echo "     (Prérequis : Node.js installé)"
  echo "  3. Codex (optionnel) → double-clic : ${ARCHIVE_NAME}/codex/install-codex.command"
else
  echo "ERREUR : l'archive n'a pas été créée." >&2
  echo "Appuie sur Entrée pour fermer." ; read -r _ ; exit 1
fi

echo
echo "Appuie sur Entrée pour fermer."
read -r _
