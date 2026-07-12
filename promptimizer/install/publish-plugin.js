#!/usr/bin/env node
'use strict';
// Publie le plugin `pmz` assemblé sur une branche dédiée (commit orphelin), pour
// distribution via une marketplace GitHub PUBLIQUE (lot D4-bis, canal alternatif au
// partage local/git-interne déjà documenté).
//
// `main` reste le miroir plat source, intact : la branche ne contient QUE l'artefact
// de build (plugin assemblé + .claude-plugin/marketplace.json), régénéré à chaque
// publication — jamais d'historique hérité de main (commit orphelin, comme gh-pages).
//
// Usage :
//   node install/publish-plugin.js                  # build + commit local sur la branche
//   node install/publish-plugin.js --push            # + push --force vers origin
//   node install/publish-plugin.js --push --remote X --branch Y
//
// stdlib seule ; ne pousse vers un remote QUE si --push est explicitement passé.
// Exige un working tree propre (sinon on publierait un état local non commité).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const BRANCH = argValue('--branch') || 'plugin-release';
const REMOTE = argValue('--remote') || 'origin';
const PUSH = process.argv.includes('--push');
const MARKETPLACE_NAME = 'pmz-marketplace';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

function log(s) { process.stdout.write(s + '\n'); }
function fail(s) { process.stderr.write('ERREUR publish-plugin : ' + s + '\n'); process.exit(1); }

function git(args, cwd) {
  return execFileSync('git', args, { cwd: cwd || REPO, encoding: 'utf8' });
}

// ── 0. Working tree propre requis ──
const status = git(['status', '--porcelain']).trim();
if (status) fail('working tree non propre — commit ou stash avant de publier :\n' + status);

// ── 1. Build l'artefact plugin dans un dossier temporaire ──
const tmpBuild = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-publish-build-'));
execFileSync(process.execPath, [path.join(__dirname, 'build-plugin.js'), tmpBuild], { stdio: 'inherit' });
const market = path.join(tmpBuild, 'marketplace');
if (!fs.existsSync(market)) fail('build-plugin.js n’a pas produit ' + market);

// ── 2. Renomme la marketplace locale ("pmz-local") en marketplace publique ──
const marketManifestPath = path.join(market, '.claude-plugin', 'marketplace.json');
const marketManifest = JSON.parse(fs.readFileSync(marketManifestPath, 'utf8'));
marketManifest.name = MARKETPLACE_NAME;
marketManifest.metadata = {
  description: 'Marketplace publique Promptimizer (gouvernance de session vibecoding).',
};
fs.writeFileSync(marketManifestPath, JSON.stringify(marketManifest, null, 2) + '\n');

// ── 3. Worktree détaché pour ne pas perturber le checkout courant ──
const tmpWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-publish-wt-'));
fs.rmSync(tmpWorktree, { recursive: true, force: true }); // git worktree add crée le dossier lui-même
git(['worktree', 'add', '--detach', tmpWorktree, 'HEAD']);

// La branche est régénérée à chaque publication : purge l'ancienne si présente
// (sinon `checkout --orphan` échoue sur un nom déjà pris).
try {
  git(['show-ref', '--verify', '--quiet', 'refs/heads/' + BRANCH]);
  git(['branch', '-D', BRANCH]);
} catch (_) { /* pas de branche existante — rien à purger */ }

try {
  // Branche orpheline : aucun historique hérité de main.
  git(['checkout', '--orphan', BRANCH], tmpWorktree);
  git(['rm', '-rf', '--quiet', '.'], tmpWorktree);

  // Copie l'artefact assemblé (plugin + marketplace.json) à la racine de la branche.
  for (const entry of fs.readdirSync(market)) {
    fs.cpSync(path.join(market, entry), path.join(tmpWorktree, entry), { recursive: true });
  }

  git(['add', '-A'], tmpWorktree);
  git(['commit', '--quiet', '-m', 'build(plugin): publication pmz — artefact régénéré depuis main'], tmpWorktree);

  log('Branche « ' + BRANCH + ' » régénérée (commit orphelin, local).');

  if (PUSH) {
    execFileSync('git', ['push', REMOTE, `HEAD:refs/heads/${BRANCH}`, '--force'], { cwd: tmpWorktree, stdio: 'inherit' });
    log('Poussé sur ' + REMOTE + '/' + BRANCH + '.');
  } else {
    log('Local uniquement (pas de --push). Pour publier :');
    log(`  git push ${REMOTE} ${BRANCH} --force`);
  }
} finally {
  git(['worktree', 'remove', '--force', tmpWorktree]);
  fs.rmSync(tmpBuild, { recursive: true, force: true });
}

log('');
log('Marketplace publique attendue (dépôt public + push effectué) :');
log('  claude plugin marketplace add <owner>/<repo>@' + BRANCH);
log('  claude plugin install pmz@' + MARKETPLACE_NAME);
