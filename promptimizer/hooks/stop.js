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
const { loadBacklog, doneLot, setClosedVerify, nextLot, blockedByOf, progress, currentLot, costLotFor, addCost, COST_WARN_TOKENS, epicBilan } = require('../lib/backlog');
const subagentcost = require('../lib/subagentcost');
const occupancy = require('../lib/occupancy');
const { readLastModel } = require('../lib/modelwatch');
const turnstats = require('../lib/turnstats');
const turnbudget = require('../lib/turnbudget');
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
  turnBudgetWarnMessage, turnBudgetPrescriptionMessage,
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

// Repli d'attribution en vague (lot #119) : le lot que le REGISTRE DE VAGUE (fleet.json) dit
// tenu par cette session, quand `session_owner` du backlog ne le dit pas (lot démarré sans
// `start --owner`, cas fréquent : l'inscription se fait par `fleet join`). Le lot n'est retenu
// que s'il est réellement in_progress au backlog — le fleet ne fait pas foi sur le statut.
// Fail-open : null au moindre doute, aucune imputation plutôt qu'une imputation devinée.
function fleetOwnedLot(root, sid) {
  try {
    if (!sid) return null;
    const mine = require('../lib/fleet').lotForSession(root, sid);
    if (!mine) return null;
    const lot = loadBacklog(root).lots.find((l) => l.id === mine.id && l.status === 'in_progress');
    return lot || null;
  } catch (_) {
    return null;
  }
}

function main() {
  const input = parseHookInput();
  if (input.stop_hook_active === true) return passThrough(); // anti-boucle
  const sid = input.session_id || null;
  const cwd = input.cwd || process.cwd();
  // Racine du repo résolue ICI et non plus juste avant la branche clôture (lot #112) : la
  // prescription (a1) a désormais besoin du projet pour lire la borne d'occupation de
  // `rules.yaml` et nommer le lot en cours. `gitRoot` est fail-open (null hors repo) et
  // n'était déjà appelé qu'une fois — remonter l'appel ne change que son ordre.
  const root = gitRoot(cwd);
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
  // BORNE D'OCCUPATION (lot #112) : le seuil n'est plus fatalement celui de l'auto-compact — un
  // projet peut le poser plus bas dans `.vibe-agent/rules.yaml` (bloc `budget:`), là où le coût de
  // cache devient dissuasif. `resolveRedZone` retombe sur le régime d'origine si rien n'est
  // configuré (ou hors repo, root === null) : zéro régression pour un projet existant. Le lot en
  // cours est joint au message pour prescrire la clôture EN MILIEU DE LOT, dans un try/catch dédié
  // — un backlog illisible ne doit jamais escamoter la prescription elle-même.
  const rzModel = readLastModel(input.transcript_path);
  const rzBound = occupancy.resolveRedZone(root, rzModel);
  const rz = occupancy.evaluateRedZone(input.transcript_path, sid, rzModel, rzBound);
  if (rz) {
    let rzLot = null;
    if (root) {
      try { rzLot = currentLot(loadBacklog(root)); } catch (_) { rzLot = null; }
    }
    parts.push(redZonePrescriptionMessage(rz, rzLot));
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
    // (a4bis) coût DÉLÉGUÉ (lot #119) : les tours d'un sous-agent (outil Agent/Task) s'écrivent
    // dans des transcripts à part et ne passent JAMAIS par ce hook — leur coût était donc
    // strictement invisible (un lot mené par sous-agents sortait à ~0 token). Rattrapage à
    // chaque Stop : on scanne le delta des transcripts de sous-agents de cette session et on
    // l'impute au même lot que le tour courant. Corpus disjoint du transcript parent, donc
    // aucun double comptage avec computeTurn. Fail-open dédié dans computeSubagentCost.
    let subOut = 0;
    try {
      const subCost = subagentcost.computeSubagentCost(input.transcript_path, sid);
      if (subCost && Number.isFinite(subCost.out) && subCost.out > 0) subOut = subCost.out;
    } catch (_) { /* fail-open : coût délégué non mesuré ce tour, jamais deviné */ }
    try {
      // Imputation NOMINATIVE (lot #119) : en vague, plusieurs lots sont in_progress à la fois et
      // `currentLot` renvoyait le premier du tableau — chaque session créditait le lot d'une
      // autre. `costLotFor` n'impute qu'au lot de CETTE session (rien, plutôt qu'au hasard) ;
      // repli sur l'attribution du fleet quand le lot a été démarré sans --owner.
      let cur = costLotFor(loadBacklog(root), sid);
      if (!cur) cur = fleetOwnedLot(root, sid);
      if (cur) {
        const out = (turn && turn.out > 0 ? turn.out : 0) + subOut;
        const updated = out > 0 ? addCost(root, cur.id, out, subOut) : cur;
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
            // de silence) — /close-batch relance la même preuve avec un délai large, réglable par
            // projet (resolveVerifyCloseMs, cf. lib/timeouts.js).
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

  // (d) BUDGET DE TOURS (lot #124) — le signal que l'occupation ne donne pas : une session peut
  // rester à basse occupation et coûter cher quand même, le coût croissant en tours^1,66 à ^1,98
  // (cf. lib/turnbudget.js). Évalué ICI, en toute fin de tour, pour deux raisons : le compteur
  // vient d'être incrémenté par computeTurn (a3), et la branche clôture ci-dessus a déjà pu poser
  // sa propre coda de session fraîche — auquel cas on se TAIT (le lot est clos, la reco est déjà
  // là ; prescrire deux fois la même action serait du bruit). Fonctionne hors repo : les défauts
  // sont codés en dur et `rules` retombe dessus quand root est null.
  // Deux niveaux, deux canaux : rappel ⚠ dans `parts` (c'est un constat, il se soumet à
  // l'arbitre) ; prescription ⛔ en CODA hors arbitre, comme la zone rouge — une prescription
  // unique ne se met pas en concurrence avec les diagnostics du tour.
  let turnCoda = null;
  if (!coda) {
    try {
      const tb = turnbudget.evaluate(root, sid, turn ? turn.turnCount : null, 'stop');
      if (tb && tb.stage === 'warn') {
        parts.push(turnBudgetWarnMessage(tb));
      } else if (tb) {
        let tbLot = null;
        if (root) {
          try { tbLot = currentLot(loadBacklog(root)); } catch (_) { tbLot = null; }
        }
        turnCoda = turnBudgetPrescriptionMessage(tb, tbLot);
      }
    } catch (_) { /* fail-open : pas de budget de tours ce tour, jamais de blocage */ }
  }

  // Arbitre de tour (#57) : plafonne le nombre de nudges concaténés, priorité à la sévérité
  // (via le glyphe de tête, sans re-parser la prose). Ordre de lecture d'origine préservé.
  const shown = arbitrate(parts);
  // Coda de clôture (#108) : ajoutée APRÈS l'arbitre, donc HORS plafond. L'arbitre borne le bruit
  // de DIAGNOSTIC (constats concurrents d'un même tour) ; une PRESCRIPTION unique et non rejouable
  // — repartir en session fraîche maintenant — n'est pas du bruit et ne se met pas en concurrence
  // avec lui. Toujours en dernier : c'est l'action qui clôt le bloc.
  if (coda) shown.push(coda);
  // Coda de budget de tours (#124) : même statut hors plafond, exclusive de la précédente par
  // construction (`if (!coda)` plus haut) — jamais deux prescriptions de session fraîche d'affilée.
  if (turnCoda) shown.push(turnCoda);
  if (shown.length) return systemMessage(shown.join('\n\n'));
  return passThrough();
}

main();
process.exit(0);
