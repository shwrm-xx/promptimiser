'use strict';
// Bootstrap PRUDENT du socle projet — logique partagée entre le script CLI
// (scripts/bootstrap-project.js, appelé par /pmz-init) et les hooks (auto-scaffold
// d'un projet neuf, cf. session-start.js / user-prompt-submit.js).
// Gardes : repo git requis, jamais $HOME/dossiers système, jamais d'écrasement —
// ne touche QUE .vibe-agent/ + CLAUDE.md + AGENTS.md + CHANGELOG.md.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { gitRoot, vibeDir, git } = require('./project');

const TEMPLATES = path.join(__dirname, '..', 'templates');
const FORBIDDEN = ['/', '/tmp', '/var', '/usr', '/etc', '/opt', '/Applications', '/System', '/Library', os.homedir()]
  .map((p) => path.resolve(p));

function isForbidden(p) {
  try {
    return FORBIDDEN.includes(path.resolve(p));
  } catch (_) {
    return true; // au doute, on refuse d'agir
  }
}

function copyIfAbsent(srcName, destPath, created, skipped) {
  try {
    if (fs.existsSync(destPath)) { skipped.push(destPath); return; }
    fs.copyFileSync(path.join(TEMPLATES, srcName), destPath);
    created.push(destPath);
  } catch (_) {
    skipped.push(destPath + ' (erreur)');
  }
}

// Scaffold non-destructif d'un repo git déjà existant (racine déjà résolue par
// l'appelant). copyIfAbsent ne remplace jamais un fichier présent : appeler ceci
// plusieurs fois sur le même repo est sans risque.
function runBootstrap(root) {
  const result = { ok: false, root: root || null, created: [], skipped: [], reason: null };
  if (!root) { result.reason = 'not_a_git_repo'; return result; }
  if (isForbidden(root)) { result.reason = 'forbidden_root'; return result; }

  const created = [];
  const skipped = [];
  const vd = vibeDir(root);
  try { fs.mkdirSync(vd, { recursive: true }); } catch (_) { /* ignore */ }

  // .vibe-agent/.gitignore EN PREMIER : whiteliste backlog.json (le plan de lots est
  // durable et ne doit JAMAIS être perdu) tout en ignorant l'état éphémère réécrit à
  // chaque tour. Posé avant les ledgers pour qu'ils naissent déjà ignorés.
  copyIfAbsent('vibe-gitignore', path.join(vd, '.gitignore'), created, skipped);
  copyIfAbsent('rules.yaml', path.join(vd, 'rules.yaml'), created, skipped);
  copyIfAbsent('context-ledger.json', path.join(vd, 'context-ledger.json'), created, skipped);
  copyIfAbsent('read-ledger.json', path.join(vd, 'read-ledger.json'), created, skipped);
  copyIfAbsent('session-state.json', path.join(vd, 'session-state.json'), created, skipped);
  copyIfAbsent('CLAUDE.md', path.join(root, 'CLAUDE.md'), created, skipped);
  copyIfAbsent('AGENTS.md', path.join(root, 'AGENTS.md'), created, skipped);
  copyIfAbsent('CHANGELOG.md', path.join(root, 'CHANGELOG.md'), created, skipped);

  result.ok = true;
  result.created = created;
  result.skipped = skipped;
  return result;
}

const PMZ_RULES_START = '<!-- pmz:rules:start -->';

// Ajoute la section PMZ taguée (templates/pmz-rules.md) à la FIN d'un fichier
// existant. Réservé au flux /pmz-init explicite (« projet en cours ») — jamais
// appelé par les hooks : l'auto-scaffold ne modifie jamais un fichier présent.
// Append-only, idempotent (marqueur), réversible (bloc pmz:rules:start/end à
// supprimer pour revenir en arrière).
function augmentIfPresent(destPath, section, augmented, skipped) {
  try {
    if (!fs.existsSync(destPath)) return; // absent -> la création relève de copyIfAbsent
    const raw = fs.readFileSync(destPath, 'utf8');
    if (raw.includes(PMZ_RULES_START)) return; // déjà porteur des règles (idempotence, cas normal)
    fs.appendFileSync(destPath, (raw.endsWith('\n') ? '\n' : '\n\n') + section);
    augmented.push(destPath);
  } catch (_) {
    skipped.push(destPath + ' (erreur)');
  }
}

// Augmente CLAUDE.md/AGENTS.md EXISTANTS d'un projet en cours avec les règles PMZ.
// Un fichier posé depuis les templates porte déjà le marqueur (les templates
// encadrent leurs règles avec pmz:rules:start/end) : jamais de double section.
function augmentExisting(root) {
  const result = { ok: false, root: root || null, augmented: [], skipped: [], reason: null };
  if (!root) { result.reason = 'not_a_git_repo'; return result; }
  if (isForbidden(root)) { result.reason = 'forbidden_root'; return result; }
  let section;
  try {
    section = fs.readFileSync(path.join(TEMPLATES, 'pmz-rules.md'), 'utf8');
  } catch (_) {
    result.reason = 'template_missing';
    return result;
  }
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    augmentIfPresent(path.join(root, name), section, result.augmented, result.skipped);
  }
  result.ok = true;
  return result;
}

// Commit initial du socle — best-effort (dépôt sans user.name/email configuré,
// etc.), jamais bloquant. `git()` (lib/project.js) ne throw jamais, renvoie null
// sur échec.
function commitScaffold(root, created) {
  if (!created || !created.length) return false;
  // Ajout FICHIER PAR FICHIER : l'état éphémère de .vibe-agent/ (ledgers, session-state)
  // est désormais gitignoré (cf. .vibe-agent/.gitignore) et `git add` le refuse — on le
  // saute sans faire échouer le commit du reste du socle (backlog.json et rules.yaml, eux,
  // sont whitelistés donc bien commités). git() ne throw jamais (fail-open).
  let staged = 0;
  for (const p of created) {
    const rel = path.relative(root, p);
    if (rel && git(['add', '--', rel], root) !== null) staged += 1;
  }
  if (!staged) return false;
  const msg = 'chore: socle Promptimizer (CLAUDE.md, AGENTS.md, CHANGELOG.md, plan de lots)';
  return git(['commit', '-m', msg], root) !== null;
}

// Pour un dossier qui n'est PAS encore un repo git : git init + scaffold + 1er
// commit. Fail-open : ne throw jamais, retourne {ok:false, reason} sur tout échec.
function autoInitGitAndBootstrap(cwd) {
  if (isForbidden(cwd)) {
    return { ok: false, root: null, created: [], skipped: [], reason: 'forbidden_root' };
  }
  git(['init'], cwd);
  const root = gitRoot(cwd);
  if (!root) {
    return { ok: false, root: null, created: [], skipped: [], reason: 'git_init_failed' };
  }
  const result = runBootstrap(root);
  if (result.ok) {
    result.gitInitDone = true;
    result.committed = commitScaffold(root, result.created);
  }
  return result;
}

module.exports = { runBootstrap, augmentExisting, autoInitGitAndBootstrap, commitScaffold, isForbidden, FORBIDDEN };
