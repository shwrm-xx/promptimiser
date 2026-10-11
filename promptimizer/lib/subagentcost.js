'use strict';
// Coût des TOURS DÉLÉGUÉS À UN SOUS-AGENT (lot #119). Un sous-agent (outil Agent/Task) n'écrit
// PAS dans le transcript de la session : Claude Code lui ouvre son propre fichier, à côté,
//   <transcript sans .jsonl>/subagents/agent-<id>.jsonl
// (constaté sur transcripts réels : aucun uuid des lignes `usage` du sous-agent ne figure dans le
// transcript parent, et le parent ne contient aucune ligne `isSidechain`). Conséquence : le hook
// Stop, qui ne scanne QUE le transcript de la session, ne voyait rien de ce coût — un lot dont le
// gros du travail était délégué sortait à `cost_tokens` ≈ 0 (imputation aveugle).
//
// Ce module scanne ces fichiers avec la MÊME méthode que lib/turnstats (offset persisté par
// fichier : un octet déjà compté ne l'est jamais deux fois) et rend le coût de sortie APPARU
// depuis le Stop précédent. Corpus strictement disjoint du transcript parent → aucun risque de
// double comptage avec turnstats.computeTurn.
//
// Deux bornes de prudence, dans l'esprit « jamais de valeur inventée » :
//   - fichier RÉTRÉCI (offset > taille : réécrit/tronqué) → on recale l'offset sans rien compter,
//     plutôt que de tout recompter (une sur-imputation est plus grave qu'un trou) ;
//   - budget de travail borné par tour (MAX_FILES_PER_TURN, les plus récemment écrits d'abord) :
//     un dossier de vague avec des dizaines d'agents ne fait jamais déborder le délai du hook.
//     Les fichiers non traités gardent leur offset — ils seront comptés au Stop suivant.
// Fail-silent partout (code de hook) : au moindre doute, null.
const fs = require('fs');
const path = require('path');
const { stateFileFor } = require('./occupancy');
const { writeAtomic, readJson } = require('./fsjson');
const { scanRange } = require('./turnstats');

const MAX_FILES_PER_TURN = 40; // fichiers d'agents scannés par Stop (les plus récents d'abord)
const MAX_TRACKED = 200;       // offsets conservés dans l'état (FIFO par fraîcheur) — anti-bloat

// Dossier des transcripts de sous-agents d'une session, dérivé du transcript parent (aucune
// dépendance à la disposition de ~/.claude/projects). null si le chemin n'a pas la forme attendue.
function subagentDir(transcriptPath) {
  if (!transcriptPath) return null;
  const s = String(transcriptPath);
  if (!s.endsWith('.jsonl')) return null;
  return path.join(s.slice(0, -'.jsonl'.length), 'subagents');
}

function stateFile(sid) { return stateFileFor(sid, 'subagents.json'); }

function loadOffsets(sid) {
  const st = readJson(stateFile(sid), null);
  const o = st && st.offsets;
  if (!o || typeof o !== 'object') return {};
  const out = {};
  for (const k of Object.keys(o)) if (typeof o[k] === 'number' && o[k] >= 0) out[k] = o[k];
  return out;
}

// Coût de sortie des sous-agents apparu depuis le dernier appel, pour la session `sid`.
// Renvoie null s'il n'y a pas de dossier de sous-agents (cas ultra-majoritaire : rien délégué),
// sinon { out, agents, files } — `out` = tokens de sortie du delta, `agents` = nombre de fichiers
// ayant réellement produit du coût ce tour, `files` = leurs noms (diagnostic, jamais affiché).
function computeSubagentCost(transcriptPath, sid) {
  const dir = subagentDir(transcriptPath);
  if (!dir) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((n) => /^agent-.*\.jsonl$/.test(n));
  } catch (_) {
    return null; // pas de sous-agent pour cette session
  }
  if (!entries.length) return null;

  const prev = loadOffsets(sid);
  const stats = [];
  for (const n of entries) {
    try {
      const st = fs.statSync(path.join(dir, n));
      stats.push({ n, size: st.size, mtime: st.mtimeMs });
    } catch (_) { /* fichier disparu entre readdir et stat : ignoré */ }
  }
  if (!stats.length) return null;
  stats.sort((a, b) => b.mtime - a.mtime);

  // Offsets repartis de l'état précédent, mais LIMITÉS aux fichiers encore présents : un agent
  // supprimé ne doit pas garder une entrée éternelle dans l'état.
  const next = {};
  let out = 0;
  const files = [];
  const work = stats.slice(0, MAX_FILES_PER_TURN);
  const workNames = new Set(work.map((s) => s.n));
  for (const s of stats) {
    if (!workNames.has(s.n) && typeof prev[s.n] === 'number') next[s.n] = prev[s.n];
  }
  for (const s of work) {
    const known = typeof prev[s.n] === 'number' ? prev[s.n] : null;
    // Fichier rétréci : on recale sans compter (pas de recomptage intégral).
    const start = (known == null) ? 0 : (known > s.size ? s.size : known);
    next[s.n] = s.size;
    if (start >= s.size) continue;
    let sum = 0;
    for (const u of scanRange(path.join(dir, s.n), start, s.size)) sum += u.output;
    if (sum > 0) { out += sum; files.push(s.n); }
  }

  // Anti-bloat : au plus MAX_TRACKED offsets, les plus récemment écrits conservés.
  let offsets = next;
  const keys = Object.keys(next);
  if (keys.length > MAX_TRACKED) {
    const order = new Map(stats.map((s, i) => [s.n, i])); // stats déjà triés du + récent au + vieux
    const keep = keys.sort((a, b) => (order.has(a) ? order.get(a) : Infinity) - (order.has(b) ? order.get(b) : Infinity))
      .slice(0, MAX_TRACKED);
    offsets = {};
    for (const k of keep) offsets[k] = next[k];
  }
  writeAtomic(stateFile(sid), { offsets });

  return { out, agents: files.length, files };
}

module.exports = { computeSubagentCost, subagentDir, MAX_FILES_PER_TURN, MAX_TRACKED };
