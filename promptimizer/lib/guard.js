'use strict';
// Fail-open : tout incident -> exit 0. Watchdog qui sort avant le timeout du hook.
function armFailOpen(watchdogMs) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  if (watchdogMs && watchdogMs > 0) {
    // unref : le watchdog est un filet de sécurité (cas hang), pas un facteur de latence —
    // si tout le travail synchrone est fini, le process sort sans attendre le timer.
    const t = setTimeout(() => process.exit(0), watchdogMs);
    if (t && typeof t.unref === 'function') t.unref();
  }
}
module.exports = { armFailOpen };
