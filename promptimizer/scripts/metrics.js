#!/usr/bin/env node
'use strict';
// CLI du moteur de mesure de session (lot #110) — 5 indicateurs d'économie de contexte,
// pour la session courante ou pour une fenêtre de N sessions du projet.
//
//   node promptimizer/scripts/metrics.js                    → session la plus récente, texte
//   node promptimizer/scripts/metrics.js --json             → même chose en JSON
//   node promptimizer/scripts/metrics.js --sessions 20      → fenêtre des 20 dernières sessions
//   node promptimizer/scripts/metrics.js --transcript <p>   → un transcript précis
//   node promptimizer/scripts/metrics.js --cwd <p>          → un autre projet
//   node promptimizer/scripts/metrics.js --min-turns 20     → seuil de la régression log-log
//
// Fail-open absolu : sort toujours en code 0, même sans transcript. En `--json`, l'échec est
// une valeur (`{"ok":false,"reason":…}`) — un appelant ne doit jamais avoir à parser stderr.
const m = require('../lib/metrics');
const { parseCwd } = require('../lib/cli');

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

// ---------- formatage (sortie texte uniquement ; le JSON reste en valeurs brutes) ----------

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

// ---------- rendu texte ----------

const REASONS = {
  'no-transcript': 'aucun transcript pour ce projet (jamais ouvert dans Claude Code, ou CLAUDE_CONFIG_DIR déplacé)',
  'empty-transcript': 'transcript vide',
  'no-usage': 'aucune ligne d\'usage exploitable dans le transcript',
  'read-error': 'transcript illisible',
};

function reasonText(reason) { return REASONS[reason] || 'indéterminé'; }

// Seuil au-delà duquel le contrôle de validité cesse d'être une confirmation du modèle.
const RATIO_WARN = 1.15;

function breakdownLines(b) {
  const s = b.shares || {};
  const lines = [
    '',
    '### Décomposition du cache-read',
    '',
    `- préfixe rejoué à chaque tour : ${tok(b.prefix)} (${pct(s.prefix)})`,
    `- sortie de l'IA relue        : ${tok(b.output)} (${pct(s.output)})`,
    `- résultats d'outils relus    : ${tok(b.toolResults)} (${pct(s.toolResults)})`,
    `- prompts et injections relus : ${tok(b.prompts)} (${pct(s.prompts)})`,
    `- somme ${tok(b.sum)} vs cache-read réel ${tok(b.actual)} — contrôle ${dec(b.ratio)} (viser ≈ 1,0)`,
  ];
  // Le contrôle n'est pas une note de qualité du moteur, c'est un test d'hypothèse : le modèle
  // suppose que TOUT ce qui est émis reste relu à chaque tour suivant. Deux faits le violent —
  // la compaction (le contexte a été tronqué) et le raisonnement étendu (`output_tokens`
  // compte les tokens de thinking, qui ne sont PAS rejoués). Dans les deux cas la somme
  // surestime, et les parts du poste « sortie de l'IA » sont un plafond, pas une mesure.
  if (b.ratio != null && b.ratio > RATIO_WARN) {
    lines.push(`- ⚠ contrôle > ${fr(String(RATIO_WARN))} : somme surestimée — compaction en cours de session, ` +
      'ou raisonnement étendu (thinking compté en sortie mais non rejoué). Parts à lire comme des plafonds.');
  }
  return lines;
}

function sessionText(r) {
  if (!r.ok) return ['## Mesure de session', '', `Statut : ${reasonText(r.reason)}`].join('\n');
  const o = r.occupancy;
  const c = r.cost;
  const lines = [
    '## Mesure de session',
    '',
    `Session : \`${r.sessionId}\` — ${r.turns} tour${r.turns > 1 ? 's' : ''}` +
      (r.sidechainTurns ? ` (+${r.sidechainTurns} en sous-agent, hors contexte principal)` : '') +
      ` · palier ${r.tier}`,
    '',
    `- **préfixe** : ${tok(r.prefix)} — plancher payé à chaque tour avant toute conversation`,
    `- **occupation** : médiane ${tok(o.median)} · p90 ${tok(o.p90)} · max ${tok(o.max)}`,
    `- **accrétion** : ${r.accretion == null ? '— (session trop courte)' : dec(r.accretion, 0) + ' tokens/tour'}`,
    `- **coût** : ${usd(c.total)} au total, ${usd(r.costPerTurn)} par tour · cache hit ${pct(r.cacheHitRate)}`,
    `  (entrée ${usd(c.input)} · écriture cache ${usd(c.cacheWrite)} · lecture cache ${usd(c.cacheRead)} · sortie ${usd(c.output)})`,
  ];
  return lines.concat(breakdownLines(r.cacheReadBreakdown)).join('\n');
}

