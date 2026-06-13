#!/bin/bash
# Désinstalleur Vibe Session Governor — retire UNIQUEMENT les hooks VSG, restaure l'existant.
set -u

DEST="$HOME/.claude"
SETTINGS="$DEST/settings.json"
MS="$DEST/vibe-session-governor/install/merge-settings.js"

echo "── Vibe Session Governor — désinstallation ──"
echo

if [ ! -f "$MS" ]; then
  echo "merge-settings.js introuvable ($MS). VSG ne semble pas installé."
  echo "Appuie sur Entrée pour fermer." ; read -r _ ; exit 1
fi

# 1. Retirer les hooks VSG (backup + restauration de context-guard.py si applicable)
if node "$MS" "$SETTINGS" --remove; then
  echo "Hooks VSG retirés de settings.json (sauvegarde créée)."
else
  echo "ERREUR : modification de settings.json impossible (rien changé)." >&2
fi

# 2. Proposer la suppression des fichiers installés
echo
printf "Supprimer aussi les fichiers VSG (~/.claude/vibe-session-governor, skill, commands) ? [o/N] "
read -r ANS
case "${ANS:-N}" in
  o|O)
    rm -rf "$DEST/vibe-session-governor"
    rm -rf "$DEST/skills/vibe-session-governor"
    for c in budget check-context close-batch fresh-session vsg-init; do
      rm -f "$DEST/commands/$c.md"
    done
    echo "Fichiers VSG supprimés."
    ;;
  *)
    echo "Fichiers conservés (réinstall possible)."
    ;;
esac

echo
echo "Note : VSG ne touche jamais à tes projets (.vibe-agent/, CLAUDE.md… restent en place)."
echo "Redémarre Claude Code pour prendre en compte le retrait."
echo "Appuie sur Entrée pour fermer."
read -r _
