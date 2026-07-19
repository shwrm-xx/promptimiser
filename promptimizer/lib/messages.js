'use strict';
// Messages injectés par les hooks. Courts, conformes à la spec mwn/ (rg -> git grep).
const { BUCKETS, FLOATING_STEP } = require('./occupancy');
const { COST_BUDGET_TOKENS, modelEffortTag } = require('./backlog');
const { hintResolvableClaude } = require('./modelwatch');
const { SEV, withSeverity } = require('./severity');

const MSG_ACTIF = [
  'Promptimizer actif.',
  'Priorité : réduire les relectures de contexte.',
  'Utilise git grep/git diff avant Read complet.',
  'Lot terminé : propose la clôture via une question à choix (OK / Non), jamais en texte',
  'libre ; sur OK, déroule /close-batch (vérif ciblée + changelog + commit + handoff court).',
].join('\n');

// Variante SessionStart pour projet déjà augmenté : les règles PMZ vivent déjà dans le
// bloc « pmz:rules » du CLAUDE.md (chargé à chaque session) — inutile de les répéter.
// On ne garde que le protocole de clôture, qui n'est PAS dans pmz-rules.md.
const MSG_ACTIF_SLIM = [
  'Promptimizer actif. Règles : bloc « pmz:rules » du CLAUDE.md (ne pas les répéter).',
  'Lot terminé : propose la clôture via une question à choix (OK / Non), jamais en texte',
  'libre ; sur OK, déroule /close-batch (vérif ciblée + changelog + commit + handoff court).',
].join('\n');

const MSG_NON_INIT = [
  'Projet non initialisé détecté.',
  'Promptimizer peut créer un socle prudent (CLAUDE.md, AGENTS.md, CHANGELOG.md, .vibe-agent/).',
  "Propose à l'utilisateur de lancer /init (ou le bootstrap) et ne crée rien qu'APRÈS sa confirmation.",
  'Avant de coder : finaliser CLAUDE.md/AGENTS.md avec lecture minimale, puis proposer un premier lot court.',
].join('\n');

// MSG_LECTURE / MSG_CLOTURE sont des nudges VISIBLES (systemMessage stop.js, toast OpenCode) :
// ils portent le glyphe de sévérité (grammaire lib/severity.js). Les constantes ci-dessus
// (MSG_ACTIF…MSG_INIT_BEFORE_CODE) sont au contraire INJECTÉES (additionalContext) — des
// instructions, pas des alertes — et restent volontairement sans glyphe.
const MSG_LECTURE = withSeverity(SEV.WARN, [
  'Lecture potentiellement coûteuse.',
  'Ce fichier semble déjà connu ou non modifié.',
  'Préférer git grep, git diff ou lecture partielle sauf besoin exact.',
]);

const MSG_CLOTURE = withSeverity(SEV.WARN, [
  'Lot modifié sans clôture complète.',
  'Propose la clôture via une question à choix (OK / Non) — pas en texte libre ; sur OK,',
  'lance /close-batch pour la checklist et l\'audit complets (vérif ciblée, CHANGELOG, commit, handoff).',
]);

const MSG_HANDOFF = [
  'Handoff de la session précédente (.vibe-agent/handoff.md) — prends-le comme point de départ.',
  "Ne relis pas les fichiers qu'il liste sauf changement (git diff/git grep d'abord).",
].join('\n');

const MSG_LARGE = [
  'Demande potentiellement large.',
  'Propose un découpage en 2 à 5 lots (1 lot = 1 commit livrable), fais-le valider, puis',
  'persiste-le : /scope, ou node ~/.claude/promptimizer/scripts/backlog.js add --title "…" --scope "fait quand : …" (puis start --id N).',
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

// Argument CHIFFRÉ anti-compaction, partagé par occupancyMessage (palier 300k) et le
// hook pre-compact. Compacter fait relire tout le transcript au résumeur : ≈ l'occupation
// courante réécrite en cache-write (×1,25) PUIS un résumé lossy ; clôturer + repartir d'un
// handoff coûte ~8k sans perte. Aucun prix codé en dur (on raisonne en tokens, pas en €) ;
// TTL formulé prudemment (dépend du plan : clé API vs abonnement).
function compactionCostLines(occ) {
  const write = Math.round((occ * 1.25) / 1000);
  return [
    `Compacter ≈ faire relire tout le transcript au résumeur : réécriture de l'occupation en cache-write (×1,25 ≈ ${write}k tokens) + un résumé lossy.`,
    "Clôturer puis repartir d'un handoff ≈ ~8k tokens, sans perte. Le cache expire de toute façon après ~5 min (clé API) / ~1 h (abonnement) : inutile de compacter pour « garder » le contexte.",
  ];
}

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
  const lines = [
    `Contexte ≈ ${k}k tokens (${repere}).`,
    'Pense à : git diff/git grep plutôt que relire.',
    "Lot fini → lance /close-batch. Sinon → /fresh-session après un commit intermédiaire pour repartir au plancher.",
  ];
  // À partir du palier 300k (bucket ≥ 2), ajoute l'argument chiffré : compacter coûte
  // plus cher qu'une clôture + session fraîche. Ces messages sont VISIBLES (systemMessage),
  // pas réinjectés dans le contexte — donc ce détail n'ajoute aucun coût de cache.
  if (bucket >= 2) lines.push(...compactionCostLines(occ));
  return withSeverity(SEV.WARN, lines);
}

