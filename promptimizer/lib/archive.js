'use strict';
// Archive à tiroirs des lots clos (.vibe-agent/archive/). Trois tiroirs, ouverts un
// à la fois — c'est tout l'intérêt : la mémoire est DURABLE sans être injectée.
//   tier 0 — index.md            : une ligne par lot, greppable, versionnée git ;
//   tier 1 — lots/lot-NNNN.md    : la fiche narrative (décisions + pourquoi), versionnée,
//                                  écrite UNE fois à la clôture puis immuable (zéro course
//                                  entre sessions filles, contrairement au handoff unique) ;
//   tier 2 — raw/lot-NNNN.md     : le brut (retour de sous-agent, handoff manuel intégral),
//                                  NON versionné (volumineux, chemins machine) — perte au
//                                  clone acceptable puisque la fiche capture le stable.
// C'est le référentiel qui survit au handoff (fichier unique, gitignoré, écrasé à chaque Stop).
//
// PARE-FEU (invariant du chantier) : ce module n'est JAMAIS requis en lecture par
// un hook ni par la chaîne d'injection (session-start.js, handoff.js, messages.js,
// pre-compact.js). Il s'écrit à la clôture et se lit à la demande, jamais tout seul.
//
// Format markdown ligne-à-ligne (et pas JSON) : consulté par l'humain ET par grep,
// diff git lisible, merge trivial (append d'une ligne), et surtout une ligne
// corrompue n'invalide pas le reste — contrairement à un JSON qui retombe en bloc
// sur le fallback silencieux de readJson.
//
// Fail-open absolu : chaque fonction try/catch → valeur neutre. Ce code tourne
// dans le hook Stop (filet doneLot) : il ne doit JAMAIS casser une clôture.
const fs = require('fs');
const path = require('path');
const { vibeDir, git } = require('./project');
const { writeAtomicText } = require('./fsjson');

const VERIFY_VALUES = ['OK', 'ÉCHEC', 'timeout', 'aucune', 'inconnu'];
const FICHE_VALUES = ['oui', 'non'];
const UNKNOWN = '—';

// En-tête réémis à chaque réécriture. La 1re ligne est le marqueur machine ; le titre
// commence par « # » suivi d'une espace, jamais confondu avec une entrée « #NNNN | ».
const HEADER = [
  '<!-- pmz:archive:index -->',
  '# Archive PMZ — index des lots clos',
  '',
  '<!-- Fichier machine : réécrit trié par id à chaque écriture. Format d\'une entrée :',
  '     #NNNN | AAAA-MM-JJ | <sha> | epic:<epic> | verify:<OK|ÉCHEC|timeout|aucune|inconnu> | fiche:<oui|non> | <titre> -->',
  '',
];

// Bloc de whitelist git du tier 0/1. L'ORDRE compte (dernier motif gagnant) : le `*`
// du .gitignore exclut tout, `!archive/` dé-ignore le dossier (git ne ré-inclut jamais
// le contenu d'un dossier exclu), `!archive/**` son contenu, puis `archive/raw/`
// ré-ignore le tier 2 (brut volumineux, porteur de chemins machine — perte acceptable).
const GITIGNORE_BLOCK = [
  '# Archive des lots clos (tier 0/1) : DURABLE, versionnée. Le brut (tier 2) reste ignoré.',
  '!archive/',
  '!archive/**',
  'archive/raw/',
];
const GITIGNORE_ANCHOR = '!archive/';

// Borne dure de la fiche tier 1 : ~600 tokens visés, refus au-delà. Jamais de coupe
// silencieuse (même philosophie que la garde anti-troncature du titre de lot) — une fiche
// trop longue est un symptôme (diff ou listing de code collé), pas un cas à rogner.
const MAX_FICHE_CHARS = 8000;

function archiveDir(root) { return path.join(vibeDir(root), 'archive'); }
function indexFile(root) { return path.join(archiveDir(root), 'index.md'); }
function ficheDir(root) { return path.join(archiveDir(root), 'lots'); }
function rawDir(root) { return path.join(archiveDir(root), 'raw'); }

function pad4(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n < 0) return '0000';
  return String(Math.round(n)).padStart(4, '0');
}

