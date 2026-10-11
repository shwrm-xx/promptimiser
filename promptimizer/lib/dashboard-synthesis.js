'use strict';
// ============================================================================
// SYNTHÈSE D'OUVERTURE DU TABLEAU DE BORD (lot #122)
// ============================================================================
// Le tableau de bord publiait sept blocs d'indicateurs : de la mesure, pas une lecture. Ce
// module dérive de la MÊME mesure (aucune donnée nouvelle, aucun transcript relu) la synthèse
// sur laquelle la page s'ouvre : Constat / Garder / Améliorer / Arrêter, plus 3 bons points et
// 3 points d'attention. Le détail technique passe au second niveau, derrière un `<details>`.
//
// Trois règles tenues ici :
//
//   1. PUR. Aucune I/O, aucun `require`. Toute mise en forme est INJECTÉE (`fmt`), sur le
//      modèle de `rtk-metrics.gainLines(co, tok)` : un seul jeu de formateurs dans le projet,
//      celui de `scripts/dashboard.js`. Ce module ne sait pas ce qu'est un euro.
//
//   2. JAMAIS DE SIGNAL NON MESURÉ. Une métrique absente (`null`, fenêtre trop pauvre) ne
//      produit pas un signal prudent : elle ne produit RIEN. Le garde-fou de complétude
//      (toujours 3 + 3, comme les 3 recommandations du lot #114) complète par un constat
//      d'insuffisance de mesure — jamais par une affirmation qu'on n'a pas mesurée.
//
//   3. SEUILS NOMMÉS. Tout seuil vit dans THRESHOLDS, un seul point d'édition. Un signal qui
//      se déclenche affiche toujours le chiffre qui l'a déclenché : le lecteur doit pouvoir
//      contester le seuil sans lire le code.
//
// Le classement se fait par sévérité puis par montant en jeu (€), la même monnaie que les
// recommandations chiffrées — pas par ordre d'écriture dans ce fichier.

// ============================ SEUILS ============================

// Parts (`*Share*`) : fraction de la lecture de cache portée par un poste de la décomposition.
// Occupation : fraction de la borne de zone rouge DU PROJET (lib/occupancy.resolveRedZone) —
// pas un palier absolu, sinon le même chiffre sur-alerterait sur Haiku et sous-alerterait sur
// Opus. Accrétion : tokens gagnés par tour.
const THRESHOLDS = {
  cacheHitGood: 0.90, cacheHitStrong: 0.95, cacheHitWatch: 0.75, cacheHitCrit: 0.55,
  prefixShareGood: 0.20, prefixShareWatch: 0.35, prefixShareCrit: 0.50,
  outputShareGood: 0.20, outputShareWatch: 0.35, outputShareCrit: 0.50,
  toolShareGood: 0.15, toolShareWatch: 0.30, toolShareCrit: 0.45,
  promptShareWatch: 0.20, promptShareCrit: 0.35,
  scalingGood: 1.05, scalingWatch: 1.20, scalingCrit: 1.50,
  occupancyGood: 0.40, occupancyWatch: 0.70, occupancyP90Crit: 0.90,
  accretionGood: 1000, accretionWatch: 3000, accretionCrit: 6000,
  concentrationWatch: 0.40, concentrationCrit: 0.60,
  ratioWarn: 1.15,
};

// Gain d'un découpage en deux sous la loi `coût ∝ tours^k`. Dupliqué du même calcul dans
// scripts/dashboard.js à dessein : ce module est pur et ne require rien (cf. règle 1).
function splitGain(k) { return 1 - Math.pow(0.5, k - 1); }

function fin(x) { return x != null && Number.isFinite(x); }

// ============================ SIGNAUX ============================

