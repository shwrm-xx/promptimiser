'use strict';
// Occupation contexte RELATIVE à la fenêtre du modèle — pendant OpenCode de lib/occupancy.js
// (Claude Code), qui lui scanne un transcript `.jsonl` inexistant côté OpenCode. Ici la
// source est l'événement `message.updated` (tokens du dernier message assistant) ; l'occ
// est comparée à la fenêtre UTILE du modèle (contexte − sortie réservée) en paliers
// relatifs 50/70/85/95 %. Anti-spam : palier persisté MONOTONE par session (fichier d'état
// hors-projet), réarmé seulement par une nouvelle session_id ou un resync post-compaction.
// Fail-open absolu : toute I/O est try/catchée, aucune fonction ne throw.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ocdir = require('./oc-dir');

// Paliers relatifs (% de la fenêtre utile). 95 % ≈ seuil où OpenCode s'apprête à compacter
// de lui-même : c'est le dernier avertissement avant résumé lossy.
const THRESHOLDS = [50, 70, 85, 95];

function stateFile(sid, suffix) {
  const dir = ocdir.stateDir();
  const h = crypto.createHash('sha1').update(String(sid || 'unknown')).digest('hex').slice(0, 16);
  return path.join(dir, suffix ? `${h}-${suffix}` : h);
}

// Occupation réelle = input + cache lu + cache écrit (même définition que Claude Code :
// input_tokens + cache_read + cache_creation). La sortie (output) n'occupe pas le contexte.
function occFromTokens(tokens) {
  if (!tokens) return 0;
  const cache = tokens.cache || {};
  return (tokens.input || 0) + (cache.read || 0) + (cache.write || 0);
}

// Enregistre l'occ du dernier message ASSISTANT (message.updated). Silencieux, sans log
// (message.updated est très bavard en streaming) : on ne garde que le dernier état connu.
function recordFromMessage(info) {
  try {
    if (!info || info.role !== 'assistant' || !info.tokens || !info.sessionID) return false;
    const occ = occFromTokens(info.tokens);
    if (!(occ > 0)) return false;
    const rec = { occ, providerID: info.providerID || null, modelID: info.modelID || null };
    fs.writeFileSync(stateFile(info.sessionID, 'occ.json'), JSON.stringify(rec));
    return true;
  } catch (_) {
    return false;
  }
}

function readRecord(sid) {
  try {
    const rec = JSON.parse(fs.readFileSync(stateFile(sid, 'occ.json'), 'utf8'));
    return rec && typeof rec.occ === 'number' ? rec : null;
  } catch (_) {
    return null;
  }
}

// Fenêtre UTILE = contexte − sortie réservée (limit.output). Réserve la place que le modèle
// gardera pour sa réponse : c'est le budget d'ENTRÉE réellement disponible. Fenêtre inconnue
// (modèle local sans limit.context déclaré) -> null (pas d'évaluation relative, fail-open).
function usefulWindow(limit) {
  if (!limit || !(limit.context > 0)) return null;
  const out = limit.output > 0 ? limit.output : 0;
  const useful = limit.context - out;
  return useful > 0 ? useful : limit.context;
}

function bucketIndex(pct) {
  let idx = 0;
  for (let i = 0; i < THRESHOLDS.length; i++) if (pct >= THRESHOLDS[i]) idx = i + 1;
  return idx;
}

// Évalue le franchissement d'un palier relatif. Palier persisté monotone croissant : on
// n'alerte QU'EN montée (un message « maigre » ne réarme jamais un palier déjà franchi).
// Retourne { occ, pct, bucket, crossedNew, useful, threshold, rec } ou null si rien
// d'exploitable (pas d'occ enregistrée, ou fenêtre inconnue).
function evaluate(sid, useful) {
  const rec = readRecord(sid);
  if (!rec || !(rec.occ > 0) || !(useful > 0)) return null;
  const pct = (rec.occ / useful) * 100;
  const cur = bucketIndex(pct);
  const sf = stateFile(sid, 'occbucket');
  let prev = 0;
  try { prev = parseInt(String(fs.readFileSync(sf, 'utf8')).trim() || '0', 10) || 0; } catch (_) { prev = 0; }
  let crossedNew = false;
  if (cur > prev) {
    crossedNew = true;
    try { fs.writeFileSync(sf, String(cur)); } catch (_) { /* au pire on resignale */ }
  }
  return { occ: rec.occ, pct, bucket: cur, crossedNew, useful, threshold: cur > 0 ? THRESHOLDS[cur - 1] : 0, rec };
}

// Réarme le palier (post-compaction) : l'occ a chuté, le palier persisté est périmé (trop
// haut). Sans pct fourni -> palier 0 (réarme tout depuis le prochain message enregistré).
function resyncBucket(sid, pct) {
  try {
    fs.writeFileSync(stateFile(sid, 'occbucket'), String(pct == null ? 0 : bucketIndex(pct)));
    return true;
  } catch (_) {
    return false;
  }
}

// Efface l'occ enregistrée (post-compaction : la valeur pré-compaction ne vaut plus rien,
// le prochain message.updated réenregistrera la nouvelle occ, plus basse).
function clearUsage(sid) {
  try { fs.rmSync(stateFile(sid, 'occ.json'), { force: true }); } catch (_) {}
}

// Toast de franchissement (canal visible côté OpenCode — pas de statusline). Court par
// nature (un toast, pas un paragraphe injecté) : le détail chiffré vit dans /pmz budget.
function occupancyToast(pct, occ) {
  const k = Math.round(occ / 1000);
  const p = Math.round(pct);
  return `Contexte ≈ ${p} % de la fenêtre utile (~${k}k tokens). Lot fini → clôture (commit + handoff) ; sinon git diff/grep plutôt que relire.`;
}

// ---- Injection différée (session.created / session.compacted -> 1er chat.message) ----
// OpenCode n'a pas d'équivalent au `additionalContext` de SessionStart : le seul point où
// injecter du contexte au (re)démarrage est le 1er `chat.message` (mutation des parts). Le
// texte à injecter est mis en file dans un fichier d'état par session (survit à un reload du
// plugin, et reste PAR session — la closure du plugin est partagée entre sessions du serveur).

function putPending(sid, text) {
  try {
    if (!sid || !text) return false;
    fs.writeFileSync(stateFile(sid, 'pending.md'), String(text));
    return true;
  } catch (_) {
    return false;
  }
}

// Lit ET consomme (supprime) l'injection en attente. Renvoie null s'il n'y a rien.
function takePending(sid) {
  try {
    const f = stateFile(sid, 'pending.md');
    const text = fs.readFileSync(f, 'utf8');
    fs.rmSync(f, { force: true });
    return text || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  THRESHOLDS,
  occFromTokens, recordFromMessage, readRecord, usefulWindow, bucketIndex, evaluate,
  resyncBucket, clearUsage, occupancyToast, putPending, takePending, stateFile,
};
