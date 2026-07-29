'use strict';
// BUDGET DE TOURS PAR SESSION (lot #124).
//
// Pourquoi ce module existe. PMZ mesurait le coût de session par l'OCCUPATION en tokens
// (lib/occupancy.js) et avait explicitement écarté le compteur de tours (« occupation-tokens
// plutôt que compteur de tours », cf. ARCHITECTURE.md). Les mesures du dépôt sur lui-même
// ont retourné cette décision : l'occupation médiane reste basse (~125k, ~15 % de la borne),
// donc la borne d'occupation ne mord presque jamais — tandis que le coût croît en
// tours^1,66 à ^1,98 (régression log-log, cf. la loi d'échelle décrite dans ARCHITECTURE.md).
// Le nombre de TOURS est donc le signal qui commande, et l'occupation reste le filet haut :
// les deux cohabitent, ils ne mesurent pas la même chose.
//
// Ce que fait ce module : traduire le compteur de tours déjà persisté par turnstats
// (`turnCount`, résistant aux resume) en PALIER franchi, une seule fois par palier et par
// canal. Deux seuils, exactement les clés que la spec d'origine portait déjà (mortes) dans
// `.vibe-agent/rules.yaml`, bloc `budget:` :
//   warn_after_session_turns: 12            -> rappel ⚠ (Stop)
//   recommend_fresh_session_after_turns: 20 -> prescription ⛔ (Stop) + injection (UserPromptSubmit)
// puis rappel flottant tous les +FLOATING_TURNS tours (même esprit que occupancy.FLOATING_STEP :
// une session marathon ne doit pas devenir silencieuse après son dernier palier fixe).
//
// Défauts ACTIFS codés en dur (12/20) : contrairement à la borne d'occupation du lot #112, qui
// est un réglage opt-in, le budget de tours est une doctrine — il doit mordre sur un projet qui
// n'a rien configuré. `rules.yaml` ne fait que le déplacer.
//
// Désactivation explicite. `rules.readNumber` traite une valeur hors bornes comme absente
// (retour au défaut), si bien qu'aucun nombre ne peut éteindre le budget — un `0` retomberait
// sur 12/20. D'où une clé dédiée, non numérique, lue en scalaire brut :
//   turn_budget: off      (off | false | no | none | disabled | 0)
// C'est le SEUL moyen de se taire, et il est explicite : personne ne désactive un garde-fou
// par accident de frappe.
//
// Fail-open absolu : toute erreur (rules illisible, état non écrivable, sessionId absent)
// -> `null`, jamais d'exception. Aucune dépendance au-delà de `fs` + occupancy/rules.
const fs = require('fs');
const { stateFileFor } = require('./occupancy');
const rules = require('./rules');

const BLOCK = 'budget';
const WARN_DEFAULT = 12;        // rappel ⚠ : la session commence à coûter
const PRESCRIBE_DEFAULT = 20;   // prescription ⛔ : au-delà, scinder coûte moins que continuer
const TURN_MIN = 3;             // bornes saines : un budget < 3 tours rendrait PMZ inutilisable
const TURN_MAX = 500;           // ... et au-delà de 500 la clé est une faute de frappe, pas un réglage
const FLOATING_TURNS = 10;      // après la prescription, on re-prescrit tous les +10 tours
const OFF_RE = /^(off|false|no|none|disabled|0)$/i;

// Suffixes d'état : un fichier PAR CANAL. Sans cette séparation, le premier hook du tour à
// franchir le palier consommerait l'anti-spam de l'autre — or le Stop (visible utilisateur)
// et l'UserPromptSubmit (injecté au modèle) portent deux messages différents et doivent
// tous deux sortir une fois.
const CHANNELS = { stop: 'turnbudget', prompt: 'turnbudget-prompt' };

// Budget éteint pour ce projet ? Clé non numérique volontairement (cf. en-tête).
function disabledFor(root) {
  try {
    const raw = rules.readScalar(root, BLOCK, 'turn_budget');
    return raw !== null && OFF_RE.test(String(raw).trim());
  } catch (_) {
    return false; // fail-open : au doute, le garde-fou reste actif
  }
}

