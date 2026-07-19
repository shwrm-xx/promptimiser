#!/usr/bin/env node
'use strict';
// Stop : garde-fou de fin de tour UNIFIÉ et NON BLOQUANT (systemMessage).
// (a) alerte palier d'occupation contexte (méthode reprise de context-guard.py) ;
// (b) rappel de clôture si un lot est ouvert (anti-spam par lot) ;
// (c) handoff auto écrit dans .vibe-agent/handoff.md (écrasé à chaque tour).
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const { armFailOpen } = require('../lib/guard');
const { SETTINGS_TIMEOUT_S, VERIFY_AUTOCLOSE_MS, watchdogMs } = require('../lib/timeouts');
armFailOpen(watchdogMs(SETTINGS_TIMEOUT_S.default));
const { disabled } = require('../lib/env');
if (disabled()) process.exit(0);

const { parseHookInput } = require('../lib/stdin');
const { systemMessage, passThrough } = require('../lib/output');
const { gitRoot, ensureLedger, gitStatusMeaningful, changelogTouched, runVerify } = require('../lib/project');
const { writeAutoHandoff } = require('../lib/handoff');
const { loadSessionState, saveSessionState } = require('../lib/state');
const { loadContextLedger, loadReadLedger, recordOccupancy, evaluateWaste } = require('../lib/ledger');
const { incrementLot } = require('../lib/lot');
const { loadBacklog, doneLot, nextLot, progress, currentLot, addCost, COST_WARN_TOKENS, epicBilan } = require('../lib/backlog');
const occupancy = require('../lib/occupancy');
const { readLastModel } = require('../lib/modelwatch');
const turnstats = require('../lib/turnstats');
const loopwatch = require('../lib/loopwatch');
const gitdebt = require('../lib/gitdebt');
const { arbitrate } = require('../lib/arbiter');
const {
  MSG_CLOTURE, occupancyMessage, redZonePrescriptionMessage, lotClosedMessage, epicBilanMessage,
  costlyTurnMessage, driftMessage, loopingCommandMessage, gitDebtMessage, bustIntraMessage, pauseTtlMessage, lotCostMessage, closureProofMessage,
  wasteBucketMessage, subagentNudgeMessage, readHygieneMessage, avoidableRereadsMessage,
  closureWithDraftMessage, lotClosureCardMessage,
} = require('../lib/messages');

