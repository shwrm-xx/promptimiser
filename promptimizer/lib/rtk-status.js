'use strict';
// Statut & activation persistée du bridge RTK (lot #82, epic Bridge RTK).
//
// Sépare deux notions : la DÉTECTION (RTK est-il présent ? un hook autonome existe-t-il déjà,
// hors PMZ, dans un des 3 canaux qu'un provider de réécriture de commandes peut utiliser :
// réglages Claude Code, plugin OpenCode, instructions Codex — spec §9) et l'ACTIVATION du
// bridge PMZ lui-même (lot #81). L'activation doit être un état PERSISTANT : un hook Bash est
// un process JETABLE relancé à chaque appel outil, `PMZ_RTK_ENABLE` en env n'est donc qu'un
// override ponctuel (tests / désactivation d'un seul appel) — l'activation normale vit dans un
// fichier sous PMZ_STATE_DIR, qui survit à un `git pull`/update du plugin (cf. claude-dir.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cdir = require('./claude-dir');
const { readJson, writeAtomic } = require('./fsjson');
const { findTool } = require('./env');
const { RTK_STATUS_MS } = require('./timeouts');

function stateDir() {
  return process.env.PMZ_STATE_DIR || cdir.stateDir();
}
function stateFile() {
  return path.join(stateDir(), 'rtk-state.json');
}

function readEnableState() {
  return readJson(stateFile(), { enabled: false });
}

function writeEnableState(enabled, extra) {
  try { fs.mkdirSync(stateDir(), { recursive: true }); } catch (_) { /* fail-open : lecture repli false */ }
  return writeAtomic(stateFile(), Object.assign({}, extra || {}, { enabled: !!enabled }));
}

// Activation effective — lue par le chemin chaud (optimizer.js). Override d'env explicite
// prioritaire (tests / désactivation ponctuelle), sinon état persisté. Fail-open : toute
// erreur de lecture => désactivé (jamais de réécriture surprise sur panne de disque).
function isBridgeEnabled(env) {
  const e = env || process.env;
  if (e.PMZ_RTK_ENABLE === '1') return true;
  if (e.PMZ_RTK_ENABLE === '0') return false;
  try { return readEnableState().enabled === true; } catch (_) { return false; }
}

// --- Détection binaire + version ---
function detectBinary(resolve) {
  return (resolve || findTool)('rtk');
}

// Binaire trouvé mais incapable de répondre à `--version` dans le budget imparti => install
// cassée/incompatible (distinct de « absent »). Jamais d'exception propagée.
function checkVersion(bin, opts) {
  const o = opts || {};
  try {
    execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: o.timeoutMs || RTK_STATUS_MS });
    return true;
  } catch (_) {
    return false;
  }
}

// --- Canal 1 : hook autonome dans les réglages Claude Code ---
// Mêmes tags que merge-settings.js (dupliqués volontairement : lib/ ne dépend pas d'install/).
const PMZ_HOOK_TAGS = ['promptimizer/hooks/', 'vibe-session-governor/hooks/'];
function isPmzHookCommand(command) {
  return PMZ_HOOK_TAGS.some((t) => command.includes(t));
}
function readSettings(settingsPath) {
  const p = settingsPath || cdir.settingsPath();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    return {};
  }
}
// Détection par CONTENU (recherche « rtk » dans la commande), pas par nom de fichier attendu :
// un hook RTK autonome peut être vendoré sous un nom arbitraire côté utilisateur (acceptance
// #82 : « plugin rtk invisible dans settings » — il ne s'annonce pas forcément comme tel).
function detectClaudeHookConflict(settingsPath) {
  const settings = readSettings(settingsPath);
  const hooks = settings && settings.hooks;
  const found = [];
  if (hooks && typeof hooks === 'object') {
    for (const event of Object.keys(hooks)) {
      const arr = hooks[event];
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (!entry || !Array.isArray(entry.hooks)) continue;
        for (const h of entry.hooks) {
          const command = h && typeof h.command === 'string' ? h.command : '';
          if (command && /rtk/i.test(command) && !isPmzHookCommand(command)) {
            found.push({ event, command });
          }
        }
      }
    }
  }
  return { present: found.length > 0, entries: found };
}

