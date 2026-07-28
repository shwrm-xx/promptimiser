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
const { gitRoot, ensureLedger, gitStatusMeaningful, changelogTouched, runVerify, git } = require('../lib/project');
const { writeAutoHandoff } = require('../lib/handoff');
const { loadSessionState, saveSessionState } = require('../lib/state');
const { loadContextLedger, loadReadLedger, recordOccupancy, evaluateWaste } = require('../lib/ledger');
const { incrementLot } = require('../lib/lot');
const { loadBacklog, doneLot, setClosedVerify, nextLot, blockedByOf, progress, currentLot, addCost, COST_WARN_TOKENS, epicBilan } = require('../lib/backlog');
const occupancy = require('../lib/occupancy');
const { readLastModel } = require('../lib/modelwatch');
const turnstats = require('../lib/turnstats');
const loopwatch = require('../lib/loopwatch');
const gitdebt = require('../lib/gitdebt');
const claudemd = require('../lib/claudemd');
const notify = require('../lib/notify');
const { arbitrate } = require('../lib/arbiter');
const { SEV, withSeverity } = require('../lib/severity');
const {
  MSG_CLOTURE, occupancyMessage, redZonePrescriptionMessage,
  costlyTurnMessage, driftMessage, loopingCommandMessage, gitDebtMessage, claudeMdMessage, bustIntraMessage, pauseTtlMessage, lotCostMessage, closureProofMessage,
  wasteBucketMessage, subagentNudgeMessage, readHygieneMessage, avoidableRereadsMessage,
  closureWithDraftMessage, closureCardMessage, freshSessionCodaMessage,
} = require('../lib/messages');

// Un commit est-il tombé DEPUIS le démarrage du lot ? (lot #108) Sert d'armement de l'auto-clôture
// quand le flag de session `closure_reminded_for_batch` n'a jamais été posé (lot démarré dans une
// session, commité dans une autre — le flag est remis à zéro à chaque session, si bien que le lot
// restait `in_progress` pour toujours et que la carte de clôture ne sortait jamais). Comparaison
// date de commit de HEAD vs `started_at` du lot : aucune persistance nouvelle, et robuste aux
// sessions fraîches, contrairement à un sha mémorisé dans l'état de session.
// Sans `started_at` (lot legacy) -> false : on retombe sur l'ancien armement, jamais de régression.
// Fail-open total : toute erreur git/date -> false (pas de clôture inventée).
function committedSinceLotStart(root, lot) {
  try {
    if (!lot || !lot.started_at) return false;
    const iso = git(['log', '-1', '--format=%cI', 'HEAD'], root);
    if (!iso) return false; // pas encore de commit dans le repo
    const head = new Date(iso).getTime();
    const start = new Date(lot.started_at).getTime();
    if (!Number.isFinite(head) || !Number.isFinite(start)) return false;
    return head > start;
  } catch (_) {
    return false;
  }
}

