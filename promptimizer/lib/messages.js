'use strict';
// Messages injectés par les hooks. Courts, conformes à la spec mwn/ (rg -> git grep).
const { BUCKETS, FLOATING_STEP } = require('./occupancy');

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
  'Lance /close-batch pour la checklist et l\'audit complets (vérif ciblée, CHANGELOG, commit, handoff).',
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
  let repere;
  if (bucket < BUCKETS.length) {
    const next = BUCKETS[bucket];
    repere = `prochain palier ~${Math.round(next / 1000)}k`;
  } else {
    // Palier flottant au-delà de 750k : continue à alerter tous les +250k au lieu
    // de se taire pour le reste d'une session marathon.
    const last = BUCKETS[BUCKETS.length - 1];
    const nextFloating = last + (bucket - BUCKETS.length + 1) * FLOATING_STEP;
    repere = `au-delà du dernier palier fixe — prochain rappel ~${Math.round(nextFloating / 1000)}k`;
  }
  return [
    `Contexte ≈ ${k}k tokens (${repere}).`,
    'Pense à : git diff/git grep plutôt que relire.',
    "Lot fini → lance /close-batch. Sinon → /fresh-session après un commit intermédiaire pour repartir au plancher.",
  ].join('\n');
}

// Confirmation factuelle après un auto-scaffold de projet neuf (point 6) — jamais
// silencieux sur ce qui a été fait ou pas.
function autoInitMessage({ gitInitDone, committed }) {
  const lines = [
    gitInitDone
      ? "Nouveau projet détecté : git init + socle Promptimizer posés automatiquement (CLAUDE.md, AGENTS.md, CHANGELOG.md, .vibe-agent/)."
      : "Nouveau projet détecté (0 commit) : socle Promptimizer posé automatiquement (CLAUDE.md, AGENTS.md, CHANGELOG.md, .vibe-agent/).",
    committed
      ? 'Commit initial du socle effectué.'
      : "Commit initial NON effectué (git a échoué) — à faire manuellement.",
    'Relis CLAUDE.md avant de coder, puis propose un premier lot court.',
  ];
  return lines.join('\n');
}

function sessionTitleMessage(title) {
  return [
    `Titre de session suggéré : « ${title} ».`,
    "Essaie de renommer cette session avec ce titre via l'outil de renommage de session s'il est disponible dans ce contexte.",
    "Confirme ensuite explicitement à l'utilisateur si le renommage a réussi, ou explique pourquoi ce n'était pas possible (outil absent, erreur…) — jamais silencieux sur ce point.",
  ].join('\n');
}

module.exports = {
  MSG_ACTIF, MSG_NON_INIT, MSG_LECTURE, MSG_CLOTURE, MSG_LARGE, MSG_INIT_BEFORE_CODE,
  occupancyMessage, sessionTitleMessage, autoInitMessage,
};