// --- Canal 2 : plugin RTK OpenCode ---
// Best-effort : format/emplacement d'un plugin tiers non normalisé côté PMZ. On cherche la
// chaîne « rtk » dans les config candidates ; absence de config OpenCode = « non concerné »,
// jamais traité comme un conflit.
function opencodeCandidates(root) {
  const list = [];
  if (root) {
    list.push(path.join(root, 'opencode.json'));
    list.push(path.join(root, '.opencode', 'config.json'));
  }
  list.push(path.join(os.homedir(), '.config', 'opencode', 'opencode.json'));
  return list;
}
function detectOpenCodeConflict(root) {
  const checked = [];
  for (const file of opencodeCandidates(root)) {
    checked.push(file);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    if (/rtk/i.test(raw)) return { present: true, evidence: file, checked };
  }
  return { present: false, evidence: null, checked };
}

// --- Canal 3 : instructions Codex ---
// Marqueur resserré (pas juste /rtk/i) : un AGENTS.md de projet peut légitimement mentionner
// « rtk » en prose (documentation de CE projet, par exemple) sans qu'un hook autonome existe.
const CODEX_MARKER = /\brtk\b[^\n]{0,60}\b(rewrite|hook|instructions?)\b|<!--\s*rtk/i;
function codexCandidates(root) {
  const list = [];
  if (root) list.push(path.join(root, 'AGENTS.md'));
  list.push(path.join(os.homedir(), '.codex', 'instructions.md'));
  return list;
}
function detectCodexConflict(root) {
  const checked = [];
  for (const file of codexCandidates(root)) {
    checked.push(file);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    if (CODEX_MARKER.test(raw)) return { present: true, evidence: file, checked };
  }
  return { present: false, evidence: null, checked };
}

// --- Statut composite ---
// États (backlog #82) : absent | present-inactive | active | conflict | incompatible.
// Le conflit prime sur tout le reste (spec §9 : un hook autonome détecté est un avertissement
// qui rend le bridge PMZ redondant/dangereux — double réécriture possible) et NEUTRALISE le
// bridge : dès que status/doctor/enable/disable constatent un conflit alors que l'état
// persisté était actif, on le repasse à false immédiatement (self-healing, pas d'action
// manuelle requise pour couper le bridge).
function computeStatus(opts) {
  const o = opts || {};
  const root = o.root || null;
  const settingsPath = o.settingsPath;
  const resolve = o.resolve;

  const bin = detectBinary(resolve);
  const claude = detectClaudeHookConflict(settingsPath);
  const opencode = detectOpenCodeConflict(root);
  const codex = detectCodexConflict(root);
  const conflict = claude.present || opencode.present || codex.present;
  const wasEnabled = isBridgeEnabled(o.env);

  let neutralized = false;
  if (conflict && wasEnabled) {
    writeEnableState(false, { neutralized_at_conflict: true });
    neutralized = true;
  }

  let state;
  if (conflict) state = 'conflict';
  else if (!bin) state = 'absent';
  else if (!checkVersion(bin, { timeoutMs: o.timeoutMs })) state = 'incompatible';
  else if (wasEnabled) state = 'active';
  else state = 'present-inactive';

  return {
    state,
    binary: bin,
    bridgeEnabled: conflict ? false : wasEnabled,
    neutralized,
    channels: { claude, opencode, codex },
  };
}

module.exports = {
  stateFile,
  readEnableState,
  writeEnableState,
  isBridgeEnabled,
  detectBinary,
  checkVersion,
  detectClaudeHookConflict,
  detectOpenCodeConflict,
  detectCodexConflict,
  computeStatus,
};
