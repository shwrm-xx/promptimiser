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

const MSG_HANDOFF = [
  'Handoff de la session précédente (.vibe-agent/handoff.md) — prends-le comme point de départ.',
  "Ne relis pas les fichiers qu'il liste sauf changement (git diff/git grep d'abord).",
].join('\n');

const MSG_LARGE = [
  'Demande potentiellement large.',
  'Propose un découpage en 2 à 5 lots (1 lot = 1 commit livrable), fais-le valider, puis',
  'persiste-le : /pmz-scope, ou node ~/.claude/promptimizer/scripts/backlog.js add --title "…" --scope "fait quand : …" (puis start --id N).',
  'Traite ensuite UNIQUEMENT le premier lot.',
].join('\n');

// Variante quand un plan de lots existe déjà : ne pas repartir sur un nouveau plan.
function largeWithPlanMessage(prog, cur) {
  return [
    `Demande potentiellement large — un plan de lots existe déjà (${prog.done}/${prog.total} faits).`,
    cur
      ? `Rattache la demande au lot en cours (« ${cur.title} ») ou ajoute un lot via backlog.js add — sans élargir le lot courant.`
      : 'Rattache la demande à un lot existant ou ajoute un lot via backlog.js add — un seul lot à la fois.',
  ].join('\n');
}

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

// Nudge occupation HAUTE injecté dans UserPromptSubmit (coûte du contexte) — donc
// volontairement court (2 lignes) et plafonné 1×/palier par l'appelant.
function occupancyPromptMessage(occ, bucket) {
  const k = Math.round(occ / 1000);
  return [
    `Contexte ≈ ${k}k tokens — occupation haute, ce tour coûtera plus cher en cache.`,
    "Lot fini → /close-batch. Sinon → commit intermédiaire puis /fresh-session pour repartir au plancher.",
  ].join('\n');
}

function fmtK(n) {
  const v = Math.abs(n || 0);
  return v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`;
}

// Tour coûteux : +delta d'occupation notable sur le dernier tour (anti-spam 3 tours).
function costlyTurnMessage(turn) {
  return [
    `Tour coûteux : +${fmtK(turn.delta)} tokens de contexte (sortie ~${fmtK(turn.out)}, ${turn.req} appel${turn.req > 1 ? 's' : ''}).`,
    'Cause fréquente : Read complet ou tool_result verbeux. git grep/git diff ou lecture partielle coûtent bien moins.',
  ].join('\n');
}

// Cache invalidé EN PLEIN tour (anormal) : un fichier lu par le cache a changé en session.
function bustIntraMessage(turn) {
  const b = turn.busts.filter((x) => !x.first).slice(-1)[0] || {};
  const k = fmtK(b.cacheCreation || turn.cacheCreation);
  return [
    `Cache invalidé EN PLEIN tour (~${k} tokens recréés) — anormal.`,
    'Cause probable : un fichier relu par le cache (CLAUDE.md, settings, gros fichier) modifié en cours de session ; il sera recréé à chaque tour suivant.',
  ].join('\n');
}

// Cache expiré au 1er appel du tour (pause/TTL) : normal, signalé 1×/session.
function pauseTtlMessage(turn) {
  const b = turn.busts.filter((x) => x.first)[0] || {};
  const k = fmtK(b.cacheCreation || turn.cacheCreation);
  return [
    `Cache expiré après une pause (~${k} tokens retokenisés au 1er appel du tour).`,
    "Normal après > ~5 min d'inactivité ; enchaîner les tours l'évite. (Signalé 1×/session.)",
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

// Annonce d'auto-clôture d'un lot du backlog (stop.js, systemMessage — jamais injecté).
function lotClosedMessage(lot, next, prog) {
  const lines = [`Lot « ${lot.title} » clos (${prog.done}/${prog.total}).`];
  if (next) {
    lines.push(`Suivant : « ${next.title} »${next.scope ? ` — ${String(next.scope).slice(0, 100)}` : ''}.`);
    lines.push('Nouvelle session recommandée : le handoff reprendra ce plan au démarrage.');
  } else {
    lines.push('Plan de lots terminé.');
  }
  return lines.join('\n');
}

// Réinjection minimale après compaction (SessionStart source=compact, additionalContext).
function compactResumeMessage(lot, prog, todos) {
  const lines = [`Après compaction — lot en cours : « ${lot.title} » (${prog.done}/${prog.total} faits).`];
  if (todos && todos.length) {
    lines.push('Reste à faire (TodoWrite) : ' + todos.map((t) => t.content).join(' · '));
  }
  let msg = lines.join('\n');
  if (msg.length > 300) msg = msg.slice(0, 299) + '…';
  return msg;
}

// Filet SessionStart quand aucun handoff n'est injectable mais qu'un plan de lots existe.
function backlogResumeMessage(cur, next, prog) {
  const lines = [];
  if (cur) {
    lines.push(`Plan de lots : ${prog.done}/${prog.total} faits. Lot en cours : « ${cur.title} »${cur.scope ? ` — ${String(cur.scope).slice(0, 120)}` : ''}.`);
    lines.push('Traite ce lot uniquement ; clôture par vérif ciblée + CHANGELOG + commit.');
  } else if (next) {
    lines.push(`Plan de lots : ${prog.done}/${prog.total} faits. Prochain lot : « ${next.title} »${next.scope ? ` — ${String(next.scope).slice(0, 120)}` : ''}.`);
    lines.push(`Démarre-le (node ~/.claude/promptimizer/scripts/backlog.js start --id ${next.id}) puis traite ce lot uniquement.`);
  } else {
    return null; // plan terminé/abandonné : rien à rappeler
  }
  let msg = lines.join('\n');
  if (msg.length > 400) msg = msg.slice(0, 399) + '…';
  return msg;
}

function sessionTitleMessage(title) {
  return [
    `Titre de session suggéré : « ${title} ».`,
    "Renomme la session PRÉCÉDENTE (jamais la session courante — l'outil de renommage la refuse) avec ce titre, via l'outil de renommage de session s'il est disponible dans ce contexte. N'essaie pas de renommer la session courante, ne t'interroge pas dessus : cible directement la précédente.",
    "Confirme ensuite explicitement à l'utilisateur si le renommage a réussi, ou explique pourquoi ce n'était pas possible (outil absent, session précédente introuvable, erreur…) — jamais silencieux sur ce point.",
  ].join('\n');
}

module.exports = {
  MSG_ACTIF, MSG_NON_INIT, MSG_LECTURE, MSG_CLOTURE, MSG_HANDOFF, MSG_LARGE, MSG_INIT_BEFORE_CODE,
  occupancyMessage, occupancyPromptMessage, sessionTitleMessage, autoInitMessage, lotClosedMessage,
  compactResumeMessage, backlogResumeMessage, largeWithPlanMessage,
  costlyTurnMessage, bustIntraMessage, pauseTtlMessage,
};
