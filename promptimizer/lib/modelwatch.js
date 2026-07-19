'use strict';
// Vigie modèle réel vs préconisé (lot #42) : compare le modèle qui a effectivement répondu
// (transcript) au model_hint du lot backlog en cours. Même méthode de lecture que
// occupancy.js (fenêtre depuis la fin, agrandie si besoin) — indépendante des ledgers projet.
const fs = require('fs');

const MAX_TAIL = 8 * 1024 * 1024;

function scanTailForModel(transcriptPath, size, tail) {
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
    if (!line || line.indexOf('"model"') === -1) continue;
    let model = null;
    try {
      const obj = JSON.parse(line);
      model = (obj && obj.message && obj.message.model) || null;
    } catch (_) {
      continue;
    }
    if (model) return model;
  }
  return null;
}

// Dernier modèle ayant répondu dans le transcript (ex. "claude-sonnet-5"), ou null.
function readLastModel(transcriptPath) {
  if (!transcriptPath) return null;
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch (_) {
    return null;
  }
  let tail = 512 * 1024;
  for (;;) {
    let model;
    try {
      model = scanTailForModel(transcriptPath, size, tail);
    } catch (_) {
      return null;
    }
    if (model != null) return model;
    if (tail >= size || tail >= MAX_TAIL) return null;
    tail = Math.min(tail * 4, MAX_TAIL);
  }
}

// model_hint est un mot-clé libre (« sonnet », « opus »…) ; le modèle réel est un id complet
// (« claude-sonnet-5 »). Correspondance par sous-chaîne, insensible à la casse — pas d'énum
// à maintenir en synchro avec les futurs noms de modèles.
function modelsDiffer(hint, actualModel) {
  if (!hint || !actualModel) return false;
  return !String(actualModel).toLowerCase().includes(String(hint).toLowerCase());
}

// Le model_hint désigne-t-il un modèle de la famille Claude, joignable par /model dans Claude
// Code ? Un lot peut préconiser un runtime tiers (« ollama », « gpt-4o », « gemini »…) : dans
// ce cas la vigie modèle et la suggestion /model n'ont AUCUN sens (CC ne peut pas s'y basculer)
// et doivent rester muettes. Allow-list des marqueurs Claude plutôt que deny-list des tiers :
// un hint inconnu est présumé non-Claude (silence sûr) — jamais de faux nudge « bascule ».
const CLAUDE_HINT_TOKENS = ['claude', 'opus', 'sonnet', 'haiku', 'fable'];
function hintResolvableClaude(hint) {
  if (!hint) return false;
  const h = String(hint).toLowerCase();
  return CLAUDE_HINT_TOKENS.some((t) => h.includes(t));
}

module.exports = { readLastModel, modelsDiffer, hintResolvableClaude };
