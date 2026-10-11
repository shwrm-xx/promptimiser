'use strict';
// Classification pure d'une commande Bash : deny (catastrophique) / ask (destructif) / null
// (rien à signaler). Partagée entre le hook Claude Code (pre-tool-use.js) et le plugin
// OpenCode (opencode/plugin/impl/index.js) — aucune I/O ici, juste des regex sur la chaîne.

// --- Détection rm robuste, mais SEULEMENT en position de commande ---
// On ne déclenche pas sur le mot « rm » en prose (ex. message de commit, echo "...rm...").
// rm doit être en tête de segment (début, ou après ; & | ( ` ), éventuellement précédé de
// sudo/xargs. On n'inspecte que les arguments de CETTE invocation (jusqu'au prochain séparateur).
const RM_INV = /(?:^|[\n;&|(`])[ \t]*(?:sudo[ \t]+)?(?:xargs[ \t]+(?:-[^\s]+[ \t]+)*)?rm\b([^\n;&|()`]*)/g;
function rmInvocations(cmd) {
  const invs = [];
  RM_INV.lastIndex = 0;
  let m;
  while ((m = RM_INV.exec(cmd))) invs.push(m[1] || '');
  return invs;
}
// Flags séparés ou groupés, ordre indifférent : -rf, -fr, -r -f, -R, --recursive.
function isRecursive(args) {
  return /(^|\s)-[a-zA-Z]*r/i.test(args) || /\s--recursive\b/.test(args);
}
// Cible catastrophique = racine / home « nus » (pas un sous-dossier : ~/x reste destructif).
const ROOT_TARGET = /^["']?(\/|\/\*|~\/?|\$\{?HOME\}?\/?)["']?$/;
function rmTargets(args) {
  return args.split(/\s+/).filter((a) => a && !a.startsWith('-'));
}
function isCatastrophicRm(cmd) {
  return rmInvocations(cmd).some((args) => isRecursive(args) && rmTargets(args).some((t) => ROOT_TARGET.test(t)));
}
function isDestructiveRm(cmd) {
  return rmInvocations(cmd).some((args) => isRecursive(args)); // rm récursif non catastrophique -> ask
}

// Catastrophique -> deny (conservateur : on ne bloque que le clairement irréversible/système).
const CATASTROPHIC = [
  /\bmkfs\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;\s*:/,            // fork bomb
  />\s*\/dev\/(disk|rdisk|sd)[0-9a-z]/i,                     // écriture brute sur un disque (sd*, macOS disk/rdisk)
  /\bchmod\s+-R\s+0?777\s+\//,
];

// Destructif -> ask (confirmation utilisateur).
const DESTRUCTIVE = [
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*[df][a-z]*\b/,
  // push --force / -f, mais on laisse passer la variante sûre --force-with-lease.
  /\bgit\s+push\b[^\n]*(--force(?!-with-lease)\b|\s-f(\s|$))/,
  /\bgit\s+checkout\s+(--\s+)?\.(?:\s|$)/,
  /\bgit\s+branch\s+-D\b/,
  /\bchmod\s+-R\b/,
  // truncate en tête de commande suivi d'un flag (évite « grep truncate », « npm run truncate-x »).
  /(?:^|[\n;&|]\s*|\bsudo\s+|\bxargs\s+)truncate\s+-/,
  // exécution de code distant : curl/wget (en tête de commande) piped vers un interpréteur.
  /(?:^|[\n;&|(`])[ \t]*(?:sudo[ \t]+)?(?:curl|wget)\b[^\n|]*\|[ \t]*(?:sudo[ \t]+)?(?:sh|bash|zsh|python3?|perl|ruby|node)\b/,
  // find (en tête de commande) avec suppression de masse
  /(?:^|[\n;&|(`])[ \t]*(?:sudo[ \t]+)?find\b[^\n;&|()`]*\s-delete\b/,
  // xargs (en tête, typiquement après un pipe) invoquant rm
  /(?:^|[\n;&|(`])[ \t]*(?:sudo[ \t]+)?xargs\b[^\n;&|()`]*\brm\b/,
  />\s*\/(etc|usr|bin|sbin|boot|System|Library)\//,           // écrasement de fichier système
  /\bmv\b[^\n]+\s\/dev\/null(\s|$)/,                          // mv vers /dev/null = perte de données
];

// -> 'deny' | 'ask' | null
function classify(cmd) {
  if (!cmd) return null;
  if (isCatastrophicRm(cmd)) return 'deny';
  for (const re of CATASTROPHIC) if (re.test(cmd)) return 'deny';
  if (isDestructiveRm(cmd)) return 'ask';
  for (const re of DESTRUCTIVE) if (re.test(cmd)) return 'ask';
  return null;
}

module.exports = { classify };