// Message VISIBLE émis par pre-compact sur une compaction MANUELLE (/compact) : rappelle
// en chiffres qu'une clôture + session fraîche coûte moins qu'une compaction. Informatif,
// jamais bloquant (il est déjà trop tard pour empêcher la compaction en cours).
function compactionNudgeMessage(occ) {
  const lines = ['Compaction manuelle demandée.'];
  if (occ != null && occ > 0) lines.push(...compactionCostLines(occ));
  lines.push(
    "Alternative la prochaine fois : /close-batch (lot fini) ou commit intermédiaire + /fresh-session — repart d'un handoff sans résumé lossy.",
  );
  return withSeverity(SEV.WARN, lines);
}

// Nudge occupation HAUTE injecté dans UserPromptSubmit (coûte du contexte) — donc
// volontairement court (2 lignes) et plafonné 1×/palier par l'appelant. INJECTÉ (additionalContext,
// pas systemMessage) : hors grammaire de sévérité (pas de glyphe — c'est un coût de contexte, pas
// une alerte visible), à la différence de occupancyMessage ci-dessus.
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

// Ligne UNIQUE de la statusline (lot #45, opt-in) : version PMZ + epic/lot + occupation
// temps réel. Pure et testable — aucun accès disque/stdin. L'assemblage saute toute partie
// absente (jamais de séparateur orphelin « ·  · »). Toujours au moins « PMZ ».
function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function statusLineText(info) {
  const i = info || {};
  const parts = ['PMZ' + (i.version ? ` v${i.version}` : '')];
  if (i.epic) parts.push(clip(i.epic, 24));
  if (i.lot) {
    let s = `lot #${i.lot.id}`;
    if (i.lot.title) s += ` ${clip(i.lot.title, 24)}`;
    parts.push(s);
  }
  if (Number.isFinite(i.done) && Number.isFinite(i.total) && i.total > 0) {
    parts.push(`${i.done}/${i.total}`);
  }
  if (Number.isFinite(i.occ) && i.occ > 0) parts.push(`ctx ${fmtK(i.occ)}`);
  return parts.join(' · ');
}

// Tour coûteux : +delta d'occupation notable sur le dernier tour (anti-spam 3 tours).
function costlyTurnMessage(turn) {
  return withSeverity(SEV.WARN, [
    `Tour coûteux : +${fmtK(turn.delta)} tokens de contexte (sortie ~${fmtK(turn.out)}, ${turn.req} appel${turn.req > 1 ? 's' : ''}).`,
    'Cause fréquente : Read complet ou tool_result verbeux. git grep/git diff ou lecture partielle coûtent bien moins.',
  ]);
}

// Dérive de session (#62) : sur une fenêtre de tours, le coût de contexte grimpe ET
// le cache rend moins -> prescrit la clôture plutôt que de continuer à payer l'accumulé.
function pct(x) { return `${Math.round((x || 0) * 100)}%`; }
function driftMessage(drift) {
  return withSeverity(SEV.WARN, [
    `Dérive de session sur ${drift.turns} tours : le coût de contexte monte (~${fmtK(drift.avgDeltaOld)} → ~${fmtK(drift.avgDeltaNew)}/tour) pendant que le cache rend moins (${pct(drift.avgHitOld)} → ${pct(drift.avgHitNew)}).`,
    'Signe qu\'il vaut mieux clôturer le lot et repartir sur une session fraîche que continuer à payer le contexte accumulé (/close-batch puis /fresh-session).',
  ]);
}

