'use strict';
// Moteur de mesure de session (lot #110) — analyse HORS BANDE des transcripts Claude Code.
//
// Pourquoi un moteur séparé de `occupancy.js` / `turnstats.js` : ces deux-là sont des
// capteurs TEMPS RÉEL appelés dans des hooks (lecture de la QUEUE du transcript, plafond dur,
// état incrémental). Ici on fait l'inverse : balayage COMPLET d'un ou N transcripts pour
// produire des statistiques agrégées (percentiles, régressions, décomposition du cache-read).
// Un hook ne doit jamais faire ça (coût de lecture) ; un script d'analyse doit.
//
// Ce que ça mesure, et pourquoi ces 5 indicateurs :
//   1. PRÉFIXE   — coût plancher d'un tour (système + outils + CLAUDE.md + skills + hooks).
//                  C'est ce que PMZ paie AVANT d'avoir dit quoi que ce soit.
//   2. OCCUPATION — médiane/p90/max de la taille de prompt. La cible du lot #112.
//   3. ACCRÉTION  — pente en tokens/tour : à quelle vitesse la session s'alourdit.
//   4. DÉCOMPOSITION DU CACHE-READ en 4 postes — dit OÙ part l'argent. Le contre-intuitif
//                  mesuré sur le projet SDD : la sortie de l'IA elle-même pèse ~47 %, loin
//                  devant les tool_results. Relire moins de fichiers ne suffit donc pas.
//   5. LOI D'ÉCHELLE — exposant k de `coût ∝ tours^k`. k > 1 (mesuré ~1,23) = scinder une
//                  session en deux coûte moins cher que la laisser courir.
//
// Fail-open absolu (règle du dépôt) : jamais de throw vers l'appelant, toute erreur ressort
// en `{ ok: false, reason }`. Zéro dépendance externe : `fs`, `path` seulement.
const fs = require('fs');
const path = require('path');
const cdir = require('./claude-dir');

// ============================ CONSTANTES DE MODÈLE ============================

// Ratio caractères → tokens utilisé PARTOUT dans la décomposition. Valeur calibrée sur le
// corpus SDD (131 transcripts) : le contrôle de validité somme/réel tombe à 1,05 avec 3,6.
// Ne pas « améliorer » sans refaire le contrôle : c'est ce ratio qui fait tenir le modèle.
const CHARS_PER_TOKEN = 3.6;