// Id zero-paddé 4 chiffres : le tri lexicographique des noms de fichiers vaut tri numérique.
function ficheFile(root, id) { return path.join(ficheDir(root), `lot-${pad4(id)}.md`); }
function rawFile(root, id) { return path.join(rawDir(root), `lot-${pad4(id)}.md`); }
function ficheMarker(id) { return `<!-- pmz:archive:lot ${Number(id)} -->`; }

// Un champ d'entrée ne doit jamais casser le format : le séparateur `|` devient `/` (on
// garde une trace visible plutôt que de l'effacer), les sauts de ligne deviennent des
// espaces, les espaces sont collapsés. Jamais de coupe silencieuse de longueur (le titre
// est déjà plafonné côté backlog, MAX_TITLE).
function cell(v, fallback) {
  const s = String(v == null ? '' : v)
    .replace(/\|/g, '/')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || (fallback == null ? UNKNOWN : fallback);
}

function normalizeEntry(e) {
  const o = e || {};
  return {
    id: Number.isFinite(Number(o.id)) ? Math.round(Number(o.id)) : null,
    date: cell(o.date),
    commit: cell(o.commit),
    epic: cell(o.epic),
    verify: VERIFY_VALUES.includes(o.verify) ? o.verify : 'inconnu',
    fiche: FICHE_VALUES.includes(o.fiche) ? o.fiche : 'non',
    title: cell(o.title, 'sans titre'),
  };
}

function formatEntry(e) {
  return `#${pad4(e.id)} | ${e.date} | ${e.commit} | epic:${e.epic} | verify:${e.verify} | fiche:${e.fiche} | ${e.title}`;
}

const ENTRY_RE = /^#(\d{4}) \| ([^|]*) \| ([^|]*) \| epic:([^|]*) \| verify:([^|]*) \| fiche:([^|]*) \| ([\s\S]*)$/;

function parseEntry(line) {
  const m = ENTRY_RE.exec(line);
  if (!m) return null;
  return normalizeEntry({
    id: parseInt(m[1], 10),
    date: m[2].trim(),
    commit: m[3].trim(),
    epic: m[4].trim(),
    verify: m[5].trim(),
    fiche: m[6].trim(),
    title: m[7].trim(),
  });
}

// Lecture tolérante : les lignes hors format sont conservées à part (jamais perdues à
// la réécriture) et les doublons d'id résolus « dernier gagne ».
function readIndexRaw(root) {
  const result = { entries: new Map(), others: [] };
  let raw;
  try {
    raw = fs.readFileSync(indexFile(root), 'utf8');
  } catch (_) {
    return result; // absent = index vide, pas une erreur
  }
  for (const line of String(raw).split('\n')) {
    const t = line.replace(/\s+$/, '');
    if (t === '') continue;
    const e = parseEntry(t);
    if (e && e.id != null) { result.entries.set(e.id, e); continue; }
    if (HEADER.includes(t)) continue; // en-tête : réémis, pas dupliqué
    result.others.push(t);
  }
  return result;
}

// Vue publique (CLI uniquement) : entrées triées par id croissant.
function readIndex(root) {
  try {
    const { entries } = readIndexRaw(root);
    return Array.from(entries.values()).sort((a, b) => a.id - b.id);
  } catch (_) {
    return [];
  }
}

// Whitelist git de l'archive dans un .vibe-agent/.gitignore DÉJÀ POSÉ. copyIfAbsent ne
// met jamais à jour un fichier existant : sans cette migration, les projets bootstrappés
// avant l'archive la garderaient ignorée — précédent vécu, le backlog avait disparu faute
// d'être suivi par git. Append-only, idempotent, fail-open (philosophie merge-settings).
// Retourne true UNIQUEMENT si le bloc vient d'être ajouté.
function ensureArchiveGitignore(root) {
  try {
    if (!root) return false;
    const gi = path.join(vibeDir(root), '.gitignore');
    if (!fs.existsSync(gi)) return false; // absent : c'est le template (bootstrap) qui le pose, déjà à jour
    const raw = fs.readFileSync(gi, 'utf8');
    if (raw.split('\n').some((l) => l.trim() === GITIGNORE_ANCHOR)) return false; // déjà migré
    fs.appendFileSync(gi, (raw.endsWith('\n') ? '' : '\n') + GITIGNORE_BLOCK.join('\n') + '\n');
    try { git(['add', '--', path.relative(root, gi)], root); } catch (_) { /* fail-open */ }
    return true;
  } catch (_) {
    return false;
  }
}

