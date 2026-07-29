#!/usr/bin/env node
'use strict';
// CLI de l'archive à tiroirs des lots clos (.vibe-agent/archive/).
//
// UN TIROIR À LA FOIS — c'est la raison d'être de l'outil : l'archive est une mémoire
// DURABLE qui ne doit jamais s'inviter dans le contexte. `index` sort le tier 0 seul,
// `show` une fiche seule, et le brut (tier 2, des dizaines de Ko) reste derrière
// `--confirm` : sans lui on n'affiche que le chemin et la taille.
//
// Lecture : index | show | raw. Écriture : write | raw --stdin | backfill.
// Toujours exit 0 (fail-open) : une erreur d'archive ne casse jamais un flux.
const fs = require('fs');
const { gitRoot } = require('../lib/project');
const { parseCwd } = require('../lib/cli');
const archive = require('../lib/archive');

function has(name) { return process.argv.indexOf('--' + name) !== -1; }
function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
function out(s) { process.stdout.write(s + '\n'); }

function wantedId() {
  const raw = arg('id');
  const n = Number(String(raw == null ? '' : raw).replace(/^#/, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Corps d'une écriture : --stdin (pipe) ou --file <chemin>. Jamais d'argument inline :
// une fiche fait plusieurs paragraphes, la ligne de commande n'est pas le bon canal.
function readBody() {
  const f = arg('file');
  if (f) {
    try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
  }
  if (has('stdin')) {
    try { return fs.readFileSync(0, 'utf8'); } catch (_) { return null; }
  }
  return null;
}

function showIndex(root) {
  const entries = archive.readIndex(root);
  if (!entries.length) {
    out('Archive vide — aucun lot indexé. (`backfill` rétro-remplit le tier 0 depuis le plan de lots.)');
    return;
  }
  const sansFiche = entries.filter((e) => e.fiche !== 'oui').length;
  out(`Archive PMZ — ${entries.length} lot(s) clos · ${entries.length - sansFiche} avec fiche · ${sansFiche} sans fiche.`);
  out('');
  for (const e of entries) out(archive.formatEntry(e));
  out('');
  out('Fiche d\'un lot : archive.js show --id N. Ne l\'ouvre pas sans demande explicite.');
}

function showFiche(root, id) {
  const text = archive.readFiche(root, id);
  if (text) { process.stdout.write(text.endsWith('\n') ? text : text + '\n'); return; }
  const e = archive.readIndex(root).find((x) => x.id === id);
  out(e ? archive.formatEntry(e) : `Lot #${id} : absent de l'index.`);
  const info = archive.rawInfo(root, id);
  out(`Fiche jamais écrite — brut/transcript éventuels : ${info.exists ? 'archive.js raw --id ' + id : 'aucun brut local'}.`);
}

// Tier 2 : par défaut on N'AFFICHE PAS. Le brut peut peser des dizaines de Ko de contexte ;
// il ne s'ouvre que sur demande explicite (--confirm), après question à choix côté commande.
function showRaw(root, id) {
  const info = archive.rawInfo(root, id);
  if (!info.exists) { out(`Aucun brut pour le lot #${id} (tier 2 local, non versionné).`); return; }
  if (!has('confirm')) {
    out(`${info.file} — ${info.bytes} octets. Relance avec --confirm pour l'afficher.`);
    return;
  }
  const text = archive.readRaw(root, id);
  if (text == null) { out(`Brut du lot #${id} illisible.`); return; }
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function main() {
  const cmd = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'index';
  const root = gitRoot(parseCwd());
  if (!root) { out('Pas un dépôt git : aucune archive.'); return; }

  if (cmd === 'index') { showIndex(root); return; }

  if (cmd === 'show') {
    const id = wantedId();
    if (id == null) { out('Usage : archive.js show --id N.'); return; }
    showFiche(root, id);
    return;
  }

  if (cmd === 'raw') {
    const id = wantedId();
    if (id == null) { out('Usage : archive.js raw --id N [--confirm] | raw --id N --stdin.'); return; }
    if (has('stdin') || arg('file')) { // intention d'écriture explicite → tier 2 en écriture
      const r = archive.writeRaw(root, id, readBody());
      out(r.ok ? `Brut du lot #${id} écrit : ${r.file} (${r.bytes} octets, non versionné).`
        : `Brut du lot #${id} non écrit (corps vide ou écriture impossible).`);
      return;
    }
    showRaw(root, id);
    return;
  }

  if (cmd === 'write') {
    const id = wantedId();
    if (id == null) { out('Usage : archive.js write --id N --stdin | --file <chemin> [--force].'); return; }
    const body = readBody();
    if (body == null || !body.trim()) { out('Fiche vide : rien écrit. Passe le corps via --stdin ou --file <chemin>.'); return; }
    const r = archive.writeFiche(root, id, body, { force: has('force') });
    if (r.ok) { out(`Fiche du lot #${id} écrite : ${r.file} (${r.chars} caractères, stagée · index → fiche:oui).`); return; }
    if (r.action === 'exists') { out(`Fiche du lot #${id} déjà écrite (immuable) : ${r.file}. Relance avec --force pour la remplacer.`); return; }
    if (r.action === 'no-marker') { out(`Fiche du lot #${id} refusée : marqueur « ${archive.ficheMarker(id)} » absent de la 1re ligne.`); return; }
    if (r.action === 'too-long') { out(`Fiche du lot #${id} refusée : ${r.chars} caractères > ${archive.MAX_FICHE_CHARS} (borne dure). Distille — jamais de diff ni de listing de code.`); return; }
    out(`Fiche du lot #${id} non écrite (erreur d'écriture) — rien de changé.`);
    return;
  }

  if (cmd === 'backfill') {
    const dryRun = has('dry-run');
    const r = archive.backfill(root, { dryRun });
    if (!r.ok) { out('Backfill impossible (archive non écrite) — rien de changé.'); return; }
    const verbe = dryRun ? 'à ajouter' : 'ajoutée(s)';
    out(`Backfill tier 0 — ${r.total} lot(s) clos · ${r.added.length} ligne(s) ${verbe} · ${r.skipped} déjà indexé(s).`);
    for (const e of r.added) out('  ' + archive.formatEntry(e));
    if (dryRun) out('(--dry-run : rien écrit. Relance sans --dry-run pour appliquer.)');
    else if (r.added.length) out(`Index : ${archive.indexFile(root)} (stagé).`);
    return;
  }

  out('Commande inconnue : ' + cmd + '. Commandes : index | show --id N | raw --id N [--confirm] | write --id N --stdin [--force] | backfill [--dry-run].');
}

if (require.main === module) {
  try { main(); } catch (_) { /* fail-open */ }
  process.exit(0);
}
