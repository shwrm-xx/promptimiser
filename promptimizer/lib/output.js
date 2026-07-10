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

// Message VISIBLE par l'utilisateur, NON réinjecté dans le contexte, NON bloquant.
function systemMessage(text) {
  if (text) write({ systemMessage: text });
  process.exit(0);
}

// Ne rien faire : laisse passer (allow implicite).
function passThrough() {
  process.exit(0);
}

module.exports = { write, injectContext, postToolContext, preToolDecision, systemMessage, passThrough };