// Un signal = un fait mesuré + ce qu'on en fait. `stake` est le montant en jeu sur la fenêtre
// (USD, converti à l'affichage), `null` quand la métrique ne se traduit pas en argent.
// `action` est la phrase de la colonne Garder (bons points) ou Arrêter (points d'attention).
function buildSignals(w, fmt, opts) {
  const T = THRESHOLDS;
  const o = opts || {};
  const good = [];
  const watch = [];
  const b = w.cacheReadBreakdown || {};
  const s = b.shares || {};
  const crCost = w.cost.cacheRead;
  const ratioWarn = fin(o.ratioWarn) && o.ratioWarn > 0 ? o.ratioWarn : T.ratioWarn;
  const degraded = fin(b.ratio) && b.ratio > ratioWarn;
  // Un poste déclassé en plafond reste utilisable comme signal — à condition de ne jamais
  // taire son statut (même règle que la section de décomposition du lot #114).
  const hedge = degraded ? ' (poste déclassé en plafond, contrôle ' + fmt.dec(b.ratio) + ')' : '';
  const postCost = (share) => (fin(share) ? crCost * share : null);

  // --- 1. Réutilisation du cache -------------------------------------------
  const cacheable = w.totals.cacheRead + w.totals.cacheWrite;
  const hit = cacheable > 0 ? w.totals.cacheRead / cacheable : null;
  if (fin(hit)) {
    if (hit >= T.cacheHitGood) {
      good.push({
        id: 'cache-hit', severity: hit >= T.cacheHitStrong ? 3 : 2, stake: o.cacheSavingUsd,
        title: `Le cache porte ${fmt.pct(hit)} des tokens de contexte facturés`,
        detail: `Seuls ${fmt.pct(1 - hit)} du contexte sont réécrits en cache : le préfixe reste chaud d'un tour ` +
          `au suivant.${fin(o.cacheSavingUsd) ? ` Au tarif d'entrée, relire ces ${fmt.tok(w.totals.cacheRead)} tokens sans cache aurait coûté ` +
          `${fmt.eur(o.cacheSavingUsd)} de plus.` : ''}`,
        action: `Garder l'enchaînement des tours dans une session déjà chaude : chaque démarrage à froid repaie ` +
          `l'écriture de cache avant le premier mot utile.`,
      });
    } else if (hit <= T.cacheHitWatch) {
      watch.push({
        id: 'cache-hit', severity: hit <= T.cacheHitCrit ? 3 : 2, stake: w.cost.cacheWrite,
        title: `${fmt.pct(1 - hit)} du contexte est réécrit en cache, pas relu`,
        detail: `Le taux de réutilisation tombe à ${fmt.pct(hit)} — signe de sessions rouvertes à froid ou de contexte ` +
          `invalidé en cours de route. L'écriture de cache pèse ${fmt.eur(w.cost.cacheWrite)} sur la fenêtre.`,
        action: `Arrêter les allers-retours en session neuve pour une question isolée : regrouper dans la session ` +
          `du lot en cours, dont le préfixe est déjà payé.`,
      });
    }
  }

  // --- 2. Préfixe (le seul poste rejoué à CHAQUE tour) ----------------------
  if (fin(s.prefix)) {
    if (s.prefix <= T.prefixShareGood) {
      good.push({
        id: 'prefix', severity: 2, stake: null,
        title: `Le plancher rejoué à chaque tour ne pèse que ${fmt.pct(s.prefix)} de la lecture de cache`,
        detail: `Préfixe médian ${fmt.tok(w.prefix.median)} (de ${fmt.tok(w.prefix.min)} à ${fmt.tok(w.prefix.max)} selon la session) : ` +
          `système, outils, CLAUDE.md, skills et injections restent contenus.`,
        action: `Garder le préfixe court : ne pas rallonger CLAUDE.md ni réactiver des serveurs MCP ou des skills inutilisés.`,
      });
    } else if (s.prefix >= T.prefixShareWatch) {
      watch.push({
        id: 'prefix', severity: s.prefix >= T.prefixShareCrit ? 3 : 2, stake: postCost(s.prefix),
        title: `Le préfixe pèse ${fmt.pct(s.prefix)} de la lecture de cache, soit ${fmt.eur(postCost(s.prefix))}`,
        detail: `${fmt.tok(w.prefix.median)} en médiane, rejoués aux ${fmt.int(w.turns)} tours de la fenêtre${hedge}. ` +
          `C'est le seul poste dont une coupe se paie à chaque tour, même les plus courts.`,
        action: `Arrêter de charger ce qui ne sert pas au lot : skills et serveurs MCP hors sujet désactivés, ` +
          `CLAUDE.md ramené à la couche stable, injections de hook resserrées.`,
      });
    }
  }

  // --- 3. Sortie de l'IA relue ---------------------------------------------
  if (fin(s.output)) {
    if (s.output <= T.outputShareGood) {
      good.push({
        id: 'output', severity: 2, stake: null,
        title: `La sortie de l'IA ne représente que ${fmt.pct(s.output)} de la relecture`,
        detail: `${fmt.tok(b.output)} de sortie relus sur la fenêtre : les réponses ne se repaient pas indéfiniment.`,
        action: `Garder ce régime : diffs plutôt que fichiers réécrits, pas de récapitulatif de code déjà produit.`,
      });
    } else if (s.output >= T.outputShareWatch) {
      watch.push({
        id: 'output', severity: s.output >= T.outputShareCrit ? 3 : 2, stake: postCost(s.output),
        title: `La sortie de l'IA est relue pour ${fmt.eur(postCost(s.output))}, ${fmt.pct(s.output)} de la lecture de cache`,
        detail: `${fmt.tok(b.output)} produits puis repayés à chaque tour suivant${hedge}. Relire moins de fichiers ` +
          `ne corrige pas ce poste : c'est la longueur des réponses qui le nourrit.`,
        action: `Arrêter de réécrire des fichiers entiers et de récapituler du code déjà écrit ; réserver le ` +
          `raisonnement étendu aux décisions.`,
      });
    }
  }

  // --- 4. Résultats d'outils relus ------------------------------------------
  if (fin(s.toolResults)) {
    if (s.toolResults <= T.toolShareGood) {
      good.push({
        id: 'tools', severity: 2, stake: null,
        title: `Les résultats d'outils ne pèsent que ${fmt.pct(s.toolResults)} de la relecture`,
        detail: `${fmt.tok(b.toolResults)} relus : les lectures sont ciblées, pas des fichiers entiers versés au contexte.`,
        action: `Garder le réflexe git grep / git diff et les lectures partielles avant tout Read complet.`,
      });
    } else if (s.toolResults >= T.toolShareWatch) {
      watch.push({
        id: 'tools', severity: s.toolResults >= T.toolShareCrit ? 3 : 2, stake: postCost(s.toolResults),
        title: `Les fichiers relus coûtent ${fmt.eur(postCost(s.toolResults))}, ${fmt.pct(s.toolResults)} de la lecture de cache`,
        detail: `${fmt.tok(b.toolResults)} de résultats d'outils rejoués${hedge}. Un fichier versé au contexte ` +
          `est repayé à tous les tours suivants, qu'il serve encore ou non.`,
        action: `Arrêter les Read complets par défaut : git grep / git diff d'abord, lectures partielles ensuite, ` +
          `sous-agent pour les explorations larges (son contexte ne pèse pas sur la session).`,
      });
    }
  }

  // --- 5. Prompts et injections relus ---------------------------------------
  if (fin(s.prompts) && s.prompts >= T.promptShareWatch) {
    watch.push({
      id: 'prompts', severity: s.prompts >= T.promptShareCrit ? 3 : 2, stake: postCost(s.prompts),
      title: `Prompts et injections relus pour ${fmt.eur(postCost(s.prompts))}, ${fmt.pct(s.prompts)} de la lecture de cache`,
      detail: `${fmt.tok(b.prompts)} rejoués${hedge} — prompts utilisateur, pièces jointes et injections de hook, ` +
        `celles de Promptimizer comprises.`,
      action: `Arrêter de recoller du contexte déjà présent : repartir sur le handoff court en session fraîche.`,
    });
  }

  // --- 6. Loi d'échelle ----------------------------------------------------
  if (w.scaling && fin(w.scaling.exponent)) {
    const k = w.scaling.exponent;
    if (k <= T.scalingGood) {
      good.push({
        id: 'scaling', severity: 2, stake: null,
        title: `Le coût croît quasi linéairement avec les tours (tours<sup>${fmt.dec(k)}</sup>)`,
        detail: `Régressé sur ${fmt.int(w.scaling.n)} session(s) de ${fmt.int(w.scaling.minTurns)} tours ou plus, ` +
          `r² ${fmt.dec(w.scaling.r2)} : une session longue ne coûte pas plus que deux courtes équivalentes.`,
        action: `Garder le rythme de clôture actuel : c'est lui qui empêche l'exposant de dériver au-dessus de 1.`,
      });
    } else if (k >= T.scalingWatch) {
      const g = splitGain(k);
      watch.push({
        id: 'scaling', severity: k >= T.scalingCrit ? 3 : 2, stake: w.cost.total * g,
        title: `Les sessions longues dérapent : coût en tours<sup>${fmt.dec(k)}</sup>, ${fmt.eur(w.cost.total * g)} récupérables en scindant`,
        detail: `r² ${fmt.dec(w.scaling.r2)} sur ${fmt.int(w.scaling.n)} session(s) de ${fmt.int(w.scaling.minTurns)} tours ou plus. ` +
          `Deux sessions de T/2 tours coûtent ${fmt.pct(g)} de moins qu'une de T.`,
        action: `Arrêter d'enchaîner les lots dans la même session : clore, puis repartir sur le handoff court.`,
      });
    }
  }

  // --- 7. Occupation, rapportée à la borne du projet -------------------------
  if (fin(o.redZoneTokens) && o.redZoneTokens > 0) {
    const rMed = w.occupancy.median / o.redZoneTokens;
    const rP90 = w.occupancy.p90 / o.redZoneTokens;
    if (rMed <= T.occupancyGood && rP90 < T.occupancyP90Crit) {
      good.push({
        id: 'occupancy', severity: 2, stake: null,
        title: `L'occupation médiane reste à ${fmt.pct(rMed)} de la borne (${fmt.tok(o.redZoneTokens)})`,
        detail: `Médiane ${fmt.tok(w.occupancy.median)}, p90 ${fmt.tok(w.occupancy.p90)}, pic ${fmt.tok(w.occupancy.max)} : ` +
          `il reste de la marge avant la zone rouge du projet.`,
        action: `Garder la marge : c'est elle qui laisse le choix de clore au bon moment plutôt que sous la contrainte.`,
      });
    } else if (rMed >= T.occupancyWatch || rP90 >= T.occupancyP90Crit) {
      watch.push({
        id: 'occupancy', severity: rP90 >= T.occupancyP90Crit ? 3 : 2, stake: null,
        title: `L'occupation frôle la borne : médiane à ${fmt.pct(rMed)}, p90 à ${fmt.pct(rP90)} de ${fmt.tok(o.redZoneTokens)}`,
        detail: `Médiane ${fmt.tok(w.occupancy.median)}, p90 ${fmt.tok(w.occupancy.p90)}, pic ${fmt.tok(w.occupancy.max)}. ` +
          `Au-delà de la borne, la compaction tronque le contexte et la mesure elle-même se dégrade.`,
        action: `Arrêter de laisser filer les sessions jusqu'à la borne : clore le lot avant, ou déléguer à un sous-agent.`,
      });
    }
  }

  // --- 8. Accrétion ---------------------------------------------------------
  if (fin(w.accretion.median)) {
    const a = w.accretion.median;
    if (a <= T.accretionGood) {
      good.push({
        id: 'accretion', severity: 2, stake: null,
        title: `Les sessions ne s'alourdissent que de ${fmt.dec(a, 0)} tokens par tour`,
        detail: `Pente médiane sur ${fmt.int(w.accretion.n)} session(s) : le contexte grossit lentement, chaque tour ` +
          `reste proche du coût du précédent.`,
        action: `Garder cette discipline d'accumulation : un tour qui n'ajoute rien au contexte est un tour qui ne renchérit pas les suivants.`,
      });
    } else if (a >= T.accretionWatch) {
      const perTurn = w.turns > 0 ? w.cost.total / w.turns : null;
      const turnsToP90 = a > 0 ? w.occupancy.p90 / a : null;
      watch.push({
        id: 'accretion', severity: a >= T.accretionCrit ? 3 : 2,
        stake: fin(perTurn) && fin(turnsToP90) ? perTurn * (turnsToP90 / 2) : null,
        title: `+${fmt.dec(a, 0)} tokens par tour : le p90 est atteint vers le tour ${fmt.int(turnsToP90)}`,
        detail: `Pente médiane sur ${fmt.int(w.accretion.n)} session(s). Le coût par tour croît avec l'occupation : ` +
          `${fmt.eur(perTurn)} en moyenne sur la fenêtre, davantage en fin de session.`,
        action: `Arrêter d'accumuler au-delà de ~${fmt.int(turnsToP90)} tours : clore le lot pendant que le tour est encore bon marché.`,
      });
    }
  }

  // --- 9. Concentration du coût sur une seule session -----------------------
  if (w.sessions.length > 1 && w.cost.total > 0) {
    const worst = w.sessions.slice().sort((x, y) => y.cost.total - x.cost.total)[0];
    const share = worst.cost.total / w.cost.total;
    if (share >= T.concentrationWatch) {
      watch.push({
        id: 'concentration', severity: share >= T.concentrationCrit ? 3 : 2, stake: worst.cost.total,
        title: `Une seule session porte ${fmt.pct(share)} du coût de la fenêtre (${fmt.eur(worst.cost.total)})`,
        // Identifiant de session = nom de fichier venu du disque : échappé, comme partout
        // ailleurs dans la page (un transcript est une donnée, pas du balisage).
        detail: `Session ${fmt.esc(worst.sessionId.slice(0, 8))}, ${fmt.int(worst.turns)} tours sur ${fmt.int(w.turns)} — ` +
          `occupation médiane ${fmt.tok(worst.occupancy.median)}, p90 ${fmt.tok(worst.occupancy.p90)}.`,
        action: `Arrêter les sessions marathon : le coût d'une session n'est pas proportionnel à ce qu'elle produit.`,
      });
    }
  }

  // --- 10. Contrôle de validité de la décomposition -------------------------
  if (fin(b.ratio)) {
    if (!degraded) {
      good.push({
        id: 'control', severity: 1, stake: null,
        title: `La décomposition est mesurable : contrôle ${fmt.dec(b.ratio)}`,
        detail: `Somme modélisée ${fmt.tok(b.sum)} contre ${fmt.tok(b.actual)} réellement facturés — ni compaction ` +
          `massive, ni raisonnement étendu qui faussent la lecture. Les quatre postes se lisent comme des parts.`,
        action: `Garder des sessions qui n'atteignent pas la compaction : c'est ce qui rend la mesure exploitable.`,
      });
    } else {
      watch.push({
        id: 'control', severity: 2, stake: null,
        title: `Contrôle ${fmt.dec(b.ratio)} > ${fmt.dec(ratioWarn)} : les quatre postes sont des plafonds, pas des parts`,
        detail: `La somme modélisée (${fmt.tok(b.sum)}) dépasse la lecture de cache facturée (${fmt.tok(b.actual)}). ` +
          `Deux causes : compaction en cours de session, ou raisonnement étendu compté en sortie mais non rejoué.`,
        action: `Arrêter de lire la décomposition comme des parts tant que le contrôle n'est pas revenu vers 1,0.`,
      });
    }
  }

  return { good, watch };
}