// Tarifs $ par million de tokens, par palier. `cacheWrite` = écriture de cache 5 minutes
// (× 1,25 du tarif input). LIMITE CONNUE ASSUMÉE : une session en TTL 1 heure paie × 2 au
// lieu de × 1,25 ; les transcripts n'exposent pas le TTL de façon fiable, donc le coût
// cache-write est un PLANCHER. Les 3 autres postes sont exacts.
const PRICES = {
  opus: { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  sonnet: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  haiku: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
};

// Taux de conversion d'AFFICHAGE $ → € — snapshot statique, à éditer ICI uniquement (même statut
// que PRICES ci-dessus). Les calculs de coût internes restent en USD partout dans ce fichier ;
// seule la couche d'affichage (dashboard.js) convertit, pour ne jamais dupliquer le taux.
const USD_TO_EUR = 0.92; // relevé 2026-07

// Palier de repli quand `message.model` est absent ou inconnu : sonnet (tarif médian).
// Facturer un modèle inconnu au tarif opus gonflerait artificiellement les vieilles sessions.
const DEFAULT_TIER = 'sonnet';

// Détection du palier par regex sur la chaîne de modèle. `fable` est tarifé comme sonnet.
// Ordre significatif : `claude-fable-5` ne contient pas « sonnet », d'où l'entrée dédiée.
const TIER_RULES = [
  [/opus/i, 'opus'],
  [/haiku/i, 'haiku'],
  [/sonnet/i, 'sonnet'],
  [/fable/i, 'sonnet'],
];

function tierForModel(model) {
  const s = String(model || '');
  for (let i = 0; i < TIER_RULES.length; i++) {
    if (TIER_RULES[i][0].test(s)) return TIER_RULES[i][1];
  }
  return DEFAULT_TIER;
}

function priceFor(tier) { return PRICES[tier] || PRICES[DEFAULT_TIER]; }

// Nombre minimal de tours pour qu'une session compte dans la régression log-log.
// Sous ~20 tours le bruit du premier tour (primage du cache) domine la pente.
const MIN_TURNS_FOR_SCALING = 20;

// Seuil d'alerte du coût marginal (lot #113) : ratio marginal/nominal à partir duquel la
// relecture future d'un token de sortie pèse plus lourd que sa production immédiate. 2 = le
// jour où continuer coûte déjà autant que recommencer devient un signal en soi, distinct de
// l'alerte zone rouge (occupancy.js) qui, elle, parle d'imminence d'auto-compact.
const MARGINAL_ALERT_RATIO = 2;

// ============================ LOCALISATION DES TRANSCRIPTS ============================

// Claude Code range les transcripts dans `<claudeDir>/projects/<slug>/<sessionId>.jsonl`,
// où <slug> est le chemin absolu du cwd avec tout caractère non alphanumérique remplacé
// par `-` (vérifié sur la machine : `/Users/x.y/Documents/GitHub/p` → `-Users-x-y-Documents-GitHub-p`).
function projectSlug(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function transcriptDir(cwd) {
  return path.join(cdir.claudeDir(), 'projects', projectSlug(cwd));
}

// Transcripts du projet, du plus récemment écrit au plus ancien. Tableau vide si le dossier
// n'existe pas (projet jamais ouvert dans Claude Code, ou CLAUDE_CONFIG_DIR déplacé).
function listTranscripts(cwd) {
  const dir = transcriptDir(cwd);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (let i = 0; i < names.length; i++) {
    if (!/\.jsonl$/.test(names[i])) continue;
    const file = path.join(dir, names[i]);
    let st;
    try {
      st = fs.statSync(file);
    } catch (_) {
      continue;
    }
    if (!st.isFile() || st.size === 0) continue;
    out.push({ file, size: st.size, mtime: st.mtimeMs, sessionId: names[i].replace(/\.jsonl$/, '') });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ============================ LECTURE LIGNE À LIGNE ============================

const CHUNK = 1024 * 1024; // 1 Mo : un transcript de 100 Mo ne doit jamais tenir en RAM d'un coup

// Parcourt le fichier ligne par ligne en O(1) mémoire (hors ligne courante), de façon
// SYNCHRONE — cohérent avec le reste du dépôt, et testable sans async. `cb` peut throw :
// l'exception remonte à l'appelant, qui la convertit en `{ ok: false }`.
function forEachLine(file, cb) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let rest = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      const text = rest + buf.toString('utf8', 0, n);
      const parts = text.split('\n');
      rest = parts.pop(); // fragment de ligne incomplète, recollé au chunk suivant
      for (let i = 0; i < parts.length; i++) {
        const line = parts[i];
        if (line) cb(line);
      }
    }
    if (rest) cb(rest);
  } finally {
    fs.closeSync(fd);
  }
}

// ============================ STATISTIQUES ============================

function median(sorted) {
  const n = sorted.length;
  if (!n) return null;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Percentile par rang le plus proche (pas d'interpolation) : sur des tailles de prompt,
// une valeur RÉELLEMENT observée est plus parlante qu'une moyenne pondérée fictive.
function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sorted[idx];
}

// Pente de la régression linéaire de y sur son index (0..n-1), en unités de y par tour.
// null sous 3 points : une pente sur 2 points n'est pas une tendance.
function slopeByIndex(ys) {
  const n = ys.length;
  if (n < 3) return null;
  const tBar = (n - 1) / 2;
  let yBar = 0;
  for (let i = 0; i < n; i++) yBar += ys[i];
  yBar /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dt = i - tBar;
    num += dt * (ys[i] - yBar);
    den += dt * dt;
  }
  if (!den) return null;
  return num / den;
}

// Régression log-log de y sur x : renvoie l'exposant k de `y ≈ a·x^k`, plus r² et n.
// Les points à x ou y non strictement positifs sont écartés (log indéfini).
function logLogFit(points) {
  const xs = [];
  const ys = [];
  for (let i = 0; i < points.length; i++) {
    const x = points[i][0];
    const y = points[i][1];
    if (!(x > 0) || !(y > 0)) continue;
    xs.push(Math.log(x));
    ys.push(Math.log(y));
  }
  const n = xs.length;
  if (n < 3) return null;
  let xBar = 0;
  let yBar = 0;
  for (let i = 0; i < n; i++) { xBar += xs[i]; yBar += ys[i]; }
  xBar /= n;
  yBar /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xBar;
    const dy = ys[i] - yBar;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!sxx) return null;
  const k = sxy / sxx;
  const r2 = syy ? (sxy * sxy) / (sxx * syy) : null;
  return { exponent: k, intercept: Math.exp(yBar - k * xBar), r2, n };
}

