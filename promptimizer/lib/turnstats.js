'use strict';
// Métrologie PAR TOUR. Mesure le coût réel du dernier tour en ne scannant QUE les
// octets ajoutés au transcript depuis le Stop précédent (offset stocké dans l'état
// hors-projet <sha1(sid)>-turns.json). Détecte : tours coûteux (delta d'occupation),
// invalidations de cache (pause/TTL au 1er appel vs bust anormal EN PLEIN tour), et
// redescentes brutales (compaction) pour resynchroniser le palier d'occupation.
// Fail-silent partout : au moindre doute, on renvoie des métriques neutres.
const fs = require('fs');
const { stateFileFor, readLastOccupancy } = require('./occupancy');
const { writeAtomic, readJson } = require('./fsjson');

const COSTLY_DELTA = 50000;              // +50k tokens de contexte sur un tour = tour coûteux
const COSTLY_COOLDOWN = 3;               // ... mais au plus 1 alerte / 3 tours (anti-spam)
const BUST_OCC_MIN = 100000;             // sous ce seuil, un cache faible ne coûte rien de notable
const BUST_CACHE_RATIO = 0.5;            // cache_read < 50% de l'occ précédente = cache cassé
const RESYNC_DELTA = -100000;            // delta < -100k = compaction probable -> resync palier
const BASELINE_WINDOW = 2 * 1024 * 1024; // fenêtre de repli quand l'offset est inutilisable
const MAX_TURNS = 40;                    // FIFO d'historique (~2-4 KB max)

// Détecteur de dérive de session (#62). Une session « dérive » quand le contexte
// coûte de plus en plus par tour (delta d'occ qui grimpe) ET que le cache rend de
// moins en moins (hitRate qui se dégrade) sur une fenêtre de tours — signe qu'il
// vaut mieux clôturer et repartir frais que continuer à payer le contexte accumulé.
const DRIFT_WINDOW = 6;                   // N derniers tours EXPLOITABLES jugés (2 moitiés de 3)
const DRIFT_COST_RATIO = 1.3;            // moitié récente >= 1.3× la moitié ancienne (delta moyen)
const DRIFT_MIN_DELTA = 15000;           // ... mais seulement si le delta moyen récent est notable
const DRIFT_HIT_DROP = 0.08;             // hitRate moyen : chute >= 8 points entre les 2 moitiés
const DRIFT_COOLDOWN = DRIFT_WINDOW;     // au plus 1 nudge / fenêtre (anti-spam persisté)

function turnsFile(sid) { return stateFileFor(sid, 'turns.json'); }
function ttlFile(sid) { return stateFileFor(sid, 'ttl'); }
function driftFile(sid) { return stateFileFor(sid, 'drift'); }

function parseUsage(line) {
  if (!line || line.indexOf('"usage"') === -1) return null;
  let u;
  try {
    const obj = JSON.parse(line);
    u = obj && obj.message && obj.message.usage;
  } catch (_) {
    return null;
  }
  if (!u) return null;
  const input = u.input_tokens || 0;
  const read = u.cache_read_input_tokens || 0;
  const creation = u.cache_creation_input_tokens || 0;
  const output = u.output_tokens || 0;
  if (input + read + creation === 0) return null;
  return { input, read, creation, output, occ: input + read + creation };
}

// Lit [start, size) du transcript et renvoie les lignes usage parsées, dans l'ordre.
function scanRange(transcriptPath, start, size) {
  const usages = [];
  const len = size - start;
  if (len <= 0) return usages;
  let chunk;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      chunk = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return usages;
  }
  for (const line of chunk.split(/\r?\n/)) {
    const u = parseUsage(line);
    if (u) usages.push(u);
  }
  return usages;
}

function loadTurnState(sid) {
  const st = readJson(turnsFile(sid), null) || {};
  return {
    offset: typeof st.offset === 'number' ? st.offset : null,
    occ: typeof st.occ === 'number' ? st.occ : null,
    turnCount: typeof st.turnCount === 'number' ? st.turnCount : 0,
    // Valeur initiale telle que le 1er tour coûteux passe le cooldown sans état.
    lastCostlyTurn: typeof st.lastCostlyTurn === 'number' ? st.lastCostlyTurn : -COSTLY_COOLDOWN,
    turns: Array.isArray(st.turns) ? st.turns : [],
  };
}

