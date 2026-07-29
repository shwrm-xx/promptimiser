'use strict';
// Périmètre d'un lot (cf. décision D3, palier 2 « périmètre exclusif ») : liste de chemins/
// globs qu'un lot a le droit de modifier. Ce module ne fait que la NORMALISATION et le test de
// DISJONCTION — « deux lots peuvent-ils coexister en cours sans se marcher dessus ? ». Le test
// d'APPARTENANCE d'un fichier à un périmètre (verdict du hook PreToolUse en mode fleet-fille)
// (lot #78) puis le calcul de vagues par le lot #79. Zéro dépendance, pas de lib de glob :
// matching conservateur au niveau des préfixes statiques (granularité « dossier », cf. D3
// « pressenti : dossier + liste d'exceptions »).

const path = require('path');

const MAX_GLOBS = 20; // au-delà, un périmètre n'est plus lisible d'un coup d'œil (même esprit que les caps du backlog)
const MAX_GLOB_LEN = 120;

// Normalise une liste de globs : trim, séparateurs POSIX, sans « ./ » ni « / » de tête/queue,
// vides et doublons retirés, caps appliqués. Entrée non-array → []. Idempotent.
function normalize(globs) {
  if (!Array.isArray(globs)) return [];
  const seen = new Set();
  const out = [];
  for (const g of globs) {
    let s = String(g == null ? '' : g).trim().replace(/\\/g, '/');
    s = s.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!s || s.length > MAX_GLOB_LEN) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_GLOBS) break;
  }
  return out;
}

// Préfixe statique d'un glob = tout ce qui précède le 1er joker (*, ?), remonté au dernier
// séparateur pour ne garder que des segments entiers. Borne conservatrice pour la disjonction :
//   « lib/*.js » → « lib » ; « lib/foo.js » → « lib/foo.js » ; « * » → « » (couvre tout).
// NB (lot #89) : « [ » n'est PAS un joker ici. Les crochets sont des segments LITTÉRAUX — cas
// dominant : les routes dynamiques Next.js (« app/[id]/page.tsx », « [slug] », « [...all] »).
// Les traiter en classe de caractères rabattait « app/[id]/** » sur le préfixe « app » (tout le
// dossier), rendant deux routes distinctes [id] et [slug] faussement chevauchantes (jamais
// disjointes). On ne développe de toute façon aucune classe de caractères (matching par préfixe).
function staticPrefix(glob) {
  const i = glob.search(/[*?]/);
  if (i === -1) return glob; // glob concret (dossier ou fichier) : préfixe = lui-même
  const head = glob.slice(0, i);
  const cut = head.lastIndexOf('/');
  return cut === -1 ? '' : head.slice(0, cut);
}

// a est-il préfixe-de-chemin de b, au sens SEGMENTS ? « » est préfixe de tout ; « lib » est
// préfixe de « lib/foo » mais pas de « libfoo ».
function isPathPrefix(a, b) {
  if (a === '') return true;
  if (a === b) return true;
  return b.startsWith(a + '/');
}

// Deux globs peuvent-ils désigner un chemin commun ? Conservateur : vrai dès qu'un préfixe
// statique est préfixe-de-chemin de l'autre (dans un sens ou l'autre).
function globsOverlap(g1, g2) {
  const p1 = staticPrefix(g1);
  const p2 = staticPrefix(g2);
  return isPathPrefix(p1, p2) || isPathPrefix(p2, p1);
}

// Zone PARTAGÉE ADDITIVE (lot #119) : premiers segments où chaque lot AJOUTE ses cas sans
// réécrire ceux des autres — les fichiers de test. Ces globs sont retirés du seul test de
// DISJONCTION. Sans cette exception, `test/**` (présent dans presque tous les périmètres du
// backlog, par construction : un lot livre ses tests) rendait TOUTE paire de lots non disjointe
// et sérialisait la vague entière — un lot par vague, la parallélisation annulée en silence.
// Ce que ça ne change PAS : `memberVerdict` (une fille garde le droit d'écrire dans SON test/**),
// et un périmètre réduit à la seule zone partagée reste non disjoint (cf. disjoint).
// Compromis assumé : deux filles peuvent toucher le même fichier de test → conflit de MERGE
// possible, détecté / annulé / imputé au bon lot par la réintégration en pipeline
// (lib/reintegrate.js, runPipeline) — jamais une écriture concurrente silencieuse.
const SHARED_SEGMENTS = ['test', 'tests', '__tests__', 'spec'];

