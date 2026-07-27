'use strict';
// Handoff de session : UN fichier .vibe-agent/handoff.md, ÉCRASÉ à chaque tour
// (jamais cumulé — pas de bloat). Deux origines :
//  - auto   : mécanique, écrit par stop.js à chaque fin de tour (dernier état connu) ;
//  - manuel : riche, écrit par l'assistant via /fresh-session ou /close-batch.
// Un handoff manuel n'est JAMAIS écrasé par l'auto tant qu'il n'a pas été consommé :
// session-start.js l'injecte au démarrage suivant puis le rebascule en auto.
// Un fichier sans marqueur PMZ (notes utilisateur) n'est ni écrasé ni injecté.
//
// EN VAGUE PARALLÈLE (lot #99, FIA-19) : N sessions filles partagent le même checkout donc
// le même .vibe-agent/ — un fichier unique = last-writer-wins (l'état du lot A remplacé par
// celui du lot B juste avant la reprise de A). Chaque fille INSCRITE au fleet écrit donc son
// propre `handoff-lot-<id>.md` ; `handoff.md` reste celui de l'orchestrateur. Hors vague (cas
// ultra-majoritaire) et en mode worktree (chaque fille a déjà son .vibe-agent isolé) :
// strictement rien ne change. Le fleet reste le handoff PARTAGÉ de la vague (structure : qui
// tient quoi, tête d'intégration) ; handoff-lot-* est le handoff PAR SESSION (état riche).
const fs = require('fs');
const path = require('path');
const { vibeDir, git, gitStatusMeaningful, lastCommitEpoch } = require('./project');
const { writeAtomicText } = require('./fsjson');
const { loadContextLedger, topWaste, scoredSummaries } = require('./ledger');
const { readEpic, getLotCounter } = require('./lot');
const { summaryLines, readTodoSnapshot } = require('./backlog');
const { waveHandoffLines, lotForSession, loadFleet } = require('./fleet');

const AUTO_MARKER = '<!-- pmz:handoff:auto -->';
const MANUAL_MARKER = '<!-- pmz:handoff:manual -->';
const MAX_INJECT_CHARS = 6000; // cap d'injection SessionStart (un handoff doit rester court)
const MAX_DIRTY_LINES = 15;
const MAX_READ_LINES = 10;
const MAX_WASTE_LINES = 3;
const MAX_SUMMARY_LINES = 5;

const LOT_HANDOFF_RE = /^handoff-lot-(\d+)\.md$/;

function baseHandoffFile(root) {
  return path.join(vibeDir(root), 'handoff.md');
}

function lotHandoffFile(root, id) {
  return path.join(vibeDir(root), `handoff-lot-${Number(id)}.md`);
}

// Fichier où CETTE session ÉCRIT son handoff. `handoff-lot-<id>.md` si et seulement si la
// session tient un lot en vol dans une vague partageant ce checkout (pas de worktree) ;
// `handoff.md` sinon. Fail-open : au moindre doute, le fichier historique.
function handoffFile(root, sessionId) {
  const base = baseHandoffFile(root);
  if (!sessionId) return base;
  try {
    const mine = lotForSession(root, sessionId);
    // worktree : la fille a son propre checkout donc son propre .vibe-agent — un fichier par
    // lot y serait mort-né (personne ne le lirait). On garde handoff.md.
    if (!mine || mine.worktree) return base;
    return lotHandoffFile(root, mine.id);
  } catch (_) {
    return base;
  }
}

// Fichiers candidats à la LECTURE, dans l'ordre : le handoff de lot d'abord (état propre à
// cette fille), `handoff.md` en repli. Le repli est ce qui permet à une fille de démarrer sur
// le handoff de l'orchestrateur tant qu'elle n'a pas encore écrit le sien.
function handoffCandidates(root, sessionId) {
  const base = baseHandoffFile(root);
  const mine = handoffFile(root, sessionId);
  return mine === base ? [base] : [mine, base];
}