function main() {
  const input = parseHookInput();
  if (input.stop_hook_active === true) return passThrough(); // anti-boucle
  const sid = input.session_id || null;
  const cwd = input.cwd || process.cwd();
  const parts = [];

  // (a) occupation contexte — fonctionne même hors projet (ne dépend que du transcript).
  const occ = occupancy.evaluate(input.transcript_path, sid);
  if (occ && occ.crossedNew && occ.bucket > 0) {
    parts.push(occupancyMessage(occ.occupancy, occ.bucket));
  }

  // (a1) ZONE ROUGE (lot #71) — prescription la PLUS grave (⛔), RELATIVE à la fenêtre du modèle
  // courant (#70) : au franchissement du seuil (≈85 % de la fenêtre), l'auto-compact approche —
  // on prescrit clôture + handoff + session fraîche AVANT de subir un résumé lossy. Le modèle
  // réel est lu au transcript (même source que la vigie modèle) ; s'il est absent, repli fenêtre
  // prudente. 1×/épisode (état 'redzone'), réarmé sur compaction plus bas. Indépendant du projet
  // (transcript + état seuls) -> marche même hors repo. Fail-open dédié dans evaluateRedZone.
  const rz = occupancy.evaluateRedZone(input.transcript_path, sid, readLastModel(input.transcript_path));
  if (rz) parts.push(redZonePrescriptionMessage(rz));

  // (a2) hygiène de lecture — indépendante du ledger, une fois par session, marche
  // même sur un projet jamais initialisé (lit le transcript brut comme (a)).
  const mix = occupancy.evaluateReadMix(input.transcript_path, sid);
  if (mix) parts.push(readHygieneMessage(mix));

  // (a2bis) nudge subagent (lot #52) — haute occupation (>= 300k) + lectures récentes :
  // suggère de déporter l'exploration hors du contexte. Anti-spam DÉDIÉ (état 'subagent'),
  // indépendant de l'hygiène ci-dessus : part même si (a2) a déjà été consommé plus tôt à
  // basse occupation. Indépendant du ledger (transcript + état seuls) -> marche hors projet.
  const sub = occupancy.evaluateSubagentNudge(input.transcript_path, sid);
  if (sub) parts.push(subagentNudgeMessage(sub.occ, sub.mix));

  // (a3) métrologie PAR TOUR — coût réel du dernier tour (scan du seul offset ajouté).
  // Fonctionne hors projet (ne dépend que du transcript). Le miroir ledger est fait
  // plus bas, quand root est connu.
  const turn = turnstats.computeTurn(input.transcript_path, sid);
  if (turn) {
    if (turn.alerts.costly) parts.push(costlyTurnMessage(turn));
    if (turn.alerts.intraBust) parts.push(bustIntraMessage(turn));
    if (turn.alerts.pause) parts.push(pauseTtlMessage(turn));
    // Redescente brutale (compaction) : le palier d'occupation persisté est périmé,
    // on le resynchronise pour réarmer les futures alertes de palier ; idem pour la
    // prescription zone-rouge (#71) — un nouveau franchissement du seuil re-prescrira.
    if (turn.alerts.resync) { occupancy.resyncBucket(sid, turn.occ); occupancy.resyncRedZone(sid); }
  }

  // (a3bis) dérive de session (#62) — tendance sur plusieurs tours (coût qui grimpe +
  // cache qui se dégrade) : prescrit la clôture. Lit l'historique que computeTurn vient
  // d'écrire (donc APRÈS lui) ; anti-spam et fail-open dédiés dans evaluateDrift.
  // Indépendant du projet (transcript + état seuls) -> marche même hors repo.
  const drift = turnstats.evaluateDrift(sid);
  if (drift) parts.push(driftMessage(drift));

  // (a3quater) vigie des tours en boucle (#69) — la même commande Bash a échoué en rafale
  // (>= 3 fois d'affilée, boucle encore ouverte) : nudge « change d'approche » plutôt que
  // laisser relancer. Anti-spam par commande (1×/session·commande) et fail-open dédiés dans
  // evaluateLoop. Indépendant du projet (transcript + état seuls) -> marche même hors repo.
  const loop = loopwatch.evaluateLoop(input.transcript_path, sid);
  if (loop) parts.push(loopingCommandMessage(loop));

  // (b) clôture — dans tout repo git (ledger auto-créé, jamais de confirmation requise).
  const root = gitRoot(cwd);
  if (root) {
    ensureLedger(root);
    // Miroir compact de l'occupation dans le ledger projet (aperçu lisible).
    if (turn && turn.occ != null) recordOccupancy(root, { occ: turn.occ, delta: turn.delta, sessionId: sid, hitRate: turn.hitRate });

    // (a5) palier de gaspillage trans-session (lot #52) — évalué INCONDITIONNELLEMENT
    // (surtout PAS dans la branche clôture, qui n'est prise qu'à tree sale) : au
    // franchissement d'un nouveau palier (25k/50k/100k puis +100k), un seul systemMessage
    // avec le top-3 des coupables. writeAtomic + fail-open dans evaluateWaste. Après
    // recordOccupancy pour lire le ledger le plus à jour.
    const waste = evaluateWaste(root);
    if (waste) parts.push(wasteBucketMessage(waste.waste, waste.topFiles));

    const st = loadSessionState(root, sid);

    // (a4) coût réel par lot (#43) : agrège la sortie du tour écoulé sur le lot EN COURS
    // (porté par le lot -> agrégat trans-session) et alerte à l'approche du budget ~300k
    // avec proposition de redécoupage. Message VISIBLE (systemMessage) donc sans coût de
    // cache, plafonné 1× par lot·session (réarmé quand le tree redevient propre, plus bas).
    // Fail-open dédié : une erreur d'agrégation ne casse jamais la clôture ci-dessous.
    try {
      const cur = currentLot(loadBacklog(root));
      if (cur) {
        const updated = (turn && turn.out > 0) ? addCost(root, cur.id, turn.out) : cur;
        const cost = updated && Number.isFinite(updated.cost_tokens) ? updated.cost_tokens : 0;
        if (cost >= COST_WARN_TOKENS && !st.cost_reminded_for_batch) {
          st.cost_reminded_for_batch = true;
          saveSessionState(root, st);
          parts.push(lotCostMessage(updated, cost));
        }
      }
    } catch (_) { /* fail-open : pas d'agrégation ni d'alerte de coût ce tour */ }

    // gitStatusMeaningful : le churn .vibe-agent/ (ledgers, handoff réécrit à
    // chaque tour) ne doit pas compter comme lot ouvert ni bloquer sa clôture.
    const dirty = gitStatusMeaningful(root);
    const open = dirty.length > 0;

    // (b0) vigie de dette git non commitée (#73) — signal de TENDANCE distinct du rappel de
    // clôture one-shot ci-dessous : nudge quand un diff significatif GROSSIT sur >= 3 tours
    // sans commit (travail non versionné exposé à la perte + commit monstre à venir). Réutilise
    // `dirty` (pas de 2e git status). Anti-spam par palier + fail-open dédiés dans evaluate.
    const debt = gitdebt.evaluate(root, sid, dirty);
    if (debt) parts.push(gitDebtMessage(debt));

    if (open && !st.closure_reminded_for_batch) {
      // Brouillon CHANGELOG servi (lot #68) : le rappel de clôture embarque une entrée
      // pré-mâchée (titre/scope du lot en cours, fichiers modifiés, verify). Fail-open :
      // toute erreur retombe sur le rappel nu.
      let closure = MSG_CLOTURE;
      try {
        const files = dirty.map((l) => l.slice(3).replace(/^"/, '').replace(/"$/, ''));
        closure = closureWithDraftMessage(currentLot(loadBacklog(root)), files, new Date().toISOString().slice(0, 10));
      } catch (_) { /* rappel de clôture sans brouillon ce tour */ }
      parts.push(closure);
      // Relectures évitables du lot (ledger context) -> note concrète (spirit de MSG_LECTURE).
      const cl = loadContextLedger(root);
      const rereads = Array.from(new Set((cl.repeated_reads || []).map((r) => r && r.path).filter(Boolean))).slice(0, 5);
      if (rereads.length) parts.push(avoidableRereadsMessage(rereads));
      st.closure_reminded_for_batch = true;
      saveSessionState(root, st);
    } else if (!open && st.closure_reminded_for_batch) {
      st.closure_reminded_for_batch = false; // working tree propre -> nouveau lot
      st.cost_reminded_for_batch = false;    // ... réarme aussi l'alerte de coût par lot (#43)
      saveSessionState(root, st);
      const closedNumber = incrementLot(root); // lot fermé -> le prochain sera proposé au SessionStart suivant
      // Auto-clôture du lot backlog — cas univoque seulement (exactement un in_progress) ;
      // sinon on ne touche à rien (réconciliation via backlog.js reconcile / close-batch).
      const b = loadBacklog(root);
      const inProg = b.lots.filter((l) => l.status === 'in_progress');
      if (inProg.length === 1) {
        const done = doneLot(root, inProg[0].id, null, closedNumber, sid, turn && turn.occ);
        if (done) {
          const after = loadBacklog(root);
          parts.push(lotClosedMessage(done, nextLot(after), progress(after)));
          // Bilan d'epic (lot #58) : émis en plus, seulement quand ce lot clôturait le
          // DERNIER lot en attente de son epic (epicBilan renvoie null sinon). Poussé AVANT
          // la carte de clôture (#59) : à sévérité INFO égale et sous plafond de l'arbitre
          // (#57, stable à égalité -> le premier poussé survit), le bilan d'epic — rare,
          // un seul par epic — doit primer sur la carte, elle qui sort à CHAQUE lot.
          const bilan = epicBilan(after, done);
          if (bilan) parts.push(epicBilanMessage(bilan));
          // Carte de clôture (lot #59) : mini-récap chiffré à CHAQUE clôture (coût, durée,
          // relectures évitées) — try/catch dédié, une erreur de lecture du ledger ne doit
          // jamais faire échouer la clôture déjà acquise ci-dessus.
          try {
            const rl = loadReadLedger(root);
            parts.push(lotClosureCardMessage(done, rl.avoid_reread_notes.length));
          } catch (_) { /* fail-open : pas de carte ce tour */ }
          // (b2) Preuve de clôture (lot #44) — APRÈS que doneLot a persisté l'état (un dépassement
          // du watchdog pendant le verify ne peut donc plus corrompre le backlog). Jamais bloquant :
          // le lot est déjà marqué fait quoi qu'il arrive ici. try/catch dédié -> fail-open local.
          try {
            const verify = done.verify
              ? Object.assign({ cmd: done.verify }, runVerify(root, done.verify, VERIFY_AUTOCLOSE_MS))
              : null;
            // tree propre ici -> changelogTouched se réduit au dernier commit (celui de clôture).
            const changelogMissing = !changelogTouched(root);
            const proof = closureProofMessage(verify, changelogMissing, !done.verify);
            if (proof) parts.push(proof);
          } catch (_) { /* fail-open : la clôture reste acquise, pas de preuve ce tour */ }
        }
      }
    }
    // (c) handoff auto : dernier état connu, ÉCRASÉ à chaque fin de tour (un seul
    // fichier, pas de bloat) ; session-start.js l'injectera au prochain démarrage.
    // Ne touche jamais un handoff manuel (/fresh-session) non encore consommé.
    writeAutoHandoff(root);
  }

  // Arbitre de tour (#57) : plafonne le nombre de nudges concaténés, priorité à la sévérité
  // (via le glyphe de tête, sans re-parser la prose). Ordre de lecture d'origine préservé.
  const shown = arbitrate(parts);
  if (shown.length) return systemMessage(shown.join('\n\n'));
  return passThrough();
}

main();
process.exit(0);