// Classement : sévérité d'abord, montant en jeu ensuite (même monnaie que les recommandations
// chiffrées), identifiant en dernier — pour que deux fenêtres identiques donnent exactement la
// même page.
function rank(list) {
  return list.slice().sort((a, z) =>
    (z.severity - a.severity) || ((z.stake || 0) - (a.stake || 0)) || a.id.localeCompare(z.id));
}

// Garde-fou de complétude : la page promet 3 + 3. Une fenêtre trop pauvre ne fabrique pas un
// signal de complaisance — elle dit qu'elle n'a pas de quoi en produire un de plus.
function padTo3(list, kind, w, fmt) {
  const out = list.slice(0, 3);
  while (out.length < 3) {
    out.push({
      id: 'insufficient-' + out.length, severity: 0, stake: null, filler: true,
      title: kind === 'good'
        ? 'Rien d\'autre de saillant à porter au crédit de cette fenêtre'
        : 'Aucun autre signal d\'alerte sur cette fenêtre',
      detail: `${fmt.int(w.count)} session(s) et ${fmt.int(w.turns)} tours mesurés : aucun indicateur de plus ne franchit ` +
        `son seuil. Élargir la fenêtre (<code>--all</code>) donnerait une lecture plus sûre.`,
      action: null,
    });
  }
  return out;
}

