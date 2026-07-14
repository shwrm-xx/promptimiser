#!/usr/bin/env node
'use strict';
// Assemble le PLUGIN Claude Code Promptimizer depuis la source en miroir plat.
//
// Le format plugin impose commands/, skills/, hooks/hooks.json AU ROOT du plugin, sans
// chemin personnalisable (cf. docs/decisions/D1-plugin-go-nogo.md). La source du dépôt
// garde son miroir plat (canal d'install manuelle) ; ce script en DÉRIVE un dossier plugin
// self-contained — zéro duplication committée, source manuelle intacte.
//
// Sortie (gitignorée) :
//   dist/marketplace/
//     .claude-plugin/marketplace.json        (marketplace locale : source = "./promptimizer")
//     promptimizer/                           (RACINE du plugin)
//       .claude-plugin/plugin.json
//       hooks/hooks.json + hooks/*.js
//       commands/*.md      (chemins ~/.claude/promptimizer → ${CLAUDE_PLUGIN_ROOT})
//       skills/promptimizer/SKILL.md  (idem)
//       lib/ scripts/ templates/ bin/ VERSION
//
// Test bac à sable (jamais le vrai ~/.claude) :
//   node build-plugin.js && CLAUDE_CONFIG_DIR=/tmp/x claude plugin marketplace add dist/marketplace \
//     && CLAUDE_CONFIG_DIR=/tmp/x claude plugin install pmz@pmz-local
//
// Usage : node build-plugin.js [dossierSortie]   (défaut : <repo>/dist)
// stdlib seule, fail-safe : exit 1 avec message si un composant attendu manque.
const fs = require('fs');
const path = require('path');
const { readVersion } = require('../lib/version');

const PMZ_SRC = path.resolve(__dirname, '..');            // .../promptimizer (source)
const REPO = path.resolve(PMZ_SRC, '..');                 // racine du dépôt
const SKILL_SRC = path.join(REPO, 'skills', 'promptimizer');
const OUT_ROOT = path.resolve(process.argv[2] || path.join(REPO, 'dist'));
const MARKET = path.join(OUT_ROOT, 'marketplace');
const PLUGIN = path.join(MARKET, 'promptimizer');         // racine du plugin

const MARKETPLACE_NAME = 'pmz-local';
// Composants EXCLUS du plugin : l'installeur manuel (obsolète en plugin) et le bruit OS.
// `statusline.md` : commande opt-in du CANAL MANUEL uniquement (lot #45). Elle invoque
// install/merge-settings.js, absent du plugin (install/ exclu) → la livrer dans le plugin
// donnerait une commande cassée. La statusline reste une feature settings.json = canal manuel.
const EXCLUDE = new Set(['install', '.DS_Store', 'statusline.md']);

// Garde-fou anti-suppression accidentelle (post-mortem v1.1.3 : le cleanup 7533d72 avait
// supprimé pmz-scope/pmz-init/pmz-about de la source, croyant à tort les commandes namespacées
// `/pmz:*` séparées — invisible tant que le cache plugin restait figé). Liste EXPLICITE des
// commandes que le plugin DOIT porter : à éditer consciemment quand on ajoute/retire une
// commande. Une disparition non voulue la fait diverger → build refusé, jamais propagé au cache.
const REQUIRED_COMMANDS = [
  'budget.md', 'check-context.md', 'close-batch.md', 'fresh-session.md',
  'about.md', 'init.md', 'scope.md', 'help.md',
];

function log(s) { process.stdout.write(s + '\n'); }
function fail(s) { process.stderr.write('ERREUR build-plugin : ' + s + '\n'); process.exit(1); }

// Réécrit les chemins d'install manuelle → placeholder plugin substitué inline par Claude
// Code dans le contenu des commands/skills. Idempotent (ne touche pas ce qui est déjà migré).
function rewritePaths(content) {
  return content.replace(/~\/\.claude\/promptimizer/g, '${CLAUDE_PLUGIN_ROOT}');
}
function rewriteMdInDir(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return n;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { n += rewriteMdInDir(p); continue; }
    if (!entry.name.endsWith('.md')) continue;
    const before = fs.readFileSync(p, 'utf8');
    const after = rewritePaths(before);
    if (after !== before) { fs.writeFileSync(p, after); n++; }
  }
  return n;
}

