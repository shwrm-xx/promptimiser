'use strict';
// Lecteur MINIMAL de scalaires dans `.vibe-agent/rules.yaml` (lot #112).
//
// Pourquoi ce fichier existe : `rules.yaml` était jusqu'ici un pur bloc documentaire
// (« aucun parseur YAML ne le lit »), et le zéro-dépendance du dépôt interdit d'y coller
// une lib YAML. Rendre un réglage « configurable dans rules.yaml » demandait donc soit un
// parseur, soit de déplacer la config ailleurs. Arbitrage : un lecteur de SCALAIRES, pas
// un parseur YAML.
//
// Ce qu'il lit — et RIEN d'autre : des paires `clé: valeur` indentées sous un bloc de
// premier niveau (`budget:`), la valeur étant un scalaire sur une seule ligne. Ce qu'il
// ignore délibérément en silence : listes (`- item`), imbrication au-delà d'un niveau,
// ancres/alias, valeurs multi-lignes (`|`, `>`), documents multiples. Toute forme non
// reconnue n'est pas une erreur : elle n'existe pas pour ce lecteur.
//
// Le périmètre est volontairement étroit pour que la surface de maintenance reste bornée :
// les blocs riches de `rules.yaml` (`context_policy`, `closure_policy`) restent lus par le
// modèle, pas par du code — seuls des scalaires numériques ont besoin d'être exécutables.
//
// Fail-open absolu (doctrine PMZ) : fichier absent, illisible, mal formé, valeur aberrante
// -> `null`. L'appelant retombe TOUJOURS sur son défaut codé en dur. Aucune dépendance
// au-delà de `fs`/`path` : ce module est requis par `occupancy.js`, qui doit rester léger
// (pas de `child_process`, pas de git).
const fs = require('fs');
const path = require('path');

function rulesPath(root) {
  return path.join(root, '.vibe-agent', 'rules.yaml');
}

// Retire un commentaire de fin de ligne. Un `#` ne compte que s'il est en tête ou précédé
// d'un blanc (`http://x#y` n'est pas un commentaire). Une valeur entre guillemets est
// prise telle quelle jusqu'au guillemet fermant, commentaire éventuel écarté ensuite.
function stripComment(raw) {
  const s = String(raw);
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    if (end > 0) return s.slice(1, end);
    return s.slice(1); // guillemet non fermé : au mieux-effort, jamais une erreur
  }
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trim();
  }
  return s.trim();
}

// Tous les scalaires d'un bloc de premier niveau, en objet plat { clé: 'valeur brute' }.
// Objet VIDE si le bloc est absent (indistinguable d'un bloc vide, et c'est voulu :
// l'appelant ne teste que la présence de SA clé).
function readBlock(root, block) {
  const out = {};
  if (!root || !block) return out;
  let raw;
  try {
    raw = fs.readFileSync(rulesPath(root), 'utf8');
  } catch (_) {
    return out; // pas de rules.yaml (projet non initialisé, ou fichier supprimé) -> défauts
  }
  const lines = String(raw).split(/\r?\n/);
  let inBlock = false;
  let indent = -1; // indentation des clés DIRECTES du bloc, fixée par la première rencontrée
  const head = new RegExp('^' + block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(#.*)?$');
  for (const line of lines) {
    if (!inBlock) {
      if (head.test(line)) inBlock = true;
      continue;
    }
    if (/^\s*$/.test(line)) continue;           // ligne vide : le bloc continue
    if (/^\s*#/.test(line)) continue;           // commentaire : ignoré
    if (!/^\s/.test(line)) break;               // désindenté -> fin du bloc
    const m = /^(\s+)([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!m) continue;                           // liste `- x`, forme exotique : ignorée
    if (indent < 0) indent = m[1].length;
    // Seul le premier niveau compte : une clé plus indentée appartient à un sous-bloc et ne
    // doit PAS remonter dans le parent (sans quoi `sous_bloc: { profond: 42 }` se lirait comme
    // `budget.profond`, avec un risque de collision de nom silencieuse).
    if (m[1].length !== indent) continue;
    const value = stripComment(m[3]);
    if (value === '') continue;                 // `clé:` nue = sous-bloc, hors périmètre
    out[m[2]] = value;
  }
  return out;
}

// Scalaire brut (string) ou null.
function readScalar(root, block, key) {
  const b = readBlock(root, block);
  return Object.prototype.hasOwnProperty.call(b, key) ? b[key] : null;
}

// Scalaire NUMÉRIQUE fini, ou null si absent / non numérique / hors bornes. `min`/`max`
// sont inclusifs et optionnels : une valeur hors bornes est traitée comme absente (on
// retombe sur le défaut de l'appelant) plutôt que d'être rabotée en silence — un
// `red_zone_ratio: 35` est une faute de frappe, pas une demande de 3500 %.
function readNumber(root, block, key, min, max) {
  const raw = readScalar(root, block, key);
  if (raw === null) return null;
  // `Number('')` vaut 0 : on exige une forme numérique explicite avant de convertir.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

module.exports = { rulesPath, readBlock, readScalar, readNumber, stripComment };
