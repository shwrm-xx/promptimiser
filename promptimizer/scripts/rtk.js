#!/usr/bin/env node
'use strict';
// CLI /pmz:rtk (lot #82, epic Bridge RTK) — statut (5 états), activation/désactivation
// persistée, migration guidée du canal Claude Code. Zéro dépendance, fail-open : toute
// erreur imprévue retombe sur un message clair et exit 0 (jamais de crash côté agent).
const fs = require('fs');
const cdir = require('../lib/claude-dir');
const { gitRoot } = require('../lib/project');
const { parseCwd } = require('../lib/cli');
const rtk = require('../lib/rtk-status');

const STATE_LABEL = {
  absent: 'absent',
  'present-inactive': 'présent — inactif',
  active: 'actif',
  conflict: 'conflit',
  incompatible: 'incompatible',
};

function root() {
  return gitRoot(parseCwd()) || process.cwd();
}

function remediation(status) {
  const lines = [];
  const c = status.channels.claude;
  const o = status.channels.opencode;
  const x = status.channels.codex;
  if (c.present) {
    lines.push('Canal Claude Code : hook RTK autonome détecté dans settings.json :');
    for (const e of c.entries) lines.push(`  - event ${e.event} : ${e.command}`);
    lines.push('  -> `/pmz:rtk migrate` sauvegarde settings.json puis retire ces entrées et active le bridge PMZ.');
  }
  if (o.present) {
    lines.push(`Canal OpenCode : mention « rtk » trouvée dans ${o.evidence}.`);
    lines.push("  -> retire manuellement l'entrée du plugin RTK de ce fichier (PMZ ne modifie pas la config OpenCode d'un tiers).");
  }
  if (x.present) {
    lines.push(`Canal Codex : mention « rtk » trouvée dans ${x.evidence}.`);
    lines.push("  -> retire manuellement le bloc d'instructions RTK de ce fichier.");
  }
  return lines;
}

function printStatus(status) {
  const lines = ['## Promptimizer — bridge RTK', ''];
  lines.push(`État : ${STATE_LABEL[status.state] || status.state}`);
  lines.push(`Binaire rtk : ${status.binary || 'introuvable'}`);
  lines.push(`Bridge PMZ : ${status.bridgeEnabled ? 'actif' : 'inactif'}`);
  if (status.neutralized) lines.push('⚠ Bridge neutralisé automatiquement (conflit détecté sur un état précédemment actif).');
  lines.push('');
  const rem = remediation(status);
  if (rem.length) {
    lines.push('Conflit(s) détecté(s) :');
    lines.push(...rem);
  } else if (status.state === 'absent') {
    lines.push('Aucun binaire `rtk` trouvé sur le PATH — le bridge reste sans effet (commandes inchangées).');
  } else if (status.state === 'incompatible') {
    lines.push('Binaire `rtk` présent mais `rtk --version` échoue/timeout — installation à vérifier avant activation.');
  } else if (status.state === 'present-inactive') {
    lines.push('RTK détecté, aucun conflit — `/pmz:rtk enable` pour activer le bridge.');
  } else if (status.state === 'active') {
    lines.push('Bridge PMZ actif — les commandes Bash sûres transitent par `rtk rewrite` (spec §8).');
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function cmdStatus() {
  printStatus(rtk.computeStatus({ root: root() }));
}

function cmdEnable() {
  const status = rtk.computeStatus({ root: root() });
  if (status.state === 'conflict') {
    printStatus(status);
    process.stdout.write("\nRefus : conflit non résolu — résous-le (`/pmz:rtk migrate` ou manuellement) avant d'activer.\n");
    return;
  }
  if (status.state === 'absent') {
    process.stdout.write('Refus : binaire `rtk` introuvable — rien à activer.\n');
    return;
  }
  if (status.state === 'incompatible') {
    process.stdout.write('Refus : `rtk --version` échoue — installation à réparer avant activation.\n');
    return;
  }
  rtk.writeEnableState(true);
  process.stdout.write('Bridge RTK activé (état persisté, survit aux prochains hooks et à un update du plugin).\n');
}

function cmdDisable() {
  rtk.writeEnableState(false);
  process.stdout.write('Bridge RTK désactivé (état persisté).\n');
}

function cmdMigrate() {
  const r = root();
  const status = rtk.computeStatus({ root: r });
  const c = status.channels.claude;
  if (!c.present) {
    printStatus(status);
    process.stdout.write('\nRien à migrer côté Claude Code (aucun hook RTK autonome détecté).\n');
    return;
  }
  const settingsPath = cdir.settingsPath();
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    process.stdout.write(`ABORT : ${settingsPath} illisible/invalide (${e.message}). Aucune modification.\n`);
    return;
  }
  const backupPath = settingsPath.replace(/\.json$/, '') + `.pmz-backup-rtk-migrate-${Date.now()}.json`;
  try {
    fs.copyFileSync(settingsPath, backupPath);
  } catch (e) {
    process.stdout.write(`ABORT : sauvegarde impossible (${e.message}). Aucune modification.\n`);
    return;
  }
  const commands = new Set(c.entries.map((e) => e.command));
  const hooks = settings.hooks || {};
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event]
      .map((entry) => {
        if (!entry || !Array.isArray(entry.hooks)) return entry;
        const kept = entry.hooks.filter((h) => !(h && commands.has(h.command)));
        return kept.length ? Object.assign({}, entry, { hooks: kept }) : null;
      })
      .filter(Boolean);
    if (hooks[event].length === 0) delete hooks[event];
  }
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    process.stdout.write(`ABORT après sauvegarde (${backupPath}) : écriture impossible (${e.message}).\n`);
    return;
  }
  rtk.writeEnableState(true);
  process.stdout.write(`Migration effectuée. Backup : ${backupPath}\n`);
  process.stdout.write(`Hook(s) RTK autonome retiré(s) : ${c.entries.length}. Bridge PMZ activé.\n`);
}

function parseSub() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') { i++; continue; }
    if (!argv[i].startsWith('--')) return argv[i];
  }
  return 'status';
}

function main() {
  const sub = parseSub();
  if (sub === 'enable') return cmdEnable();
  if (sub === 'disable') return cmdDisable();
  if (sub === 'migrate') return cmdMigrate();
  return cmdStatus(); // 'status' | 'doctor' | défaut
}

try {
  main();
} catch (e) {
  process.stdout.write(`## Promptimizer — bridge RTK\n\nErreur inattendue (${e && e.message ? e.message : e}) — statut indisponible.\n`);
}
process.exit(0);
