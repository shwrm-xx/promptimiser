'use strict';
// Ledgers projet (.vibe-agent/read-ledger.json + context-ledger.json).
// Maintenus par post-tool-use.js. Écriture atomique, lecture défensive, cap FIFO.
const path = require('path');
const { vibeDir, isInitialized } = require('./project');
const { writeAtomic, readJson } = require('./fsjson');

const MAX_READS = 200;
const MAX_MODIFIED = 200;
const MAX_REPEATED = 200;
const MAX_SUMMARIES = 200;
const MAX_SUMMARY_CHARS = 240;
const MAX_HOT_FILES = 15;

// Clés de summaries normalisées avec des séparateurs `/` : les lignes pmz:summary d'un
// handoff écrivent des chemins POSIX alors que relOf (post-tool-use) produit des `\` sous
// Windows — sans normalisation la purge sur Edit raterait sa cible.
function normPath(p) {
  return String(p).split('\\').join('/');
}

// Paliers de gaspillage de relecture (tokens cumulés, trans-session) — plus fins que les
// paliers d'occupation d'occupancy.js car le gaspillage est un signal évitable qu'on veut
// surfacer tôt. Au-delà du dernier palier fixe, rappel flottant tous les +100k. Source de
// vérité unique : audit-context.js aligne son statut sur WASTE_BUCKETS (lot #52).
const WASTE_BUCKETS = [25000, 50000, 100000];
const WASTE_FLOATING_STEP = 100000;

function wasteBucketIndex(waste) {
  let idx = 0;
  for (let i = 0; i < WASTE_BUCKETS.length; i++) {
    if (waste >= WASTE_BUCKETS[i]) idx = i + 1;
  }
  const last = WASTE_BUCKETS[WASTE_BUCKETS.length - 1];
  if (waste >= last) idx = WASTE_BUCKETS.length + Math.floor((waste - last) / WASTE_FLOATING_STEP);
  return idx;
}

function readLedgerFile(root) { return path.join(vibeDir(root), 'read-ledger.json'); }
function contextLedgerFile(root) { return path.join(vibeDir(root), 'context-ledger.json'); }

function loadReadLedger(root) {
  const rl = readJson(readLedgerFile(root), null) || {};
  rl.reads = Array.isArray(rl.reads) ? rl.reads : [];
  rl.summaries = rl.summaries && typeof rl.summaries === 'object' ? rl.summaries : {};
  rl.avoid_reread_notes = Array.isArray(rl.avoid_reread_notes) ? rl.avoid_reread_notes : [];
  return rl;
}

function loadContextLedger(root) {
  const cl = readJson(contextLedgerFile(root), null) || {};
  cl.files_read = cl.files_read && typeof cl.files_read === 'object' ? cl.files_read : {};
  cl.files_modified = cl.files_modified && typeof cl.files_modified === 'object' ? cl.files_modified : {};
  cl.repeated_reads = Array.isArray(cl.repeated_reads) ? cl.repeated_reads : [];
  if (!('estimated_context_waste' in cl)) cl.estimated_context_waste = null;
  cl.waste_by_file = cl.waste_by_file && typeof cl.waste_by_file === 'object' ? cl.waste_by_file : {};
  cl.warnings = Array.isArray(cl.warnings) ? cl.warnings : [];
  if (!('occupancy' in cl)) cl.occupancy = null;
  cl.hot_files = Array.isArray(cl.hot_files) ? cl.hot_files : [];
  // Palier de gaspillage franchi et persisté (trans-session, monotone croissant) : borne
  // l'alerte à 1×/palier sur toute la vie du projet, pas 1×/session (lot #52).
  cl.waste_bucket = Number.isFinite(cl.waste_bucket) ? cl.waste_bucket : 0;
  return cl;
}

