'use strict';
// Helpers CLI partagés par les scripts/. Zéro dépendance.

// Récupère le répertoire de travail : --cwd <path> si fourni, sinon process.cwd().
function parseCwd() {
  const i = process.argv.indexOf('--cwd');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.cwd();
}

module.exports = { parseCwd };
