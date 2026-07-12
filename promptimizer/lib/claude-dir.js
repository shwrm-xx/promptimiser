'use strict';
// Résolution du dossier de config Claude Code — SOURCE DE VÉRITÉ UNIQUE.
// Claude Code honore la variable CLAUDE_CONFIG_DIR pour relocaliser ~/.claude ;
// PMZ doit la respecter partout (installeur ET hooks runtime), sinon sur une machine
// où l'utilisateur a déplacé sa config : install au mauvais endroit et hooks aveugles
// (STATE_DIR/settings/HOOK_BASE calculés sur un ~/.claude qui n'existe pas pour lui).
//
// Deux modes de déploiement coexistent (lot D2) :
//   - install manuelle : le code PMZ vit sous ~/.claude/promptimizer, l'état sous …/state ;
//   - plugin Claude Code : le harness expose CLAUDE_PLUGIN_ROOT (racine du plugin, REMPLACÉE
//     à chaque update) et CLAUDE_PLUGIN_DATA (dossier d'état PERSISTANT qui survit aux updates).
// D'où le découplage pmzDir()/stateDir() : l'état ne doit JAMAIS vivre sous pmzDir() en plugin,
// sinon il serait effacé à chaque update. Voir docs/decisions/D1-plugin-go-nogo.md.
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

// Racine du CODE PMZ (lib/, hooks/, commands/…). En plugin : CLAUDE_PLUGIN_ROOT (fourni par
// le harness au runtime des hooks). En install manuelle : ~/.claude/promptimizer.
function pmzDir() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (root && root.trim()) return root.trim();
  return path.join(claudeDir(), 'promptimizer');
}

// État PERSISTANT (occupancy, sidecar). Découplé de pmzDir() : en plugin il vit sous
// CLAUDE_PLUGIN_DATA (survit aux updates) ; en manuel sous ~/.claude/promptimizer/state.
// L'override explicite PMZ_STATE_DIR est appliqué par les APPELANTS (occupancy.js /
// merge-settings.js : `process.env.PMZ_STATE_DIR || cdir.stateDir()`), pas ici — sinon un
// test qui pose PMZ_STATE_DIR globalement fausserait aussi les assertions sur le repli manuel.
function stateDir() {
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (data && data.trim()) return path.join(data.trim(), 'state');
  return path.join(claudeDir(), 'promptimizer', 'state');
}

function hooksDir() { return path.join(pmzDir(), 'hooks'); }
function settingsPath() { return path.join(claudeDir(), 'settings.json'); }

module.exports = { claudeDir, pmzDir, stateDir, hooksDir, settingsPath };
