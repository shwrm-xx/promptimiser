'use strict';
// Cœur du plugin PMZ pour OpenCode.
//   OC2 : sûreté Bash (tool.execute.before/permission.ask) + ledgers (tool.execute.after).
//   OC3 : métrologie d'occupation RELATIVE à la fenêtre du modèle (event message.updated +
//         fallback client.session.messages), franchissements en toast ; session.idle
//         (occupation + clôture + handoff, idempotent multi-idle) ; injection différée au
//         (re)démarrage (session.created / session.compacted -> 1er chat.message) ; suggestion
//         de renommage de session. Contrat, mapping des hooks et gaps assumés : opencode/NOTES.md.
const path = require('path');
const fs = require('fs');
const bridge = require('./bridge');
const ocdir = require('./oc-dir');
const occ = require('./occupancy-oc');
const { classify } = require('../lib/bash-guard');
const project = require('../lib/project');
const ledger = require('../lib/ledger');
const {
  writeTodoSnapshot, loadBacklog, currentLot, nextLot, progress, readTodoSnapshot, doneLot,
} = require('../lib/backlog');
const { loadSessionState, saveSessionState } = require('../lib/state');
const { readHandoff, markConsumed, parseSkipPaths, writeAutoHandoff } = require('../lib/handoff');
const { incrementLot, suggestedTitle } = require('../lib/lot');
const {
  MSG_ACTIF, MSG_HANDOFF, MSG_CLOTURE, backlogResumeMessage, compactResumeMessage,
} = require('../lib/messages');

// Événements du bus retenus dans le journal (message.updated & part.updated sont trop bavards
// pour être journalisés ligne à ligne — ils sont traités hors log).
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

// Racine git normalisée du projet (input.directory peut être un sous-dossier). Repli sur
// le répertoire fourni si ce n'est pas un repo git (writeAutoHandoff sera alors no-op).
function repoRoot(dir) {
  try { return project.gitRoot(dir) || dir; } catch (_) { return dir; }
}

