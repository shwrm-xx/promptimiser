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

// Verify rejouée à la clôture délibérée (/close-batch) : budget LARGE — cette commande est
// pilotée par l'assistant, hors du budget serré d'un hook, et doit laisser une vraie suite de
// tests aller au bout (les nôtres tournent ~35 s). Assez généreux pour ne pas tuer une suite
// réelle à mi-course (un kill par timeout n'est PAS un échec : status null, à distinguer d'un
// exit ≠ 0), mais borné pour que /close-batch ne pende jamais indéfiniment.
// Override d'env réservé aux TESTS (déclencher la branche timeout sans attendre 120 s) ;
// borne > 0 sinon repli sur le défaut — jamais utilisé en usage réel.
const VERIFY_CLOSE_MS = (() => {
  const env = parseInt(process.env.PMZ_VERIFY_CLOSE_MS || '', 10);
  return Number.isFinite(env) && env > 0 ? env : 120000;
})();

function watchdogMs(timeoutS) {
  return Math.max(0, timeoutS * 1000 - WATCHDOG_MARGIN_MS);
}

module.exports = { SETTINGS_TIMEOUT_S, WATCHDOG_MARGIN_MS, VERIFY_AUTOCLOSE_MS, VERIFY_CLOSE_MS, watchdogMs };
