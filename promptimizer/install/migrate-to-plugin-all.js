#!/usr/bin/env node
/**
 * Enchaîne la migration complète du canal manuel vers le plugin Claude Code :
 * 1. Assemble le plugin depuis la source
 * 2. Retire les hooks legacy du canal manuel
 * 3. Installe le plugin via marketplace locale
 *
 * Usage : node migrate-to-plugin-all.js
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const INSTALL_ROOT = path.dirname(__filename);
const REPO_ROOT = path.dirname(path.dirname(INSTALL_ROOT));
const DIST_MARKETPLACE = path.join(REPO_ROOT, 'dist', 'marketplace');

function log(msg) {
  console.log(`[migrate-all] ${msg}`);
}

function logStep(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📦 ${title}`);
  console.log('='.repeat(60));
}

function run(cmd, opts = {}) {
  log(`  $ ${cmd}`);
  try {
    const result = execSync(cmd, { stdio: 'inherit', ...opts });
    return result;
  } catch (e) {
    console.error(`\n❌ Erreur : ${e.message}`);
    process.exit(1);
  }
}

function main() {
  logStep('Étape 1 : Assembler le plugin');
  run(`node "${path.join(INSTALL_ROOT, 'build-plugin.js')}"`);

  if (!fs.existsSync(DIST_MARKETPLACE)) {
    console.error(`\n❌ Erreur : ${DIST_MARKETPLACE} non créé`);
    process.exit(1);
  }

  log(`✅ Plugin assemblé dans ${DIST_MARKETPLACE}`);

  logStep('Étape 2 : Retirer les hooks legacy du canal manuel');
  run(`node "${path.join(INSTALL_ROOT, 'migrate-to-plugin.js')}"`);
  log(`✅ Hooks PMZ retirés de ~/.claude/settings.json`);

  logStep('Étape 3 : Enregistrer la marketplace locale');
  const marketplaceCmd = `claude plugin marketplace add "${DIST_MARKETPLACE}"`;
  run(marketplaceCmd);
  log(`✅ Marketplace locale enregistrée`);

  logStep('Étape 4 : Installer le plugin');
  run(`claude plugin install pmz@pmz-local`);
  log(`✅ Plugin Promptimizer installé`);

  logStep('Vérification finale');
  run(`claude plugin details pmz`);

  console.log(`
✅ Migration réussie !

Résumé des changements :
  • Hooks legacy retirés du canal manuel
  • Plugin Claude Code natif installé
  • Marketplace locale prête pour partage à d'autres postes

Prochaines étapes (optionnelles) :
  • Nettoyer les fichiers legacy : node migrate-to-plugin.js --purge
  • Vérifier la santé globale : pmz-doctor.command / .sh / .ps1
  • Distribuer le plugin à d'autres (dossier dist/marketplace/ ou git interne)
  `);
}

main();