// ============================ LES QUATRE BLOCS ============================

// Constat : des FAITS, aucun jugement — c'est le rôle des trois autres blocs. Un chiffre absent
// est dit absent.
function constat(w, fmt, opts) {
  const b = w.cacheReadBreakdown || {};
  const s = b.shares || {};
  const NAMES = { prefix: 'le préfixe rejoué à chaque tour', output: "la sortie de l'IA relue", toolResults: "les fichiers relus", prompts: 'les prompts et injections relus' };
  const top = ['prefix', 'output', 'toolResults', 'prompts']
    .filter((k) => fin(s[k]))
    .sort((a, z) => s[z] - s[a])[0];
  const parts = [
    `${fmt.int(w.count)} session${w.count > 1 ? 's' : ''} et ${fmt.int(w.turns)} tours mesurés, pour ${fmt.eur(w.cost.total)} ` +
      `— soit ${fmt.eur(w.turns > 0 ? w.cost.total / w.turns : null)} par tour.`,
    `L'occupation médiane est de ${fmt.tok(w.occupancy.median)}` +
      (fin(opts.redZoneTokens) && opts.redZoneTokens > 0
        ? `, ${fmt.pct(w.occupancy.median / opts.redZoneTokens)} de la borne du projet (${fmt.tok(opts.redZoneTokens)})`
        : '') + `, pic à ${fmt.tok(w.occupancy.max)}.`,
    top
      ? `Le premier poste de relecture est ${NAMES[top]} : ${fmt.pct(s[top])} de la lecture de cache, elle-même ` +
        `${fmt.eur(w.cost.cacheRead)} sur ${fmt.eur(w.cost.total)}.`
      : `La décomposition de la lecture de cache est indisponible sur cette fenêtre.`,
    w.scaling && fin(w.scaling.exponent)
      ? `Le coût croît en tours<sup>${fmt.dec(w.scaling.exponent)}</sup> (r² ${fmt.dec(w.scaling.r2)}, ${fmt.int(w.scaling.n)} session(s) longues).`
      : `La loi d'échelle n'est pas régressable ici : moins de 3 sessions assez longues.`,
  ];
  return parts.join(' ');
}