function capObject(obj, max) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return;
  // Valeur numérique (files_read/files_modified) ou entrée { at } (summaries) : dans les
  // deux cas on évince les plus anciennes d'abord.
  const rank = (v) => (typeof v === 'number' ? v : (v && typeof v.at === 'number' ? v.at : 0));
  const sorted = keys.sort((a, b) => rank(obj[a]) - rank(obj[b]));
  for (const k of sorted.slice(0, keys.length - max)) delete obj[k];
}

// stat : { bytes, mtimeMs } capturé par le hook (statSync), ou null si indisponible.
// Coût estimé d'un fichier ≈ bytes / 4 (heuristique tokens standard).
function estTokens(stat) {
  return stat && stat.bytes ? Math.round(stat.bytes / 4) : 0;
}

// Renvoie { waste, bytes, modifiedSince } pour l'advisory intra-tour (lot B4) — évite
// à l'appelant de recharger les ledgers pour ré-évaluer le même événement de lecture.
function recordRead(root, relPath, sessionId, partial, stat) {
  if (!isInitialized(root) || !relPath) return null;
  const rl = loadReadLedger(root);
  const cl = loadContextLedger(root);
  const now = Date.now();
  const existing = rl.reads.find((r) => r && r.path === relPath);
  const modifiedSince = Object.prototype.hasOwnProperty.call(cl.files_modified, relPath);
  let waste = false;
  if (existing) {
    cl.repeated_reads.push({ path: relPath, at: now });
    if (cl.repeated_reads.length > MAX_REPEATED) {
      cl.repeated_reads = cl.repeated_reads.slice(-MAX_REPEATED);
    }
    if (!rl.avoid_reread_notes.includes(relPath)) rl.avoid_reread_notes.push(relPath);
    // Gaspillage réel : relecture COMPLÈTE (!partial) d'un fichier INCHANGÉ depuis
    // la dernière lecture (mtime identique). Une lecture partielle ou un fichier
    // modifié entre-temps est un coût justifié, pas du gaspillage.
    if (!partial && stat && existing.mtime != null && stat.mtimeMs === existing.mtime) {
      waste = true;
      const est = estTokens(stat);
      cl.estimated_context_waste = (cl.estimated_context_waste || 0) + est;
      cl.waste_by_file[relPath] = (cl.waste_by_file[relPath] || 0) + est;
    }
    existing.read_at = now;
    existing.partial = !!partial;
    if (stat) { existing.bytes = stat.bytes; existing.mtime = stat.mtimeMs; }
  } else {
    const entry = { path: relPath, read_at: now, partial: !!partial };
    if (stat) { entry.bytes = stat.bytes; entry.mtime = stat.mtimeMs; }
    rl.reads.push(entry);
    if (rl.reads.length > MAX_READS) rl.reads = rl.reads.slice(-MAX_READS);
  }
  cl.files_read[relPath] = now;
  capObject(cl.files_read, MAX_READS);
  if (sessionId) cl.session_id = sessionId;
  writeAtomic(readLedgerFile(root), rl);
  writeAtomic(contextLedgerFile(root), cl);
  return { waste, bytes: stat ? stat.bytes : null, modifiedSince };
}

// Miroir COMPACT de la mesure par tour (turnstats) dans le ledger projet. La mesure
// fine vit dans l'état hors-projet <sha1>-turns.json ; ici c'est un aperçu lisible,
// last-writer-wins ASSUMÉ (le dernier Stop écrase — acceptable, ce n'est pas la source
// de vérité). No-op hors projet initialisé ou sans occ.
function recordOccupancy(root, { occ, delta, sessionId, hitRate }) {
  if (!isInitialized(root) || occ == null) return;
  const cl = loadContextLedger(root);
  cl.occupancy = {
    last: occ,
    at: Date.now(),
    delta_last_turn: delta == null ? null : delta,
    session: sessionId || null,
    // hitRate cache (lot #58) : miroir de turnstats.computeTurn().hitRate, lu par /budget
    // sans reparser le transcript. null si non calculable ce tour (garde la dernière valeur).
    hit_rate: Number.isFinite(hitRate) ? hitRate : (cl.occupancy && Number.isFinite(cl.occupancy.hit_rate) ? cl.occupancy.hit_rate : null),
  };
  if (sessionId) cl.session_id = sessionId;
  writeAtomic(contextLedgerFile(root), cl);
}

