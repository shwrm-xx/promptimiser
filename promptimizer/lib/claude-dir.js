'use strict';
// Résolution du dossier de config Claude Code — SOURCE DE VÉRITÉ UNIQUE.
// Claude Code honore la variable CLAUDE_CONFIG_DIR pour relocaliser ~/.claude ;
// PMZ doit la respecter partout (installeur ET hooks runtime), sinon sur une machine
// où l'utilisateur a déplacé sa config : install au mauvais endroit et hooks aveugles
// (STATE_DIR/settings/HOOK_BASE calculés sur un ~/.claude qui n'existe pas pour lui).
//
// Fonctions (call-time, sensibles à l'env) plutôt que constantes : un test peut poser
// CLAUDE_CONFIG_DIR puis appeler sans recharger le module. Fail-open : jamais de throw.
const os = require('os');
const path = require('path');

// Dossier de config Claude : CLAUDE_CONFIG_DIR si posée (non vide), sinon ~/.claude.
// Valeur utilisée telle quelle (Claude Code attend un chemin absolu) après trim.
function claudeDir() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && env.trim()) return env.trim();
  return path.join(os.homedir(), '.claude');
}

function pmzDir() { return path.join(claudeDir(), 'promptimizer'); }
function stateDir() { return path.join(pmzDir(), 'state'); }
function hooksDir() { return path.join(pmzDir(), 'hooks'); }
function settingsPath() { return path.join(claudeDir(), 'settings.json'); }

module.exports = { claudeDir, pmzDir, stateDir, hooksDir, settingsPath };
