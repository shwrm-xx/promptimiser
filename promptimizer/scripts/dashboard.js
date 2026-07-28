#!/usr/bin/env node
'use strict';
// Tableau de bord d'économie de contexte (lot #114) — rend en HTML autonome les 5 indicateurs
// du moteur de mesure (lot #110) pour le projet courant, plus 3 recommandations chiffrées.
//
//   node promptimizer/scripts/dashboard.js                  → .vibe-agent/dashboard.html
//   node promptimizer/scripts/dashboard.js --sessions 40    → fenêtre de 40 sessions
//   node promptimizer/scripts/dashboard.js --all            → toutes les sessions du projet
//   node promptimizer/scripts/dashboard.js --out <path>     → autre destination
//   node promptimizer/scripts/dashboard.js --stdout         → HTML sur la sortie standard
//   node promptimizer/scripts/dashboard.js --json           → résumé machine (pas de HTML)
//   node promptimizer/scripts/dashboard.js --cwd <p> --min-turns 20 --top 12
//
// APPELANT LÉGITIME : ce script, comme `scripts/metrics.js`, est HORS BANDE — une commande à
// la demande. Aucun hook ne doit l'appeler : il balaye des transcripts entiers, ce qui est
// exactement le coût qu'un hook n'a pas le droit de payer.
//
// AUTONOMIE DE LA PAGE : zéro requête réseau, par construction — pas de CDN, pas de police
// distante, pas de `<script>`, pas de `url()` en CSS, et un `<link rel="icon" href="data:,">`
// qui neutralise la seule requête que le navigateur ferait de lui-même (/favicon.ico).
// Le thème passe intégralement par des variables CSS (clair, sombre système, forçage
// `data-theme`) — aucune couleur en dur dans le balisage produit ici.
//
// Fail-open absolu : exit 0 systématique. Transcript absent, illisible, gabarit manquant →
// la page est quand même écrite, avec son statut affiché.
const fs = require('fs');
const path = require('path');
const m = require('../lib/metrics');
const project = require('../lib/project');
const { readVersion } = require('../lib/version');
const { parseCwd } = require('../lib/cli');

// ============================ ARGUMENTS ============================

