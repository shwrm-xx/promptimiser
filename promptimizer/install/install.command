#!/bin/bash
# Installeur Promptimizer — double-clic macOS, sans sudo.
set -u

PMZ_SRC="$(cd "$(dirname "$0")/.." && pwd)"   # .../promptimizer
REPO="$(cd "$PMZ_SRC/.." && pwd)"             # racine du dépôt source
DEST="$HOME/.claude"
SETTINGS="$DEST/settings.json"

echo "── Promptimizer — installation ──"
echo "Source : $PMZ_SRC"
echo "Cible  : $DEST"
echo

# 0. Hook git local : lève la quarantaine macOS sur les .command après chaque
# pull/merge/checkout, pour ne plus jamais revoir le popup Gatekeeper (une fois
# par clone — persiste ensuite tout seul).
if [ -d "$REPO/.git" ] && [ -d "$REPO/.githooks" ]; then
  git -C "$REPO" config core.hooksPath .githooks 2>/dev/null || true
fi

# 1. Pré-requis : node
if ! command -v node >/dev/null 2>&1; then
  echo "ERREUR : 'node' introuvable dans le PATH. Installe Node.js puis relance." >&2
  echo "Appuie sur Entrée pour fermer." ; read -r _ ; exit 1
fi

# 2. Dossiers cibles
mkdir -p "$DEST" "$DEST/skills" "$DEST/commands" || { echo "ERREUR : création des dossiers."; read -r _; exit 1; }

# 3. Copie du package, de la skill et des slash commands
# Purge des fichiers obsolètes d'une version précédente (un cp -R fusionne sans supprimer).
# On NE touche PAS à state/ (sidecar de prise de relais context-guard.py).
if [ -d "$DEST/promptimizer" ]; then
  for sub in hooks lib scripts install templates commands; do
    rm -rf "$DEST/promptimizer/$sub"
  done
fi
cp -R "$PMZ_SRC" "$DEST/" || { echo "ERREUR : copie du package."; read -r _; exit 1; }
if [ -d "$REPO/skills/promptimizer" ]; then
  cp -R "$REPO/skills/promptimizer" "$DEST/skills/"
fi
if ls "$PMZ_SRC/commands/"*.md >/dev/null 2>&1; then
  cp "$PMZ_SRC/commands/"*.md "$DEST/commands/"
fi
echo "Fichiers copiés."

# 4. Permissions + quarantine
chmod +x "$DEST/promptimizer/install/"*.command 2>/dev/null || true
chmod +x "$DEST/promptimizer/hooks/"*.js "$DEST/promptimizer/scripts/"*.js 2>/dev/null || true
if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$DEST/promptimizer" "$DEST/skills/promptimizer" "$DEST/commands" 2>/dev/null || true
fi

# 5. Fusion settings.json (backup + idempotent + réversible)
MS="$DEST/promptimizer/install/merge-settings.js"
TAKEOVER=""
CHECK="$(node "$MS" "$SETTINGS" --check 2>/dev/null)"
if echo "$CHECK" | grep -q '"context_guard_present": true' && echo "$CHECK" | grep -q '"pmz_hooks_present": false'; then
  echo
  echo "Un hook Stop 'context-guard.py' existe déjà."
  echo "PMZ sait suivre le coût/contexte (paliers de tokens) : il peut reprendre ce rôle"
  echo "pour éviter des alertes en double. C'est RÉVERSIBLE (sauvegarde + désinstalleur)."
  printf "PMZ reprend ce rôle ? [O/n] "
  read -r ANS
  case "${ANS:-O}" in
    n|N) TAKEOVER="" ; echo "→ Les deux hooks Stop resteront actifs." ;;
    *)   TAKEOVER="--takeover" ; echo "→ PMZ reprend le rôle." ;;
  esac
fi

if ! node "$MS" "$SETTINGS" $TAKEOVER; then
  echo "ERREUR : la fusion de settings.json a échoué (rien n'a été modifié). Voir le message ci-dessus." >&2
  echo "Appuie sur Entrée pour fermer." ; read -r _ ; exit 1
fi

# 6. Diagnostic
echo
"$DEST/promptimizer/install/pmz-doctor.command" --no-pause || true

echo
echo "── Installé. ──"
echo "• Hooks globaux fusionnés dans : $SETTINGS (sauvegarde horodatée créée)"
echo "• Skill : $DEST/skills/promptimizer/SKILL.md"
echo "• Commands : /pmz-init /budget /check-context /close-batch /fresh-session"
echo "• Redémarre Claude Code pour activer les hooks."
echo "• Désinstaller : promptimizer/install/uninstall.command"
echo
echo "Appuie sur Entrée pour fermer."
read -r _