// Mesure le tour écoulé, persiste le nouvel offset et les compteurs anti-spam.
// Renvoie null si le transcript est illisible (fail-open : le hook ne dit rien).
function computeTurn(transcriptPath, sid) {
  if (!transcriptPath) return null;
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch (_) {
    return null;
  }

  const st = loadTurnState(sid);
  const prevOffset = st.offset;
  const prevOcc = st.occ;

  let baselineReset = false;
  let start;
  if (prevOffset == null) {
    // 1re observation de la session : pas de baseline -> pas de delta.
    start = Math.max(0, size - BASELINE_WINDOW);
  } else if (prevOffset > size) {
    // Transcript tronqué/remplacé (compaction dure, nouveau fichier) : offset périmé.
    baselineReset = true;
    start = Math.max(0, size - BASELINE_WINDOW);
  } else {
    start = prevOffset;
  }
  const noBaseline = prevOffset == null || baselineReset;

  const usages = scanRange(transcriptPath, start, size);
  let occ = usages.length
    ? usages[usages.length - 1].occ
    : (prevOcc != null ? prevOcc : readLastOccupancy(transcriptPath));

  // Sans baseline fiable, on établit seulement l'occ et l'offset : aucune métrique de
  // tour ni détection de bust (la fenêtre de repli couvre plusieurs tours passés).
  let out = 0, req = 0, input = 0, cacheRead = 0, cacheCreation = 0, hitRate = null;
  const busts = [];
  let delta = null;
  if (!noBaseline) {
    let occPrev = prevOcc;
    for (let i = 0; i < usages.length; i++) {
      const u = usages[i];
      out += u.output;
      req += 1;
      input += u.input;
      cacheRead += u.read;
      cacheCreation += u.creation;
      // Cache-bust : cache_read effondré alors que l'occ précédente était grosse.
      // first=true -> 1re requête du tour (cause : pause, TTL de cache expiré).
      // first=false -> bust EN PLEIN tour (anormal : ex. CLAUDE.md modifié en session).
      if (occPrev != null && occPrev >= BUST_OCC_MIN && u.read < BUST_CACHE_RATIO * occPrev) {
        busts.push({ prevOcc: occPrev, cacheCreation: u.creation, first: i === 0 });
      }
      occPrev = u.occ;
    }
    const denom = input + cacheRead + cacheCreation;
    hitRate = denom > 0 ? cacheRead / denom : null;
    delta = (occ != null && prevOcc != null) ? occ - prevOcc : null;
  }

  const turnCount = st.turnCount + 1;

  // Décisions d'alerte (anti-spam persisté).
  const costly = delta != null && delta >= COSTLY_DELTA && (turnCount - st.lastCostlyTurn) >= COSTLY_COOLDOWN;
  const intraBust = busts.some((b) => !b.first);
  const pauseBust = busts.some((b) => b.first);
  let pause = false;
  if (pauseBust && !fs.existsSync(ttlFile(sid))) {
    pause = true; // pause/TTL : 1×/session
    try { fs.writeFileSync(ttlFile(sid), '1'); } catch (_) { /* fail-open */ }
  }
  const resync = delta != null && delta < RESYNC_DELTA;

  // Persistance : offset AVANCÉ à la fin du fichier courant + historique FIFO.
  // `h` = hitRate du tour (null si baseline) : requis par evaluateDrift (#62).
  const turns = st.turns.concat([{ d: delta, o: out, h: hitRate, at: Date.now() }]);
  if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);
  writeAtomic(turnsFile(sid), {
    offset: size,
    occ,
    turnCount,
    lastCostlyTurn: costly ? turnCount : st.lastCostlyTurn,
    turns,
  });

  return {
    occ, delta, out, req, input, cacheRead, cacheCreation, hitRate,
    busts, baselineReset, turnCount,
    alerts: { costly, intraBust, pause, resync },
  };
}

// Détecteur de dérive (#62). Lit l'historique persisté par computeTurn (donc à
// appeler APRÈS lui, une fois le tour courant écrit) et cherche une tendance sur
// les DRIFT_WINDOW derniers tours EXPLOITABLES (delta ET hitRate connus). On compare
// la moitié récente à la moitié ancienne : dérive = le coût de contexte grimpe
// (delta moyen récent >= DRIFT_COST_RATIO× l'ancien, et notable) ET le cache se
// dégrade (hitRate moyen récent en baisse d'au moins DRIFT_HIT_DROP). Anti-spam
// dédié (état 'drift', cooldown en tours). Fail-silent : renvoie null au moindre doute.
function evaluateDrift(sid) {
  let st;
  try {
    st = loadTurnState(sid);
  } catch (_) {
    return null;
  }
  // On ne juge que les tours mesurés (baseline/compaction -> d ou h null : écartés).
  const usable = st.turns.filter((t) => t && typeof t.d === 'number' && typeof t.h === 'number');
  if (usable.length < DRIFT_WINDOW) return null;

  const win = usable.slice(-DRIFT_WINDOW);
  const half = DRIFT_WINDOW / 2;
  const older = win.slice(0, half);
  const newer = win.slice(half);
  const avg = (arr, key) => arr.reduce((s, t) => s + t[key], 0) / arr.length;
  const avgDeltaOld = avg(older, 'd');
  const avgDeltaNew = avg(newer, 'd');
  const avgHitOld = avg(older, 'h');
  const avgHitNew = avg(newer, 'h');

  // Coût qui grimpe : ratio seulement défini sur une base ancienne positive ; garde
  // absolu pour ne pas alerter sur une hausse relative de tours minuscules.
  const costRising = avgDeltaOld > 0
    && avgDeltaNew >= DRIFT_COST_RATIO * avgDeltaOld
    && avgDeltaNew >= DRIFT_MIN_DELTA;
  // Cache qui se dégrade : hitRate moyen en baisse franche.
  const hitDropping = (avgHitOld - avgHitNew) >= DRIFT_HIT_DROP;
  if (!costRising || !hitDropping) return null;

  // Anti-spam : au plus 1 nudge par fenêtre de tours (cooldown persisté).
  const turnCount = st.turnCount;
  let lastDrift = -DRIFT_COOLDOWN;
  const dfCur = readJson(driftFile(sid), null);
  if (dfCur && typeof dfCur.lastDriftTurn === 'number') lastDrift = dfCur.lastDriftTurn;
  if (turnCount - lastDrift < DRIFT_COOLDOWN) return null;
  writeAtomic(driftFile(sid), { lastDriftTurn: turnCount });

  return {
    turns: DRIFT_WINDOW,
    avgDeltaOld, avgDeltaNew,
    avgHitOld, avgHitNew,
  };
}

module.exports = {
  computeTurn, evaluateDrift,
  COSTLY_DELTA, COSTLY_COOLDOWN, BUST_OCC_MIN, BUST_CACHE_RATIO, RESYNC_DELTA, MAX_TURNS,
  DRIFT_WINDOW, DRIFT_COST_RATIO, DRIFT_MIN_DELTA, DRIFT_HIT_DROP, DRIFT_COOLDOWN,
};