function recordModify(root, relPath, sessionId) {
  if (!isInitialized(root) || !relPath) return;
  const cl = loadContextLedger(root);
  cl.files_modified[relPath] = Date.now();
  capObject(cl.files_modified, MAX_MODIFIED);
  if (sessionId) cl.session_id = sessionId;
  writeAtomic(contextLedgerFile(root), cl);
  // Purge du résumé : un fichier modifié rend son résumé stocké périmé — mieux vaut
  // aucun résumé qu'un résumé faux servi à la place d'une relecture (lot #53).
  try {
    const rl = loadReadLedger(root);
    const key = normPath(relPath);
    if (rl.summaries[key]) {
      delete rl.summaries[key];
      writeAtomic(readLedgerFile(root), rl);
    }
  } catch (_) { /* fail-open */ }
}

// Top-n des fichiers historiquement les plus gaspillés (relectures complètes inchangées),
// pour semer un signal anti-relecture dès le tour 1 (handoff auto). [{ path, waste }].
function topWaste(root, n) {
  try {
    const wb = loadContextLedger(root).waste_by_file;
    return Object.keys(wb)
      .sort((a, b) => (wb[b] || 0) - (wb[a] || 0))
      .slice(0, n)
      .map((p) => ({ path: p, waste: wb[p] }));
  } catch (_) {
    return [];
  }
}

// Évalue le palier de gaspillage trans-session à partir de `estimated_context_waste`.
// Le palier franchi est PERSISTÉ dans le ledger (waste_bucket) donc monotone croissant
// sur toute la vie du projet -> un seul systemMessage par palier, jamais de re-alerte.
// Renvoie { waste, bucket, topFiles } au franchissement d'un NOUVEAU palier, sinon null.
// Ledger absent/corrompu/erreur -> null (silence total, fail-open). L'écriture du nouveau
// palier passe par writeAtomic (jamais de ledger tronqué).
function evaluateWaste(root) {
  try {
    if (!isInitialized(root)) return null;
    const cl = loadContextLedger(root);
    const waste = cl.estimated_context_waste || 0;
    if (waste <= 0) return null;
    const cur = wasteBucketIndex(waste);
    const prev = Number.isFinite(cl.waste_bucket) ? cl.waste_bucket : 0;
    if (cur <= prev) return null; // même palier ou redescente : silence
    cl.waste_bucket = cur;
    if (!writeAtomic(contextLedgerFile(root), cl)) return null;
    const wb = cl.waste_by_file || {};
    const topFiles = Object.keys(wb)
      .filter((p) => (wb[p] || 0) > 0)
      .sort((a, b) => (wb[b] || 0) - (wb[a] || 0))
      .slice(0, 3)
      .map((p) => ({ path: p, waste: wb[p] }));
    return { waste, bucket: cur, topFiles };
  } catch (_) {
    return null;
  }
}

// Sème read-ledger.summaries à partir d'entrées [{ path, text }] (lignes `pmz:summary:`
// du handoff) : résumé servi à la place d'une relecture. Clés normalisées `/`, texte
// plafonné, cap 200 entrées (éviction des plus anciennes). Fail-open.
function seedSummaries(root, entries) {
  if (!isInitialized(root) || !Array.isArray(entries) || !entries.length) return;
  const rl = loadReadLedger(root);
  const now = Date.now();
  let dirty = false;
  for (const e of entries) {
    if (!e || !e.path || !e.text) continue;
    const text = String(e.text).trim().slice(0, MAX_SUMMARY_CHARS);
    if (!text) continue;
    rl.summaries[normPath(e.path)] = { text, at: now };
    dirty = true;
  }
  if (!dirty) return;
  capObject(rl.summaries, MAX_SUMMARIES);
  writeAtomic(readLedgerFile(root), rl);
}

