#!/usr/bin/env node
'use strict';
// Détection projet -> JSON sur stdout. Ne lit jamais tout le repo.
const { gitRoot, isInitialized, exists, detectStack } = require('../lib/project');

function parseCwd() {
  const i = process.argv.indexOf('--cwd');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.cwd();
}

function main() {
  const cwd = parseCwd();
  const root = gitRoot(cwd);
  const out = {
    is_git_repo: !!root,
    root: root || null,
    initialized: root ? isInitialized(root) : false,
    has_claude_md: root ? exists(root, 'CLAUDE.md') : false,
    has_agents_md: root ? exists(root, 'AGENTS.md') : false,
    has_changelog: root ? exists(root, 'CHANGELOG.md') : false,
    stack: root ? detectStack(root) : 'unknown',
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

try { main(); } catch (_) { process.stdout.write('{}\n'); }
process.exit(0);
