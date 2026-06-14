'use strict';
// Contrôleur de budget contexte — méthode reprise de l'ancien context-guard.py.
// Lit la dernière ligne `usage` du transcript, estime l'occupation réelle du contexte
// (input + cache_read + cache_creation) et la compare à des paliers de tokens.
// Anti-spam : un seul franchissement par palier et par session ; reset si le contexte redescend.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BUCKETS = [150000, 300000, 500000, 750000];
const STATE_DIR = process.env.PMZ_STATE_DIR ||
  path.join(os.homedir(), '.claude', 'promptimizer', 'state');

const MAX_TAIL = 8 * 1024 * 1024; // plafond dur de lecture du transcript

function scanTailForOccupancy(transcriptPath, size, tail) {
  let chunk;
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const start = size > tail ? size - tail : 0;
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    chunk = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = chunk.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"usage"') === -1) continue;
    let u = null;
    try {
      const obj = JSON.parse(line);
      u = (obj && obj.message && obj.message.usage) || null;
    } catch (_) {
      continue;
    }
    if (!u) continue;
    const occ =
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
    if (occ > 0) return occ;
  }
  return null;
}

// Cherche la dernière occupation en agrandissant la fenêtre depuis la fin
// (512 KB -> 2 MB -> 8 MB) : une rafale de gros tool_result en fin de transcript
// peut sinon pousser toute ligne `usage` hors d'une fenêtre fixe de 512 KB.
function readLastOccupancy(transcriptPath, tailBytes) {
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch (_) {
    return null;
  }
  let tail = tailBytes || 512 * 1024;
  for (;;) {
    let occ;
    try {
      occ = scanTailForOccupancy(transcriptPath, size, tail);
    } catch (_) {
      return null;
    }
    if (occ != null) return occ;
    if (tail >= size || tail >= MAX_TAIL) return null; // toute la fenêtre utile balayée
    tail = Math.min(tail * 4, MAX_TAIL);
  }
}

function bucketIndex(occ) {
  let idx = 0;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (occ >= BUCKETS[i]) idx = i + 1;
  }
  return idx;
}

function stateFileFor(sessionId) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  const h = crypto.createHash('sha1').update(String(sessionId || 'unknown')).digest('hex').slice(0, 16);
  return path.join(STATE_DIR, h);
}

// Retourne { occupancy, bucket, crossedNew } ou null si rien d'exploitable.
function evaluate(transcriptPath, sessionId) {
  if (!transcriptPath) return null;
  const occ = readLastOccupancy(transcriptPath);
  if (!occ) return null;
  const cur = bucketIndex(occ);
  const sf = stateFileFor(sessionId);
  let prev = 0;
  try {
    prev = parseInt(String(fs.readFileSync(sf, 'utf8')).trim() || '0', 10) || 0;
  } catch (_) {
    prev = 0;
  }
  // Palier persisté MONOTONE croissant pendant la session : on n'alerte qu'en montée
  // et on ne redescend jamais le flag (une ligne `usage` « maigre » — fort cache_read
  // faible — ne doit pas réarmer un palier déjà franchi). Un vrai reset = nouvelle
  // session_id => nouveau fichier d'état (clé sha1 du session_id).
  let crossedNew = false;
  if (cur > prev) {
    crossedNew = true;
    try { fs.writeFileSync(sf, String(cur)); } catch (_) {}
  }
  return { occupancy: occ, bucket: cur, crossedNew };
}

module.exports = { readLastOccupancy, bucketIndex, evaluate, BUCKETS, STATE_DIR };