// Seuils effectifs { warn, prescribe }. Hors repo (root null) ou sans rules.yaml : défauts.
// Une seule des deux clés peut être posée, l'autre garde son défaut.
function resolveThresholds(root) {
  let warn = WARN_DEFAULT;
  let prescribe = PRESCRIBE_DEFAULT;
  try {
    const w = rules.readNumber(root, BLOCK, 'warn_after_session_turns', TURN_MIN, TURN_MAX);
    if (w !== null) warn = Math.floor(w);
    const p = rules.readNumber(root, BLOCK, 'recommend_fresh_session_after_turns', TURN_MIN, TURN_MAX);
    if (p !== null) prescribe = Math.floor(p);
  } catch (_) {
    /* fail-open : défauts codés en dur */
  }
  return { warn, prescribe };
}

// Palier atteint, ENTIER MONOTONE croissant (même contrat que occupancy.bucketIndex) :
//   0 = rien à dire · 1 = seuil de rappel franchi · 2 = seuil de prescription franchi
//   3, 4, … = prescription + N × FLOATING_TURNS
// Un `warn` >= `prescribe` (config incohérente) n'a pas besoin d'être rejeté : le test de
// prescription passe d'abord, l'intervalle de rappel est simplement vide.
function levelFor(turnCount, warn, prescribe) {
  if (!Number.isFinite(turnCount)) return 0;
  if (turnCount >= prescribe) return 2 + Math.floor((turnCount - prescribe) / FLOATING_TURNS);
  if (turnCount >= warn) return 1;
  return 0;
}

// Tours restants avant le prochain palier, pour chiffrer le message.
function nextThreshold(level, prescribe) {
  return level <= 1 ? prescribe : prescribe + (level - 1) * FLOATING_TURNS;
}

// Verdict de budget pour ce tour, ou null (rien à dire / déjà dit / éteint / illisible).
// `channel` : 'stop' (défaut) ou 'prompt' — anti-spam indépendant, cf. CHANNELS.
// Retourne { turnCount, warn, prescribe, level, stage: 'warn'|'prescribe', next, step, floating }.
function evaluate(root, sessionId, turnCount, channel) {
  // Sans session_id, l'état serait partagé par toutes les sessions anonymes (clé 'unknown') :
  // on se tait plutôt que de prescrire sur le compteur d'une autre session.
  if (!sessionId) return null;
  if (!Number.isFinite(turnCount) || turnCount <= 0) return null;
  if (disabledFor(root)) return null;

  const { warn, prescribe } = resolveThresholds(root);
  const level = levelFor(turnCount, warn, prescribe);
  if (level <= 0) return null;

  const sf = stateFileFor(sessionId, CHANNELS[channel] || CHANNELS.stop);
  let prev = 0;
  try {
    prev = parseInt(String(fs.readFileSync(sf, 'utf8')).trim() || '0', 10) || 0;
  } catch (_) {
    prev = 0; // pas d'état : premier franchissement
  }
  // Monotonie : on ne parle qu'en MONTÉE et on ne redescend jamais le flag (le compteur de
  // tours ne décroît pas, mais un état corrompu/relu ne doit pas pouvoir respammer).
  if (level <= prev) return null;
  try { fs.writeFileSync(sf, String(level)); } catch (_) { /* fail-open : au pire on resignale */ }

  return {
    turnCount, warn, prescribe, level,
    stage: level >= 2 ? 'prescribe' : 'warn',
    next: nextThreshold(level, prescribe),
    step: FLOATING_TURNS,
    floating: level > 2,
  };
}

module.exports = {
  evaluate, levelFor, resolveThresholds, disabledFor, nextThreshold,
  BLOCK, WARN_DEFAULT, PRESCRIBE_DEFAULT, TURN_MIN, TURN_MAX, FLOATING_TURNS, CHANNELS,
};