// Premier candidat porteur d'un marqueur PMZ : { file, raw }, ou null. Point d'entrée UNIQUE
// de readHandoff et markConsumed — les deux doivent viser exactement le même fichier.
function resolveHandoff(root, sessionId) {
  for (const f of handoffCandidates(root, sessionId)) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      if (raw.includes(MANUAL_MARKER) || raw.includes(AUTO_MARKER)) return { file: f, raw };
    } catch (_) {
      /* candidat suivant */
    }
  }
  return null;
}

// Supprime les handoffs de lot (réintégration : la fille n'existe plus, son état riche devient
// de la péremption dans .vibe-agent). `ids` omis → TOUS, y compris les orphelins d'une vague
// précédente. Renvoie le nombre de fichiers retirés. Best-effort, jamais d'exception.
function purgeLotHandoffs(root, ids) {
  let n = 0;
  try {
    const dir = vibeDir(root);
    const keep = Array.isArray(ids) ? new Set(ids.map(Number)) : null;
    for (const name of fs.readdirSync(dir)) {
      const m = LOT_HANDOFF_RE.exec(name);
      if (!m) continue;
      if (keep && !keep.has(Number(m[1]))) continue;
      try { fs.unlinkSync(path.join(dir, name)); n++; } catch (_) { /* fail-open */ }
    }
  } catch (_) {
    /* fail-open */
  }
  return n;
}

// Purge les handoffs de lot d'une vague ABANDONNÉE : jamais réintégrée (closeWave n'est donc
// jamais passé) ni quittée lot par lot (fleet leave), le fleet redevient inerte par un autre
// chemin (reset manuel, clearWave direct, fleet.json supprimé) et les handoff-lot-*.md restent
// sur disque en péremption pour toujours — même famille que purgeLotHandoffs mais SANS dépendre
// de closeWave. Détection : fleet inactif (aucun lot en vol) alors que des fichiers de lot
// existent encore — la vague est « inerte mais avec des fichiers restants ». Une vague ENCORE
// active garde légitimement ses handoffs, on n'y touche pas. Renvoie le nombre de fichiers
// retirés (0 si vague active, absente, ou aucun fichier orphelin). Best-effort, jamais throw.
function purgeOrphanLotHandoffs(root) {
  try {
    if (loadFleet(root).active) return 0;
    return purgeLotHandoffs(root);
  } catch (_) {
    return 0;
  }
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

// Extrait les entrées des lignes `pmz:summary: <chemin> — <résumé>` d'un handoff —
// sème read-ledger.summaries pour servir le résumé à la place d'une relecture (lot #53).
// Séparateur « — » (tiret cadratin) obligatoire ; ligne malformée ignorée (fail-open).
function parseSummaryLines(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const m = /pmz:summary:\s*(.+)/.exec(line);
    if (!m) continue;
    const idx = m[1].indexOf(' — ');
    if (idx <= 0) continue;
    const p = m[1].slice(0, idx).trim();
    const t = m[1].slice(idx + 3).trim();
    if (p && t) out.push({ path: p, text: t });
  }
  return out;
}

// Lit le handoff pour injection. null si absent, illisible ou sans marqueur PMZ.
// `sessionId` (optionnel) : en vague, sert à lire le handoff DE CETTE FILLE en priorité.
function readHandoff(root, sessionId) {
  try {
    const h = resolveHandoff(root, sessionId);
    if (!h) return null;
    const manual = h.raw.includes(MANUAL_MARKER);
    let text = h.raw.trim();
    if (text.length > MAX_INJECT_CHARS) text = text.slice(0, MAX_INJECT_CHARS) + '\n[handoff tronqué]';
    return { text, manual, file: h.file };
  } catch (_) {
    return null;
  }
}

// Handoff manuel consommé (injecté) -> rebasculé en auto : le prochain stop.js
// reprend la main et le remplace par l'état courant. Vise le MÊME fichier que readHandoff.
function markConsumed(root, sessionId) {
  try {
    const h = resolveHandoff(root, sessionId);
    if (!h || !h.raw.includes(MANUAL_MARKER)) return;
    writeAtomicText(h.file, h.raw.split(MANUAL_MARKER).join(AUTO_MARKER));
  } catch (_) {
    /* fail-open */
  }
}

