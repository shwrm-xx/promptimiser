'use strict';
// Formats de sortie des hooks. Chaque fonction écrit AU PLUS un objet JSON puis exit 0.
// passThrough() est le défaut absolu : ne rien dire, ne rien bloquer.

function write(obj) {
  try {
    process.stdout.write(JSON.stringify(obj));
  } catch (_) {
    /* sérialisation impossible -> on n'écrit rien (fail-open) */
  }
}

// Injecte du texte DANS le contexte du modèle (SessionStart / UserPromptSubmit).
function injectContext(eventName, text) {
  if (text) {
    write({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
  }
  process.exit(0);
}

// Additionnel injecté APRÈS un tool (PostToolUse) : informatif, jamais bloquant —
// distinct d'injectContext pour garder le bon hookEventName (SessionStart/UserPromptSubmit
// vs PostToolUse). Jamais de permissionDecision ici : PostToolUse ne peut plus bloquer le
// tool déjà exécuté, seulement informer le tour suivant.
function postToolContext(text) {
  if (text) {
    write({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
  }
  process.exit(0);
}

// Décision de permission pour PreToolUse : 'allow' | 'ask' | 'deny'.
function preToolDecision(decision, reason) {
  write({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason || '',
    },
  });
  process.exit(0);
}

// Réécrit l'input d'un tool AVANT son exécution, SANS émettre de permissionDecision : la commande
// réécrite suit ensuite le flux d'autorisation normal (rien n'est forcé à allow/ask/deny). C'est
// le « gate » du bridge RTK (lot #81). Prérequis d'appel : la commande ORIGINALE a DÉJÀ passé le
// contrôle de sécurité PMZ en amont — ici on ne fait que substituer l'input.
function preToolUpdatedInput(updatedInput) {
  write({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } });
  process.exit(0);
}

// Remplace la sortie d'un tool DÉJÀ exécuté par une version réduite (PostToolUse, lot #84).
// La valeur DOIT matcher la shape de sortie du tool (Bash = objet {stdout,stderr,interrupted,
// isImage,…}) : un objet qui ne matche pas est IGNORÉ par Claude Code et la sortie originale est
// conservée (fail-open natif de la plateforme, cf. doc « PostToolUse decision control »). On
// construit donc toujours l'objet à partir de la réponse reçue, en ne substituant que stdout.
function postToolUpdatedOutput(updatedToolOutput) {
  write({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput } });
  process.exit(0);
}

// Message VISIBLE par l'utilisateur, NON réinjecté dans le contexte, NON bloquant.
function systemMessage(text) {
  if (text) write({ systemMessage: text });
  process.exit(0);
}

// Ne rien faire : laisse passer (allow implicite).
function passThrough() {
  process.exit(0);
}

module.exports = { write, injectContext, postToolContext, preToolDecision, preToolUpdatedInput, postToolUpdatedOutput, systemMessage, passThrough };
