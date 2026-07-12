#!/bin/bash
# Désinstalleur Promptimizer — retire UNIQUEMENT les hooks PMZ, restaure l'existant.
set -u

DEST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$DEST/settings.json"
MS="$DEST/promptimizer/install/merge-settings.js"

echo "── Promptimizer — désinstallation ──"
echo

if [ ! -f "$MS" ]; then
  echo "merge-settings.js introuvable ($MS). PMZ ne semble pas installé."
  echo "Appuie sur Entrée pour fermer." ; read -r _ ; exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERREUR : 'node' introuvable dans le PATH — impossible de modifier settings.json automatiquement." >&2
  echo "Retire à la main les entrées dont la commande contient 'promptimizer/hooks/' dans :" >&2
  echo "  $SETTINGS" >&2
  echo "Appuie sur Entrée pour fermer." ; read -r _ ; exit 1
fi

# 1. Retirer les hooks PMZ (backup + restauration de context-guard.py si applicable)
if node "$MS" "$SETTINGS" --remove; then
  echo "Hooks PMZ retirés de settings.json (sauvegarde créée)."
else
  echo "ERREUR : modification de settings.json impossible (rien changé)." >&2
fi

# 2. Proposer la suppression des fichiers installés
echo
printf "Supprimer aussi les fichiers PMZ (~/.claude/promptimizer, skill, commands) ? [o/N] "
read -r ANS
case "${ANS:-N}" in
  o|O)
    rm -rf "$DEST/promptimizer"
    rm -rf "$DEST/skills/promptimizer"
    for c in budget check-context close-batch fresh-session pmz-init; do
      rm -f "$DEST/commands/$c.md"
    done
    echo "Fichiers PMZ supprimés."
    ;;
  *)
    echo "Fichiers conservés (réinstall possible)."
    ;;
esac

echo
echo "Note : PMZ ne touche jamais à tes projets (.vibe-agent/, CLAUDE.md… restent en place)."
echo "Redémarre Claude Code pour prendre en compte le retrait."
echo "Appuie sur Entrée pour fermer."
read -r _