// ============================ COMPTAGE DES CARACTÈRES ============================

// Longueur du contenu textuel d'un bloc de message, quelle que soit sa forme.
function blockChars(block) {
  if (block == null) return 0;
  if (typeof block === 'string') return block.length;
  if (typeof block !== 'object') return 0;
  if (typeof block.text === 'string') return block.text.length;
  if (typeof block.content === 'string') return block.content.length;
  if (Array.isArray(block.content)) {
    let sum = 0;
    for (let i = 0; i < block.content.length; i++) sum += blockChars(block.content[i]);
    return sum;
  }
  // Bloc structuré sans champ texte (image, document…) : on le pèse par sa sérialisation,
  // c'est le seul proxy disponible et il reste du bon ordre de grandeur.
  try {
    return JSON.stringify(block).length;
  } catch (_) {
    return 0;
  }
}

// ============================ ANALYSE D'UNE SESSION ============================

// Balaye un transcript et renvoie les 4 premiers indicateurs pour cette session.
// `{ ok: false, reason }` si le fichier est absent, vide, ou dépourvu de ligne `usage`.
function analyzeSession(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (_) {
    return { ok: false, reason: 'no-transcript', file };
  }
  if (!st.isFile() || st.size === 0) return { ok: false, reason: 'empty-transcript', file };

  const prompts = [];        // taille de prompt de chaque requête assistant, dans l'ordre
  const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const cost = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 };
  const models = Object.create(null);
  const tiers = Object.create(null);
  let toolResultChars = 0;
  let userTextChars = 0;
  let attachmentChars = 0;
  let firstAt = null;
  let lastAt = null;
  let sidechainTurns = 0;

  try {
    forEachLine(file, (line) => {
      // Filtre bon marché avant JSON.parse : la majorité des lignes ne nous intéresse pas.
      if (line.indexOf('"type"') === -1) return;
      let e;
      try {
        e = JSON.parse(line);
      } catch (_) {
        return; // ligne tronquée (transcript en cours d'écriture) : ignorée, jamais fatale
      }
      if (!e || typeof e !== 'object') return;

      if (e.timestamp) {
        if (firstAt == null || e.timestamp < firstAt) firstAt = e.timestamp;
        if (lastAt == null || e.timestamp > lastAt) lastAt = e.timestamp;
      }

      // Les sous-agents (isSidechain) ont leur PROPRE contexte : leurs tokens ne pèsent pas
      // sur l'occupation de la session principale. On les compte à part, jamais dans les stats.
      if (e.isSidechain) {
        if (e.type === 'assistant' && e.message && e.message.usage) sidechainTurns++;
        return;
      }

      if (e.type === 'assistant' && e.message && e.message.usage) {
        const u = e.message.usage;
        const input = u.input_tokens || 0;
        const cw = u.cache_creation_input_tokens || 0;
        const cr = u.cache_read_input_tokens || 0;
        const out = u.output_tokens || 0;
        const size = input + cw + cr;
        if (size <= 0) return; // ligne d'usage dégénérée (erreur API) : pas un tour facturé
        prompts.push(size);
        totals.input += input;
        totals.cacheWrite += cw;
        totals.cacheRead += cr;
        totals.output += out;
        const model = e.message.model || null;
        const tier = tierForModel(model);
        if (model) models[model] = (models[model] || 0) + 1;
        tiers[tier] = (tiers[tier] || 0) + 1;
        const p = priceFor(tier);
        cost.input += (input / 1e6) * p.input;
        cost.cacheWrite += (cw / 1e6) * p.cacheWrite;
        cost.cacheRead += (cr / 1e6) * p.cacheRead;
        cost.output += (out / 1e6) * p.output;
        return;
      }

      // Tout ce qui entre dans le contexte SANS être de la sortie IA : résultats d'outils,
      // texte utilisateur, et attachements (c'est sous ce type que sortent les injections
      // de hook comme session-start — donc PMZ se facture lui-même ici, à juste titre).
      if (e.type === 'user' && e.message) {
        const c = e.message.content;
        if (typeof c === 'string') {
          userTextChars += c.length;
        } else if (Array.isArray(c)) {
          for (let i = 0; i < c.length; i++) {
            const b = c[i];
            if (b && b.type === 'tool_result') toolResultChars += blockChars(b);
            else userTextChars += blockChars(b);
          }
        }
        return;
      }
      if (e.type === 'attachment') {
        attachmentChars += blockChars(e.attachment != null ? e.attachment : e.content);
      }
    });
  } catch (_) {
    return { ok: false, reason: 'read-error', file };
  }

  const T = prompts.length;
  if (!T) return { ok: false, reason: 'no-usage', file };

  cost.total = cost.input + cost.cacheWrite + cost.cacheRead + cost.output;
  const sorted = prompts.slice().sort((a, b) => a - b);
  // Le préfixe est le PLANCHER observé : au premier tour le prompt ne contient que le
  // socle (système + outils + CLAUDE.md + skills + injections de hook), rien de la conversation.
  const prefix = sorted[0];

  // Décomposition du cache-read. Un token émis au tour i est relu à chaque tour suivant ;
  // sur T tours, un token « moyen » est donc relu k = (T−1)/2 fois. On applique ce k unique
  // à chaque poste : le préfixe, lui, est relu à chaque tour (donc × T, pas × k).
  const k = (T - 1) / 2;
  const bPrefix = prefix * T;
  const bOutput = totals.output * k;
  const bTools = (toolResultChars / CHARS_PER_TOKEN) * k;
  const bPrompts = ((userTextChars + attachmentChars) / CHARS_PER_TOKEN) * k;
  const bSum = bPrefix + bOutput + bTools + bPrompts;
  // Contrôle de validité : viser ≈ 1,0. Nettement > 1 = compaction en cours de session
  // (le contexte a été tronqué, donc le modèle « relu à chaque tour » surestime).
  const ratio = totals.cacheRead > 0 ? bSum / totals.cacheRead : null;
  const share = (v) => (bSum > 0 ? v / bSum : null);

  const cacheable = totals.cacheRead + totals.cacheWrite;

  return {
    ok: true,
    file,
    sessionId: path.basename(file).replace(/\.jsonl$/, ''),
    bytes: st.size,
    mtime: st.mtimeMs,
    firstAt,
    lastAt,
    turns: T,
    sidechainTurns,
    prefix,
    occupancy: {
      median: median(sorted),
      p90: percentile(sorted, 0.9),
      max: sorted[sorted.length - 1],
      min: sorted[0],
      // Dernier tour CHRONOLOGIQUE (pas le max trié) : c'est la base du coût marginal
      // (lot #113) — un token écrit MAINTENANT part de l'occupation actuelle, pas du pic.
      last: prompts[prompts.length - 1],
    },
    accretion: slopeByIndex(prompts),
    totals,
    cost,
    costPerTurn: cost.total / T,
    cacheHitRate: cacheable > 0 ? totals.cacheRead / cacheable : null,
    cacheReadBreakdown: {
      prefix: bPrefix,
      output: bOutput,
      toolResults: bTools,
      prompts: bPrompts,
      sum: bSum,
      actual: totals.cacheRead,
      ratio,
      shares: {
        prefix: share(bPrefix),
        output: share(bOutput),
        toolResults: share(bTools),
        prompts: share(bPrompts),
      },
    },
    chars: { toolResults: toolResultChars, userText: userTextChars, attachments: attachmentChars },
    models,
    tier: Object.keys(tiers).sort((a, b) => tiers[b] - tiers[a])[0] || DEFAULT_TIER,
  };
}