function scalingLine(s, label) {
  if (!s) return `- **${label}** : — (moins de 3 sessions de ${s && s.minTurns ? s.minTurns : '?'} tours ou plus)`;
  const gain = 1 - Math.pow(0.5, s.exponent - 1); // scinder en deux : économie sur la métrique
  return `- **${label}** : ∝ tours^${dec(s.exponent)} (r² ${dec(s.r2)}, n=${s.n} sessions ≥ ${s.minTurns} tours)` +
    (s.exponent > 1 ? ` → scinder une session en deux fait ${pct(-gain).replace('-', '−')} sur ce poste` : '');
}

function windowText(w) {
  if (!w.ok) return ['## Mesure de fenêtre', '', `Statut : ${reasonText(w.reason)}`, `Dossier : \`${w.dir}\``].join('\n');
  const lines = [
    '## Mesure de fenêtre',
    '',
    `${w.count} session${w.count > 1 ? 's' : ''} · ${w.turns} tours · ${usd(w.cost.total)}` +
      (w.skipped && w.skipped.length ? ` (${w.skipped.length} transcript(s) écarté(s))` : ''),
    '',
    `- **préfixe** : médiane ${tok(w.prefix.median)} (de ${tok(w.prefix.min)} à ${tok(w.prefix.max)})`,
    `- **occupation** : médiane des médianes ${tok(w.occupancy.median)} · p90 ${tok(w.occupancy.p90)} · max ${tok(w.occupancy.max)}`,
    `- **accrétion** : médiane ${w.accretion.median == null ? '—' : dec(w.accretion.median, 0) + ' tokens/tour'} (sur ${w.accretion.n} sessions)`,
    scalingLine(w.scaling, 'loi d\'échelle du coût'),
    scalingLine(w.scalingCacheRead, 'loi d\'échelle du cache-read'),
  ];
  lines.push.apply(lines, breakdownLines(w.cacheReadBreakdown));

  // Palmarès par coût : c'est là que se trouvent les sessions à scinder en priorité.
  const top = w.sessions.slice().sort((a, b) => b.cost.total - a.cost.total).slice(0, num('top', 5));
  if (top.length) {
    lines.push('', '### Sessions les plus chères', '');
    for (let i = 0; i < top.length; i++) {
      const s = top[i];
      lines.push(`${i + 1}. \`${s.sessionId.slice(0, 8)}\` — ${usd(s.cost.total)} · ${s.turns} tours · ` +
        `occupation médiane ${tok(s.occupancy.median)} · accrétion ${s.accretion == null ? '—' : dec(s.accretion, 0) + '/tour'}`);
    }
  }
  return lines.join('\n');
}

// ---------- point d'entrée ----------

function main() {
  const cwd = parseCwd();
  const asJson = flag('json');
  const windowed = flag('sessions') || flag('all');

  let result;
  if (windowed) {
    result = m.analyzeWindow(cwd, {
      limit: flag('all') ? 1e9 : num('sessions', 20),
      minTurns: num('min-turns', m.MIN_TURNS_FOR_SCALING),
    });
    if (asJson && result.ok) {
      // Les sessions complètes gonflent la sortie sans rien apprendre à un appelant machine :
      // on garde une ligne par session, l'analyse détaillée s'obtient avec --transcript.
      result = Object.assign({}, result, {
        sessions: result.sessions.map((s) => ({
          sessionId: s.sessionId, turns: s.turns, prefix: s.prefix,
          occupancy: s.occupancy, accretion: s.accretion,
          cost: s.cost.total, cacheRead: s.totals.cacheRead, tier: s.tier,
        })),
      });
    }
  } else {
    const explicit = opt('transcript', null);
    let file = explicit;
    if (!file) {
      const list = m.listTranscripts(cwd);
      file = list.length ? list[0].file : null;
    }
    result = file
      ? m.analyzeSession(file)
      : { ok: false, reason: 'no-transcript', dir: m.transcriptDir(cwd) };
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  process.stdout.write((windowed ? windowText(result) : sessionText(result)) + '\n');
}

try {
  main();
} catch (e) {
  // Dernier rempart : le script est appelé depuis des commandes et des skills, il ne doit
  // jamais faire échouer son appelant, même sur une panne imprévue.
  if (flag('json')) process.stdout.write(JSON.stringify({ ok: false, reason: 'error' }) + '\n');
  else process.stdout.write('## Mesure de session\n\nStatut : indéterminé\n');
}
