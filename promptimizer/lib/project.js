'use strict';
// Détection projet partagée. Aucune lecture massive : git + existsSync seulement.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveTool } = require('./env');

// Chemin absolu de git résolu une fois (même angle mort PATH que node sous les apps GUI macOS).
const GIT = resolveTool('git');

function git(args, cwd) {
  try {
    return execFileSync(GIT, args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch (_) {
    return null;
  }
}

function gitRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], cwd) || null;
}

function vibeDir(root) {
  return path.join(root, '.vibe-agent');
}

function isInitialized(root) {
  try {
    return !!root && fs.existsSync(vibeDir(root));
  } catch (_) {
    return false;
  }
}

// Crée .vibe-agent/ silencieusement si absent (plomberie interne, jamais de contenu
// visible ajouté au repo utilisateur). Idempotent, ne remonte jamais d'erreur.
function ensureLedger(root) {
  try {
    if (!root) return false;
    fs.mkdirSync(vibeDir(root), { recursive: true });
    return true;
  } catch (_) {
    return false;
  }
}

// Socle visible posé (CLAUDE.md) EN PLUS du ledger — distinct de isInitialized()
// qui ne teste que la plomberie interne (désormais auto-créée par ensureLedger).
function isFullyInitialized(root) {
  return isInitialized(root) && exists(root, 'CLAUDE.md');
}

function exists(root, name) {
  try {
    return fs.existsSync(path.join(root, name));
  } catch (_) {
    return false;
  }
}

function detectStack(root) {
  const manifests = [
    ['package.json', 'node'],
    ['pyproject.toml', 'python'],
    ['requirements.txt', 'python'],
    ['Cargo.toml', 'rust'],
    ['go.mod', 'go'],
    ['Gemfile', 'ruby'],
    ['pom.xml', 'java'],
    ['composer.json', 'php'],
  ];
  for (const [file, label] of manifests) {
    if (exists(root, file)) return label;
  }
  return 'unknown';
}

function gitStatusPorcelain(root) {
  const out = git(['status', '--porcelain'], root);
  if (out == null) return [];
  return out.split('\n').filter((l) => l.trim() !== '');
}

// Statut porcelain SANS le bruit .vibe-agent/ : les ledgers et le handoff sont
// réécrits par les hooks à chaque tour ; seul le reste compte comme « lot ouvert ».
function gitStatusMeaningful(root) {
  return gitStatusPorcelain(root).filter((l) => {
    const p = l.slice(3).replace(/^"/, '');
    return !p.startsWith('.vibe-agent');
  });
}

function lastCommitEpoch(root) {
  const out = git(['log', '-1', '--format=%ct'], root);
  if (!out) return null;
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : null;
}

function hasAnyCommit(root) {
  return git(['rev-parse', '--verify', 'HEAD'], root) != null;
}

function changelogTouched(root) {
  // CHANGELOG.md dans les changements non commités OU dans le dernier commit
  const porcelain = gitStatusPorcelain(root);
  if (porcelain.some((l) => /CHANGELOG\.md\s*$/i.test(l))) return true;
  if (hasAnyCommit(root)) {
    const last = git(['show', '--name-only', '--format=', 'HEAD'], root);
    if (last && /CHANGELOG\.md/i.test(last)) return true;
  }
  return false;
}

module.exports = {
  git, gitRoot, vibeDir, isInitialized, ensureLedger, isFullyInitialized, exists, detectStack,
  gitStatusPorcelain, gitStatusMeaningful, lastCommitEpoch, hasAnyCommit, changelogTouched,
};
