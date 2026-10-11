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
const fs = require('fs');
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

// true si CE process tourne dans le contexte plugin (env posé par le harness). false pour un
// script lancé "à la main" (terminal nu, hors session Claude Code) même sur une machine où le
// plugin PMZ est par ailleurs installé.
function isPluginContext() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  return !!(root && root.trim());
}

// Détecte le plugin INSTALLÉ sur la machine, indépendamment de l'env du process courant — mêmes
// signaux que install/doctor.js (enabledPlugins de settings.json, installed_plugins.json),
// dupliqués volontairement ici : lib/ ne dépend pas d'install/. Lecture de fichier seule.
function pluginInstalledOnDisk() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const ep = data && data.enabledPlugins;
    if (ep && Object.keys(ep).some((k) => k.split('@')[0] === 'pmz' && ep[k] === true)) return true;
  } catch (_) { /* absent/illisible -> pas de signal */ }
  try {
    const raw = fs.readFileSync(path.join(claudeDir(), 'plugins', 'installed_plugins.json'), 'utf8');
    const data = JSON.parse(raw);
    const plugins = data && data.plugins;
    if (plugins && Object.keys(plugins).some((k) => k.split('@')[0] === 'pmz')) return true;
  } catch (_) { /* absent/illisible */ }
  return false;
}

// Risque de divergence de stateDir() : le plugin est installé sur la machine mais CE process ne
// tourne pas dans son contexte (CLAUDE_PLUGIN_ROOT/DATA absents) -> stateDir() va retomber sur le
// chemin manuel alors que les hooks du plugin, eux, liront CLAUDE_PLUGIN_DATA/state au runtime.
// Le chemin réel de CLAUDE_PLUGIN_DATA n'est JAMAIS reconstruit ici (aucun format garanti côté
// harness au-delà de l'env — cf. docs/decisions/D1-plugin-go-nogo.md) : mieux vaut signaler le
// risque que d'écrire en silence dans un dossier que les hooks ne liront jamais (lot #118).
function stateDirDivergenceRisk() {
  return !isPluginContext() && pluginInstalledOnDisk();
}

module.exports = {
  claudeDir,
  pmzDir,
  stateDir,
  hooksDir,
  settingsPath,
  isPluginContext,
  pluginInstalledOnDisk,
  stateDirDivergenceRisk,
};
