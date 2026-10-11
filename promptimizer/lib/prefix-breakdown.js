'use strict';
// Ventilation approximative du préfixe (lot #113) — décompose le plancher mesuré par
// metrics.analyzeSession() (taille du premier tour) en postes mesurables : CLAUDE.md
// (global + projet) et skills (nom + ligne `description` seule, tout ce qui charge par
// défaut). Le reste (système, définitions d'outils natifs, MCP) est groupé, jamais inventé :
// Claude Code ne journalise ni le system prompt ni les schémas d'outils envoyés à l'API —
// seule la taille totale du premier tour est observable dans le transcript. Décision actée
// avec Marwan (lot #113) : un reste groupé honnête plutôt qu'un chiffre MCP fabriqué.
// Fail-open absolu : toute erreur de lecture retombe à 0, jamais de throw.
const fs = require('fs');
const path = require('path');
const cdir = require('./claude-dir');

function readChars(file) {
  try {
    if (!fs.statSync(file).isFile()) return 0;
    return fs.readFileSync(file, 'utf8').length;
  } catch (_) {
    return 0;
  }
}

// CLAUDE.md effectivement chargés pour une session sur ce projet : global puis projet.
function claudeMdChars(root) {
  let total = readChars(path.join(cdir.claudeDir(), 'CLAUDE.md'));
  if (root) total += readChars(path.join(root, 'CLAUDE.md'));
  return total;
}

const DESCRIPTION_RE = /^description:\s*(.*)$/m;

// Nom du skill (dossier) + ligne `description` de son frontmatter — c'est la seule partie
// listée dans le prompt système par défaut ; le corps du SKILL.md ne charge qu'à l'invocation.
function skillListingChars(skillMdFile) {
  let raw;
  try {
    raw = fs.readFileSync(skillMdFile, 'utf8');
  } catch (_) {
    return 0;
  }
  const m = DESCRIPTION_RE.exec(raw);
  const name = path.basename(path.dirname(skillMdFile));
  return name.length + (m ? m[1].length : 0);
}

function listSkillMdFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i].isDirectory()) continue;
    const f = path.join(dir, entries[i].name, 'SKILL.md');
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

function skillsChars(root) {
  const dirs = [path.join(cdir.claudeDir(), 'skills')];
  if (root) dirs.push(path.join(root, '.claude', 'skills'));
  let total = 0;
  for (let i = 0; i < dirs.length; i++) {
    const files = listSkillMdFiles(dirs[i]);
    for (let j = 0; j < files.length; j++) total += skillListingChars(files[j]);
  }
  return total;
}

// `prefixTokens` : plancher mesuré par metrics.analyzeSession (session.prefix). Le reste est
// clampé à 0 : si l'estimation CLAUDE.md+skills dépasse le mesuré (ratio chars/token
// approximatif), on n'affiche jamais un poste négatif — mieux vaut un reste à 0 qu'un signe faux.
function composition(root, prefixTokens, charsPerToken) {
  const cpt = charsPerToken > 0 ? charsPerToken : 3.6;
  const claudeMdTokens = claudeMdChars(root) / cpt;
  const skillsTokens = skillsChars(root) / cpt;
  const prefix = prefixTokens > 0 ? prefixTokens : 0;
  const restTokens = Math.max(0, prefix - claudeMdTokens - skillsTokens);
  const total = claudeMdTokens + skillsTokens + restTokens;
  const share = (v) => (total > 0 ? v / total : null);
  return {
    prefixTokens: prefix,
    claudeMd: { tokens: claudeMdTokens, share: share(claudeMdTokens) },
    skills: { tokens: skillsTokens, share: share(skillsTokens) },
    rest: { tokens: restTokens, share: share(restTokens) },
  };
}

module.exports = { claudeMdChars, skillsChars, composition };
