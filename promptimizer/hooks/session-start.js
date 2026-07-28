#!/usr/bin/env node
'use strict';
// SessionStart (matcher startup|resume|clear|compact) : détecte le projet, propose
// l'init, rappel court. N'injecte qu'au startup/clear — sauf compact, qui reçoit une
// réinjection MINIMALE du lot en cours (le contexte compacté a perdu le plan).
// Ne crée RIEN automatiquement, ne scanne jamais le repo.
// Préambule fail-open AVANT tout require : si un require échoue (module corrompu/absent),
// l'exception est captée et on sort en exit 0 (jamais exit non-0 qui bruiterait la session).
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const { armFailOpen } = require('../lib/guard');
const { SETTINGS_TIMEOUT_S, watchdogMs } = require('../lib/timeouts');
armFailOpen(watchdogMs(SETTINGS_TIMEOUT_S.sessionStart));
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { injectContext, systemMessage, passThrough } = require('../lib/output');
const { gitRoot, isFullyInitialized, hasAnyCommit, carriesRules } = require('../lib/project');
const { runBootstrap, commitScaffold } = require('../lib/bootstrap');
const { loadSessionState, saveSessionState } = require('../lib/state');
const { suggestedTitle } = require('../lib/lot');
const { readHandoff, parseSkipPaths, parseSummaryLines, markConsumed, purgeOrphanLotHandoffs } = require('../lib/handoff');
const { seedAvoidReread, seedSummaries, avoidRereadNotes, topSummaries } = require('../lib/ledger');
const { loadBacklog, currentLot, nextLot, blockedByOf, progress, readTodoSnapshot } = require('../lib/backlog');
const { fleetLines } = require('../lib/fleet');
const occupancy = require('../lib/occupancy');
const rtkStatus = require('../lib/rtk-status');
const { readVersion } = require('../lib/version');
const {
  MSG_ACTIF, MSG_ACTIF_SLIM, MSG_NON_INIT, MSG_HANDOFF, sessionTitleMessage, autoInitMessage,
  compactResumeMessage, backlogResumeMessage, occupancyMessage, rtkStartupLine,
} = require('../lib/messages');

// 1 ligne si l'état RTK est notable, RIEN si absent (zéro bruit sur l'immense majorité des
// sessions, RTK n'étant pas installé). Best-effort strict : jamais bloquant au démarrage.
function withRtk(root, msg) {
  try {
    const line = rtkStartupLine(rtkStatus.computeStatus({ root }));
    return line ? msg + '\n\n' + line : msg;
  } catch (_) {
    return msg;
  }
}

// Estampille de version PMZ (lot #111) : l'attribution de version d'une session à une epic,
// pour l'analyse de bilan, reposait jusqu'ici sur les dates de release (comparaison approximative,
// des sessions peuvent chevaucher une release) faute de marqueur direct dans les transcripts.
// Une ligne courte ajoutée à l'injection SessionStart (grep-able : `Promptimizer vX.Y.Z.`).
// readVersion() est déjà fail-open (renvoie null si VERSION illisible) ; try/catch en plus par
// prudence (jamais de crash de session-start.js pour une ligne cosmétique).
function withVersion(msg) {
  try {
    const v = readVersion();
    return v ? msg + '\n\n' + `Promptimizer v${v}.` : msg;
  } catch (_) {
    return msg;
  }
}

const OCC_RESUME_THRESHOLD = 300000;

// Filet quand il n'y a pas de handoff à injecter : 2 lignes sur le plan de lots.
function backlogFallback(root) {
  try {
    const b = loadBacklog(root);
    if (!b.lots.length) return null;
    const nxt = nextLot(b);
    return backlogResumeMessage(currentLot(b), nxt, progress(b), blockedByOf(b, nxt));
  } catch (_) {
    return null;
  }
}

// Ajoute le handoff de la session précédente (écrit par stop.js ou /fresh-session)
// au message injecté, puis le marque consommé (un handoff manuel redevient
// écrasable par le handoff auto). Fail-open : renvoie msg inchangé au moindre doute.
// `sessionId` : en vague parallèle, la fille lit SON handoff-lot-<id>.md en priorité (repli
// sur handoff.md tant qu'elle n'en a pas écrit un) — cf. lib/handoff, FIA-19.
function withHandoff(root, msg, sessionId) {
  try {
    const h = readHandoff(root, sessionId);
    if (h && h.text) {
      markConsumed(root, sessionId);
      try { seedAvoidReread(root, parseSkipPaths(h.text)); } catch (_) { /* fail-open */ }
      try { seedSummaries(root, parseSummaryLines(h.text)); } catch (_) { /* fail-open */ }
      return msg + '\n\n' + MSG_HANDOFF + '\n\n' + h.text;
    }
    // Pas de handoff injectable (premier démarrage, notes utilisateur) : le plan de
    // lots sert de filet minimal pour ne pas repartir sans objectif.
    const fb = backlogFallback(root);
    return fb ? msg + '\n\n' + fb : msg;
  } catch (_) {
    return msg;
  }
}

// Ajoute au message injecté les lignes COURTES de la vague parallèle si CETTE session tient
// un lot en vol (cf. lib/fleet.fleetLines). Silencieux (msg inchangé) hors vague ou tant que
// la session n'est pas inscrite — fail-open au moindre doute.
function withFleet(root, sessionId, msg) {
  try {
    const lines = fleetLines(root, sessionId);
    return lines.length ? msg + '\n\n' + lines.join('\n') : msg;
  } catch (_) {
    return msg;
  }
}

