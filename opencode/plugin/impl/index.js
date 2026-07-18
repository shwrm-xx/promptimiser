'use strict';
// Cœur du plugin PMZ pour OpenCode — lot OC1 : squelette instrumenté.
// Chaque hook cible du portage est branché en no-op journalisé (preuve de vie),
// enveloppé dans bridge.guard() (fail-open absolu). La logique métier arrive aux
// lots OC2–OC4. Contrat, mapping des hooks et gaps assumés : voir opencode/NOTES.md.
const bridge = require('./bridge');
const ocdir = require('./oc-dir');

// Événements du bus retenus dans le journal (message.part.updated & co sont trop bavards).
const LOGGED_EVENTS = /^(session\.|permission\.|file\.edited|command\.executed)/;

async function createHooks(input) {
  if (process.env.PMZ_DISABLE === '1') return {};
  const client = input && input.client;
  const version = ocdir.readVersion();
  bridge.log('plugin.loaded', { version, directory: (input && input.directory) || null });

  return {
    // ≈ SessionStart / Stop / PreCompact (filet) — bus d'événements catch-all.
    event: bridge.guard('event', async ({ event }) => {
      if (!event || typeof event.type !== 'string') return;
      if (!LOGGED_EVENTS.test(event.type)) return;
      bridge.log('event', { type: event.type });
      if (event.type === 'session.created') {
        await bridge.toast(client, 'PMZ v' + version + ' actif (squelette OC1)');
      }
    }),
    // ≈ UserPromptSubmit — futurs nudges init/broad/occupation/model-mismatch (OC3/OC4).
    'chat.message': bridge.guard('chat.message', async (inp) => {
      bridge.log('chat.message', {
        sessionID: (inp && inp.sessionID) || null,
        model: inp && inp.model ? inp.model.providerID + '/' + inp.model.modelID : null,
      });
    }),
    // ≈ PreToolUse — futur verdict deny/ask/allow sur bash (OC2).
    'tool.execute.before': bridge.guard('tool.execute.before', async (inp) => {
      bridge.log('tool.execute.before', { tool: (inp && inp.tool) || null });
    }),
    // ≈ PostToolUse — futurs ledgers de lecture/édition + todo-snapshot (OC2).
    'tool.execute.after': bridge.guard('tool.execute.after', async (inp) => {
      bridge.log('tool.execute.after', { tool: (inp && inp.tool) || null });
    }),
    // Tiers « destructif » du verdict PreToolUse (OC2) — no-op : ne change jamais le statut.
    'permission.ask': bridge.guard('permission.ask', async () => {
      bridge.log('permission.ask', {});
    }),
    // ≈ PreCompact — futur handoff avant compaction (OC3). API experimental : filet
    // session.compacted côté event obligatoire.
    'experimental.session.compacting': bridge.guard('experimental.session.compacting', async (inp) => {
      bridge.log('experimental.session.compacting', { sessionID: (inp && inp.sessionID) || null });
    }),
  };
}

module.exports = { createHooks };