// Un glob désigne-t-il la zone partagée ? Jugé sur le PREMIER segment de son préfixe statique
// (ancré à la racine du repo) : « test/**  », « test/run-tests.js », « test » → oui ;
// « src/lib/__tests__/** » → non (conservateur : pas partagé = continue de sérialiser).
// « * » (préfixe vide, couvre tout) n'est jamais partagé.
function isShared(glob) {
  const p = staticPrefix(glob);
  if (!p) return false;
  return SHARED_SEGMENTS.includes(p.split('/')[0]);
}

// Deux périmètres sont-ils disjoints (aucune paire de globs ne peut se chevaucher) ? Un
// périmètre VIDE n'est disjoint de rien : un lot sans périmètre déclaré pourrait toucher
// n'importe quoi, donc il ne peut pas coexister avec un autre lot en cours. Conservateur : au
// moindre doute → NON disjoint (on préfère refuser une coexistence douteuse qu'autoriser un
// conflit d'écriture).
function disjoint(a, b) {
  const na = normalize(a).filter((g) => !isShared(g));
  const nb = normalize(b).filter((g) => !isShared(g));
  // Un périmètre réduit à la seule zone partagée redevient vide ici, donc non disjoint : on ne
  // fait JAMAIS coexister deux lots sur la seule foi de « chacun ses tests » — il faut un
  // périmètre de code propre pour se voir accorder une place en vague.
  if (!na.length || !nb.length) return false;
  for (const g1 of na) {
    for (const g2 of nb) {
      if (globsOverlap(g1, g2)) return false;
    }
  }
  return true;
}

// Ramène un chemin (absolu OU relatif à `root`) à un relatif POSIX sous `root`, ou null s'il
// s'en échappe (« ../ »), est absolu hors root, ou n'est pas résoluble. Sans `root` on ne peut
// rien affirmer → null (indécidable) : c'est au hook d'en faire un « allow ».
function toRelPosix(filePath, root) {
  const raw = String(filePath == null ? '' : filePath).trim();
  if (!raw || !root) return null;
  try {
    const abs = path.resolve(root, raw);
    const rel = path.relative(root, abs);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || rel.startsWith('../') || path.isAbsolute(rel)) {
      return null;
    }
    return rel.replace(/\\/g, '/');
  } catch (_) {
    return null;
  }
}

// Un chemin appartient-il au périmètre ? Verdict CONSERVATEUR à trois issues pour le hook
// fleet-fille :
//   'inside'   — couvert par ≥ 1 glob (préfixe statique préfixe-de-chemin du fichier) → allow ;
//   'outside'  — CERTAIN hors de TOUS les globs → SEUL cas où le hook refuse ;
//   'unknown'  — périmètre vide, chemin hors root ou non résoluble → indécidable → allow.
// Granularité « dossier » : on raisonne sur le préfixe statique de chaque glob (pas de vrai
// moteur de glob), ce qui ÉLARGIT volontairement les périmètres — on ne refuse donc JAMAIS un
// chemin qu'un glob pourrait couvrir (deny sur certitude seule).
function memberVerdict(globs, filePath, root) {
  const gl = normalize(globs);
  if (!gl.length) return 'unknown';
  const rel = toRelPosix(filePath, root);
  if (rel === null) return 'unknown';
  for (const g of gl) {
    if (isPathPrefix(staticPrefix(g), rel)) return 'inside';
  }
  return 'outside';
}

module.exports = {
  normalize, disjoint, staticPrefix, memberVerdict, toRelPosix, isShared,
  MAX_GLOBS, MAX_GLOB_LEN, SHARED_SEGMENTS,
};
