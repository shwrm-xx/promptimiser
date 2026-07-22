'use strict';
// Grammaire de sévérité des nudges VISIBLES (canal systemMessage / toast OpenCode — jamais
// réinjecté dans le contexte du modèle). Centralise le glyphe et le rang de priorité pour que :
//   (a) chaque fabrique de messages.js préfixe son constat d'un glyphe lisible, donnant une
//       hiérarchie visuelle immédiate quand stop.js concatène plusieurs nudges en un seul bloc ;
//   (b) l'arbitre de tour (lot #57) trie et plafonne les nudges par sévérité DÉCROISSANTE sans
//       avoir à re-parser la prose — via severityOf() sur un texte déjà préfixé, ou rank() direct.
// Les messages INJECTÉS dans le contexte (additionalContext : MSG_ACTIF, handoff, résumés,
// vigie modèle…) ne relèvent PAS de cette grammaire — ce sont des instructions, pas des alertes,
// et un glyphe y coûterait des tokens pour rien.
//
// Glyphes centralisés ici : un seul point de changement si un terminal les rend mal. Purement
// cosmétiques — jamais lus par une logique de contrôle, donc fail-open par construction.

const SEV = { INFO: 'info', WARN: 'warn', ALERT: 'alert' };

const GLYPH = { info: 'ℹ', warn: '⚠', alert: '⛔' };

// Rang croissant = plus grave. L'arbitre garde les nudges au rang le plus élevé quand il plafonne.
const RANK = { info: 0, warn: 1, alert: 2 };

function glyph(sev) { return GLYPH[sev] || GLYPH.info; }
function rank(sev) { return RANK[sev] != null ? RANK[sev] : RANK.info; }

// Préfixe la 1re ligne d'un corps « constat → chiffre → action » par le glyphe de sévérité.
// `body` peut être une chaîne (multi-lignes) ou un tableau de lignes (joint par \n).
function withSeverity(sev, body) {
  const text = Array.isArray(body) ? body.join('\n') : String(body);
  return glyph(sev) + ' ' + text;
}

// Sévérité d'un texte déjà préfixé (hook de l'arbitre lot #57). Défaut INFO si non préfixé —
// jamais d'exception, un texte nu est traité comme informatif.
function severityOf(text) {
  const first = String(text || '')[0];
  for (const s of Object.keys(GLYPH)) if (GLYPH[s] === first) return s;
  return SEV.INFO;
}

module.exports = { SEV, GLYPH, RANK, glyph, rank, withSeverity, severityOf };