// ============================ COÛT MARGINAL D'UN TOKEN DE SORTIE ============================

// Un token de sortie écrit maintenant coûte son émission (tarif output) PLUS sa relecture à
// chaque tour restant de la session (tarif cache-read, bien moins cher à l'unité mais répété).
// `remainingTurns` est projeté depuis l'accrétion mesurée (pente tokens/tour, indicateur #3 de
// analyzeSession) et la borne de zone rouge du projet (occupancy.resolveRedZone) : au rythme
// observé, combien de tours avant la borne. Fail-open : sans accrétion positive ou sans borne
// connue, on retombe sur le coût plancher (émission seule, `source: 'floor'`) plutôt que
// d'inventer une projection — jamais de chiffre de relecture fantôme (même règle que la
// décomposition du cache-read plus haut).
function marginalOutputCost(opts) {
  const o = opts || {};
  const p = priceFor(o.tier);
  const floor = { perTokenUsd: p.output / 1e6, remainingTurns: null, ratio: 1, source: 'floor' };
  if (!(o.accretion > 0) || !(o.redZoneTokens > 0) || typeof o.lastOccupancy !== 'number') return floor;
  const remainingTurns = Math.max(0, (o.redZoneTokens - o.lastOccupancy) / o.accretion);
  const perTokenUsd = (p.output + p.cacheRead * remainingTurns) / 1e6;
  const ratio = floor.perTokenUsd > 0 ? perTokenUsd / floor.perTokenUsd : 1;
  return { perTokenUsd, remainingTurns, ratio, source: 'projected' };
}

