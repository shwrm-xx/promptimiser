'use strict';
// Vigie des tours en boucle (lot #69). Détecte une commande Bash relancée en rafale alors
// qu'elle échoue (>= LOOP_MIN_FAILS échecs d'affilée, sans succès entre eux) — signe que le
// modèle « insiste » au lieu de changer d'approche, et brûle du contexte en tool_result
// d'erreur répétés. Même méthode de lecture que occupancy.scanTailForReadMix : fenêtre fixe
// depuis la fin du transcript (tendance récente, pas d'exactitude au tour près), indépendante
// des ledgers projet -> marche même hors repo git.
//
// Sémantique de rafale PAR COMMANDE (clé = commande normalisée en espaces) : un échec
// incrémente la série de SA commande, un succès la remet à zéro ; les autres commandes ne
// s'interposent pas (le modèle intercale souvent des diagnostics entre deux relances — c'est
// bien la même boucle). On ne signale qu'une boucle ENCORE OUVERTE : si le dernier résultat
// de la commande est un succès, la boucle s'est résolue toute seule, nudger serait du bruit.
const fs = require('fs');
const crypto = require('crypto');
const { stateFileFor } = require('./occupancy');
const { writeAtomic, readJson } = require('./fsjson');

const LOOP_MIN_FAILS = 3;               // >= 3 échecs consécutifs de la même commande = boucle
const LOOP_TAIL = 1.5 * 1024 * 1024;    // fenêtre de scan (même ordre que READ_MIX_TAIL)

function loopsFile(sid) { return stateFileFor(sid, 'loops.json'); }

function normalizeCmd(cmd) {
  return String(cmd == null ? '' : cmd).replace(/\s+/g, ' ').trim();
}

function cmdKey(cmd) {
  return crypto.createHash('sha1').update(normalizeCmd(cmd)).digest('hex').slice(0, 16);
}

// Scanne la fenêtre de fin du transcript et renvoie la pire boucle ENCORE OUVERTE :
// { cmd, fails } (fails = longueur de la série d'échecs courante, >= LOOP_MIN_FAILS),
// ou null. Deux passes implicites en une : les tool_use Bash donnent id -> commande,
// les tool_result (dans l'ordre du fichier, donc après leur tool_use) font vivre les séries.
function scanTailForLoop(transcriptPath, tail) {
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch (_) {
    return null;
  }
  const t = tail || LOOP_TAIL;
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
  const idToCmd = new Map();   // tool_use_id -> commande normalisée (Bash seulement)
  const streaks = new Map();   // commande -> série d'échecs courante (0 après un succès)
  for (const line of chunk.split(/\r?\n/)) {
    if (!line) continue;
    const hasUse = line.indexOf('"tool_use"') !== -1;
    const hasResult = line.indexOf('"tool_result"') !== -1;
    if (!hasUse && !hasResult) continue;
    let content;
    try {
      const obj = JSON.parse(line);
      content = obj && obj.message && Array.isArray(obj.message.content) ? obj.message.content : null;
    } catch (_) {
      continue;
    }
    if (!content) continue;
    for (const block of content) {
      if (!block) continue;
      if (block.type === 'tool_use' && block.name === 'Bash' && block.id) {
        const cmd = normalizeCmd(block.input && block.input.command);
        if (cmd) idToCmd.set(block.id, cmd);
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        const cmd = idToCmd.get(block.tool_use_id);
        if (!cmd) continue; // résultat d'un autre outil, ou tool_use hors fenêtre
        if (block.is_error === true) streaks.set(cmd, (streaks.get(cmd) || 0) + 1);
        else streaks.set(cmd, 0);
      }
    }
  }
  let best = null;
  for (const [cmd, fails] of streaks) {
    if (fails >= LOOP_MIN_FAILS && (!best || fails > best.fails)) best = { cmd, fails };
  }
  return best;
}

// Évalue la vigie pour le tour : boucle ouverte détectée ET pas encore signalée cette
// session pour CETTE commande -> { cmd, fails }, sinon null. Anti-spam par commande
// (clé sha1) et non par session entière : une 2e commande qui part en boucle après la
// 1re mérite son propre nudge ; la même commande, elle, ne re-nudge jamais (la fenêtre
// revoit les mêmes échecs à chaque Stop tant qu'ils n'en sortent pas). Fail-open total.
function evaluateLoop(transcriptPath, sessionId) {
  try {
    if (!transcriptPath) return null;
    const loop = scanTailForLoop(transcriptPath);
    if (!loop) return null;
    const sf = loopsFile(sessionId);
    const st = readJson(sf, null) || {};
    const nudged = st.nudged && typeof st.nudged === 'object' ? st.nudged : {};
    const key = cmdKey(loop.cmd);
    if (nudged[key]) return null; // déjà signalée cette session
    nudged[key] = loop.fails;
    writeAtomic(sf, { nudged });
    return loop;
  } catch (_) {
    return null; // fail-open : jamais d'exception vers le hook
  }
}

module.exports = { scanTailForLoop, evaluateLoop, normalizeCmd, LOOP_MIN_FAILS, LOOP_TAIL };
