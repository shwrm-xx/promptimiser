'use strict';
// Vigie de gouvernance du CLAUDE.md (lot #74). Le CLAUDE.md projet est rechargé dans le
// contexte à CHAQUE session : les deux extrêmes coûtent cher. Absent, chaque session
// repart sans règles projet (relectures, rappels et corrections répétés à chaque fois).
// Hypertrophié (> CLAUDEMD_MAX_BYTES), son poids entier est repayé à chaque session et à
// chaque recréation de cache — la spec (mwn/) est explicite : « Ne pas créer un CLAUDE.md
// énorme ».
//
// Distinct de MSG_NON_INIT (session-start) : celui-là vise le projet JAMAIS initialisé et
// propose le socle complet ; cette vigie couvre le repo déjà vivant dont le CLAUDE.md
// manque ou a enflé au fil des lots. Nudge 1×/session (fichier d'état marqueur, même
// mécanique que l'hygiène de lecture d'occupancy.js) — un CLAUDE.md sain n'écrit AUCUN
// état : le stat par tour est quasi gratuit et un fichier qui enfle en cours de session
// sera encore signalé. Fail-open total : toute erreur -> null, jamais d'exception au hook.
const fs = require('fs');
const path = require('path');
const { stateFileFor } = require('./occupancy');

const CLAUDEMD_MAX_BYTES = 10 * 1024; // ~2,5k tokens repayés à chaque session : trop
const BYTES_PER_TOKEN = 4;            // approximation grossière, suffisante pour le message

// Renvoie { kind: 'missing' } si le CLAUDE.md projet n'existe pas, { kind: 'bloated',
// bytes, tokensApprox } s'il dépasse le seuil, null sinon (fichier sain, hors repo, ou
// déjà signalé cette session). Le marqueur 1×/session n'est posé QUE lorsqu'un nudge part.
function evaluate(root, sessionId) {
  try {
    if (!root) return null;
    const sf = stateFileFor(sessionId, 'claudemd');
    if (fs.existsSync(sf)) return null; // déjà signalé cette session

    let st = null;
    try { st = fs.statSync(path.join(root, 'CLAUDE.md')); } catch (_) { st = null; }
    let res = null;
    if (!st || !st.isFile()) {
      res = { kind: 'missing' };
    } else if (st.size > CLAUDEMD_MAX_BYTES) {
      res = { kind: 'bloated', bytes: st.size, tokensApprox: Math.round(st.size / BYTES_PER_TOKEN) };
    }
    if (!res) return null;
    try { fs.writeFileSync(sf, '1'); } catch (_) { /* fail-open : au pire on resignale */ }
    return res;
  } catch (_) {
    return null; // fail-open : jamais d'exception vers le hook
  }
}

module.exports = { evaluate, CLAUDEMD_MAX_BYTES, BYTES_PER_TOKEN };
