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
  cl.warnings = Array.isArray(cl.warnings) ? cl.warnings : [];
  return cl;
}

function capObject(obj, max) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return;
  const sorted = keys.sort((a, b) => (obj[a] || 0) - (obj[b] || 0));
  for (const k of sorted.slice(0, keys.length - max)) delete obj[k];
}

function recordRead(root, relPath, sessionId, partial) {
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
    existing.read_at = now;
    existing.partial = !!partial;
  } else {
    rl.reads.push({ path: relPath, read_at: now, partial: !!partial });
    if (rl.reads.length > MAX_READS) rl.reads = rl.reads.slice(-MAX_READS);
  }
  cl.files_read[relPath] = now;
  capObject(cl.files_read, MAX_READS);
  if (sessionId) cl.session_id = sessionId;
  writeAtomic(readLedgerFile(root), rl);
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

module.exports = { loadReadLedger, loadContextLedger, recordRead, recordModify };
