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
// Au-delà du dernier palier fixe, on continue d'alerter tous les +250k au lieu de
// se taire pour le reste de la session (les sessions marathon dépassent 750k et
// restaient jusqu'ici silencieuses jusqu'à la fin).
const FLOATING_STEP = 250000;
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

// Fenêtre fixe (pas besoin de grandir comme readLastOccupancy : on veut une
// tendance récente, pas une ligne précise). Compte les Read complets (sans
// offset/limit) vs les recherches (Grep/Glob natifs, ou Bash contenant grep)
// dans les blocs tool_use de la fenêtre. Retourne null si rien d'exploitable.
const READ_MIX_TAIL = 1.5 * 1024 * 1024;
const GREP_CMD_RE = /\bgrep\b/i;

function scanTailForReadMix(transcriptPath, tail) {
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch (_) {
    return null;
  }
  const t = tail || READ_MIX_TAIL;
  let chunk;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const start = size > t ? size - t : 0;
      const len = size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      chunk = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return null;
  }
  let reads = 0;
  let fullReads = 0;
  let searches = 0;
  for (const line of chunk.split(/\r?\n/)) {
    if (!line || line.indexOf('"tool_use"') === -1) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const content = obj && obj.message && Array.isArray(obj.message.content) ? obj.message.content : null;
    if (!content) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      const name = block.name;
      const input = block.input || {};
      if (name === 'Read') {
        reads += 1;
        if (input.offset == null && input.limit == null) fullReads += 1;
      } else if (name === 'Grep' || name === 'Glob') {
        searches += 1;
      } else if (name === 'Bash' && GREP_CMD_RE.test(String(input.command || ''))) {
        searches += 1;
      }
    }
  }
  if (reads === 0 && searches === 0) return null;
  return { reads, fullReads, searches };
}

function bucketIndex(occ) {
  let idx = 0;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (occ >= BUCKETS[i]) idx = i + 1;
  }
  const last = BUCKETS[BUCKETS.length - 1];
  if (occ >= last) idx = BUCKETS.length + Math.floor((occ - last) / FLOATING_STEP);
  return idx;
}

function stateFileFor(sessionId, suffix) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  const h = crypto.createHash('sha1').update(String(sessionId || 'unknown')).digest('hex').slice(0, 16);
  return path.join(STATE_DIR, suffix ? `${h}-${suffix}` : h);
}

// Note d'hygiène de lecture, une seule fois par session (fichier d'état global,
// indépendant du ledger projet — marche même sur un repo jamais initialisé).
function evaluateReadMix(transcriptPath, sessionId) {
  if (!transcriptPath) return null;
  const mix = scanTailForReadMix(transcriptPath);
  if (!mix || mix.reads < 4) return null;
  const fullShare = mix.fullReads / mix.reads;
  if (fullShare < 0.5) return null;
  const sf = stateFileFor(sessionId, 'hygiene');
  if (fs.existsSync(sf)) return null; // déjà signalé cette session
  try {
    fs.writeFileSync(sf, '1');
  } catch (_) {
    /* fail-open : au pire on resignale */
  }
  return mix;
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

module.exports = {
  readLastOccupancy, bucketIndex, evaluate, scanTailForReadMix, evaluateReadMix,
  BUCKETS, FLOATING_STEP, STATE_DIR,
};
