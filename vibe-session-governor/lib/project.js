'use strict';
// Détection projet partagée. Aucune lecture massive : git + existsSync seulement.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
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
  git, gitRoot, vibeDir, isInitialized, exists, detectStack,
  gitStatusPorcelain, lastCommitEpoch, hasAnyCommit, changelogTouched,
};
