'use strict';
// Cœur du plugin PMZ pour OpenCode — lot OC2 : sûreté Bash + ledgers.
// Chaque hook cible du portage est branché en no-op journalisé (préserve OC1) ; OC2 ajoute
// la logique métier de deux hooks : garde Bash (tool.execute.before/permission.ask) et
// ledgers (tool.execute.after). Le reste attend OC3/OC4. Contrat, mapping des hooks et
// gaps assumés : voir opencode/NOTES.md.
const path = require('path');
const fs = require('fs');
const bridge = require('./bridge');
const ocdir = require('./oc-dir');
const { classify } = require('../lib/bash-guard');
const project = require('../lib/project');
const ledger = require('../lib/ledger');
const { writeTodoSnapshot } = require('../lib/backlog');

// Événements du bus retenus dans le journal (message.part.updated & co sont trop bavards).
const LOGGED_EVENTS = /^(session\.|permission\.|file\.edited|command\.executed)/;

function short(cmd) {
  return cmd.length > 200 ? cmd.slice(0, 200) + '…' : cmd;
}

// Commande Bash portée par un appel tool.execute.before (args.command / args.cmd, défensif).
function bashCommandFromArgs(args) {
  return String((args && (args.command || args.cmd)) || '');
}

// Commande Bash portée par une Permission OpenCode (permission.ask) — le champ exact
// (metadata.command vs pattern) n'est pas garanti par le SDK : on tente les deux, défensif.
function bashCommandFromPermission(perm) {
  if (!perm) return '';
  if (perm.metadata && typeof perm.metadata.command === 'string') return perm.metadata.command;
  if (Array.isArray(perm.pattern)) return perm.pattern.join(' ');
  if (typeof perm.pattern === 'string') return perm.pattern;
  return String(perm.title || '');
}

function relOf(root, fp) {
  try {
    const r = path.relative(root, fp);
    return r && !r.startsWith('..') ? r : fp;
  } catch (_) {
    return fp;
  }
}

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
    // ≈ PreToolUse — garde Bash catastrophique. Pas de bridge.guard() ici : bridge.guard()
    // avale les throws, or un deny volontaire EST un throw délibéré (seul canal de blocage
    // synchrone que tool.execute.before offre). Tout le reste (log, classification) reste
    // défensif en interne — seul le throw de deny doit atteindre l'appelant.
    'tool.execute.before': async (inp, out) => {
      if (process.env.PMZ_DISABLE === '1') return;
      const tool = inp && inp.tool;
      try { bridge.log('tool.execute.before', { tool: tool || null }); } catch (_) {}
      if (tool !== 'bash') return;
      let verdict = null;
      let cmd = '';
      try {
        cmd = bashCommandFromArgs(out && out.args);
        verdict = classify(cmd);
      } catch (_) { verdict = null; }
      if (verdict !== 'deny') return;
      // Tiers « ask » (destructif, non catastrophique) : pas de blocage direct ici — pas de
      // canal de confirmation synchrone depuis ce hook. Relayé par permission.ask ci-dessous
      // quand OpenCode déclenche son propre contrôle de permission pour l'appel.
      try { bridge.log('tool.execute.before.deny', { cmd: short(cmd) }); } catch (_) {}
      throw new Error('PMZ : commande catastrophique bloquée — ' + short(cmd));
    },
    // ≈ PostToolUse — ledgers de lecture/édition + todo-snapshot.
    'tool.execute.after': bridge.guard('tool.execute.after', async (inp, out) => {
      const tool = (inp && inp.tool) || null;
      bridge.log('tool.execute.after', { tool });
      const root = input && input.directory;
      if (!root || !tool) return;
      const args = (inp && inp.args) || {};
      const sid = (inp && inp.sessionID) || null;
      if (tool === 'todowrite') {
        writeTodoSnapshot(root, args.todos, sid);
        return;
      }
      const fp = args.filePath || args.path || args.file;
      if (!fp) return;
      project.ensureLedger(root);
      const rel = relOf(root, fp);
      if (tool === 'read') {
        let stat = null;
        try {
          const st = fs.statSync(fp);
          stat = { bytes: st.size, mtimeMs: st.mtimeMs };
        } catch (_) { /* fichier disparu/inaccessible : coût inconnu, pas de gaspillage */ }
        ledger.recordRead(root, rel, sid, false, stat);
      } else if (tool === 'edit' || tool === 'write') {
        ledger.recordModify(root, rel, sid);
      }
    }),
    // Tiers « destructif » (ask) du verdict Bash — s'appuie sur le contrôle de permission
    // natif d'OpenCode quand il se déclenche pour cet appel (bash gated par la config de
    // l'agent) : PMZ ne fait jamais que RESSERRER un statut déjà résolu (allow -> ask/deny),
    // jamais l'inverse (ne dégrade pas une décision plus stricte prise ailleurs).
    'permission.ask': bridge.guard('permission.ask', async (inp, out) => {
      bridge.log('permission.ask', { type: inp && inp.type });
      if (!inp || inp.type !== 'bash' || !out) return;
      const cmd = bashCommandFromPermission(inp);
      const verdict = classify(cmd);
      if (verdict === 'deny') { out.status = 'deny'; return; }
      if (verdict === 'ask' && out.status === 'allow') { out.status = 'ask'; }
    }),
    // ≈ PreCompact — futur handoff avant compaction (OC3). API experimental : filet
    // session.compacted côté event obligatoire.
    'experimental.session.compacting': bridge.guard('experimental.session.compacting', async (inp) => {
      bridge.log('experimental.session.compacting', { sessionID: (inp && inp.sessionID) || null });
    }),
  };
}

module.exports = { createHooks };