// Résumé connu pour un chemin (clé normalisée), ou null. Fail-open.
function getSummary(root, relPath) {
  try {
    if (!isInitialized(root) || !relPath) return null;
    const s = loadReadLedger(root).summaries[normPath(relPath)];
    return s && s.text ? s.text : null;
  } catch (_) {
    return null;
  }
}

// Top-n des résumés les plus récents, [{ path, text }] — restitués dans le handoff auto
// pour que la boucle pmz:summary survive de session en session sans relecture.
function topSummaries(root, n) {
  try {
    const s = loadReadLedger(root).summaries;
    return Object.keys(s)
      .filter((p) => s[p] && s[p].text)
      .sort((a, b) => (s[b].at || 0) - (s[a].at || 0))
      .slice(0, n)
      .map((p) => ({ path: p, text: s[p].text }));
  } catch (_) {
    return [];
  }
}

// Notes « ne pas relire » (liste canonique) pour la réinjection post-compact (#72). Tail =
// plus récent (append à chaque relecture / seed pmz:skip). Fail-open : [] au moindre doute.
function avoidRereadNotes(root, n) {
  try {
    const notes = loadReadLedger(root).avoid_reread_notes;
    if (!Array.isArray(notes)) return [];
    return n ? notes.slice(-n) : notes.slice();
  } catch (_) {
    return [];
  }
}

// Sème avoid_reread_notes à partir de chemins fournis (ex : `pmz:skip:` du handoff) —
// actif dès le tour 1, sans attendre une 1re relecture réelle. Fail-open.
function seedAvoidReread(root, paths) {
  if (!isInitialized(root) || !Array.isArray(paths) || !paths.length) return;
  const rl = loadReadLedger(root);
  for (const p of paths) {
    if (p && !rl.avoid_reread_notes.includes(p)) rl.avoid_reread_notes.push(p);
  }
  if (rl.avoid_reread_notes.length > MAX_READS) {
    rl.avoid_reread_notes = rl.avoid_reread_notes.slice(-MAX_READS);
  }
  writeAtomic(readLedgerFile(root), rl);
}

// Amorçage à froid (lot #65) : sème context-ledger.hot_files depuis [{ path, commits }]
// (cf. project.js#gitHotFiles) au moment du bootstrap d'un dépôt mûr. N'écrase JAMAIS un
// amorçage déjà fait ou de la donnée réelle accumulée en session — un seul seed possible
// par ledger (garde `hot_files.length`), ce qui rend l'appel reprenable (rejouer /init sur
// un ledger déjà amorcé ou déjà vécu est un no-op silencieux). Fail-open.
function seedHotFiles(root, entries) {
  if (!isInitialized(root) || !Array.isArray(entries) || !entries.length) return;
  const cl = loadContextLedger(root);
  if (cl.hot_files.length) return; // déjà semé ou déjà réel : on ne remplace jamais
  cl.hot_files = entries
    .filter((e) => e && e.path)
    .slice(0, MAX_HOT_FILES)
    .map((e) => ({ path: e.path, commits: e.commits || 0 }));
  if (!cl.hot_files.length) return;
  writeAtomic(contextLedgerFile(root), cl);
}

// Fichiers chauds connus (semés ou accumulés), [{ path, commits }]. Fail-open : [].
function hotFiles(root, n) {
  try {
    const list = loadContextLedger(root).hot_files;
    return n ? list.slice(0, n) : list.slice();
  } catch (_) {
    return [];
  }
}

module.exports = {
  loadReadLedger, loadContextLedger, recordRead, recordModify, recordOccupancy, estTokens,
  seedAvoidReread, avoidRereadNotes, seedSummaries, getSummary, topSummaries, normPath,
  topWaste, evaluateWaste, wasteBucketIndex, WASTE_BUCKETS, WASTE_FLOATING_STEP,
  seedHotFiles, hotFiles, MAX_HOT_FILES,
};
