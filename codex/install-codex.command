#!/bin/bash
# Installeur Promptimizer — delta Codex.
# Double-clic macOS, sans sudo.
# Installe : ~/.codex/AGENTS.md  +  ~/bin/pmz-codex (optionnel)
set -u

CODEX_SRC="$(cd "$(dirname "$0")" && pwd)"   # .../codex/

echo "── Promptimizer — delta Codex ──"
echo "Source : $CODEX_SRC"
echo

# 1. ~/.codex/AGENTS.md (global Codex)
CODEX_DIR="$HOME/.codex"
AGENTS_DST="$CODEX_DIR/AGENTS.md"
mkdir -p "$CODEX_DIR"
if [ -f "$AGENTS_DST" ]; then
  BACKUP="$AGENTS_DST.bak.$(date +%Y%m%d%H%M%S)"
  cp "$AGENTS_DST" "$BACKUP"
  echo "Sauvegarde existante : $BACKUP"
fi
cp "$CODEX_SRC/AGENTS.md" "$AGENTS_DST"
echo "AGENTS.md global installé : $AGENTS_DST"

# 2. pmz-codex — wrapper optionnel (~/bin, dans PATH courant ?)
BIN="$HOME/bin"
printf "\nInstaller le wrapper pmz-codex dans %s ? [O/n] " "$BIN"
read -r ANS
case "${ANS:-O}" in
  n|N) echo "→ Wrapper ignoré." ;;
  *)
    mkdir -p "$BIN"
    cp "$CODEX_SRC/pmz-codex" "$BIN/pmz-codex"
    chmod +x "$BIN/pmz-codex"
    if command -v xattr >/dev/null 2>&1; then
      xattr -d com.apple.quarantine "$BIN/pmz-codex" 2>/dev/null || true
    fi
    echo "→ Wrapper installé : $BIN/pmz-codex"
    # Vérif PATH
    if ! echo ":$PATH:" | grep -q ":$BIN:"; then
      echo "  ⚠ $BIN n'est pas dans ton PATH."
      echo "  Ajoute dans ~/.zshrc (ou ~/.bashrc) :"
      echo "    export PATH=\"\$HOME/bin:\$PATH\""
    fi
    ;;
esac

echo
echo "── Delta Codex installé. ──"
echo "• Pour chaque projet : laisse Claude Code créer AGENTS.md (/init)"
echo "  puis ouvre le projet dans Codex."
echo "• AGENTS.md global : $AGENTS_DST"
echo "• Désinstaller : supprimer ~/.codex/AGENTS.md et ~/bin/pmz-codex"
echo
echo "Appuie sur Entrée pour fermer."
read -r _
