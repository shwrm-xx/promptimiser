'use strict';
// Fail-open : tout incident -> exit 0. Watchdog qui sort avant le timeout du hook.
function armFailOpen(watchdogMs) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  if (watchdogMs && watchdogMs > 0) {
    setTimeout(() => process.exit(0), watchdogMs);
  }
}
module.exports = { armFailOpen };
