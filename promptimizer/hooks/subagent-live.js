#!/usr/bin/env node
'use strict';
// SubagentStart / SubagentStop : tient à jour .vibe-agent/epicmaster-live.json (lot #136) pour que
// `backlog.js epicmaster --live` et la statusline sachent combien de sous-agents tournent pendant une
// session maître. Silencieux et NON BLOQUANT : aucune sortie, toujours exit 0. N'écrit que si une
// session maître est en cours (lib/epicmaster-live.js) — sans elle, aucun fichier n'est créé.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const { armFailOpen } = require('../lib/guard');
const { SETTINGS_TIMEOUT_S, watchdogMs } = require('../lib/timeouts');
armFailOpen(watchdogMs(SETTINGS_TIMEOUT_S.default));
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { gitRoot } = require('../lib/project');
const live = require('../lib/epicmaster-live');

function main() {
  const input = parseHookInput();
  const name = String(input.hook_event_name || '');
  const event = /stop/i.test(name) ? 'stop' : /start/i.test(name) ? 'start' : null;
  if (!event) return;
  const root = gitRoot(input.cwd || process.cwd());
  if (root) live.recordSubagent(root, event, input);
}

try { main(); } catch (_) { /* fail-open */ }
process.exit(0);
