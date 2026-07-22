'use strict';
// Socle « command optimizer » (lot #81, epic Bridge RTK) — DEFAULT OFF.
//
// Fait transiter une commande Bash JUGÉE SÛRE par un moteur de compression externe (RTK) via une
// réécriture d'input du hook PreToolUse, SANS jamais dupliquer le contrôle de sécurité PMZ : la
// classification deny/ask reste EN AMONT, sur la commande ORIGINALE (cf. hooks/pre-tool-use.js).
// Ici, aucune décision de permission — uniquement un candidat de réécriture ou l'original.
//
// Principe non négociable (epic §6.2/6.3) : toute absence / panne / timeout / réponse anormale de
// RTK laisse passer la commande ORIGINALE. Fail-open absolu, jamais d'exception propagée.
//
// Contrat CLI `rtk rewrite "<commande>"` (exit code → sémantique) :
//   0  → réécriture disponible, commande compressée sur stdout        → APPLIQUE (si non vide ≠ orig)
//   1  → aucune réécriture applicable (passthrough volontaire de rtk)  → commande inchangée
//   2  → erreur interne rtk                                            → commande inchangée (fail-open)
//   3  → commande exclue / refusée par rtk                             → commande inchangée
//   (tout autre code, timeout, binaire absent, stdout vide/identique)  → commande inchangée
// Seul exit 0 AVEC un stdout non vide ET différent de l'original produit une réécriture.
//
// « Détection hors chemin chaud » : la détection lourde (version RTK, matrice de compatibilité,
// conflit de hook) est VOLONTAIREMENT absente d'ici — reportée au doctor/status (lot #82). Sur ce
// chemin chaud on ne fait, et UNIQUEMENT sur opt-in explicite, qu'une résolution de binaire + un
// appel `rewrite`. Default OFF → sortie immédiate, zéro I/O, zéro latence ajoutée.

const { execFileSync } = require('child_process');
const { findTool } = require('./env');
const { RTK_REWRITE_MS } = require('./timeouts');
const { isBridgeEnabled } = require('./rtk-status');

// Active UNIQUEMENT sur opt-in explicite (default OFF, lot #81). `PMZ_RTK_ENABLE=1/0` en env
// reste un override ponctuel prioritaire (tests, désactivation d'un seul appel) ; en son
// absence, l'activation « normale » (lot #82, /pmz:rtk enable) est lue depuis l'état persisté
// sous PMZ_STATE_DIR — un hook Bash est un process jetable, il ne peut pas se souvenir d'un
// `enable` précédent autrement que via un fichier.
function rtkEnabled(env) {
  return isBridgeEnabled(env);
}

// Commande déjà préfixée RTK, ou explicitement désactivée pour cet appel → ne JAMAIS re-préfixer
// (spec §8 « Commandes déjà préfixées »). Évite le double préfixe et respecte l'override local.
function alreadyHandled(command) {
  return /^\s*rtk\b/.test(command) || /^\s*RTK_DISABLED=1\b/.test(command);
}

function unchanged(command, reason) {
  return {
    applied: false,
    originalCommand: command,
    rewrittenCommand: command,
    provider: 'passthrough',
    reason: reason || null,
  };
}

// Chemin chaud : réécrit une commande SÛRE via RTK si activé + présent. Jamais d'exception.
// opts : { env, cwd, timeoutMs, resolve } — `resolve(name)→chemin|null` injectable (tests).
function rewriteCommand(command, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const cmd = String(command || '');
  try {
    if (!cmd) return unchanged(cmd, 'empty');
    if (!rtkEnabled(env)) return unchanged(cmd, 'disabled'); // default OFF : sortie immédiate
    if (alreadyHandled(cmd)) return unchanged(cmd, 'already-prefixed');

    const resolve = o.resolve || findTool;
    const bin = resolve('rtk');
    if (!bin) return unchanged(cmd, 'absent');

    const timeout = o.timeoutMs || RTK_REWRITE_MS;
    let stdout;
    try {
      // Pas d'interpolation shell : la commande part en argv, jamais concaténée (spec §23).
      // Tout exit ≠ 0 (1/2/3…), timeout (SIGTERM/ETIMEDOUT) ou binaire illisible → throw → fail-open.
      stdout = execFileSync(bin, ['rewrite', cmd], {
        encoding: 'utf8',
        timeout,
        env,
        cwd: o.cwd || undefined,
        maxBuffer: 1024 * 1024,
      });
    } catch (_) {
      return unchanged(cmd, 'rtk-error');
    }

    const candidate = String(stdout || '').trim();
    if (!candidate || candidate === cmd) return unchanged(cmd, 'noop');
    return { applied: true, originalCommand: cmd, rewrittenCommand: candidate, provider: 'rtk', reason: null };
  } catch (_) {
    return unchanged(cmd, 'exception');
  }
}

module.exports = { rewriteCommand, rtkEnabled, alreadyHandled };
