'use strict';
// Messages injectés par les hooks. Courts, conformes à la spec mwn/ (rg -> git grep).
const { BUCKETS } = require('./occupancy');

const MSG_ACTIF = [
  'Promptimizer actif.',
  'Priorité : réduire les relectures de contexte.',
  'Utilise git grep/git diff avant Read complet.',
  'Clôture chaque lot par vérif ciblée + changelog + commit + handoff court.',
].join('\n');

const MSG_NON_INIT = [
  'Projet non initialisé détecté.',
  'Promptimizer peut créer un socle prudent (CLAUDE.md, AGENTS.md, CHANGELOG.md, .vibe-agent/).',
  "Propose à l'utilisateur de lancer /pmz-init (ou le bootstrap) et ne crée rien qu'APRÈS sa confirmation.",
  'Avant de coder : finaliser CLAUDE.md/AGENTS.md avec lecture minimale, puis proposer un premier lot court.',
].join('\n');

const MSG_LECTURE = [
  'Lecture potentiellement coûteuse.',
  'Ce fichier semble déjà connu ou non modifié.',
  'Préférer git grep, git diff ou lecture partielle sauf besoin exact.',
].join('\n');

const MSG_CLOTURE = [
  'Lot modifié sans clôture complète.',
  'Avant de continuer : vérification ciblée, CHANGELOG, commit, handoff court, session fraîche recommandée.',
].join('\n');

const MSG_LARGE = [
  'Demande potentiellement large.',
  'Découpe en un lot court et ciblé ; évite le scope creep et les relectures massives.',
].join('\n');

const MSG_INIT_BEFORE_CODE = [
  'Projet neuf : initialise le socle (CLAUDE.md/AGENTS.md/.vibe-agent) avant de coder, avec lecture minimale.',
].join('\n');

function occupancyMessage(occ, bucket) {
  const k = Math.round(occ / 1000);
  const next = BUCKETS[bucket]; // seuil suivant (bucket = nb de paliers déjà franchis), undefined au dernier
  const repere = next
    ? `prochain palier ~${Math.round(next / 1000)}k`
    : 'au-delà du dernier palier — session fraîche conseillée';
  return [
    `Contexte ≈ ${k}k tokens (${repere}).`,
    'Pense à : git diff/git grep plutôt que relire, handoff court, session fraîche si le lot est fini.',
  ].join('\n');
}

module.exports = {
  MSG_ACTIF, MSG_NON_INIT, MSG_LECTURE, MSG_CLOTURE, MSG_LARGE, MSG_INIT_BEFORE_CODE,
  occupancyMessage,
};