function flag(name) { return process.argv.indexOf('--' + name) !== -1; }
function opt(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && process.argv[i + 1] && process.argv[i + 1].indexOf('--') !== 0) return process.argv[i + 1];
  return fallback;
}
function num(name, fallback) {
  const v = parseInt(opt(name, ''), 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Seuil du contrôle de validité de la décomposition, IDENTIQUE à celui de scripts/metrics.js.
// Au-delà, les parts ne sont plus des parts : ce sont des plafonds (cf. DÉCLASSEMENT ci-dessous).
const RATIO_WARN = 1.15;

// ============================ FORMATAGE ============================

function fr(s) { return String(s).replace('.', ','); }
function tok(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Math.abs(n);
  if (v >= 1e9) return fr((n / 1e9).toFixed(2)) + ' Md';
  if (v >= 1e6) return fr((n / 1e6).toFixed(2)) + ' M';
  if (v >= 1000) return Math.round(n / 1000) + 'k';
  return String(Math.round(n));
}
function usd(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return '$' + fr(n >= 100 ? n.toFixed(0) : n.toFixed(2));
}
function pct(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  return fr((x * 100).toFixed(1)) + ' %';
}
function dec(x, d) {
  if (x == null || !Number.isFinite(x)) return '—';
  return fr(x.toFixed(d == null ? 2 : d));
}
function int(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  return String(Math.round(x));
}
// Signe moins typographique : un « -12 % » se lit mal collé à un pourcentage de gain.
function minus(x) { return '−' + pct(x).replace('-', ''); }

function frDate(ms) {
  const d = new Date(ms);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} à ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ============================ GABARIT ============================

const TPL_FILE = path.join(__dirname, '..', 'templates', 'dashboard.html');

// Gabarit de secours : si `templates/dashboard.html` est absent (install partielle), la page
// doit quand même sortir. Volontairement minimal, mais toujours thémable et sans réseau.
const FALLBACK_TPL = [
  '<!doctype html>', '<html lang="fr">', '<head>', '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>{{TITLE}}</title>', '<link rel="icon" href="data:,">',
  '<style>:root{--pmz-bg:#f6f5f2;--pmz-text:#1a1a18;--pmz-muted:#6a6862;--pmz-border:#dedcd5;--pmz-surface:#fff}',
  '@media (prefers-color-scheme:dark){:root{--pmz-bg:#16171a;--pmz-text:#ecebe7;--pmz-muted:#9c9a94;--pmz-border:#34373d;--pmz-surface:#1e2024}}',
  'body{margin:0;padding:24px;background:var(--pmz-bg);color:var(--pmz-text);font:15px/1.5 system-ui,sans-serif}',
  'section{background:var(--pmz-surface);border:1px solid var(--pmz-border);border-radius:8px;padding:14px;margin-bottom:14px}',
  'footer{color:var(--pmz-muted);font-size:.8rem}</style>',
  '</head>', '<body>', '<h1>{{TITLE}}</h1>', '<p>{{SUBTITLE}}</p>', '{{BODY}}',
  '<footer>{{FOOTER}}</footer>', '</body>', '</html>', '',
].join('\n');

function loadTemplate() {
  try {
    const raw = fs.readFileSync(TPL_FILE, 'utf8');
    if (raw && raw.indexOf('{{BODY}}') !== -1) return { tpl: raw, fallback: false };
  } catch (_) { /* gabarit absent ou illisible : on retombe sur le secours */ }
  return { tpl: FALLBACK_TPL, fallback: true };
}

// Substitution par FONCTION de remplacement, jamais par chaîne : les valeurs contiennent des
// « $ » (montants) et `String.replace` interpréterait `$&`, `$'`, `$1`… comme des références.
// Tout jeton non fourni est effacé plutôt que laissé visible dans la page.
function render(tpl, map) {
  return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (_all, key) => (map[key] == null ? '' : String(map[key])));
}

// Échappement systématique de TOUTE valeur venant du disque (chemins, identifiants de session,
// noms de modèle) : un transcript est une donnée, pas du balisage.
// L'apostrophe n'est PAS échappée, volontairement : tous les attributs produits ici sont entre
// guillemets doubles (déjà échappés en &quot;), donc une apostrophe ne peut pas s'en échapper —
// alors que la convertir en &#39; hacherait chaque apostrophe d'une interface en français.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Largeur de barre bornée à [0,100] et arrondie : une valeur hors bornes déborderait du rail.
function width(x) {
  const v = Number.isFinite(x) ? x * 100 : 0;
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

// ============================ FRAGMENTS HTML ============================

function kpi(label, value, hint) {
  return `<div class="pmz-kpi"><div class="k-label">${esc(label)}</div>` +
    `<div class="k-value">${value}</div><div class="k-hint">${hint || ''}</div></div>`;
}

function barRow(label, value, ratio, series) {
  return `<div class="r-label">${esc(label)}</div>` +
    `<div class="pmz-track"><div class="pmz-fill${series ? ' ' + series : ''}" style="width:${width(ratio)}%"></div></div>` +
    `<div class="r-value">${value}</div>`;
}

function card(title, inner) {
  return `<section class="pmz-card"><h2>${esc(title)}</h2>${inner}</section>`;
}

// ============================ SECTIONS ============================

function occupancySection(w) {
  const o = w.occupancy;
  const scale = o.max > 0 ? o.max : 1;
  const rows = [
    barRow('médiane', tok(o.median), o.median / scale, 's1'),
    barRow('p90', tok(o.p90), o.p90 / scale, 's1'),
    barRow('max', tok(o.max), 1, 's1'),
    barRow('préfixe (médian)', tok(w.prefix.median), w.prefix.median / scale, 's3'),
  ].join('');
  return card('Occupation du contexte', `<div class="pmz-rows">${rows}</div>` +
    `<p class="pmz-note">Taille de prompt par tour, en tokens (entrée + écriture de cache + lecture de cache). ` +
    `Médiane et p90 sont des médianes des médianes/p90 par session — une session de 300 tours n'écrase pas dix sessions courtes. ` +
    `Le <strong>préfixe</strong> est le plancher payé à chaque tour avant toute conversation ` +
    `(système, définitions d'outils, CLAUDE.md, skills, injections de hook) : de ${tok(w.prefix.min)} à ${tok(w.prefix.max)} selon la session.</p>`);
}

function costSection(w) {
  const c = w.cost;
  const scale = c.total > 0 ? c.total : 1;
  const rows = [
    barRow('lecture de cache', usd(c.cacheRead), c.cacheRead / scale, 's1'),
    barRow('sortie', usd(c.output), c.output / scale, 's2'),
    barRow('écriture de cache', usd(c.cacheWrite), c.cacheWrite / scale, 's3'),
    barRow('entrée', usd(c.input), c.input / scale, 's4'),
  ].join('');
  const tiers = Object.keys(m.PRICES).map((t) => `${t} ${usd(m.PRICES[t].cacheRead)}/M en lecture de cache`).join(' · ');
  return card('Décomposition du coût', `<div class="pmz-rows">${rows}</div>` +
    `<p class="pmz-note">Total ${usd(c.total)} sur la fenêtre, soit ${usd(w.turns > 0 ? c.total / w.turns : null)} par tour ` +
    `sur ${int(w.turns)} tours. Tarifs par palier de modèle&nbsp;: ${esc(tiers)}.</p>` +
    `<p class="pmz-caveat"><strong>Le coût d'écriture de cache est un plancher</strong>, pas une mesure : ` +
    `il est facturé ici au tarif 5 minutes (× 1,25 de l'entrée). Une session en TTL 1 heure paie × 2, ` +
    `et les transcripts n'exposent pas le TTL de façon fiable. Les trois autres postes sont exacts.</p>`);
}

// DÉCLASSEMENT DES PARTS EN PLAFONDS. Le modèle de décomposition suppose que tout token émis
// reste relu à chaque tour suivant. Deux faits le violent : la compaction (le contexte a été
// tronqué) et le raisonnement étendu (le thinking est compté dans `output_tokens` mais n'est
// PAS rejoué au tour suivant). Quand le contrôle somme/réel dépasse 1,15, la somme surestime :
// les parts deviennent des PLAFONDS, et la page doit le dire — jamais un chiffre de
// décomposition sans son ratio de contrôle à côté.
function breakdownSection(w) {
  const b = w.cacheReadBreakdown;
  const s = b.shares || {};
  const degraded = b.ratio != null && b.ratio > RATIO_WARN;
  const word = degraded ? 'plafond' : 'part';
  const POSTS = [
    ['s1', 'préfixe rejoué à chaque tour', b.prefix, s.prefix],
    ['s2', "sortie de l'IA relue", b.output, s.output],
    ['s3', "résultats d'outils relus", b.toolResults, s.toolResults],
    ['s4', 'prompts et injections relus', b.prompts, s.prompts],
  ];
  const stack = POSTS.map(([cls, , , share]) => `<span class="${cls}" style="width:${width(share)}%"></span>`).join('');
  const legend = POSTS.map(([cls, name, val, share]) =>
    `<li><span class="pmz-swatch ${cls}"></span><span class="l-name">${esc(name)}</span>` +
    `<span class="l-val">${tok(val)} · ${word} ${pct(share)}</span></li>`).join('');
  const badge = b.ratio == null
    ? '<span class="pmz-badge warn">contrôle indisponible (aucune lecture de cache)</span>'
    : `<span class="pmz-badge${degraded ? ' warn' : ''}">contrôle ${dec(b.ratio)} — viser ≈ 1,0</span>`;
  const caveat = degraded
    ? `<p class="pmz-caveat"><strong>Contrôle ${dec(b.ratio)} &gt; ${fr(String(RATIO_WARN))} : la somme surestime le réel.</strong> ` +
      `Les quatre chiffres ci-dessus sont donc des <strong>plafonds</strong>, pas des parts mesurées. Deux causes : ` +
      `compaction en cours de session (le contexte a été tronqué, donc « relu à chaque tour » est faux), ` +
      `ou raisonnement étendu (le thinking est compté dans la sortie mais n'est pas rejoué au tour suivant).</p>`
    : `<p class="pmz-note">Contrôle de validité dans la plage attendue : les quatre chiffres se lisent comme des parts.</p>`;
  return card('Où part la lecture de cache (4 postes)',
    `<div class="pmz-stack">${stack}</div><ul class="pmz-legend">${legend}</ul>` +
    `<p class="pmz-note">Somme modélisée ${tok(b.sum)} contre lecture de cache réellement facturée ${tok(b.actual)} &nbsp;${badge}</p>` +
    caveat +
    `<p class="pmz-note">Méthode : un token émis au tour <em>i</em> est relu à chaque tour suivant, soit ${'≈'} (T−1)/2 fois ` +
    `pour un token moyen ; le préfixe, lui, est relu à chaque tour (× T). Les caractères sont convertis en tokens ` +
    `au ratio ${fr(String(m.CHARS_PER_TOKEN))} caractères/token.</p>`);
}

function accretionSection(w) {
  const a = w.accretion;
  const perSession = w.sessions
    .filter((x) => x.accretion != null)
    .sort((x, y) => y.accretion - x.accretion)
    .slice(0, 5);
  const scale = perSession.length ? Math.max(1, perSession[0].accretion) : 1;
  const rows = perSession.map((x) =>
    barRow(x.sessionId.slice(0, 8), dec(x.accretion, 0) + '/tour', x.accretion / scale, 's2')).join('');
  const head = a.median == null
    ? `<p>Accrétion indisponible : aucune session de la fenêtre n'a assez de tours (3 minimum) pour qu'une pente soit une tendance.</p>`
    : `<p><strong>${dec(a.median, 0)} tokens/tour</strong> en médiane sur ${int(a.n)} session${a.n > 1 ? 's' : ''} — ` +
      `vitesse à laquelle la session s'alourdit, tour après tour. À ce rythme, l'occupation médiane ` +
      `(${tok(w.occupancy.median)}) est atteinte en ${int(a.median > 0 ? w.occupancy.median / a.median : null)} tours ` +
      `et le p90 (${tok(w.occupancy.p90)}) en ${int(a.median > 0 ? w.occupancy.p90 / a.median : null)} tours.</p>`;
  return card('Accrétion (tokens/tour)', head +
    (rows ? `<h3>Sessions qui s'alourdissent le plus vite</h3><div class="pmz-rows">${rows}</div>` : '') +
    `<p class="pmz-note">Pente de la régression linéaire de la taille de prompt sur l'index du tour, par session.</p>`);
}

// Gain d'un découpage en deux d'une session, sous la loi `coût ∝ tours^k` : deux sessions de
// T/2 tours coûtent 2·(T/2)^k = 2^(1−k)·T^k, soit un gain de 1 − 0,5^(k−1). k = 1 → 0 (linéaire,
// aucun intérêt à scinder) ; k = 1,5 → −29 %.
function splitGain(k) { return 1 - Math.pow(0.5, k - 1); }

function scalingLine(s, label) {
  if (!s) {
    return `<li><span class="pmz-swatch s1"></span><span class="l-name">${esc(label)}</span>` +
      `<span class="l-val">— moins de 3 sessions assez longues</span></li>`;
  }
  const gain = s.exponent > 1 ? ` → scinder en deux : ${minus(splitGain(s.exponent))}` : ' → coût linéaire, scinder ne gagne rien';
  // « proportionnel à » écrit en mots, pas en « ∝ » : le glyphe U+221D manque dans plusieurs
  // piles de polices système et retombe alors sur un rectangle ou un tiret — « coût - tours »
  // se lirait comme une soustraction. Le sens du chiffre passe avant l'élégance de la notation.
  return `<li><span class="pmz-swatch s1"></span><span class="l-name">${esc(label)} : proportionnel à tours<sup>${dec(s.exponent)}</sup>` +
    `${gain}</span><span class="l-val">r² ${dec(s.r2)} · n=${int(s.n)} ≥ ${int(s.minTurns)} tours</span></li>`;
}

function scalingSection(w) {
  const items = [scalingLine(w.scaling, "loi d'échelle du coût"), scalingLine(w.scalingCacheRead, 'loi d\'échelle de la lecture de cache')].join('');
  return card('Loi d\'échelle — le coût croît en tours^k', `<ul class="pmz-legend">${items}</ul>` +
    `<p class="pmz-note">Régression log-log du coût (et de la lecture de cache) sur le nombre de tours, ` +
    `sur les seules sessions d'au moins ${int((w.scaling && w.scaling.minTurns) || m.MIN_TURNS_FOR_SCALING)} tours — ` +
    `sous ce seuil, le bruit du premier tour domine la pente. <strong>k &gt; 1</strong> signifie qu'une session longue ` +
    `coûte plus que la somme de deux sessions courtes équivalentes. L'exposant vaut <em>null</em> plutôt qu'inventé ` +
    `quand moins de 3 sessions qualifient, et il est publié avec son r² et son n : un k régressé sur 3 sessions ` +
    `ne vaut pas un k régressé sur 100.</p>`);
}

// ============================ RECOMMANDATIONS CHIFFRÉES ============================

// Chaque candidate porte un GAIN EN DOLLARS estimé sur la fenêtre observée, ce qui permet de
// les classer par argent et non par intuition. Les 4 postes de la décomposition sont toujours
// disponibles, donc il y a toujours au moins 4 candidates → toujours 3 recommandations
// chiffrées. Les taux de réduction (−25 %, −20 %, −30 %) sont des OBJECTIFS d'action, annoncés
// comme tels : le chiffre exact est le montant que le poste pèse aujourd'hui.
function recommendations(w) {
  const b = w.cacheReadBreakdown;
  const s = b.shares || {};
  const crCost = w.cost.cacheRead;
  const degraded = b.ratio != null && b.ratio > RATIO_WARN;
  const hedge = degraded ? ' (poste déclassé en plafond : contrôle ' + dec(b.ratio) + ')' : '';
  const postCost = (share) => (share != null && Number.isFinite(share) ? crCost * share : 0);
  const cand = [];

  const push = (gain, title, detail) => { cand.push({ gain, title, detail }); };

  // 1. Scinder les sessions — souvent le plus gros levier quand k > 1.
  if (w.scaling && w.scaling.exponent > 1) {
    const g = splitGain(w.scaling.exponent);
    push(w.cost.total * g,
      `Scinder les sessions en deux : ${minus(g)} sur le coût, ${usd(w.cost.total * g)} sur la fenêtre`,
      `Le coût mesuré croît en tours<sup>${dec(w.scaling.exponent)}</sup> (r² ${dec(w.scaling.r2)}, n=${int(w.scaling.n)} sessions ` +
      `de ${int(w.scaling.minTurns)} tours ou plus) : deux sessions de T/2 tours coûtent ${minus(g)} par rapport à une de T. ` +
      `Concrètement : clore le lot puis repartir en session fraîche au lieu de laisser courir.`);
  }

  // 2. Réduire le préfixe : le seul poste dont la réduction se paie à CHAQUE tour.
  push(postCost(s.prefix) * 0.25,
    `Alléger le préfixe : ${usd(postCost(s.prefix))} de lecture de cache aujourd'hui, ${usd(postCost(s.prefix) * 0.25)} récupérables à −25 %`,
    `Le préfixe médian pèse ${tok(w.prefix.median)} et il est rejoué à chaque tour — ${pct(s.prefix)} de la lecture de cache${hedge}. ` +
    `Leviers : CLAUDE.md plus court, skills et serveurs MCP non utilisés désactivés, injections de hook resserrées. ` +
    `C'est le seul poste dont une coupe se paie sur les ${int(w.turns)} tours de la fenêtre.`);

  // 3. Sortie de l'IA : le contre-intuitif de l'epic — relire moins de fichiers ne suffit pas.
  push(postCost(s.output) * 0.2,
    `Raccourcir la sortie : ${usd(postCost(s.output))} de relecture, ${usd(postCost(s.output) * 0.2)} récupérables à −20 %`,
    `La sortie de l'IA elle-même représente ${pct(s.output)} de la lecture de cache${hedge} — ${tok(b.output)} relus. ` +
    `Chaque token produit est repayé à tous les tours suivants. Leviers : diffs au lieu de fichiers réécrits, ` +
    `pas de récapitulatif de code déjà écrit, raisonnement étendu réservé aux décisions.`);

  // 4. Résultats d'outils : le levier « relire moins », vrai mais rarement le premier.
  push(postCost(s.toolResults) * 0.3,
    `Cibler les lectures : ${usd(postCost(s.toolResults))} de résultats d'outils relus, ${usd(postCost(s.toolResults) * 0.3)} récupérables à −30 %`,
    `Les résultats d'outils pèsent ${pct(s.toolResults)} de la lecture de cache${hedge} (${tok(b.toolResults)}). ` +
    `Leviers : git grep / git diff avant tout Read complet, lectures partielles (offset/limit), ` +
    `sous-agent pour les explorations larges (son contexte ne pèse pas sur la session principale).`);

  // 5. Prompts et injections relus.
  push(postCost(s.prompts) * 0.25,
    `Resserrer prompts et injections : ${usd(postCost(s.prompts))} relus, ${usd(postCost(s.prompts) * 0.25)} récupérables à −25 %`,
    `Prompts utilisateur et injections (dont celles de PMZ lui-même) pèsent ${pct(s.prompts)} de la lecture de cache${hedge}. ` +
    `Leviers : handoff court en session fraîche, pas de re-collage de contexte déjà présent, protocole injecté en version « slim ».`);

  // 6. Accrétion : convertie en un nombre de tours, pas en dollars — donc classée par le coût
  // qu'un tour supplémentaire fait payer, pour rester comparable aux autres.
  if (w.accretion.median != null && w.accretion.median > 0 && w.turns > 0) {
    const perTurn = w.cost.total / w.turns;
    const turnsToP90 = w.occupancy.p90 / w.accretion.median;
    push(perTurn * Math.max(0, turnsToP90 / 2),
      `Clore avant ~${int(turnsToP90)} tours : au-delà, chaque tour coûte plus de ${usd(perTurn)}`,
      `À ${dec(w.accretion.median, 0)} tokens/tour d'accrétion médiane, l'occupation atteint le p90 observé ` +
      `(${tok(w.occupancy.p90)}) vers le tour ${int(turnsToP90)}. Le coût par tour croît avec l'occupation : ` +
      `${usd(perTurn)} en moyenne sur la fenêtre, davantage en fin de session.`);
  }

  cand.sort((a, z) => z.gain - a.gain);

  // Garde-fou : la page promet 3 recommandations. Si la fenêtre est trop pauvre pour en
  // produire 3 chiffrées, on complète par une action de mesure — elle aussi chiffrée.
  while (cand.length < 3) {
    cand.push({
      gain: 0,
      title: `Élargir la mesure : ${int(w.count)} session${w.count > 1 ? 's' : ''} analysée${w.count > 1 ? 's' : ''}, ${int(w.turns)} tours`,
      detail: `Trop peu de matière pour chiffrer un levier de plus. Relancer avec <code>--all</code> pour balayer ` +
        `tous les transcripts du projet (la régression log-log demande 3 sessions de ` +
        `${int(m.MIN_TURNS_FOR_SCALING)} tours minimum).`,
    });
  }

  return cand.slice(0, 3);
}

function recosSection(w) {
  const items = recommendations(w).map((r) =>
    `<li><div class="reco-title">${r.title}</div><div class="reco-detail">${r.detail}</div></li>`).join('');
  return card('3 recommandations chiffrées', `<ol class="pmz-recos">${items}</ol>` +
    `<p class="pmz-note">Classées par montant récupérable sur la fenêtre observée. Ce que pèse un poste aujourd'hui ` +
    `est <strong>mesuré</strong> ; les taux de réduction (−20 %, −25 %, −30 %) sont des <strong>objectifs d'action</strong>, pas des mesures.</p>`);
}

function sessionsSection(w, top) {
  const rows = w.sessions.slice().sort((a, b) => b.cost.total - a.cost.total).slice(0, top).map((s) =>
    `<tr><td>${esc(s.sessionId.slice(0, 8))}</td><td>${int(s.turns)}</td><td>${usd(s.cost.total)}</td>` +
    `<td>${tok(s.prefix)}</td><td>${tok(s.occupancy.median)}</td><td>${tok(s.occupancy.p90)}</td>` +
    `<td>${s.accretion == null ? '—' : dec(s.accretion, 0)}</td><td>${pct(s.cacheHitRate)}</td>` +
    `<td>${esc(s.tier)}</td></tr>`).join('');
  const skipped = w.skipped && w.skipped.length
    ? `<p class="pmz-note">${int(w.skipped.length)} transcript(s) écarté(s) : ${esc(w.skipped.map((k) => k.reason).join(', '))}.</p>`
    : '';
  return card('Sessions les plus chères',
    `<div class="pmz-scroll"><table class="pmz-table"><thead><tr><th>session</th><th>tours</th><th>coût</th>` +
    `<th>préfixe</th><th>occ. médiane</th><th>occ. p90</th><th>accrétion</th><th>cache hit</th><th>palier</th>` +
    `</tr></thead><tbody>${rows}</tbody></table></div>${skipped}`);
}

// ============================ ASSEMBLAGE ============================

const REASONS = {
  'no-transcript': 'aucun transcript pour ce projet (jamais ouvert dans Claude Code, ou CLAUDE_CONFIG_DIR déplacé)',
  'empty-transcript': 'transcript vide',
  'no-usage': "aucune ligne d'usage exploitable dans les transcripts",
  'read-error': 'transcript illisible',
};
function reasonText(reason) { return REASONS[reason] || 'indéterminé'; }

function footerHtml(w, cwd, version) {
  const items = [
    `Mesure <strong>hors bande</strong> : ce tableau de bord est une commande à la demande. Aucun hook ne balaye ` +
      `les transcripts — c'est précisément le coût de lecture qu'un hook n'a pas le droit de payer.`,
    `Page <strong>autonome</strong> : aucune requête réseau, aucun script, aucune police distante. ` +
      `Thème par variables CSS (clair, sombre système, ou forçage <code>data-theme</code> sur la racine).`,
    `Le coût d'<strong>écriture de cache est un plancher</strong> (tarif 5 minutes ; le TTL 1 heure n'est pas exposé par les transcripts).`,
    `La décomposition publie toujours son <strong>contrôle de validité</strong> ; au-delà de ${fr(String(RATIO_WARN))} ` +
      `ses quatre chiffres sont des <strong>plafonds</strong>, pas des parts.`,
    `Aucune donnée ne quitte le poste : la page est un fichier local, produit depuis ` +
      `<code>${esc(w.ok ? w.dir : m.transcriptDir(cwd))}</code>.`,
  ];
  return `<p>Promptimizer ${esc(version || '—')} · <code>promptimizer/scripts/dashboard.js</code> ` +
    `sur le moteur <code>promptimizer/lib/metrics.js</code>.</p><ul><li>${items.join('</li><li>')}</li></ul>`;
}

function buildHtml(w, cwd, opts) {
  const { tpl } = loadTemplate();
  const version = readVersion();
  const title = 'Économie de contexte — tableau de bord';
  let subtitle;
  let body;

  if (!w.ok) {
    subtitle = `Projet <code>${esc(cwd)}</code> · généré le ${esc(frDate(Date.now()))}`;
    body = card('Mesure indisponible',
      `<p><strong>Statut : ${esc(reasonText(w.reason))}.</strong></p>` +
      `<p class="pmz-note">Dossier de transcripts attendu : <code>${esc(w.dir || m.transcriptDir(cwd))}</code>. ` +
      `Rien n'a échoué : le moteur exprime l'absence de mesure en valeur, et la page est produite quand même.</p>`);
  } else {
    subtitle = `Projet <code>${esc(cwd)}</code> · ${int(w.count)} session${w.count > 1 ? 's' : ''} · ` +
      `${int(w.turns)} tours · ${usd(w.cost.total)} · généré le ${esc(frDate(Date.now()))}`;
    const k = w.scaling ? dec(w.scaling.exponent) : '—';
    const kpis = '<div class="pmz-kpis">' + [
      kpi('occupation médiane', tok(w.occupancy.median), `p90 ${tok(w.occupancy.p90)} · max ${tok(w.occupancy.max)}`),
      kpi('coût de la fenêtre', usd(w.cost.total), `${usd(w.turns > 0 ? w.cost.total / w.turns : null)} par tour`),
      kpi('accrétion médiane', w.accretion.median == null ? '—' : dec(w.accretion.median, 0), 'tokens par tour'),
      kpi('loi d\'échelle', 'tours^' + k, w.scaling ? `r² ${dec(w.scaling.r2)} · n=${int(w.scaling.n)}` : 'pas assez de sessions longues'),
    ].join('') + '</div>';
    body = kpis + occupancySection(w) + costSection(w) + breakdownSection(w) +
      accretionSection(w) + scalingSection(w) + recosSection(w) + sessionsSection(w, opts.top);
  }

  return render(tpl, {
    TITLE: esc(title),
    SUBTITLE: subtitle,
    BODY: body,
    FOOTER: footerHtml(w, cwd, version),
  });
}

// Résumé machine — pour un appelant qui veut savoir OÙ est la page et ce qu'elle dit, sans
// parser du HTML. L'échec reste une valeur, jamais un code de sortie.
function summary(w, out, written) {
  const b = w.ok ? w.cacheReadBreakdown : null;
  return {
    ok: !!w.ok,
    reason: w.ok ? null : w.reason,
    out,
    written,
    count: w.ok ? w.count : 0,
    turns: w.ok ? w.turns : 0,
    cost: w.ok ? w.cost.total : null,
    occupancy: w.ok ? w.occupancy : null,
    accretion: w.ok ? w.accretion.median : null,
    scalingExponent: w.ok && w.scaling ? w.scaling.exponent : null,
    breakdownRatio: b ? b.ratio : null,
    breakdownDegraded: !!(b && b.ratio != null && b.ratio > RATIO_WARN),
    shares: b ? b.shares : null,
    recommendations: w.ok ? recommendations(w).map((r) => r.title.replace(/<[^>]+>/g, '')) : [],
  };
}

function defaultOut(cwd) {
  const root = project.gitRoot(cwd) || cwd;
  return path.join(project.vibeDir(root), 'dashboard.html');
}

function main() {
  const cwd = parseCwd();
  const opts = {
    limit: flag('all') ? 1e9 : num('sessions', 20),
    minTurns: num('min-turns', m.MIN_TURNS_FOR_SCALING),
    top: num('top', 10),
  };
  const w = m.analyzeWindow(cwd, { limit: opts.limit, minTurns: opts.minTurns });
  const html = buildHtml(w, cwd, opts);

  if (flag('stdout')) {
    process.stdout.write(html);
    return;
  }

  const out = opt('out', null) || defaultOut(cwd);
  let written = false;
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
    written = true;
  } catch (_) { /* disque en lecture seule, chemin invalide : on le dit, on ne casse pas */ }

  if (flag('json')) {
    process.stdout.write(JSON.stringify(summary(w, out, written), null, 2) + '\n');
    return;
  }

  const lines = ['## Tableau de bord d\'économie de contexte', ''];
  if (written) lines.push(`Page écrite : \`${out}\``);
  else lines.push(`Écriture impossible : \`${out}\` (droits ou chemin). Utilise \`--out <chemin>\` ou \`--stdout\`.`);
  lines.push('');
  if (!w.ok) {
    lines.push(`Statut : ${reasonText(w.reason)} — la page affiche ce statut.`);
  } else {
    const b = w.cacheReadBreakdown;
    lines.push(`${w.count} session${w.count > 1 ? 's' : ''} · ${w.turns} tours · ${usd(w.cost.total)}`);
    lines.push(`- occupation : médiane ${tok(w.occupancy.median)} · p90 ${tok(w.occupancy.p90)} · max ${tok(w.occupancy.max)}`);
    lines.push(`- accrétion : ${w.accretion.median == null ? '—' : dec(w.accretion.median, 0) + ' tokens/tour'}`);
    lines.push(`- loi d'échelle : ${w.scaling ? 'coût ∝ tours^' + dec(w.scaling.exponent) : '— (pas assez de sessions longues)'}`);
    lines.push(`- décomposition : contrôle ${dec(b.ratio)}` +
      (b.ratio != null && b.ratio > RATIO_WARN ? ` > ${fr(String(RATIO_WARN))} → parts affichées comme des PLAFONDS` : ' (dans la plage attendue)'));
    lines.push('');
    lines.push('Recommandations chiffrées :');
    recommendations(w).forEach((r, i) => lines.push(`${i + 1}. ${r.title.replace(/<[^>]+>/g, '')}`));
  }
  process.stdout.write(lines.join('\n') + '\n');
}

try {
  main();
} catch (e) {
  // Dernier rempart : appelé depuis une commande, ce script ne doit jamais faire échouer son
  // appelant. L'échec ressort en valeur (JSON) ou en texte lisible, toujours en code 0.
  if (flag('json')) process.stdout.write(JSON.stringify({ ok: false, reason: 'error', out: null, written: false }) + '\n');
  else process.stdout.write('## Tableau de bord d\'économie de contexte\n\nStatut : indéterminé (aucune page produite).\n');
}
