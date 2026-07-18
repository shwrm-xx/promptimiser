'use strict';
// Helpers fail-open du plugin OpenCode : journal d'instrumentation + toast TUI + garde.
// Aucune fonction ici ne throw — le contrat fail-open de PMZ s'applique à tout.
const fs = require('fs');
const path = require('path');
const ocdir = require('./oc-dir');

const LOG_MAX_BYTES = 512 * 1024; // au-delà, on tronque (journal de preuve de vie, pas une archive)

function logPath() { return path.join(ocdir.stateDir(), 'plugin.log'); }

// Journalise une ligne JSON { ts, hook, …detail }. Silencieux en cas d'échec.
function log(hook, detail) {
  try {
    const file = logPath();
    try { if (fs.statSync(file).size > LOG_MAX_BYTES) fs.truncateSync(file, 0); } catch (_) {}
    const line = JSON.stringify(Object.assign({ ts: new Date().toISOString(), hook }, detail || {}));
    fs.appendFileSync(file, line + '\n');
  } catch (_) {}
}

// Toast TUI (invisible en mode `opencode run`, sans effet si le client ne répond pas).
async function toast(client, message, variant) {
  try {
    if (!client || !client.tui || typeof client.tui.showToast !== 'function') return;
    await client.tui.showToast({ body: { title: 'PMZ', message, variant: variant || 'info' } });
  } catch (_) {}
}

// Enveloppe fail-open d'un handler de hook : toute erreur est avalée (journalisée en
// best-effort) — un hook PMZ ne casse JAMAIS une session. Le deny volontaire de
// tool.execute.before (lot OC2) devra contourner cette garde explicitement.
function guard(hook, fn) {
  return async function () {
    if (process.env.PMZ_DISABLE === '1') return;
    try { return await fn.apply(null, arguments); } catch (e) {
      log('error', { source: hook, error: String((e && e.message) || e) });
    }
  };
}

module.exports = { log, toast, guard, logPath };
