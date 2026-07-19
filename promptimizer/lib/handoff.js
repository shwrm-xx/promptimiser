'use strict';
// Handoff de session : UN fichier .vibe-agent/handoff.md, ÉCRASÉ à chaque tour
// (jamais cumulé — pas de bloat). Deux origines :
//  - auto   : mécanique, écrit par stop.js à chaque fin de tour (dernier état connu) ;
//  - manuel : riche, écrit par l'assistant via /fresh-session ou /close-batch.
// Un handoff manuel n'est JAMAIS écrasé par l'auto tant qu'il n'a pas été consommé :
// session-start.js l'injecte au démarrage suivant puis le rebascule en auto.
// Un fichier sans marqueur PMZ (notes utilisateur) n'est ni écrasé ni injecté.
const fs = require('fs');
const path = require('path');
const { vibeDir, git, gitStatusMeaningful, lastCommitEpoch } = require('./project');
const { loadContextLedger, topWaste } = require('./ledger');
const { readEpic, getLotCounter } = require('./lot');
const { summaryLines, readTodoSnapshot } = require('./backlog');

const AUTO_MARKER = '<!-- pmz:handoff:auto -->';
const MANUAL_MARKER = '<!-- pmz:handoff:manual -->';
const MAX_INJECT_CHARS = 6000; // cap d'injection SessionStart (un handoff doit rester court)
const MAX_DIRTY_LINES = 15;
const MAX_READ_LINES = 10;
const MAX_WASTE_LINES = 3;

function handoffFile(root) {
  return path.join(vibeDir(root), 'handoff.md');
}

// Extrait les chemins des lignes `pmz:skip: <chemin>` d'un handoff manuel — sème
// l'advisory anti-relecture dès le tour 1 (sans attendre une 1re relecture réelle).
// Ligne malformée ou vide : ignorée silencieusement (fail-open).
function parseSkipPaths(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const m = /pmz:skip:\s*(.+)/.exec(line);
    if (m) {
      const p = m[1].trim();
      if (p) out.push(p);
    }
  }
  return out;
}

// Lit le handoff pour injection. null si absent, illisible ou sans marqueur PMZ.
function readHandoff(root) {
  try {
    const raw = fs.readFileSync(handoffFile(root), 'utf8');
    const manual = raw.includes(MANUAL_MARKER);
    if (!manual && !raw.includes(AUTO_MARKER)) return null;
    let text = raw.trim();
    if (text.length > MAX_INJECT_CHARS) text = text.slice(0, MAX_INJECT_CHARS) + '\n[handoff tronqué]';
    return { text, manual };
  } catch (_) {
    return null;
  }
}

// Handoff manuel consommé (injecté) -> rebasculé en auto : le prochain stop.js
// reprend la main et le remplace par l'état courant.
function markConsumed(root) {
  try {
    const f = handoffFile(root);
    const raw = fs.readFileSync(f, 'utf8');
    if (!raw.includes(MANUAL_MARKER)) return;
    fs.writeFileSync(f, raw.split(MANUAL_MARKER).join(AUTO_MARKER));
  } catch (_) {
    /* fail-open */
  }
}

// Fichiers lus le plus récemment (ledger contexte), pour la contrainte budget.
function recentReads(root) {
  try {
    const fr = loadContextLedger(root).files_read;
    return Object.keys(fr)
      .sort((a, b) => (fr[b] || 0) - (fr[a] || 0))
      .slice(0, MAX_READ_LINES);
  } catch (_) {
    return [];
  }
}

// Exclut les chemins modifiés depuis le dernier commit (travail en cours, pas du bruit à
// éviter) — files_modified n'est jamais purgé (FIFO 200), l'utiliser brut daterait
// l'exclusion à « modifié depuis toujours ». lastCommitMs null (pas de commit) -> no-op.
function excludeRecentlyModified(root, paths, lastCommitMs) {
  if (!paths.length || lastCommitMs == null) return paths;
  try {
    const fm = loadContextLedger(root).files_modified;
    return paths.filter((p) => !(fm[p] && fm[p] > lastCommitMs));
  } catch (_) {
    return paths;
  }
}