// Stage best-effort de l'index (modèle stageBacklog) : un fichier STAGÉ survit à un
// `git clean -fd` et part avec le prochain commit — en pratique le commit de clôture
// « chore(backlog): clôture du lot #N ». git() ne throw jamais.
function stageIndex(root) {
  try { git(['add', '--', path.relative(root, indexFile(root))], root); } catch (_) { /* fail-open */ }
}

// Fusion NON DÉGRADANTE d'une entrée sur une entrée déjà indexée. doneLot peut être
// rappelé (auto-clôture au Stop PUIS clôture CLI) et la fiche tier 1 peut avoir été
// écrite entre-temps : une réécriture machine ne doit jamais repasser `fiche:oui` à
// `non` ni écraser un `verify` connu par `inconnu`.
function mergeEntry(prev, next) {
  if (!prev) return next;
  return {
    id: next.id,
    date: next.date !== UNKNOWN ? next.date : prev.date,
    commit: next.commit !== UNKNOWN ? next.commit : prev.commit,
    epic: next.epic !== UNKNOWN ? next.epic : prev.epic,
    verify: next.verify !== 'inconnu' ? next.verify : prev.verify,
    fiche: prev.fiche === 'oui' || next.fiche === 'oui' ? 'oui' : 'non',
    title: next.title !== 'sans titre' ? next.title : prev.title,
  };
}

function renderIndex(entries, others) {
  const lines = HEADER.concat(entries.map(formatEntry));
  if (others && others.length) lines.push('', ...others);
  return lines.join('\n') + '\n';
}

function writeIndex(root, entriesMap, others) {
  const sorted = Array.from(entriesMap.values()).sort((a, b) => a.id - b.id);
  try { fs.mkdirSync(archiveDir(root), { recursive: true }); } catch (_) { /* fail-open */ }
  const okw = writeAtomicText(indexFile(root), renderIndex(sorted, others));
  if (okw) stageIndex(root);
  return okw;
}

// Ajoute (ou met à jour) la ligne tier 0 d'un lot. Idempotent PAR ID : rejouer le même
// appel ne produit ni doublon ni écriture. Course RMW multi-sessions résiduelle assumée
// (même palier que fleet) ; le lecteur tolère les doublons, dernier gagne par id.
function appendIndexLine(root, entry) {
  try {
    if (!root) return { ok: false, action: 'error' };
    const e = normalizeEntry(entry);
    if (e.id == null) return { ok: false, action: 'error' };
    ensureArchiveGitignore(root);
    const { entries, others } = readIndexRaw(root);
    const prev = entries.get(e.id) || null;
    const merged = mergeEntry(prev, e);
    if (prev && formatEntry(prev) === formatEntry(merged)) return { ok: true, action: 'unchanged' };
    entries.set(e.id, merged);
    const okw = writeIndex(root, entries, others);
    return { ok: okw, action: okw ? (prev ? 'updated' : 'added') : 'error' };
  } catch (_) {
    return { ok: false, action: 'error' };
  }
}

// ------------------------------- TIER 1 : la fiche -------------------------------