async function createHooks(input) {
  if (process.env.PMZ_DISABLE === '1') return {};
  const client = input && input.client;
  const version = ocdir.readVersion();
  bridge.log('plugin.loaded', { version, directory: (input && input.directory) || null });

  // Catalogue des modèles (fenêtres context/output) — récupéré paresseusement une fois par
  // vie du plugin. `undefined` = pas encore tenté ; `null` = échec (on ne réessaie pas).
  let providersCache;
  async function getLimit(providerID, modelID) {
    if (!providerID || !modelID) return null;
    if (!client || !client.config || typeof client.config.providers !== 'function') return null;
    if (providersCache === undefined) {
      try {
        const res = await client.config.providers();
        providersCache = res && res.data ? res.data : res; // SDK: { data } (throwOnError=false)
      } catch (_) {
        providersCache = null;
      }
    }
    const list = providersCache && Array.isArray(providersCache.providers) ? providersCache.providers : null;
    if (!list) return null;
    const prov = list.find((p) => p && p.id === providerID);
    const model = prov && prov.models ? prov.models[modelID] : null;
    return model && model.limit ? model.limit : null;
  }

  // Repli d'occupation à l'idle : dernier message assistant via l'API messages, quand aucun
  // message.updated n'a été capté (ex. plugin chargé en cours de session). Défensif.
  async function fallbackMessage(sid) {
    if (!sid || !client || !client.session || typeof client.session.messages !== 'function') return null;
    try {
      const res = await client.session.messages({ path: { id: sid } });
      const arr = res && res.data ? res.data : res;
      if (!Array.isArray(arr)) return null;
      for (let i = arr.length - 1; i >= 0; i--) {
        const info = arr[i] && arr[i].info;
        if (info && info.role === 'assistant' && info.tokens) return info;
      }
    } catch (_) { /* fail-open */ }
    return null;
  }

  // Franchissement de palier d'occupation -> toast (canal visible : pas de statusline OpenCode).
  async function evaluateOccupancy(sid) {
    let rec = occ.readRecord(sid);
    if (!rec) {
      const info = await fallbackMessage(sid);
      if (info && occ.recordFromMessage(info)) rec = occ.readRecord(sid);
    }
    if (!rec) return;
    const limit = await getLimit(rec.providerID, rec.modelID);
    const useful = occ.usefulWindow(limit);
    if (!useful) return; // fenêtre inconnue (modèle local sans limit) -> pas d'alerte relative
    const e = occ.evaluate(sid, useful);
    if (e && e.crossedNew && e.bucket > 0) {
      await bridge.toast(client, occ.occupancyToast(e.pct, e.occ), e.bucket >= 3 ? 'warning' : 'info');
    }
  }

  // Clôture (rappel anti-spam + auto-clôture mécanique sur tree propre) + handoff auto.
  // Miroir de hooks/stop.js (Claude Code), canal = toast au lieu de systemMessage. La preuve
  // de clôture (verify) reste hors périmètre OC3 (commande /close-batch -> OC4).
  async function closureAndHandoff(dir, sid) {
    const root = repoRoot(dir);
    if (!root) return;
    try {
      project.ensureLedger(root);
      const st = loadSessionState(root, sid);
      const open = project.gitStatusMeaningful(root).length > 0;
      if (open && !st.closure_reminded_for_batch) {
        st.closure_reminded_for_batch = true;
        saveSessionState(root, st);
        await bridge.toast(client, MSG_CLOTURE.split('\n')[0] + ' Propose /close-batch (commit + changelog + handoff).', 'info');
      } else if (!open && st.closure_reminded_for_batch) {
        // Tree redevenu propre -> lot considéré clos : réarme les rappels et incrémente le
        // compteur de lot. Auto-clôture backlog seulement si UN seul lot in_progress (univoque).
        st.closure_reminded_for_batch = false;
        st.cost_reminded_for_batch = false;
        saveSessionState(root, st);
        const closedNumber = incrementLot(root);
        const b = loadBacklog(root);
        const inProg = b.lots.filter((l) => l.status === 'in_progress');
        if (inProg.length === 1) {
          const r = occ.readRecord(sid);
          doneLot(root, inProg[0].id, null, closedNumber, sid, r ? r.occ : null);
        }
      }
      writeAutoHandoff(root);
    } catch (_) { /* fail-open : l'idle ne casse jamais la session */ }
  }

  // Renommage de session (client.session.update) — UNE fois par session, au 1er idle (une
  // fois qu'un lot/commit existe pour nommer le titre). Contrairement à Claude Code, où PMZ
  // ne fait que SUGGÉRER un titre (l'utilisateur valide via question à choix), OpenCode n'offre
  // aucun canal de confirmation interactif à un plugin : le titre PMZ est donc appliqué
  // directement, mais jamais réécrit ensuite (drapeau `renamed` par session) — un renommage
  // ultérieur (utilisateur/OpenCode) est préservé. suggestedTitle a un effet de bord (touchLot :
  // compteur « (partie N) ») : appelé ICI, une seule fois par session.
  async function maybeRename(dir, sid) {
    if (!client || !client.session || typeof client.session.update !== 'function') return;
    const flag = occ.stateFile(sid, 'renamed');
    try { if (fs.existsSync(flag)) return; } catch (_) { return; }
    let title = null;
    try { title = suggestedTitle(repoRoot(dir)); } catch (_) { title = null; }
    if (!title) return;
    try {
      await client.session.update({ path: { id: sid }, body: { title } });
      try { fs.writeFileSync(flag, '1'); } catch (_) {}
      bridge.log('session.renamed', { sid, title: title.slice(0, 80) });
    } catch (_) { /* fail-open : renommage best-effort, jamais bloquant */ }
  }

  // Texte injecté au 1er chat.message après session.created : gouvernance + handoff (ou plan
  // de lots à défaut) + suggestion de renommage. Miroir de hooks/session-start.js (startup).
  function buildStartInjection(dir) {
    const root = repoRoot(dir);
    const parts = [MSG_ACTIF];
    try {
      const h = readHandoff(root);
      if (h && h.text) {
        markConsumed(root);
        try { ledger.seedAvoidReread(root, parseSkipPaths(h.text)); } catch (_) {}
        parts.push(MSG_HANDOFF + '\n\n' + h.text);
      } else {
        const b = loadBacklog(root);
        if (b.lots.length) parts.push(backlogResumeMessage(currentLot(b), nextLot(b), progress(b)));
      }
    } catch (_) { /* fail-open : au moins la gouvernance part */ }
    return parts.join('\n\n');
  }

  // Réinjection MINIMALE du lot en cours après compaction (le contexte a perdu le plan).
  function buildCompactInjection(dir) {
    const root = repoRoot(dir);
    try {
      const b = loadBacklog(root);
      const cur = currentLot(b);
      if (!cur) return null;
      const snap = readTodoSnapshot(root);
      const todos = snap && Array.isArray(snap.todos)
        ? snap.todos.filter((t) => t.status === 'in_progress')
          .concat(snap.todos.filter((t) => t.status === 'pending').slice(0, 2))
        : [];
      return compactResumeMessage(cur, progress(b), todos);
    } catch (_) {
      return null;
    }
  }

  return {
    // ≈ SessionStart / Stop / PreCompact / occupation — bus d'événements catch-all.
    event: bridge.guard('event', async ({ event }) => {
      if (!event || typeof event.type !== 'string') return;
      const t = event.type;
      const props = event.properties || {};
      // Occupation : enregistrement silencieux du dernier message assistant (pas de log,
      // message.updated est bavard en streaming).
      if (t === 'message.updated') { occ.recordFromMessage(props.info); return; }
      if (LOGGED_EVENTS.test(t)) bridge.log('event', { type: t });
      if (t === 'session.created') {
        const session = props.info || null;
        await bridge.toast(client, 'PMZ v' + version + ' actif');
        const dir = input && input.directory;
        if (dir && session && session.id) {
          const text = buildStartInjection(dir);
          if (text) occ.putPending(session.id, text);
        }
      } else if (t === 'session.idle') {
        const sid = props.sessionID || null;
        if (!sid) return;
        await evaluateOccupancy(sid);
        const dir = input && input.directory;
        if (dir) {
          await closureAndHandoff(dir, sid);
          await maybeRename(dir, sid);
        }
      } else if (t === 'session.compacted') {
        const sid = props.sessionID || null;
        if (!sid) return;
        occ.clearUsage(sid);
        occ.resyncBucket(sid, 0);
        const dir = input && input.directory;
        if (dir) {
          const text = buildCompactInjection(dir);
          if (text) occ.putPending(sid, text);
        }
      }
    }),
    // ≈ UserPromptSubmit — flush de l'injection différée (created/compacted). Futurs nudges
    // init/broad/model-mismatch : OC4.
    'chat.message': bridge.guard('chat.message', async (inp, out) => {
      const sid = (inp && inp.sessionID) || null;
      bridge.log('chat.message', {
        sessionID: sid,
        model: inp && inp.model ? inp.model.providerID + '/' + inp.model.modelID : null,
      });
      if (!sid || !out || !Array.isArray(out.parts)) return;
      const pending = occ.takePending(sid);
      if (!pending) return;
      const msg = out.message || {};
      out.parts.push({
        id: (msg.id || 'pmz') + '-pmz-inject',
        sessionID: msg.sessionID || sid,
        messageID: msg.id || '',
        type: 'text',
        text: pending,
        synthetic: true,
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
    // ≈ PreCompact — filet avant compaction. La réinjection réelle se fait à session.compacted
    // (event ci-dessus) : l'API experimental.session.compacting n'a pas de garantie de tir.
    'experimental.session.compacting': bridge.guard('experimental.session.compacting', async (inp) => {
      bridge.log('experimental.session.compacting', { sessionID: (inp && inp.sessionID) || null });
    }),
  };
}

module.exports = { createHooks };
