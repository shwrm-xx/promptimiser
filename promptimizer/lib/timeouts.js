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
// même si le tour dépasse ensuite le watchdog. La preuve complète reste /close-batch (20 s).
const VERIFY_AUTOCLOSE_MS = 2500;

function watchdogMs(timeoutS) {
  return Math.max(0, timeoutS * 1000 - WATCHDOG_MARGIN_MS);
}

module.exports = { SETTINGS_TIMEOUT_S, WATCHDOG_MARGIN_MS, VERIFY_AUTOCLOSE_MS, watchdogMs };