// Cache invalidé EN PLEIN tour (anormal) : un fichier lu par le cache a changé en session.
function bustIntraMessage(turn) {
  const b = turn.busts.filter((x) => !x.first).slice(-1)[0] || {};
  const k = fmtK(b.cacheCreation || turn.cacheCreation);
  return withSeverity(SEV.ALERT, [
    `Cache invalidé EN PLEIN tour (~${k} tokens recréés) — anormal.`,
    'Cause probable : un fichier relu par le cache (CLAUDE.md, settings, gros fichier) modifié en cours de session ; il sera recréé à chaque tour suivant.',
  ]);
}

// Cache expiré au 1er appel du tour (pause/TTL) : normal, signalé 1×/session.
function pauseTtlMessage(turn) {
  const b = turn.busts.filter((x) => x.first)[0] || {};
  const k = fmtK(b.cacheCreation || turn.cacheCreation);
  return withSeverity(SEV.INFO, [
    `Cache expiré après une pause (~${k} tokens retokenisés au 1er appel du tour).`,
    "Normal après > ~5 min d'inactivité ; enchaîner les tours l'évite. (Signalé 1×/session.)",
  ]);
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
  return withSeverity(SEV.INFO, lines);
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
// Transitions de lot (lot #55) : on pousse le tag modèle/effort, une suggestion /model si le
// modèle préconisé est un Claude joignable, et un rappel « pose une verify » si le lot n'en a
// pas (sinon il se clôturera « sans preuve »). Ordre = par priorité DÉCROISSANTE : les nudges
// secondaires (/model surtout, déjà couvert par le tag) passent EN DERNIER pour être rognés en
// premier par le cap 400c — l'identité du lot et l'instruction cœur survivent toujours.
function backlogResumeMessage(cur, next, prog) {
  const lines = [];
  if (cur) {
    lines.push(`Plan de lots : ${prog.done}/${prog.total} faits. Lot en cours : « ${String(cur.title).slice(0, 60)} »${modelEffortTag(cur)}${cur.scope ? ` — ${String(cur.scope).slice(0, 100)}` : ''}.`);
    lines.push('Traite ce lot uniquement ; clôture par vérif ciblée + CHANGELOG + commit.');
    if (!cur.verify) {
      lines.push('Ce lot n\'a pas de commande verify — sans elle, « clos sans preuve » à la clôture (pose-en une : backlog.js verify --set).');
    }
    if (hintResolvableClaude(cur.model_hint)) {
      lines.push('Modèle préconisé ci-dessus : bascule via /model avant d\'attaquer si besoin.');
    }
  } else if (next) {
    lines.push(`Plan de lots : ${prog.done}/${prog.total} faits. Prochain lot : « ${String(next.title).slice(0, 60)} »${modelEffortTag(next)}${next.scope ? ` — ${String(next.scope).slice(0, 100)}` : ''}.`);
    lines.push(`Démarre-le (node ~/.claude/promptimizer/scripts/backlog.js start --id ${next.id}) puis traite ce lot uniquement.`);
    if (hintResolvableClaude(next.model_hint)) {
      lines.push('Modèle préconisé ci-dessus : bascule via /model avant de démarrer si besoin.');
    }
  } else {
    return null; // plan terminé/abandonné : rien à rappeler
  }
  let msg = lines.join('\n');
  if (msg.length > 400) msg = msg.slice(0, 399) + '…';
  return msg;
}

// Protocole de renommage compressé (~400 o max). NE PAS casser : proposition en clair +
// question à choix IMMÉDIATE (tout début du 1er tour, avant la demande — retour utilisateur
// 2026-07-12 : un renommage proposé en fin de tour ou sans dialogue = jamais traité),
// renommage de la session PRÉCÉDENTE (jamais la courante), accusé de résultat explicite.
function sessionTitleMessage(title) {
  return [
    `Titre suggéré (session PRÉCÉDENTE) : « ${title} ».`,
    'AVANT la demande, tout début du 1er tour : titre en clair + question à choix IMMÉDIATE',
    '(valider / autre nom / non) — jamais en fin de tour.',
    'Sur accord : renomme la session PRÉCÉDENTE (jamais la courante).',
    'Confirme le résultat (réussi / échec + raison), jamais muet.',
  ].join('\n');
}

// Coût réel par lot (lot #43) : le lot en cours a cumulé ~costTokens tokens de SORTIE, en
// approche (>= COST_WARN) ou au-delà (>= COST_BUDGET) du budget ~300k/lot. Message VISIBLE
// (systemMessage stop.js — jamais réinjecté), plafonné 1×/lot·session par l'appelant.
function lotCostMessage(lot, costTokens) {
  const over = (costTokens || 0) >= COST_BUDGET_TOKENS;
  const budgetK = Math.round(COST_BUDGET_TOKENS / 1000);
  return withSeverity(over ? SEV.ALERT : SEV.WARN, [
    `Lot « ${lot.title} » : ~${fmtK(costTokens)} tokens de sortie cumulés — ${over ? `au-delà du budget ~${budgetK}k/lot` : `en approche du budget ~${budgetK}k/lot`}.`,
    'Un lot devenu gros gagne à être redécoupé (un sous-lot livrable + commit intermédiaire, puis /fresh-session) plutôt qu\'étiré.',
  ]);
}

// Preuve de clôture à l'AUTO-clôture (lot #44, étendu #55) : à l'instant où le tree redevient
// propre et que le lot univoque est marqué fait, on rend VISIBLE (systemMessage stop.js, jamais
// réinjecté) (a) le résultat du verify du lot s'il en a un — jamais bloquant, une non-terminaison
// dans le délai court n'est PAS un échec ; (b) un rappel doux si le commit de clôture ne touche pas
// CHANGELOG.md ; (c) si le lot n'avait AUCUNE commande verify (noVerify), un « clos sans preuve »
// doux invitant à en poser une au prochain lot. Renvoie null si rien à dire.
function closureProofMessage(verify, changelogMissing, noVerify) {
  const lines = [];
  let sev = SEV.INFO;
  if (verify && verify.cmd) {
    if (verify.ok) {
      lines.push(`Verify du lot (\`${verify.cmd}\`) : OK.`);
      // reste INFO : preuve verte.
    } else if (verify.timedOut) {
      lines.push(`Verify du lot (\`${verify.cmd}\`) : non terminée dans le délai court de l'auto-clôture — relance-la via /close-batch pour la preuve complète.`);
      sev = SEV.WARN;
    } else {
      lines.push(`Verify du lot (\`${verify.cmd}\`) : ÉCHEC (clôture non bloquée) — à corriger avant d'enchaîner :\n  ${verify.tail}`);
      sev = SEV.ALERT;
    }
  } else if (noVerify) {
    lines.push('Clos sans preuve : ce lot n\'avait pas de commande verify. Au prochain /scope, ajoute `--verify "…"` (si le lot est vérifiable par commande) pour une clôture prouvée.');
    sev = SEV.WARN;
  }
  if (changelogMissing) {
    lines.push('Rappel doux : le commit de clôture ne touche pas CHANGELOG.md — un lot de retours = une entrée datée au CHANGELOG.');
    if (sev === SEV.INFO) sev = SEV.WARN;
  }
  return lines.length ? withSeverity(sev, lines) : null;
}

// Palier de gaspillage franchi (lot #52) : gaspillage de relecture cumulé (relectures
// COMPLÈTES de fichiers INCHANGÉS) au-dessus d'un nouveau palier. Message VISIBLE
// (systemMessage stop.js — jamais réinjecté), 1×/palier trans-session (borné par le
// waste_bucket persisté). Cite le top-3 des fichiers coupables.
function wasteBucketMessage(waste, topFiles) {
  const lines = [
    `Gaspillage de relecture ≈ ${fmtK(waste)} tokens cumulés (relectures complètes de fichiers inchangés).`,
  ];
  if (topFiles && topFiles.length) {
    lines.push('Principaux coupables : ' + topFiles.map((f) => `${f.path} (~${fmtK(f.waste)})`).join(', ') + '.');
  }
  lines.push('Avant de rouvrir un fichier déjà lu : git diff/git grep, ou lecture partielle (offset/limit).');
  return withSeverity(SEV.WARN, lines);
}

// Nudge subagent (lot #52) : à haute occupation avec beaucoup de lectures, l'exploration
// gagne à être déléguée à un subagent (seul le résultat synthétique remonte dans ce
// contexte). Message VISIBLE (systemMessage stop.js — jamais réinjecté), 1×/session.
function subagentNudgeMessage(occ, mix) {
  const k = Math.round(occ / 1000);
  return withSeverity(SEV.INFO, [
    `Contexte ≈ ${k}k tokens et beaucoup de lectures ce tour (${mix.fullReads}/${mix.reads} Read complets).`,
    "À cette occupation, délègue l'exploration à un subagent (outil Agent/Task) : le gros des lectures reste HORS de ce contexte, seul le résultat synthétique y revient.",
  ]);
}

// Hygiène de lecture de la session (nudge VISIBLE stop.js) : part des Read complets. Advisory,
// donc INFO. Extrait ici (jadis inline dans stop.js) pour passer par la grammaire de sévérité.
function readHygieneMessage(mix) {
  return withSeverity(SEV.INFO, [
    `Cette session : ${mix.fullReads}/${mix.reads} lectures étaient des Read complets (sans offset/limit).`,
    'Grep/git diff en amont sur les gros fichiers réduirait le coût des prochaines relectures.',
  ]);
}

// Relectures évitables du lot courant (nudge VISIBLE stop.js) : réutilise le corps de MSG_LECTURE
// (déjà glyphé WARN) et lui adjoint la liste des fichiers relus. Extrait ici (jadis inline) pour
// que le nudge porte la même grammaire que les autres.
function avoidableRereadsMessage(rereads) {
  return MSG_LECTURE + '\nRelectures évitables ce lot : ' + rereads.join(', ') + '.';
}

// Durée approximative jours/heures (bilan d'epic) — pas de dépendance date-fns, juste ce
// qu'il faut pour un ordre de grandeur lisible.
function fmtDurationApprox(ms) {
  const h = ms / 3600000;
  if (h < 1) return '< 1 h';
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} j`;
}

// Bilan d'epic (lot #58) : émis UNE fois, à la clôture du DERNIER lot d'une epic (cf.
// backlog.epicBilan) — chiffres déjà persistés par lot (cost_tokens #43, started_at/closed_at),
// aucun recalcul depuis le transcript. Nudge VISIBLE (systemMessage stop.js / toast OpenCode)
// donc passe par la grammaire de sévérité et l'arbitre de tour (#57) comme les autres.
function epicBilanMessage(bilan) {
  const lines = [
    `Epic « ${bilan.epic} » terminée : ${bilan.count} lot(s), ${fmtK(bilan.totalCost)} tokens`
    + ` (≈ ${fmtK(bilan.avgCost)}/lot)${bilan.durationMs != null ? `, ${fmtDurationApprox(bilan.durationMs)}` : ''}.`,
  ];
  return withSeverity(SEV.INFO, lines);
}

// Carte de clôture (lot #59) : mini-récap chiffré émis à CHAQUE auto-clôture de lot —
// contrairement à lotCostMessage (seuil ~300k) et epicBilanMessage (dernier lot d'une epic
// seulement), celui-ci sort systématiquement. Coût réel (cost_tokens déjà persisté, #43),
// durée (started_at -> closed_at, même logique que epicBilan), relectures évitées grâce à
// l'hygiène de lecture (read-ledger.avoid_reread_notes — fichiers qu'une relecture aurait
// re-coûté). Nudge VISIBLE (systemMessage stop.js), passe par l'arbitre de tour (#57).
function lotClosureCardMessage(lot, rereadsAvoided) {
  const cost = Number.isFinite(lot.cost_tokens) ? lot.cost_tokens : 0;
  const durationMs = (lot.started_at && lot.closed_at)
    ? new Date(lot.closed_at).getTime() - new Date(lot.started_at).getTime()
    : null;
  const bits = [`~${fmtK(cost)} tokens`];
  if (Number.isFinite(durationMs) && durationMs >= 0) bits.push(fmtDurationApprox(durationMs));
  bits.push(`${rereadsAvoided || 0} relecture(s) évitée(s)`);
  return withSeverity(SEV.INFO, [`Carte de clôture — lot « ${lot.title} » : ${bits.join(', ')}.`]);
}

// Vigie modèle réel vs préconisé (lot #42) : le modèle qui répond ce tour ne correspond pas
// au model_hint du lot en cours. INJECTÉ (additionalContext user-prompt-submit) 1×/session :
// hors grammaire de sévérité (pas de glyphe — coût de contexte, pas alerte visible).
function modelMismatchMessage(lot, actualModel) {
  return [
    `Modèle réel (${actualModel}) ≠ modèle préconisé pour le lot en cours (« ${lot.title} » : ${lot.model_hint}).`,
    `Bascule via /model si le lot le demande, ou ignore si le changement est volontaire.`,
  ].join('\n');
}

module.exports = {
  MSG_ACTIF, MSG_ACTIF_SLIM, MSG_NON_INIT, MSG_LECTURE, MSG_CLOTURE, MSG_HANDOFF, MSG_LARGE, MSG_INIT_BEFORE_CODE,
  occupancyMessage, occupancyPromptMessage, compactionNudgeMessage, sessionTitleMessage, autoInitMessage, lotClosedMessage,
  compactResumeMessage, backlogResumeMessage, largeWithPlanMessage,
  costlyTurnMessage, driftMessage, bustIntraMessage, pauseTtlMessage, modelMismatchMessage, lotCostMessage, closureProofMessage,
  wasteBucketMessage, subagentNudgeMessage, readHygieneMessage, avoidableRereadsMessage,
  epicBilanMessage, lotClosureCardMessage,
  fmtK, statusLineText,
};
