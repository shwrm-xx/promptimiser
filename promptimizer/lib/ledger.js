'use strict';
// Ledgers projet (.vibe-agent/read-ledger.json + context-ledger.json).
// Maintenus par post-tool-use.js. Écriture atomique, lecture défensive, cap FIFO.
const path = require('path');
const { vibeDir, isInitialized } = require('./project');
const { writeAtomic, readJson } = require('./fsjson');

const MAX_READS = 200;
const MAX_MODIFIED = 200;
const MAX_REPEATED = 200;

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
  return cl;
}

function capObject(obj, max) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return;
  const sorted = keys.sort((a, b) => (obj[a] || 0) - (obj[b] || 0));
  for (const k of sorted.slice(0, keys.length - max)) delete obj[k];
}

// stat : { bytes, mtimeMs } capturé par le hook (statSync), ou null si indisponible.
// Coût estimé d'un fichier ≈ bytes / 4 (heuristique tokens standard).
function estTokens(stat) {
  return stat && stat.bytes ? Math.round(stat.bytes / 4) : 0;
}

function recordRead(root, relPath, sessionId, partial, stat) {
  if (!isInitialized(root) || !relPath) return;
  const rl = loadReadLedger(root);
  const cl = loadContextLedger(root);
  const now = Date.now();
  const existing = rl.reads.find((r) => r && r.path === relPath);
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
}

// Miroir COMPACT de la mesure par tour (turnstats) dans le ledger projet. La mesure
// fine vit dans l'état hors-projet <sha1>-turns.json ; ici c'est un aperçu lisible,
// last-writer-wins ASSUMÉ (le dernier Stop écrase — acceptable, ce n'est pas la source
// de vérité). No-op hors projet initialisé ou sans occ.
function recordOccupancy(root, { occ, delta, sessionId }) {
  if (!isInitialized(root) || occ == null) return;
  const cl = loadContextLedger(root);
  cl.occupancy = {
    last: occ,
    at: Date.now(),
    delta_last_turn: delta == null ? null : delta,
    session: sessionId || null,
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
}

module.exports = { loadReadLedger, loadContextLedger, recordRead, recordModify, recordOccupancy, estTokens };
