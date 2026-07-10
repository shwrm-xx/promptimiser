#!/usr/bin/env node
'use strict';
// Fusion sûre des hooks PMZ dans ~/.claude/settings.json.
// - parse STRICT (échec -> abort, aucune écriture)
// - backup horodaté vérifié
// - fusion append-only par event, taguée (idempotente)
// - préserve permissions/statusLine/enabledPlugins et tout hook tiers
// - prise de relais réversible d'un hook Stop context-guard.py (--takeover / restore au --remove)
//
// Usage :
//   node merge-settings.js [settingsPath] [--takeover]   (install)
//   node merge-settings.js [settingsPath] --remove        (désinstall, restaure si possible)
//   node merge-settings.js [settingsPath] --check         (diagnostic JSON)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SETTINGS_TIMEOUT_S } = require('../lib/timeouts');

// Chemin ABSOLU (plus de dépendance à l'expansion du ~ par Claude Code dans le champ command).
const HOOK_BASE = path.join(os.homedir(), '.claude', 'promptimizer', 'hooks');
// Tags reconnus comme « hooks PMZ à nous » : courant + héritage (ancien nom du paquet).
// Permet à stripVsg() de purger les entrées orphelines d'une version précédente
// (sinon un renommage du paquet laisse des hooks fantômes => double-firing).
const PMZ_TAGS = ['promptimizer/hooks/', 'vibe-session-governor/hooks/'];
// Chemin absolu de node figé dans settings.json. Évite « node: command not found »
// (exit 127) quand Claude Code lance les hooks via sh -c avec un PATH épuré
// (cas réel des apps GUI macOS : pas de /opt/homebrew/bin). On préfère un symlink
// stable (ex. /opt/homebrew/bin/node) au chemin versionné de process.execPath
// (ex. .../Cellar/node/25.9.0/...) QUI casserait à chaque `brew upgrade node` —
// mais seulement s'il pointe sur le MÊME binaire, sinon repli sur process.execPath.
function resolveNodeBin() {
  const exec = process.execPath;
  let execReal;
  try { execReal = fs.realpathSync(exec); } catch (_) { execReal = exec; }
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    const cand = path.join(dir, 'node');
    try {
      fs.accessSync(cand, fs.constants.X_OK);
      if (fs.realpathSync(cand) === execReal) return cand;
    } catch (_) { /* continue */ }
  }
  return exec;
}
const NODE_BIN = resolveNodeBin();
const STATE_DIR = process.env.PMZ_STATE_DIR ||
  path.join(os.homedir(), '.claude', 'promptimizer', 'state');
const SIDECAR = path.join(STATE_DIR, 'taken-over.json');

const T = SETTINGS_TIMEOUT_S;
const PMZ_HOOKS = {
  // clear : le hook gère startup|clear depuis toujours, mais le matcher ne couvrait
  // pas clear → le handoff n'était jamais réinjecté après /clear (le geste recommandé).
  // compact : passThrough aujourd'hui, branche dédiée prévue (réinjection post-compaction).
  SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [cmd('session-start.js', T.sessionStart)] }],
  UserPromptSubmit: [{ hooks: [cmd('user-prompt-submit.js', T.default)] }],
  PreToolUse: [{ matcher: 'Bash', hooks: [cmd('pre-tool-use.js', T.default)] }],
  PostToolUse: [{ matcher: 'Read|Edit|Write|TodoWrite', hooks: [cmd('post-tool-use.js', T.default)] }],
  Stop: [{ hooks: [cmd('stop.js', T.default)] }],
};

function cmd(name, timeout) {
  // node entre guillemets (chemin absolu) ; ~ laissé nu pour expansion par le shell.
  return { type: 'command', command: `"${NODE_BIN}" ${HOOK_BASE}/${name}`, timeout };
}
function clone(x) { return JSON.parse(JSON.stringify(x)); }

function isVsgEntry(entry) {
  return !!(entry && Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => h && typeof h.command === 'string' &&
      PMZ_TAGS.some((t) => h.command.includes(t))));
}
function hasContextGuard(entry) {
  return !!(entry && Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => h && typeof h.command === 'string' && /context-guard\.py/.test(h.command)));
}