function main() {
  const input = parseHookInput();
  if (input.stop_hook_active === true) return passThrough(); // anti-boucle
  const sid = input.session_id || null;
  const cwd = input.cwd || process.cwd();
  const parts = [];
  // Coda de clôture (lot #108) : prescription hors arbitre — émise APRÈS arbitrate(), donc jamais
  // évincée par le plafond de nudges. Reste null tant qu'aucun lot n'est clos ce tour.
  let coda = null;

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
  if (rz) {
    parts.push(redZonePrescriptionMessage(rz));
    notify.notifyRedZone(); // opt-in (#75) ; anti-spam déjà géré par evaluateRedZone lui-même
  }

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

    // (b0bis) vigie de gouvernance du CLAUDE.md (#74) — absent (chaque session repart sans
    // règles) ou hypertrophié (> seuil d'octets, repayé à chaque session) : nudge créer /
    // dégraisser. 1×/session ; anti-spam + fail-open dédiés dans claudemd.evaluate.
    const cgov = claudemd.evaluate(root, sid);
    if (cgov) parts.push(claudeMdMessage(cgov));

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
    } else if (!open) {
      const wasReminded = st.closure_reminded_for_batch === true;
      if (wasReminded) {
        st.closure_reminded_for_batch = false; // working tree propre -> nouveau lot
        st.cost_reminded_for_batch = false;    // ... réarme aussi l'alerte de coût par lot (#43)
        saveSessionState(root, st);
      }
      // Auto-clôture du lot backlog — cas univoque seulement (exactement un in_progress) ;
      // sinon on ne touche à rien (réconciliation via backlog.js reconcile / close-batch).
      // Armement (lot #108) : le flag de session ci-dessus (le tree a été vu sale PUIS propre
      // dans CETTE session) OU, à défaut, l'état du BACKLOG lui-même — un lot en cours, un arbre
      // propre et un commit tombé depuis son démarrage. Sans ce second armement, un lot démarré
      // dans une session et commité dans la suivante (flag remis à zéro entre les deux) restait
      // `in_progress` indéfiniment : ni clôture, ni carte, ni preuve.
      const b = loadBacklog(root);
      const inProg = b.lots.filter((l) => l.status === 'in_progress');
      const armed = inProg.length === 1 && (wasReminded || committedSinceLotStart(root, inProg[0]));
      if (wasReminded || armed) {
        const closedNumber = incrementLot(root); // lot fermé -> le prochain sera proposé au SessionStart suivant
        if (armed) {
          const lotToClose = inProg[0];
          // Preuve de clôture calculée AVANT doneLot (lot #111) — répare la clôture fantôme du
          // lot #110 (marqué `done` avec closed_verify:"timeout" alors qu'aucun fichier du lot
          // n'existait) : le verdict était jadis calculé APRÈS que doneLot ait déjà persisté le
          // lot en `done`, si bien qu'un timeout ne pouvait plus rien empêcher — juste être
          // constaté a posteriori. Un verify qui n'a pas eu le temps de conclure n'est NI une
          // preuve de réussite NI une preuve d'échec : il ne doit donc jamais pouvoir produire
          // un `done`. Calculer le verdict ICI, avant toute écriture, permet de REFUSER la
          // clôture plutôt que de la défaire après coup. `failed` (échec net, pas un timeout)
          // reste non bloquant, comportement historique inchangé (lot #44/#96, cf. T4).
          let verify = null;
          let verdict = 'none';
          if (lotToClose.verify) {
            verify = Object.assign({ cmd: lotToClose.verify }, runVerify(root, lotToClose.verify, VERIFY_AUTOCLOSE_MS));
            verdict = verify.ok ? 'ok' : (verify.timedOut ? 'timeout' : 'failed');
          }
          if (verdict === 'timeout') {
            // Clôture fantôme évitée : le lot reste `in_progress`, annoncé EXPLICITEMENT (jamais
            // de silence) — /close-batch relance la même preuve avec un délai large (VERIFY_CLOSE_MS).
            parts.push(withSeverity(SEV.WARN, [
              `Lot « ${lotToClose.title} » NON clôturé : verify (\`${lotToClose.verify}\`) n'a pas terminé dans le délai court de l'auto-clôture (${Math.round(VERIFY_AUTOCLOSE_MS / 1000)} s).`,
              'Le lot reste en cours (aucune clôture fantôme) — relance la preuve via /close-batch (délai plus large) avant de clore.',
            ]));
          } else {
            const done = doneLot(root, lotToClose.id, null, closedNumber, sid, turn && turn.occ);
            if (done) {
              notify.notifyLotClosed(done); // opt-in (#75) ; événement one-shot, pas d'anti-spam dédié nécessaire
              const after = loadBacklog(root);
              const nxt = nextLot(after);
              // Carte de clôture UNIQUE (lot #108) : lot clos + suivant (#97) + bilan d'epic (#58,
              // seulement au DERNIER lot de son epic) + chiffres du lot (#59) en UN nudge, donc UNE
              // place d'arbitre — jadis 3 (voire 4 avec la preuve) pour un plafond de 3, la carte
              // chiffrée était systématiquement évincée. try/catch dédié sur le ledger de lecture :
              // une erreur y perdrait le compte de relectures, jamais la carte ni la clôture acquise.
              let rereadsAvoided = 0;
              try { rereadsAvoided = loadReadLedger(root).avoid_reread_notes.length; } catch (_) { /* chiffre absent, carte quand même */ }
              parts.push(closureCardMessage(done, nxt, progress(after), blockedByOf(after, nxt), {
                rereadsAvoided,
                bilan: epicBilan(after, done),
              }));
              // Reco de session fraîche : PRESCRIPTION, émise en coda hors arbitre (cf. plus bas).
              coda = freshSessionCodaMessage(nxt);
              // (b2) Verdict persisté (lot #96) + rappel CHANGELOG — APRÈS que doneLot a persisté
              // l'état. Jamais bloquant : le lot est déjà marqué fait quoi qu'il arrive ici.
              // try/catch dédié -> fail-open local (la clôture déjà acquise n'est jamais remise
              // en cause par un souci d'écriture ici). setClosedVerify reste idempotent (n'écrase
              // jamais un verdict déjà posé) — inerte en pratique ici (verdict jamais posé avant).
              try {
                setClosedVerify(root, done.id, verdict);
                // tree propre ici -> changelogTouched se réduit au dernier commit (celui de clôture).
                const changelogMissing = !changelogTouched(root);
                const proof = closureProofMessage(verify, changelogMissing, !done.verify);
                if (proof) parts.push(proof);
              } catch (_) { /* fail-open : la clôture reste acquise, pas de preuve ce tour */ }
            }
          }
        }
      }
    }
    // (c) handoff auto : dernier état connu, ÉCRASÉ à chaque fin de tour (un seul
    // fichier, pas de bloat) ; session-start.js l'injectera au prochain démarrage.
    // Ne touche jamais un handoff manuel (/fresh-session) non encore consommé.
    // `sid` : en vague parallèle, une fille inscrite écrit son handoff-lot-<id>.md et non
    // handoff.md — sans quoi N filles sur le même checkout s'écrasent mutuellement (FIA-19).
    writeAutoHandoff(root, sid);
  }

  // Arbitre de tour (#57) : plafonne le nombre de nudges concaténés, priorité à la sévérité
  // (via le glyphe de tête, sans re-parser la prose). Ordre de lecture d'origine préservé.
  const shown = arbitrate(parts);
  // Coda de clôture (#108) : ajoutée APRÈS l'arbitre, donc HORS plafond. L'arbitre borne le bruit
  // de DIAGNOSTIC (constats concurrents d'un même tour) ; une PRESCRIPTION unique et non rejouable
  // — repartir en session fraîche maintenant — n'est pas du bruit et ne se met pas en concurrence
  // avec lui. Toujours en dernier : c'est l'action qui clôt le bloc.
  if (coda) shown.push(coda);
  if (shown.length) return systemMessage(shown.join('\n\n'));
  return passThrough();
}

main();
process.exit(0);