// Gabarit de fiche pré-rempli, émis par /close-batch au SEUL moment où le contexte riche
// existe encore (résultat verify inclus — il n'est persisté nulle part ailleurs). Les
// sections sont vides à dessein : c'est l'assistant qui les remplit, la machine ne sait
// pas inventer un « pourquoi ». Interdits (anti-péremption) : diff, contenu de fichier,
// listing de code, sortie de tests — le sha et le CHANGELOG font foi pour le volatil.
function ficheSkeleton(meta) {
  const m = meta || {};
  const id = Number(m.id);
  const date = cell(m.date);
  const commit = cell(m.commit);
  const verifyCmd = m.verifyCmd ? '`' + String(m.verifyCmd).replace(/`/g, "'") + '`' : 'aucune';
  const verify = VERIFY_VALUES.includes(m.verify) ? m.verify : 'inconnu';
  // Pointeur US (lot #101) : jamais de valeur inventée — un lot sans US ne produit ni
  // segment d'en-tête, ni ligne « Liens ».
  const us = m.us ? String(m.us).trim() : '';
  let metaLine = `- epic : ${cell(m.epic)} · clos : ${date} · commit : ${commit} · session : ${cell(m.session, 'inconnue')}`;
  if (us) metaLine += ` · us : ${us}`;
  const liens = [`- commit ${commit} · entrée CHANGELOG du ${date} · brut : archive/raw/lot-${pad4(id)}.md (local)`];
  if (us) liens.push(`- US : ${us}`);
  return [
    ficheMarker(id),
    `# Lot #${id} — ${cell(m.title, 'sans titre')}`,
    '',
    metaLine,
    `- verify : ${verifyCmd} → ${verify} · coût : non mesuré`,
    '',
    '## Objectif',
    '',
    '## Décisions (et pourquoi)',
    '',
    '## Vérifié',
    '',
    '## Non vérifié',
    '',
    '## Dette restante',
    '',
    '## Périmètre',
    '(globs / fichiers touchés — noms seulement, jamais de diff)',
    '',
    '## Liens',
    ...liens,
    '',
  ].join('\n');
}

// Écrit la fiche tier 1. IMMUABLE par défaut : une fiche existante n'est jamais écrasée
// sans `force` (elle est écrite une fois, à la clôture, et fait foi). Valide le marqueur
// et la borne de taille AVANT d'écrire, met à jour la ligne d'index en `fiche:oui`.
// Codes d'action explicites (jamais de refus muet) : exists | no-marker | too-long | error.
function writeFiche(root, id, markdown, opts) {
  const o = opts || {};
  const n = Number(id);
  const res = { ok: false, action: 'error', file: null, chars: 0 };
  try {
    if (!root || !Number.isFinite(n)) return res;
    res.file = ficheFile(root, n);
    const text = String(markdown == null ? '' : markdown).trim();
    res.chars = text.length;
    if (!text) return res;
    if (!text.includes(ficheMarker(n))) { res.action = 'no-marker'; return res; }
    if (text.length > MAX_FICHE_CHARS) { res.action = 'too-long'; return res; }
    if (fs.existsSync(res.file) && !o.force) { res.action = 'exists'; return res; }
    ensureArchiveGitignore(root);
    try { fs.mkdirSync(ficheDir(root), { recursive: true }); } catch (_) { /* fail-open */ }
    if (!writeAtomicText(res.file, text + '\n')) return res;
    try { git(['add', '--', path.relative(root, res.file)], root); } catch (_) { /* fail-open */ }
    appendIndexLine(root, { id: n, fiche: 'oui', title: o.title, epic: o.epic, date: o.date, commit: o.commit, verify: o.verify });
    res.ok = true;
    res.action = 'written';
    return res;
  } catch (_) {
    return res;
  }
}

// Complète une fiche EXISTANTE d'une ligne, sans jamais l'écraser (lot #98) : une réouverture
// ne dément pas la fiche du cycle clos, elle s'y ajoute en pied. Seul chemin d'écriture non
// immuable de tier 1 — volontairement limité à l'AJOUT d'une ligne, jamais à la réécriture d'une
// section. No-op explicite si aucune fiche n'existe (`missing`) : le champ `reopened` du backlog
// reste alors la seule trace. Codes d'action : appended | missing | too-long | error.
function appendFicheLine(root, id, line) {
  const n = Number(id);
  const res = { ok: false, action: 'error', file: null };
  try {
    if (!root || !Number.isFinite(n)) return res;
    const text = String(line == null ? '' : line).trim();
    if (!text) return res;
    res.file = ficheFile(root, n);
    if (!fs.existsSync(res.file)) { res.action = 'missing'; return res; }
    const prev = fs.readFileSync(res.file, 'utf8');
    if (prev.includes(text)) { res.ok = true; res.action = 'appended'; return res; } // rejeu : no-op
    const next = prev.replace(/\s*$/, '') + '\n\n' + text + '\n';
    if (next.length > MAX_FICHE_CHARS) { res.action = 'too-long'; return res; }
    if (!writeAtomicText(res.file, next)) return res;
    try { git(['add', '--', path.relative(root, res.file)], root); } catch (_) { /* fail-open */ }
    res.ok = true;
    res.action = 'appended';
    return res;
  } catch (_) {
    return res;
  }
}

// Lecture d'une fiche — CLI UNIQUEMENT (pare-feu : jamais depuis la chaîne d'injection).
function readFiche(root, id) {
  try { return fs.readFileSync(ficheFile(root, id), 'utf8'); } catch (_) { return null; }
}

// ------------------------------- TIER 2 : le brut --------------------------------

// Écrit le brut. JAMAIS stagé (gitignoré par `archive/raw/`) : c'est un collage volumineux,
// potentiellement porteur de chemins machine et de sorties de tests. Écrasable sans
// cérémonie, contrairement à la fiche : on colle le dernier retour connu.
function writeRaw(root, id, text) {
  const n = Number(id);
  const res = { ok: false, file: null, bytes: 0 };
  try {
    if (!root || !Number.isFinite(n)) return res;
    res.file = rawFile(root, n);
    const s = String(text == null ? '' : text);
    if (!s.trim()) return res;
    ensureArchiveGitignore(root);
    try { fs.mkdirSync(rawDir(root), { recursive: true }); } catch (_) { /* fail-open */ }
    if (!writeAtomicText(res.file, s.endsWith('\n') ? s : s + '\n')) return res;
    res.bytes = Buffer.byteLength(s, 'utf8');
    res.ok = true;
    return res;
  } catch (_) {
    return res;
  }
}

// Métadonnées du brut sans le lire : c'est ce que le tiroir tier 2 montre par défaut
// (chemin + taille), l'affichage réel restant derrière `--confirm`. Des dizaines de Ko
// de contexte ne s'ouvrent pas par accident.
function rawInfo(root, id) {
  const f = rawFile(root, id);
  try {
    const st = fs.statSync(f);
    return { exists: true, file: f, bytes: st.size };
  } catch (_) {
    return { exists: false, file: f, bytes: 0 };
  }
}

// Lecture du brut — CLI UNIQUEMENT, derrière --confirm (pare-feu).
function readRaw(root, id) {
  try { return fs.readFileSync(rawFile(root, id), 'utf8'); } catch (_) { return null; }
}

// Entrée machine dérivée d'un lot du backlog. `verify:inconnu` est la vérité au moment de
// l'appel : appendIndexLine (via doneLot) tourne AVANT que le verdict verify ne soit connu
// (runVerify + setClosedVerify n'arrivent qu'après, cf. stop.js) — closed_verify existe
// désormais sur le lot (lot #96) mais rien ne resynchronise cette ligne d'index a posteriori,
// hors périmètre minimal de ce lot.
function entryFromLot(lot) {
  const l = lot || {};
  return {
    id: l.id,
    date: typeof l.closed_at === 'string' ? l.closed_at.slice(0, 10) : '',
    commit: l.closed_commit,
    epic: l.epic,
    verify: 'inconnu',
    fiche: 'non',
    title: l.title,
  };
}

// Rétro-remplissage tier 0 des lots déjà clos, depuis le backlog (seule source complète :
// 90/90 lots done portent closed_commit ; closed_at n'est PAS fiable, l'id est le seul
// ordre sûr). Reprenable et idempotent : un id déjà indexé est sauté tel quel — jamais
// de réécriture d'une ligne enrichie à la main ou par une fiche. `--dry-run` d'abord.
function backfill(root, opts) {
  const o = opts || {};
  const res = { ok: false, dryRun: !!o.dryRun, added: [], skipped: 0, total: 0 };
  try {
    if (!root) return res;
    const { loadBacklog } = require('./backlog');
    const b = loadBacklog(root);
    const done = (b.lots || []).filter((l) => l.status === 'done').sort((a, c) => a.id - c.id);
    res.total = done.length;
    const { entries, others } = readIndexRaw(root);
    for (const l of done) {
      const e = normalizeEntry(entryFromLot(l));
      if (e.id == null || entries.has(e.id)) { res.skipped += 1; continue; }
      res.added.push(e);
      if (!res.dryRun) entries.set(e.id, e);
    }
    if (res.dryRun) { res.ok = true; return res; }
    if (!res.added.length) { res.ok = true; return res; } // rien à faire : pas de réécriture inutile
    ensureArchiveGitignore(root);
    res.ok = writeIndex(root, entries, others);
    return res;
  } catch (_) {
    return res;
  }
}

module.exports = {
  archiveDir, indexFile, ficheDir, ficheFile, rawDir, rawFile, ficheMarker, ensureArchiveGitignore,
  appendIndexLine, readIndex, backfill, entryFromLot, formatEntry, parseEntry,
  ficheSkeleton, writeFiche, readFiche, appendFicheLine, writeRaw, readRaw, rawInfo,
  GITIGNORE_BLOCK, VERIFY_VALUES, FICHE_VALUES, MAX_FICHE_CHARS,
};
