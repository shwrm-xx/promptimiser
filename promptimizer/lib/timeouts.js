'use strict';
// Source UNIQUE des délais des hooks — évite la dérive entre le timeout déclaré dans
// settings.json (merge-settings.js) et le watchdog interne (guard.js, via les hooks).
// Le watchdog DOIT rester < timeout settings : il sort proprement (exit 0) AVANT que
// Claude Code ne tue le hook. La marge absorbe le coût de démarrage de node.
const SETTINGS_TIMEOUT_S = { sessionStart: 10, default: 5 };
const WATCHDOG_MARGIN_MS = 500;

function watchdogMs(timeoutS) {
  return Math.max(0, timeoutS * 1000 - WATCHDOG_MARGIN_MS);
}

module.exports = { SETTINGS_TIMEOUT_S, WATCHDOG_MARGIN_MS, watchdogMs };
