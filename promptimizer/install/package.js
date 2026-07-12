#!/usr/bin/env node
'use strict';
// Packaging Promptimizer — génère une archive .zip autonome (sans Git requis à l'arrivée).
// Cross-platform : archive via `zip` (macOS/Linux) ou `Compress-Archive` (Windows PowerShell).
// stdlib seule + un outil d'archivage système (pas de dépendance npm).
//
// Usage : node package.js [dossierSortie] [--no-pause]
//   dossierSortie : où déposer le .zip (défaut : ~/Desktop). Utile pour les tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readLineSync } = require('./lib-io');

const PMZ_SRC = path.resolve(__dirname, '..');   // .../promptimizer (source)
const REPO = path.resolve(PMZ_SRC, '..');        // racine du dépôt source
const argv = process.argv.slice(2);
const NO_PAUSE = argv.includes('--no-pause');
const outDirArg = argv.find((a) => !a.startsWith('--'));
const OUT_DIR = outDirArg || path.join(os.homedir(), 'Desktop');

function pad(n) { return String(n).padStart(2, '0'); }
const d = new Date();
const DATE = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const ARCHIVE_NAME = `Promptimizer-${DATE}`;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-pkg-'));
const STAGE = path.join(WORK, ARCHIVE_NAME);
const DEST_ZIP = path.join(OUT_DIR, ARCHIVE_NAME + '.zip');

function log(s) { process.stdout.write(s + '\n'); }
function err(s) { process.stderr.write(s + '\n'); }
function pause(code) {
  if (!NO_PAUSE && process.stdin.isTTY) { log('Appuie sur Entrée pour fermer.'); readLineSync(); }
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(code || 0);
}

log('── Promptimizer — packaging ──');
log('Source  : ' + REPO);
log('Archive : ' + DEST_ZIP);
log('');

// Structure autonome :
//   Promptimizer-YYYYMMDD/
//     promptimizer/         (package Claude Code complet)
//     skills/promptimizer/  (skill globale Claude Code)
//     codex/                (delta Codex : AGENTS.md + pmz-codex + install-codex.command)
fs.mkdirSync(path.join(STAGE, 'skills'), { recursive: true });
fs.cpSync(PMZ_SRC, path.join(STAGE, 'promptimizer'), { recursive: true });
const skillSrc = path.join(REPO, 'skills', 'promptimizer');
if (fs.existsSync(skillSrc)) fs.cpSync(skillSrc, path.join(STAGE, 'skills', 'promptimizer'), { recursive: true });
const codexSrc = path.join(REPO, 'codex');
if (fs.existsSync(codexSrc)) fs.cpSync(codexSrc, path.join(STAGE, 'codex'), { recursive: true });

// Permissions +x (posix) sur les scripts embarqués
if (process.platform !== 'win32') {
  const chmodInDir = (dir, exts) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (exts.some((e) => f.endsWith(e))) { try { fs.chmodSync(path.join(dir, f), 0o755); } catch (_) { /* ignore */ } }
      }
    } catch (_) { /* ignore */ }
  };
  chmodInDir(path.join(STAGE, 'promptimizer', 'install'), ['.command', '.sh']);
  chmodInDir(path.join(STAGE, 'promptimizer', 'hooks'), ['.js']);
  chmodInDir(path.join(STAGE, 'promptimizer', 'scripts'), ['.js']);
  for (const f of ['install-codex.command', 'pmz-codex']) {
    try { fs.chmodSync(path.join(STAGE, 'codex', f), 0o755); } catch (_) { /* ignore */ }
  }
}

// Script de déblocage Gatekeeper (macOS ; inoffensif ailleurs)
const DEBLOCK = path.join(STAGE, 'debloquer.command');
fs.writeFileSync(DEBLOCK,
  '#!/bin/bash\n' +
  '# Retire l\'attribut quarantine macOS sur tous les scripts Promptimizer.\n' +
  '# À lancer UNE FOIS après avoir décompressé l\'archive.\n' +
  'DIR="$(cd "$(dirname "$0")" && pwd)"\n' +
  'xattr -dr com.apple.quarantine "$DIR"\n' +
  'echo "Quarantine retirée. Tu peux maintenant double-cliquer les scripts."\n' +
  'echo "Appuie sur Entrée pour fermer."\n' +
  'read -r _\n');
if (process.platform !== 'win32') { try { fs.chmodSync(DEBLOCK, 0o755); } catch (_) { /* ignore */ } }

// README à la racine de l'archive
fs.writeFileSync(path.join(STAGE, 'LIRE-MOI.txt'),
  'Promptimizer — Installation\n' +
  '============================\n\n' +
  'Prérequis : Node.js installé (nodejs.org).\n\n' +
  'macOS :\n' +
  '  ÉTAPE 0 (une seule fois) — double-clic : debloquer.command\n' +
  '  Claude Code → double-clic : promptimizer/install/install.command\n' +
  '  Codex (opt) → double-clic : codex/install-codex.command\n\n' +
  'Linux :\n' +
  '  Claude Code → bash promptimizer/install/install.sh\n\n' +
  'Windows (PowerShell) :\n' +
  '  Claude Code → promptimizer\\install\\install.ps1\n');

// Archivage cross-platform
fs.mkdirSync(OUT_DIR, { recursive: true });
let archived = false;
if (process.platform === 'win32') {
  // Compress-Archive : -Path sur le dossier STAGE → l'archive contient le dossier Promptimizer-DATE/
  const ps = `Compress-Archive -Path '${STAGE.replace(/'/g, "''")}' -DestinationPath '${DEST_ZIP.replace(/'/g, "''")}' -Force`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  archived = !r.error && r.status === 0;
} else {
  // zip -X : sans attributs étendus (limite la propagation quarantine). cwd = WORK.
  const r = spawnSync('zip', ['-qrX', DEST_ZIP, ARCHIVE_NAME], { cwd: WORK, stdio: 'ignore' });
  archived = !r.error && r.status === 0;
}

if (archived && fs.existsSync(DEST_ZIP)) {
  log('Archive créée : ' + DEST_ZIP);
  log('');
  log('À l\'arrivée : décompresser, puis suivre LIRE-MOI.txt (Node.js requis).');
} else {
  err('ERREUR : l\'archive n\'a pas été créée.');
  err(process.platform === 'win32'
    ? "PowerShell/Compress-Archive introuvable ou en échec."
    : "Outil 'zip' introuvable ou en échec (installe-le : apt/brew install zip).");
  pause(1);
}

log('');
pause(0);