function main() {
  const input = parseHookInput();
  const cwd = input.cwd || process.cwd();
  const src = input.source || 'startup';
  const root = gitRoot(cwd);
  if (!root) return passThrough();

  // Après compaction : réinjection ENRICHIE sous budget explicite chiffré (#72). Ni MSG_ACTIF,
  // ni handoff, ni titre — mais le contexte compacté a perdu le plan ET la mémoire des
  // relectures : on restitue lot+verify, pmz:skip (ne pas relire), résumés connus (décisions)
  // et todos, sans dépasser COMPACT_RESUME_CAP. Silence total sans lot en cours.
  if (src === 'compact') {
    try {
      const b = loadBacklog(root);
      const cur = currentLot(b);
      if (!cur) return passThrough();
      const snap = readTodoSnapshot(root);
      const todos = snap && Array.isArray(snap.todos)
        ? snap.todos.filter((t) => t.status === 'in_progress')
          .concat(snap.todos.filter((t) => t.status === 'pending').slice(0, 2))
        : [];
      const skips = avoidRereadNotes(root, 5);
      const decisions = topSummaries(root, 3);
      // Après compaction, une session fille de vague a perdu sa contrainte de périmètre :
      // on la restitue en priorité haute (cf. compactResumeMessage). Vide hors vague.
      const fleet = fleetLines(root, input.session_id || null);
      return injectContext('SessionStart', compactResumeMessage(cur, progress(b), { todos, skips, decisions, fleet }));
    } catch (_) {
      return passThrough();
    }
  }

  // Reprise d'une session existante : aucun token injecté (le contexte est déjà là),
  // seulement un rappel VISIBLE (systemMessage) si l'occupation est déjà haute au
  // moment de la reprise — sans ça, une session reprise à 400k restait muette
  // jusqu'au premier Stop.
  if (src === 'resume') {
    try {
      const occ = occupancy.readLastOccupancy(input.transcript_path);
      if (occ != null && occ >= OCC_RESUME_THRESHOLD) {
        return systemMessage(occupancyMessage(occ, occupancy.bucketIndex(occ)));
      }
    } catch (_) {
      /* fail-open : reprise silencieuse */
    }
    return passThrough();
  }

  if (isFullyInitialized(root)) {
    // Anti-spam : un seul rappel par session, et jamais de réinjection au resume/compact
    // (sinon MSG_ACTIF regonfle le contexte à chaque reprise).
    if (src !== 'startup' && src !== 'clear') return passThrough();
    const st = loadSessionState(root, input.session_id || null);
    if (st.session_start_reminded) return passThrough();
    // Rangement opportuniste, muet (jamais dans le message injecté) : une vague ABANDONNÉE
    // (jamais réintégrée ni quittée lot par lot) laisse ses handoff-lot-*.md orphelins sur
    // disque indéfiniment (dette #100). Un seul point de passage garanti (au moins un
    // startup/clear par session) suffit ; best-effort strict, ne doit jamais gêner le rappel.
    try { purgeOrphanLotHandoffs(root); } catch (_) { /* fail-open */ }
    // Projet dont le CLAUDE.md porte déjà le bloc pmz:rules : rappel slim (pas de
    // redite des règles déjà chargées). Sinon, rappel plein.
    let msg = carriesRules(root) ? MSG_ACTIF_SLIM : MSG_ACTIF;
    msg = withRtk(root, msg);
    msg = withVersion(msg);
    try {
      // suggestedTitle (via previousSessionId) doit lire session-state.json AVANT le
      // saveSessionState ci-dessous, qui l'écrase avec le session_id de CETTE session.
      const title = suggestedTitle(root);
      msg = msg + '\n\n' + sessionTitleMessage(title);
      // Persisté pour un 2e rappel au 1er UserPromptSubmit (lot #40) — jamais recalculé
      // depuis là-bas (suggestedTitle a un effet de bord : touchLot incrémente le
      // compteur « (partie N) », un recalcul le fausserait).
      st.pending_title_rename = title;
    } catch (_) {
      /* fail-open : le rappel de base part quand même */
    }
    st.session_start_reminded = true;
    saveSessionState(root, st);
    return injectContext('SessionStart', withFleet(root, input.session_id || null, withHandoff(root, msg, input.session_id || null)));
  }
  // Non initialisé, et uniquement au vrai démarrage (l'état n'est pas persistable
  // hors projet initialisé).
  if (src !== 'startup' && src !== 'clear') return passThrough();

  // Projet NEUF (repo git existant mais 0 commit) : scaffold posé automatiquement,
  // sans confirmation — rien à écraser par construction (copyIfAbsent). Un projet
  // mature (des commits déjà) continue de nécessiter /init explicite.
  if (!hasAnyCommit(root)) {
    try {
      const result = runBootstrap(root);
      if (result.ok) {
        const committed = commitScaffold(root, result.created);
        return injectContext('SessionStart', withVersion(autoInitMessage({ gitInitDone: false, committed })));
      }
    } catch (_) {
      /* fail-open : on retombe sur la proposition normale ci-dessous */
    }
  }
  // Sinon : on PROPOSE seulement (l'init réelle se fait après confirmation).
  // Le handoff éventuel (ledger auto-créé sans socle visible) est injecté aussi.
  return injectContext('SessionStart', withVersion(withHandoff(root, MSG_NON_INIT, input.session_id || null)));
}

main();
process.exit(0);