// ============================ ANALYSE D'UNE FENÊTRE DE SESSIONS ============================

// Analyse les N transcripts les plus récents d'un projet et ajoute le 5e indicateur :
// la loi d'échelle `coût ∝ tours^k`, régressée sur les sessions assez longues.
// `{ ok: false }` si aucun transcript exploitable — jamais de throw.
function analyzeWindow(cwd, opts) {
  const o = opts || {};
  const limit = o.limit > 0 ? Math.floor(o.limit) : 20;
  const minTurns = o.minTurns > 0 ? Math.floor(o.minTurns) : MIN_TURNS_FOR_SCALING;
  const entries = listTranscripts(cwd).slice(0, limit);
  if (!entries.length) return { ok: false, reason: 'no-transcript', dir: transcriptDir(cwd), sessions: [] };

  const sessions = [];
  const skipped = [];
  for (let i = 0; i < entries.length; i++) {
    const r = analyzeSession(entries[i].file);
    if (r.ok) sessions.push(r);
    else skipped.push({ sessionId: entries[i].sessionId, reason: r.reason });
  }
  if (!sessions.length) return { ok: false, reason: 'no-usage', dir: transcriptDir(cwd), sessions: [], skipped };

  // Occupation de la fenêtre : médiane des médianes de session. On ne concatène PAS les
  // tailles brutes, sinon une session de 300 tours écraserait dix sessions courtes.
  const meds = sessions.map((s) => s.occupancy.median).sort((a, b) => a - b);
  const p90s = sessions.map((s) => s.occupancy.p90).sort((a, b) => a - b);
  const prefixes = sessions.map((s) => s.prefix).sort((a, b) => a - b);
  const accretions = sessions.map((s) => s.accretion).filter((v) => v != null).sort((a, b) => a - b);
  const ratios = sessions.map((s) => s.cacheReadBreakdown.ratio).filter((v) => v != null).sort((a, b) => a - b);

  const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const cost = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 };
  const breakdown = { prefix: 0, output: 0, toolResults: 0, prompts: 0 };
  let turns = 0;
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    turns += s.turns;
    totals.input += s.totals.input;
    totals.cacheWrite += s.totals.cacheWrite;
    totals.cacheRead += s.totals.cacheRead;
    totals.output += s.totals.output;
    cost.input += s.cost.input;
    cost.cacheWrite += s.cost.cacheWrite;
    cost.cacheRead += s.cost.cacheRead;
    cost.output += s.cost.output;
    breakdown.prefix += s.cacheReadBreakdown.prefix;
    breakdown.output += s.cacheReadBreakdown.output;
    breakdown.toolResults += s.cacheReadBreakdown.toolResults;
    breakdown.prompts += s.cacheReadBreakdown.prompts;
  }
  cost.total = cost.input + cost.cacheWrite + cost.cacheRead + cost.output;
  const bSum = breakdown.prefix + breakdown.output + breakdown.toolResults + breakdown.prompts;
  const shareOf = (v) => (bSum > 0 ? v / bSum : null);

  const long = sessions.filter((s) => s.turns >= minTurns);
  const scaling = logLogFit(long.map((s) => [s.turns, s.cost.total]));
  const scalingCacheRead = logLogFit(long.map((s) => [s.turns, s.totals.cacheRead]));

  return {
    ok: true,
    dir: transcriptDir(cwd),
    count: sessions.length,
    skipped,
    turns,
    prefix: { median: median(prefixes), min: prefixes[0], max: prefixes[prefixes.length - 1] },
    occupancy: {
      median: median(meds),
      p90: median(p90s),
      max: Math.max.apply(null, sessions.map((s) => s.occupancy.max)),
    },
    accretion: { median: median(accretions), n: accretions.length },
    totals,
    cost,
    cacheReadBreakdown: {
      prefix: breakdown.prefix,
      output: breakdown.output,
      toolResults: breakdown.toolResults,
      prompts: breakdown.prompts,
      sum: bSum,
      actual: totals.cacheRead,
      ratio: totals.cacheRead > 0 ? bSum / totals.cacheRead : null,
      medianRatio: median(ratios),
      shares: {
        prefix: shareOf(breakdown.prefix),
        output: shareOf(breakdown.output),
        toolResults: shareOf(breakdown.toolResults),
        prompts: shareOf(breakdown.prompts),
      },
    },
    // `minTurns` reporté explicitement : sans lui, un exposant régressé sur 3 sessions
    // se lit comme s'il valait autant qu'un régressé sur 117.
    scaling: scaling ? Object.assign({ minTurns, metric: 'cost' }, scaling) : null,
    scalingCacheRead: scalingCacheRead ? Object.assign({ minTurns, metric: 'cacheRead' }, scalingCacheRead) : null,
    sessions,
  };
}

module.exports = {
  CHARS_PER_TOKEN, PRICES, USD_TO_EUR, DEFAULT_TIER, MIN_TURNS_FOR_SCALING, MARGINAL_ALERT_RATIO,
  tierForModel, priceFor,
  projectSlug, transcriptDir, listTranscripts,
  forEachLine, median, percentile, slopeByIndex, logLogFit, blockChars,
  analyzeSession, analyzeWindow, marginalOutputCost,
};
