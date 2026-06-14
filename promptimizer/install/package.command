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

# Script de déblocage Gatekeeper (à lancer une seule fois sur l'autre ordi)
DEBLOCK="$OUT/debloquer.command"
cat > "$DEBLOCK" <<'DEBLOCK_EOF'
#!/bin/bash
# Retire l'attribut quarantine macOS sur tous les scripts Promptimizer.
# À lancer UNE FOIS après avoir décompressé l'archive.
DIR="$(cd "$(dirname "$0")" && pwd)"
xattr -dr com.apple.quarantine "$DIR"
echo "Quarantine retirée. Tu peux maintenant double-cliquer les scripts."
echo "Appuie sur Entrée pour fermer."
read -r _
DEBLOCK_EOF
chmod +x "$DEBLOCK"

# README à la racine de l'archive
cat > "$OUT/LIRE-MOI.txt" <<'README_EOF'
Promptimizer — Installation
============================

macOS bloque les scripts reçus par transfert (message "logiciel malveillant").
ÉTAPE 0 — À faire UNE SEULE FOIS avant tout :

  Double-clic sur : debloquer.command
  (ou clic droit → Ouvrir si macOS bloque aussi ce fichier)

Ensuite :
  Claude Code → double-clic : promptimizer/install/install.command
  Codex (opt) → double-clic : codex/install-codex.command

Prérequis : Node.js installé (nodejs.org).
README_EOF

# Zip sans attributs étendus (-X) pour limiter la propagation quarantine
(cd "$WORK" && zip -qrX "$DEST_ZIP" "$ARCHIVE_NAME")
rm -rf "$WORK"

if [ -f "$DEST_ZIP" ]; then
  echo "Archive créée : $DEST_ZIP"
  echo
  echo "Sur l'autre ordi :"
  echo "  0. Double-clic sur debloquer.command (déblocage Gatekeeper, une fois)"
  echo "  1. Claude Code → double-clic : ${ARCHIVE_NAME}/promptimizer/install/install.command"
  echo "     (Prérequis : Node.js installé)"
  echo "  2. Codex (optionnel) → double-clic : ${ARCHIVE_NAME}/codex/install-codex.command"
else
  echo "ERREUR : l'archive n'a pas été créée." >&2
  echo "Appuie sur Entrée pour fermer." ; read -r _ ; exit 1
fi

echo
echo "Appuie sur Entrée pour fermer."
read -r _
