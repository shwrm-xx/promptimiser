'use strict';
// Source UNIQUE des délais des hooks — évite la dérive entre le timeout déclaré dans
// settings.json (merge-settings.js) et le watchdog interne (guard.js, via les hooks).
// Le watchdog DOIT rester < timeout settings : il sort proprement (exit 0) AVANT que
// Claude Code ne tue le hook. La marge absorbe le coût de démarrage de node.
const SETTINGS_TIMEOUT_S = { sessionStart: 10, default: 5 };
const WATCHDOG_MARGIN_MS = 500;

// Verify exécutée à l'AUTO-clôture (hook Stop, lot #44) : timeout COURT, borné bien en deçà
// du watchdog Stop (watchdogMs(5) = 4500 ms). execSync rend la main à ce délai au plus (le
// process n'est pas tué), après quoi doneLot est déjà persisté -> aucune corruption d'état
// même si le tour dépasse ensuite le watchdog. La preuve complète reste /close-batch
// (VERIFY_CLOSE_MS ci-dessous).
const VERIFY_AUTOCLOSE_MS = 2500;

// Verify rejouée à la clôture délibérée (/close-batch, et `backlog.js done` sans
// --verify-verdict depuis le lot #119) : budget LARGE — ces chemins sont pilotés par
// l'assistant, hors du budget serré d'un hook, et doivent laisser une vraie suite de tests
// aller au bout. Assez généreux pour ne pas tuer une suite réelle à mi-course (un kill par
// timeout n'est PAS un échec : status null, à distinguer d'un exit ≠ 0), mais borné pour que
// la clôture ne pende jamais indéfiniment.
//
// DÉFAUT RELEVÉ À 300 s (lot #120). Il valait 120 s, posé quand la suite de CE dépôt tournait
// ~35 s. Elle en met ~130 s au lot #119 (1997 tests, mesuré deux fois) : le défaut était passé
// SOUS la durée réelle, et /close-batch rendait « timeout » sur une suite verte — une preuve de
// clôture faussée (closed_verify: 'timeout' persisté au lieu de 'ok'). Le budget doit garder une
// marge sur la croissance de la suite, pas la suivre de près : 300 s = plus du double du mesuré.
const VERIFY_CLOSE_DEFAULT_MS = 300000;

// Override d'env réservé aux TESTS (déclencher la branche timeout sans attendre le délai
// complet) ; borne > 0 sinon repli sur le défaut — jamais utilisé en usage réel.
function envVerifyCloseMs() {
  const env = parseInt(process.env.PMZ_VERIFY_CLOSE_MS || '', 10);
  return Number.isFinite(env) && env > 0 ? env : null;
}

const VERIFY_CLOSE_MS = envVerifyCloseMs() || VERIFY_CLOSE_DEFAULT_MS;

// BORNE RÉGLABLE PAR PROJET (lot #120), sur le modèle de la borne d'occupation du lot #112 :
// un défaut, même généreux, reste un pari sur la durée de la suite d'AUTRUI. Un dépôt à suite
// longue (ou lente en CI locale) pose son propre budget dans `.vibe-agent/rules.yaml`, bloc
// `budget:` :
//   verify_close_ms: 600000   -> borne en millisecondes pour la verify de clôture
// Ordre de précédence : env (test-only) > rules.yaml > défaut ci-dessus.
// Bornes de plausibilité : < 1 s ne laisse aucune suite démarrer, > 1 h n'est plus une borne
// (une clôture qui pend une heure est un blocage, pas une preuve). Hors bornes / non numérique
// / rules.yaml absent -> valeur ignorée, repli sur le défaut (fail-open, cf. lib/rules.js) :
// jamais de rabotage silencieux, jamais d'erreur remontée à l'appelant.
const VERIFY_CLOSE_BLOCK = 'budget';
const VERIFY_CLOSE_KEY = 'verify_close_ms';
const VERIFY_CLOSE_MIN_MS = 1000;
const VERIFY_CLOSE_MAX_MS = 3600000;

// `root` = racine du dépôt (celle que résout gitRoot). Absente/null -> défaut.
function resolveVerifyCloseMs(root) {
  const env = envVerifyCloseMs();
  if (env) return env;
  try {
    const n = require('./rules').readNumber(root, VERIFY_CLOSE_BLOCK, VERIFY_CLOSE_KEY,
      VERIFY_CLOSE_MIN_MS, VERIFY_CLOSE_MAX_MS);
    if (n !== null) return Math.floor(n);
  } catch (_) {
    /* fail-open : toute erreur de lecture -> défaut */
  }
  return VERIFY_CLOSE_DEFAULT_MS;
}

// Réécriture RTK (lot #81, bridge command-optimizer) : appel `rtk rewrite` sur le chemin chaud
// PreToolUse. Court PAR CONSTRUCTION — RTK doit répondre en centaines de ms ou être ignoré (la
// commande originale passe). Borné bien en deçà du watchdog PreToolUse (watchdogMs(5) = 4500 ms)
// pour ne jamais faire pendre le hook. Override d'env (tuning / tests) ; borne > 0 sinon défaut.
const RTK_REWRITE_MS = (() => {
  const env = parseInt(process.env.PMZ_RTK_REWRITE_TIMEOUT_MS || '', 10);
  return Number.isFinite(env) && env > 0 ? env : 400;
})();

// Vérif `rtk --version` (lot #82, statut/doctor) : HORS chemin chaud — déclenchée par une
// commande utilisateur (/pmz:rtk), pas par un hook PreToolUse. Peut donc rester un peu plus
// généreuse que RTK_REWRITE_MS sans risquer de faire pendre un hook. Override d'env pour les
// tests ; borne > 0 sinon défaut.
const RTK_STATUS_MS = (() => {
  const env = parseInt(process.env.PMZ_RTK_STATUS_TIMEOUT_MS || '', 10);
  return Number.isFinite(env) && env > 0 ? env : 1000;
})();

function watchdogMs(timeoutS) {
  return Math.max(0, timeoutS * 1000 - WATCHDOG_MARGIN_MS);
}

module.exports = {
  SETTINGS_TIMEOUT_S, WATCHDOG_MARGIN_MS, VERIFY_AUTOCLOSE_MS,
  VERIFY_CLOSE_MS, VERIFY_CLOSE_DEFAULT_MS, VERIFY_CLOSE_MIN_MS, VERIFY_CLOSE_MAX_MS,
  resolveVerifyCloseMs, RTK_REWRITE_MS, RTK_STATUS_MS, watchdogMs,
};
