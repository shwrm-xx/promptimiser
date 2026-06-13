#!/bin/bash
# Diagnostic Promptimizer.
set -u

DEST="$HOME/.claude"
SETTINGS="$DEST/settings.json"
PMZ="$DEST/promptimizer"
MS="$PMZ/install/merge-settings.js"
NO_PAUSE="${1:-}"

HAS_NODE=0
command -v node >/dev/null 2>&1 && HAS_NODE=1

# Claude settings
[ -f "$SETTINGS" ] && SET_OK="OK" || SET_OK="—"

# Hooks PMZ + double Stop
HOOKS_OK="—"; DOUBLE="no"
if [ -f "$MS" ] && [ "$HAS_NODE" -eq 1 ]; then
  CHK="$(node "$MS" "$SETTINGS" --check 2>/dev/null)"
  echo "$CHK" | grep -q '"pmz_hooks_present": true' && HOOKS_OK="OK"
  echo "$CHK" | grep -q '"double_stop": true' && DOUBLE="yes"
fi

# Skill
[ -f "$DEST/skills/promptimizer/SKILL.md" ] && SKILL_OK="OK" || SKILL_OK="—"

# Scripts + dry-run réel d'un hook
SCRIPTS_OK="—"
if [ "$HAS_NODE" -eq 1 ] && [ -f "$PMZ/hooks/session-start.js" ]; then
  echo '{}' | node "$PMZ/hooks/session-start.js" >/dev/null 2>&1 && SCRIPTS_OK="OK"
fi

# Projet courant
PROJ="non initialisé"
if [ "$HAS_NODE" -eq 1 ] && [ -f "$PMZ/scripts/detect-project.js" ]; then
  DET="$(node "$PMZ/scripts/detect-project.js" 2>/dev/null)"
  echo "$DET" | grep -q '"is_git_repo": false' && PROJ="hors dépôt git"
  echo "$DET" | grep -q '"initialized": true' && PROJ="initialisé"
fi

# Capacités
if [ "$HAS_NODE" -eq 1 ]; then NODE_V="$(node --version 2>/dev/null)"; else NODE_V="absent"; fi
command -v git >/dev/null 2>&1 && GIT_OK="OK" || GIT_OK="absent"
command -v rg >/dev/null 2>&1 && RG_OK="présent" || RG_OK="absent (git grep/grep utilisés)"

echo "Promptimizer — diagnostic"
echo
echo "Claude settings : $SET_OK"
echo "Hooks globaux : $HOOKS_OK"
echo "Skill globale : $SKILL_OK"
echo "Scripts exécutables : $SCRIPTS_OK"
echo "Projet courant : $PROJ"
echo
echo "node : $NODE_V | git : $GIT_OK | rg : $RG_OK"
[ "$DOUBLE" = "yes" ] && echo "Avertissement : deux hooks Stop actifs (PMZ + context-guard.py)."

STATUS="vert"
if [ "$SET_OK" != "OK" ] || [ "$HOOKS_OK" != "OK" ] || [ "$HAS_NODE" -eq 0 ]; then
  STATUS="rouge"
elif [ "$SKILL_OK" != "OK" ] || [ "$SCRIPTS_OK" != "OK" ] || [ "$DOUBLE" = "yes" ]; then
  STATUS="orange"
fi
echo
echo "Statut : $STATUS"

if [ "$NO_PAUSE" != "--no-pause" ]; then
  echo
  echo "Appuie sur Entrée pour fermer."
  read -r _
fi