// Candidats à semer en `pmz:skip:` : lectures récentes + top-3 historiquement gaspillé
// (relectures complètes inchangées), dédupliqués, fichiers modifiés depuis le dernier
// commit exclus des deux.
function skipCandidates(root, lastCommitMs) {
  const reads = excludeRecentlyModified(root, recentReads(root), lastCommitMs);
  const seen = new Set(reads);
  const waste = excludeRecentlyModified(root, topWaste(root, MAX_WASTE_LINES).map((e) => e.path), lastCommitMs)
    .filter((p) => !seen.has(p));
  return { reads, waste };
}

// Écrit le handoff auto (dernier état connu). Refuse d'écraser un handoff manuel
// non consommé ou un fichier sans marqueur PMZ. Fail-silent.
function writeAutoHandoff(root) {
  try {
    if (!root) return false;
    const f = handoffFile(root);
    if (fs.existsSync(f) && !fs.readFileSync(f, 'utf8').includes(AUTO_MARKER)) return false;

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root) || '?';
    const last = git(['log', '-1', '--format=%h %s'], root) || 'aucun commit';
    const dirty = gitStatusMeaningful(root);
    const lastCommitSec = lastCommitEpoch(root);
    const lastCommitMs = lastCommitSec == null ? null : lastCommitSec * 1000;
    const { reads, waste } = skipCandidates(root, lastCommitMs);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

    const lines = [
      AUTO_MARKER,
      '## Handoff auto — dernier état connu du projet',
      '',
      `Généré en fin de tour (${stamp}), écrasé à chaque tour. Handoff mécanique :`,
      'pour un handoff riche (objectif, décisions, non-vérifié), lancer /fresh-session',
      'ou /close-batch avant de quitter la session.',
      '',
      `- Epic / lot en cours : « ${readEpic(root)} » — lot ${getLotCounter(root) + 1}`,
      `- Branche : ${branch} — dernier commit : ${last}`,
    ];
    // Format machine pmz:skip: <chemin> — parsé par parseSkipPaths et semé dès le tour 1
    // (seedAvoidReread côté session-start.js). Émis AVANT les blocs volumineux ci-dessous :
    // readHandoff tronque à 6000c avant le parse, ces lignes doivent survivre en premier.
    if (reads.length || waste.length) {
      lines.push('- Ne pas relire sauf changement (déjà lus récemment ou historiquement coûteux — git diff/git grep ou lecture partielle d\'abord) :');
      for (const p of reads) lines.push(`  pmz:skip: ${p}`);
      for (const p of waste) lines.push(`  pmz:skip: ${p}`);
    }
    // Avancement fonctionnel : plan de lots (backlog) + dernier état des todos.
    // Blocs omis si artefacts absents — le handoff reste purement mécanique sinon.
    const plan = summaryLines(root);
    if (plan.length) {
      lines.push(`- ${plan[0]}`);
      for (const p of plan.slice(1)) lines.push(`  ${p}`);
    }
    const snap = readTodoSnapshot(root);
    if (snap && snap.todos.length) {
      const items = snap.todos.filter((t) => t.status === 'in_progress')
        .concat(snap.todos.filter((t) => t.status === 'pending').slice(0, 5));
      if (items.length) {
        lines.push('- Tâches en cours (TodoWrite, dernier état) :');
        for (const t of items) lines.push(`  - [${t.status === 'in_progress' ? 'en cours' : 'à faire'}] ${t.content}`);
      }
    }
    if (dirty.length) {
      lines.push(`- Working tree : ${dirty.length} entrée(s) non commitée(s) :`);
      for (const l of dirty.slice(0, MAX_DIRTY_LINES)) lines.push(`  - ${l}`);
      if (dirty.length > MAX_DIRTY_LINES) lines.push(`  - … +${dirty.length - MAX_DIRTY_LINES} autres`);
    } else {
      lines.push('- Working tree : propre (lot précédent commité)');
    }
    fs.writeFileSync(f, lines.join('\n') + '\n');
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { handoffFile, readHandoff, parseSkipPaths, markConsumed, writeAutoHandoff, AUTO_MARKER, MANUAL_MARKER };
