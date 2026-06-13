#!/bin/bash
# Installeur Vibe Session Governor — double-clic macOS, sans sudo.
set -u

VSG_SRC="$(cd "$(dirname "$0")/.." && pwd)"   # .../vibe-session-governor
REPO="$(cd "$VSG_SRC/.." && pwd)"             # racine du dépôt source
DEST="$HOME/.claude"
SETTINGS="$DEST/settings.json"

echo "── Vibe Session Governor — installation ──"
echo "Source : $VSG_SRC"
echo "Cible  : $DEST"
echo

# 1. Pré-requis : node
if ! command -v node >/dev/null 2>&1; then
  echo "ERREUR : 'node' introuvable dans le PATH. Installe Node.js puis relance." >&2
  echo "Appuie sur Entrée pour fermer." ; read -r _ ; exit 1
fi

# 2. Dossiers cibles
mkdir -p "$DEST" "$DEST/skills" "$DEST/commands" || { echo "ERREUR : création des dossiers."; read -r _; exit 1; }

# 3. Copie du package, de la skill et des slash commands
cp -R "$VSG_SRC" "$DEST/" || { echo "ERREUR : copie du package."; read -r _; exit 1; }
if [ -d "$REPO/skills/vibe-session-governor" ]; then
  cp -R "$REPO/skills/vibe-session-governor" "$DEST/skills/"
fi
if ls "$VSG_SRC/commands/"*.md >/dev/null 2>&1; then
  cp "$VSG_SRC/commands/"*.md "$DEST/commands/"
fi
echo "Fichiers copiés."

# 4. Permissions + quarantine
chmod +x "$DEST/vibe-session-governor/install/"*.command 2>/dev/null || true
chmod +x "$DEST/vibe-session-governor/hooks/"*.js "$DEST/vibe-session-governor/scripts/"*.js 2>/dev/null || true
xattr -dr com.apple.quarantine "$DEST/vibe-session-governor" 2>/dev/null || true

# 5. Fusion settings.json (backup + idempotent + réversible)
MS="$DEST/vibe-session-governor/install/merge-settings.js"
TAKEOVER=""
CHECK="$(node "$MS" "$SETTINGS" --check 2>/dev/null)"
if echo "$CHECK" | grep -q '"context_guard_present": true' && echo "$CHECK" | grep -q '"vsg_hooks_present": false'; then
  echo
  echo "Un hook Stop 'context-guard.py' existe déjà."
  echo "VSG sait suivre le coût/contexte (paliers de tokens) : il peut reprendre ce rôle"
  echo "pour éviter des alertes en double. C'est RÉVERSIBLE (sauvegarde + désinstalleur)."
  printf "VSG reprend ce rôle ? [O/n] "
  read -r ANS
  case "${ANS:-O}" in
    n|N) TAKEOVER="" ; echo "→ Les deux hooks Stop resteront actifs." ;;
    *)   TAKEOVER="--takeover" ; echo "→ VSG reprend le rôle." ;;
  esac
fi

if ! node "$MS" "$SETTINGS" $TAKEOVER; then
  echo "ERREUR : la fusion de settings.json a échoué (rien n'a été modifié). Voir le message ci-dessus." >&2
  echo "Appuie sur Entrée pour fermer." ; read -r _ ; exit 1
fi

# 6. Diagnostic
echo
"$DEST/vibe-session-governor/install/vsg-doctor.command" --no-pause || true

echo
echo "── Installé. ──"
echo "• Hooks globaux fusionnés dans : $SETTINGS (sauvegarde horodatée créée)"
echo "• Skill : $DEST/skills/vibe-session-governor/SKILL.md"
echo "• Commands : /vsg-init /budget /check-context /close-batch /fresh-session"
echo "• Redémarre Claude Code pour activer les hooks."
echo "• Désinstaller : vibe-session-governor/install/uninstall.command"
echo
echo "Appuie sur Entrée pour fermer."
read -r _
