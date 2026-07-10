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
const { vibeDir, git, gitStatusMeaningful } = require('./project');
const { loadContextLedger } = require('./ledger');
const { readEpic, getLotCounter } = require('./lot');

const AUTO_MARKER = '<!-- pmz:handoff:auto -->';
const MANUAL_MARKER = '<!-- pmz:handoff:manual -->';
const MAX_INJECT_CHARS = 6000; // cap d'injection SessionStart (un handoff doit rester court)
const MAX_DIRTY_LINES = 15;
const MAX_READ_LINES = 10;

function handoffFile(root) {
  return path.join(vibeDir(root), 'handoff.md');
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
    const reads = recentReads(root);
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
    if (dirty.length) {
      lines.push(`- Working tree : ${dirty.length} entrée(s) non commitée(s) :`);
      for (const l of dirty.slice(0, MAX_DIRTY_LINES)) lines.push(`  - ${l}`);
      if (dirty.length > MAX_DIRTY_LINES) lines.push(`  - … +${dirty.length - MAX_DIRTY_LINES} autres`);
    } else {
      lines.push('- Working tree : propre (lot précédent commité)');
    }
    if (reads.length) {
      lines.push('- Ne pas relire sauf changement (déjà lus récemment — git diff/git grep d\'abord) :');
      for (const p of reads) lines.push(`  - ${p}`);
    }
    fs.writeFileSync(f, lines.join('\n') + '\n');
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { handoffFile, readHandoff, markConsumed, writeAutoHandoff, AUTO_MARKER, MANUAL_MARKER };
