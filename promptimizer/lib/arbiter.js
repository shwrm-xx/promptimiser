'use strict';
// Arbitre de tour (lot #57) — plafonne le NOMBRE de nudges VISIBLES émis en un tour, en gardant
// les plus SÉVÈRES. Un tour qui déclenche simultanément occupation + hygiène + coût + clôture +
// preuve… noierait le signal important sous le bruit : l'arbitre garde au plus MAX_NUDGES_PER_TURN
// nudges, priorité à la sévérité décroissante (⛔ alert > ⚠ warn > ℹ info via lib/severity).
//
// Choke point UNIQUE des deux canaux : stop.js (systemMessage concaténé) et le plugin OpenCode
// (toasts individuels à l'idle) passent tous leurs nudges par arbitrate() avant émission.
//
// Sélection STABLE : à sévérité égale, l'ordre d'origine tranche (les nudges les plus « en amont »
// du tour survivent) ; les survivants sont ré-émis dans leur ORDRE D'ORIGINE, jamais réordonnés
// par sévérité — la hiérarchie visuelle vient déjà du glyphe, l'ordre de lecture reste stable.
//
// Fail-open par construction : entrée non-tableau -> [] ; jamais d'exception ; ne lit jamais la
// prose (uniquement le glyphe de tête via severityOf, ou un sevOf fourni par l'appelant).

const { severityOf, rank } = require('./severity');

// Plafond par défaut : au-delà, le bloc de fin de tour cesse d'être lisible d'un coup d'œil.
const MAX_NUDGES_PER_TURN = 3;

// Plafonne `items` à `opts.max` (défaut MAX_NUDGES_PER_TURN) en gardant les plus sévères.
//   - items  : tableau d'éléments quelconques (chaînes glyphées côté CC, objets toast côté OC).
//   - opts.max   : plafond (<= 0 -> aucun nudge ; défaut MAX_NUDGES_PER_TURN).
//   - opts.sevOf : item -> sévérité ('info'|'warn'|'alert'). Défaut : severityOf (item traité
//                  comme texte déjà préfixé d'un glyphe). Un objet toast passe { sevOf: t => t.sev }.
// Renvoie un NOUVEAU tableau (copie), survivants dans l'ordre d'origine. Jamais d'exception.
function arbitrate(items, opts) {
  const list = Array.isArray(items) ? items : [];
  const o = opts || {};
  const max = Number.isFinite(o.max) ? o.max : MAX_NUDGES_PER_TURN;
  if (max <= 0) return [];
  if (list.length <= max) return list.slice();
  const sevOf = typeof o.sevOf === 'function' ? o.sevOf : severityOf;
  return list
    .map((item, i) => ({ item, i, r: rank(sevOf(item)) }))
    .sort((a, b) => (b.r - a.r) || (a.i - b.i)) // sévérité desc, puis ordre d'origine (stable)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)                  // ré-émission dans l'ordre d'origine
    .map((x) => x.item);
}

module.exports = { arbitrate, MAX_NUDGES_PER_TURN };