// L'état interne PMZ n'est jamais un candidat anti-relecture : consulter le plan de lots,
// un ledger ou la mémoire durable des lots clos est une action à la demande, pas une
// relecture coûteuse à décourager. Sans ce filtre, une consultation consomme des slots
// `pmz:skip:` (MAX_READ_LINES) au détriment des vrais fichiers du projet.
const PMZ_STATE_RE = /(^|\/)\.vibe-agent\//;
function isPmzState(p) { return PMZ_STATE_RE.test(String(p || '')); }

// Fichiers lus le plus récemment (ledger contexte), pour la contrainte budget.
function recentReads(root) {
  try {
    const fr = loadContextLedger(root).files_read;
    return Object.keys(fr)
      .filter((p) => !isPmzState(p))
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
    .filter((p) => !seen.has(p) && !isPmzState(p));
  return { reads, waste };
}

// Écrit le handoff auto (dernier état connu). Refuse d'écraser un handoff manuel
// non consommé ou un fichier sans marqueur PMZ. Fail-silent.
// `sessionId` (optionnel) : en vague, écrit `handoff-lot-<id>.md` au lieu de `handoff.md` —
// une fille ne peut donc plus écraser l'état d'une sœur (FIA-19). JAMAIS de repli en lecture
// ici : écrire dans handoff.md serait précisément le last-writer-wins qu'on supprime.
function writeAutoHandoff(root, sessionId) {
  try {
    if (!root) return false;
    const f = handoffFile(root, sessionId);
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
    for (const l of waveHandoffLines(root)) lines.push(`- ${l}`);
    // Format machine pmz:skip: <chemin> — parsé par parseSkipPaths et semé dès le tour 1
    // (seedAvoidReread côté session-start.js). Émis AVANT les blocs volumineux ci-dessous :
    // readHandoff tronque à 6000c avant le parse, ces lignes doivent survivre en premier.
    if (reads.length || waste.length) {
      lines.push('- Ne pas relire sauf changement (déjà lus récemment ou historiquement coûteux — git diff/git grep ou lecture partielle d\'abord) :');
      for (const p of reads) lines.push(`  pmz:skip: ${p}`);
      for (const p of waste) lines.push(`  pmz:skip: ${p}`);
    }
    // Format machine pmz:summary: <chemin> — <résumé> (lot #53) — restitue les résumés
    // connus pour qu'ils survivent de session en session : parsés par parseSummaryLines
    // et re-semés côté session-start.js. Même contrainte que pmz:skip : émis tôt pour
    // survivre à la troncature 6000c de readHandoff.
    // Résumés servis SCORÉS par ROI (octets × fréquence de relecture, lot #66) et remplis sous
    // un budget de caractères explicite — pas un déversement des N plus récents. Le gain estimé
    // (tokens de relecture évités) est affiché pour rendre l'économie visible au repreneur.
    const sel = scoredSummaries(root, undefined, MAX_SUMMARY_LINES);
    if (sel.entries.length) {
      const gain = sel.gainTokens >= 1000 ? `${Math.round(sel.gainTokens / 1000)}k` : `${sel.gainTokens}`;
      const suffix = sel.gainTokens > 0 ? ` — ≈ ${gain} tokens de relecture évités` : '';
      lines.push(`- Résumés connus (à utiliser à la place d'une relecture complète)${suffix} :`);
      for (const s of sel.entries) lines.push(`  pmz:summary: ${s.path} — ${s.text}`);
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
    return writeAtomicText(f, lines.join('\n') + '\n');
  } catch (_) {
    return false;
  }
}

module.exports = {
  handoffFile,
  lotHandoffFile,
  purgeLotHandoffs,
  purgeOrphanLotHandoffs,
  readHandoff,
  parseSkipPaths,
  parseSummaryLines,
  markConsumed,
  writeAutoHandoff,
  AUTO_MARKER,
  MANUAL_MARKER,
};