// `synthesize(w, fmt, opts)` — `w` = fenêtre de metrics.analyzeWindow (ok:true attendu ; sur
// ok:false, la page affiche son statut et n'appelle pas ce module).
//   fmt  : { tok, eur, pct, dec, int } — formateurs de scripts/dashboard.js
//   opts : { redZoneTokens, cacheSavingUsd, ratioWarn, topReco }
// `topReco` est la première des recommandations chiffrées DÉJÀ classées par la page : le bloc
// « Améliorer » ne recalcule pas un classement concurrent, il reprend celui-là. Sans lui, il
// retombe sur le premier point d'attention — jamais sur rien.
function synthesize(w, fmt, opts) {
  const o = opts || {};
  const built = buildSignals(w, fmt, o);
  const good = padTo3(rank(built.good), 'good', w, fmt);
  const watch = padTo3(rank(built.watch), 'watch', w, fmt);
  const topGood = good.find((g) => !g.filler) || null;
  const topWatch = watch.find((x) => !x.filler) || null;

  const ameliorer = o.topReco
    ? `<strong>${o.topReco.title}.</strong> ${o.topReco.detail}`
    : (topWatch ? `<strong>${topWatch.title}</strong> ${topWatch.detail}` : null);

  const blocks = [
    { key: 'constat', label: 'Constat', text: constat(w, fmt, o) },
    {
      key: 'garder', label: 'Garder',
      text: topGood
        ? `<strong>${topGood.title}.</strong> ${topGood.action}`
        : `Aucun indicateur favorable saillant sur cette fenêtre — rien à consolider en particulier.`,
    },
    {
      key: 'ameliorer', label: 'Améliorer',
      text: ameliorer || `Fenêtre trop pauvre pour chiffrer un levier : élargir la mesure avec <code>--all</code>.`,
    },
    {
      key: 'arreter', label: 'Arrêter',
      text: topWatch
        ? `<strong>${topWatch.title}.</strong> ${topWatch.action}`
        : `Aucune pratique à arrêter au vu de cette fenêtre : aucun indicateur ne franchit son seuil d'alerte.`,
    },
  ];

  return { blocks, good, watch };
}

module.exports = { THRESHOLDS, synthesize, buildSignals, rank, splitGain };