function chmodInDir(dir, exts) {
  if (process.platform === 'win32' || !fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (exts.some((e) => f.endsWith(e))) {
      try { fs.chmodSync(path.join(dir, f), 0o755); } catch (_) { /* ignore */ }
    }
  }
}

// ── 1. Table rase de la sortie ──
try { fs.rmSync(OUT_ROOT, { recursive: true, force: true }); } catch (_) { /* ignore */ }
fs.mkdirSync(PLUGIN, { recursive: true });

// ── 2. Copie de la source (moins install/ + bruit OS) → racine du plugin ──
fs.cpSync(PMZ_SRC, PLUGIN, {
  recursive: true,
  filter: (src) => !EXCLUDE.has(path.basename(src)),
});

// ── 3. Skill : source hors miroir (skills/promptimizer/) → <plugin>/skills/promptimizer/ ──
if (!fs.existsSync(path.join(SKILL_SRC, 'SKILL.md'))) fail('skill introuvable : ' + SKILL_SRC);
fs.cpSync(SKILL_SRC, path.join(PLUGIN, 'skills', 'promptimizer'), { recursive: true });

// ── 3b. Garde-fou : toutes les commandes attendues doivent être présentes ──
const cmdDir = path.join(PLUGIN, 'commands');
const missing = REQUIRED_COMMANDS.filter((c) => !fs.existsSync(path.join(cmdDir, c)));
if (missing.length) {
  fail('commande(s) attendue(s) absente(s) du plugin : ' + missing.join(', ') +
    '\n  Si c\'est une suppression VOULUE, retire-la de REQUIRED_COMMANDS dans build-plugin.js.' +
    '\n  Sinon restaure le fichier source dans promptimizer/commands/ (git checkout).');
}

// ── 4. Réécriture des chemins dans commands + skills (contenu substitué inline) ──
const nCmd = rewriteMdInDir(cmdDir);
const nSkill = rewriteMdInDir(path.join(PLUGIN, 'skills'));

// ── 5. Synchronise la version du manifeste sur VERSION (semver direct depuis lot D3) ──
const manifestPath = path.join(PLUGIN, '.claude-plugin', 'plugin.json');
if (!fs.existsSync(manifestPath)) fail('plugin.json manquant : ' + manifestPath);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const v = readVersion();
if (v) manifest.version = v;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// ── 6. Vérifie que hooks.json est bien à l'emplacement conventionnel ──
if (!fs.existsSync(path.join(PLUGIN, 'hooks', 'hooks.json'))) fail('hooks/hooks.json manquant dans le plugin assemblé');

// ── 7. marketplace.json locale (source = string relative, cf. D1) ──
fs.mkdirSync(path.join(MARKET, '.claude-plugin'), { recursive: true });
fs.writeFileSync(path.join(MARKET, '.claude-plugin', 'marketplace.json'),
  JSON.stringify({
    name: MARKETPLACE_NAME,
    owner: { name: 'Marwan' },
    metadata: { description: 'Marketplace locale Promptimizer (gouvernance de session vibecoding).' },
    plugins: [{ name: 'pmz', source: './promptimizer' }],
  }, null, 2) + '\n');

// ── 8. Bits +x (posix) : wrapper + scripts + hooks ──
chmodInDir(path.join(PLUGIN, 'bin'), ['pmz-hook']);
chmodInDir(path.join(PLUGIN, 'hooks'), ['.js']);
chmodInDir(path.join(PLUGIN, 'scripts'), ['.js']);

log('Plugin assemblé : ' + PLUGIN);
log(`  version manifeste : ${manifest.version}`);
log(`  chemins réécrits  : ${nCmd} command(s) + ${nSkill} fichier(s) skill`);
log('  marketplace       : ' + path.join(MARKET, '.claude-plugin', 'marketplace.json'));
log('');
log('Test (bac à sable) :');
log(`  CLAUDE_CONFIG_DIR=/tmp/pmz-sbx claude plugin marketplace add "${MARKET}"`);
log('  CLAUDE_CONFIG_DIR=/tmp/pmz-sbx claude plugin install pmz@' + MARKETPLACE_NAME);
