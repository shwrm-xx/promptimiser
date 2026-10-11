'use strict';
// FREIN SUR LA SORTIE RELUE (lot #125).
//
// Pourquoi ce module existe. Le budget de tours (lib/turnbudget.js, lot #124) mesure le
// NOMBRE de tours, pas ce qu'ils COÛTENT à relire. Une sortie longue (dumps, réponses
// verbeuses) est réinjectée dans le contexte à CHAQUE tour suivant via le cache — elle se
// paie donc une fois par tour restant, pas une fois. Ce module nudge quand la sortie
// cumulée ET la moyenne par tour sont notables toutes les deux : un seul gros tour isolé
// (déjà couvert par costlyTurnMessage) n'est pas une dérive de STYLE de réponse.
//
// Un seul palier, un seul nudge par session (pas de rappel flottant comme turnbudget :
// le message porte sur un STYLE à corriger, pas une action de clôture à répéter).
//
// MIN_MEASURED_TURNS (>= 3) : sans ce plancher, un SEUL tour massif suffit à franchir les
// deux seuils (cumul ET moyenne) et fait doublon avec costlyTurnMessage (turnstats.js, delta
// d'occupation) — les deux se disputaient alors une place de l'arbitre de tour (plafond 3),
// évinçant parfois un diagnostic distinct (ex. lotCostMessage). Exiger plusieurs tours
// mesurés recentre le frein sur sa cible réelle : une DÉRIVE DE STYLE sur la durée, pas un
// pic isolé déjà couvert ailleurs.
//
// Fenêtre glissante, pas cumul de session. La sortie cumulée vient de turnstats.readOutputStats,
// qui lit l'historique FIFO plafonné à MAX_TURNS (40, cf. turnstats.js) — sur une session de
// plus de 40 tours, c'est donc une fenêtre glissante sur les 40 derniers tours, pas le vrai
// cumul depuis le début de la session. Assumé (cf. handoff lot #125) : persister un cumul à
// part aurait dupliqué un état déjà géré par turnstats pour un gain marginal (une session de
// plus de 40 tours a de toute façon déjà dépassé plusieurs fois le budget de tours).
//
// Fail-open absolu : toute erreur (rules illisible, état non écrivable, sessionId absent)
// -> null, jamais d'exception. Aucune dépendance au-delà de `fs` + occupancy/rules.
const fs = require('fs');
const { stateFileFor } = require('./occupancy');
const rules = require('./rules');

const BLOCK = 'budget';
const OUT_WARN_DEFAULT = 30000;       // sortie cumulée : au-delà, la fenêtre coûte cher en relecture
const PER_TURN_WARN_DEFAULT = 1500;   // ... mais seulement si la moyenne par tour est notable
const OUT_MIN = 5000;
const OUT_MAX = 2000000;
const PER_TURN_MIN = 200;
const PER_TURN_MAX = 50000;
const MIN_MEASURED_TURNS = 3;         // sous ce plancher, un pic isolé -> laisse costlyTurnMessage seul
const OFF_RE = /^(off|false|no|none|disabled|0)$/i;
const CHANNEL = 'outputbudget';

// Frein éteint pour ce projet ? Clé non numérique volontairement (même contrat que
// turnbudget.disabledFor) : aucun seuil chiffré ne peut l'éteindre par accident.
function disabledFor(root) {
  try {
    const raw = rules.readScalar(root, BLOCK, 'output_budget');
    return raw !== null && OFF_RE.test(String(raw).trim());
  } catch (_) {
    return false; // fail-open : au doute, le garde-fou reste actif
  }
}

// Seuils effectifs { outWarn, perTurnWarn }. Hors repo ou sans rules.yaml : défauts.
function resolveThresholds(root) {
  let outWarn = OUT_WARN_DEFAULT;
  let perTurnWarn = PER_TURN_WARN_DEFAULT;
  try {
    const o = rules.readNumber(root, BLOCK, 'warn_after_output_tokens', OUT_MIN, OUT_MAX);
    if (o !== null) outWarn = Math.floor(o);
    const p = rules.readNumber(root, BLOCK, 'warn_after_output_per_turn', PER_TURN_MIN, PER_TURN_MAX);
    if (p !== null) perTurnWarn = Math.floor(p);
  } catch (_) {
    /* fail-open : défauts codés en dur */
  }
  return { outWarn, perTurnWarn };
}

// Verdict pour ce tour, ou null (rien à dire / déjà dit cette session / éteint / illisible).
// `stats` = turnstats.readOutputStats(sessionId) : { totalOut, avgPerTurn, measuredTurns }.
// Retourne { totalOut, avgPerTurn, outWarn, perTurnWarn }. 1×/session (état simple, pas de palier).
function evaluate(root, sessionId, stats) {
  if (!sessionId) return null;
  if (!stats || !Number.isFinite(stats.totalOut) || stats.totalOut <= 0) return null;
  if (!Number.isFinite(stats.measuredTurns) || stats.measuredTurns < MIN_MEASURED_TURNS) return null;
  if (disabledFor(root)) return null;

  const { outWarn, perTurnWarn } = resolveThresholds(root);
  if (stats.totalOut < outWarn || stats.avgPerTurn < perTurnWarn) return null;

  const sf = stateFileFor(sessionId, CHANNEL);
  if (fs.existsSync(sf)) return null; // déjà signalé cette session
  try { fs.writeFileSync(sf, '1'); } catch (_) { /* fail-open : au pire on resignale */ }

  return { totalOut: stats.totalOut, avgPerTurn: stats.avgPerTurn, outWarn, perTurnWarn };
}

module.exports = {
  evaluate, disabledFor, resolveThresholds,
  BLOCK, OUT_WARN_DEFAULT, PER_TURN_WARN_DEFAULT, OUT_MIN, OUT_MAX, PER_TURN_MIN, PER_TURN_MAX, MIN_MEASURED_TURNS, CHANNEL,
};