function stripVsg(hooks) {
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].filter((e) => !isVsgEntry(e));
    if (hooks[event].length === 0) delete hooks[event];
  }
}
function addVsg(hooks) {
  for (const event of Object.keys(PMZ_HOOKS)) {
    if (!Array.isArray(hooks[event])) hooks[event] = [];
    for (const entry of PMZ_HOOKS[event]) hooks[event].push(clone(entry));
  }
}
function takeover(hooks) {
  const taken = [];
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = [];
    for (const e of hooks[event]) {
      if (hasContextGuard(e) && !isVsgEntry(e)) taken.push({ event, entry: e });
      else kept.push(e);
    }
    hooks[event] = kept;
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (taken.length) {
    try {
      fs.mkdirSync(path.dirname(SIDECAR), { recursive: true });
      fs.writeFileSync(SIDECAR, JSON.stringify(taken, null, 2));
    } catch (_) { /* non bloquant : le backup horodaté reste le filet de sécurité */ }
  }
  return taken;
}
function restore(hooks) {
  // Distingue 3 cas : pas de sidecar (rien à faire), sidecar corrompu (réversibilité
  // rompue -> on le signale au lieu de l'avaler), sidecar valide (on restaure).
  if (!fs.existsSync(SIDECAR)) return { restored: [], corrupted: false };
  let taken;
  try { taken = JSON.parse(fs.readFileSync(SIDECAR, 'utf8')); }
  catch (_) { return { restored: [], corrupted: true }; }
  if (!Array.isArray(taken) || !taken.length) {
    try { fs.unlinkSync(SIDECAR); } catch (_) { /* ignore */ }
    return { restored: [], corrupted: false };
  }
  const restored = [];
  for (const t of taken) {
    if (!t || !t.event || !t.entry) continue;
    if (!Array.isArray(hooks[t.event])) hooks[t.event] = [];
    if (!hooks[t.event].some((e) => hasContextGuard(e))) { hooks[t.event].push(t.entry); restored.push(t); }
  }
  try { fs.unlinkSync(SIDECAR); } catch (_) { /* ignore */ }
  return { restored, corrupted: false };
}

function pad(n) { return String(n).padStart(2, '0'); }
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function backup(settingsPath) {
  if (!fs.existsSync(settingsPath)) return null;
  // Garde anti-collision : timestamp() a une granularité d'1 s ; deux runs dans
  // la même seconde écraseraient le backup précédent. Suffixe -1, -2… si besoin.
  const base = settingsPath.replace(/\.json$/, '') + `.pmz-backup-${timestamp()}`;
  let dest = base + '.json';
  let n = 1;
  while (fs.existsSync(dest)) dest = `${base}-${n++}.json`;
  fs.copyFileSync(settingsPath, dest);
  try { fs.chmodSync(dest, 0o600); } catch (_) { /* best-effort : copyFileSync hérite des perms source */ }
  if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) throw new Error('sauvegarde vide/échouée');
  return dest;
}
function writeSettings(settingsPath, obj) {
  const tmp = settingsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, settingsPath);
  try { fs.chmodSync(settingsPath, 0o600); } catch (_) { /* ignore */ }
}

function main() {
  const args = process.argv.slice(2);
  const settingsPath = args.find((a) => !a.startsWith('--')) ||
    path.join(os.homedir(), '.claude', 'settings.json');
  const mode = args.includes('--remove') ? 'remove' : args.includes('--check') ? 'check' : 'install';
  const doTakeover = args.includes('--takeover');

  // Lecture STRICTE (abort si JSON invalide).
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`ABORT : ${settingsPath} n'est pas un JSON valide (${e.message}). Aucune modification.\n`);
      process.exit(1);
    }
    if (!settings || typeof settings !== 'object') settings = {};
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const hooks = settings.hooks;

  if (mode === 'check') {
    const vsgPresent = Object.values(hooks).some((arr) => Array.isArray(arr) && arr.some(isVsgEntry));
    const guardPresent = Object.values(hooks).some((arr) => Array.isArray(arr) && arr.some(hasContextGuard));
    const doubleStop = Array.isArray(hooks.Stop) &&
      hooks.Stop.some(isVsgEntry) && hooks.Stop.some(hasContextGuard);
    process.stdout.write(JSON.stringify({
      settings_exists: fs.existsSync(settingsPath),
      pmz_hooks_present: vsgPresent,
      context_guard_present: guardPresent,
      double_stop: doubleStop,
    }, null, 2) + '\n');
    process.exit(0);
  }

  let bkp = null;
  try { bkp = backup(settingsPath); } catch (e) {
    process.stderr.write(`ABORT : ${e.message}. Aucune modification.\n`);
    process.exit(1);
  }

  let note = '';
  if (mode === 'install') {
    stripVsg(hooks);
    if (doTakeover) {
      const taken = takeover(hooks);
      if (taken.length) note = `Prise de relais : ${taken.length} hook(s) context-guard.py désactivé(s) (réversible).`;
    }
    addVsg(hooks);
  } else { // remove
    stripVsg(hooks);
    const res = restore(hooks);
    if (res.corrupted) {
      note = `ATTENTION : ${SIDECAR} corrompu — context-guard.py n'a PAS pu être restauré automatiquement. Réactive-le à la main dans settings.json (backup : ${bkp}).`;
    } else if (res.restored.length) {
      note = `Restauration : ${res.restored.length} hook(s) context-guard.py réactivé(s).`;
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
  }

  writeSettings(settingsPath, settings);
  process.stdout.write(`OK (${mode}). Backup : ${bkp || 'aucun (pas de settings préexistant)'}.\n`);
  if (note) process.stdout.write(note + '\n');
  process.exit(0);
}

try { main(); } catch (e) {
  process.stderr.write(`ABORT : ${e && e.message ? e.message : e}\n`);
  process.exit(1);
}
