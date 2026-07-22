'use strict';
// Métrologie HONNÊTE des gains RTK (lot #83, epic Bridge RTK).
//
// Objectif : rattacher au lot clos une mesure du travail confié au bridge RTK, AVEC son niveau
// de preuve — jamais une valeur inventée (règle absolue du lot). Trois niveaux :
//
//   - `measured`  : chiffres issus de RTK lui-même (sorties brutes vs transmises → économie réelle).
//                   Couture BRANCHÉE mais DORMANTE : `computeLotGain` accepte un objet `rtkStats`
//                   pré-calculé, mais on ne DEVINE PAS le contrat CLI d'un `rtk stats` inconnu
//                   (inventer un format = inventer une valeur). Réservé à un contrat RTK défini.
//   - `local`     : ce qu'on peut PROUVER aujourd'hui, sans RTK — un compteur local des commandes
//                   effectivement réécrites + le volume de commande LIVRÉ (tokens estimés du texte
//                   réellement transmis). PAS d'« économie » ici : la compression opère sur la
//                   SORTIE terminale, invisible d'ici — on ne prétend donc à aucun `tokens_saved`.
//   - (rien)      : aucune activité RTK sur le lot → aucun champ écrit, rien d'affiché.
//
// Attribution par lot = delta d'un compteur monotone (spec §11 : « delta = snapshot_clôture −
// snapshot_démarrage »). Le compteur vit sous PMZ_STATE_DIR (survit aux `git pull`/updates, comme
// rtk-state.json) ; le snapshot de démarrage est figé sur le lot par backlog.startLot, le delta
// calculé par backlog.doneLot. Fail-open absolu : toute erreur → zéro, jamais d'exception (ce
// module est appelé depuis le chemin chaud du hook PreToolUse).
//
// Imprécision assumée (documentée) : en vague parallèle (plusieurs lots in_progress), le compteur
// global ne sait pas à quel lot imputer une réécriture — les deltas peuvent se chevaucher. C'est
// pourquoi ce niveau s'appelle `local` (preuve faible, explicitement étiquetée), pas `measured`.

const path = require('path');
const cdir = require('./claude-dir');
const { readJson, writeAtomic } = require('./fsjson');
const { estTokens } = require('./ledger');

function stateDir() {
  return process.env.PMZ_STATE_DIR || cdir.stateDir();
}
function metricsFile() {
  return path.join(stateDir(), 'rtk-metrics.json');
}

const ZERO = { commands: 0, delivered_tokens: 0 };

// Snapshot courant du compteur monotone (jamais réinitialisé). Fail-open → zéros.
function snapshot() {
  try {
    const s = readJson(metricsFile(), ZERO);
    return {
      commands: Number.isFinite(s.commands) && s.commands > 0 ? s.commands : 0,
      delivered_tokens: Number.isFinite(s.delivered_tokens) && s.delivered_tokens > 0 ? s.delivered_tokens : 0,
    };
  } catch (_) {
    return { commands: 0, delivered_tokens: 0 };
  }
}

// Enregistre une réécriture APPLIQUÉE (appelé par pre-tool-use.js, uniquement quand rw.applied
// ET la commande réécrite reste sûre). `delivered` = tokens estimés du texte réellement transmis.
// Jamais bloquant, jamais d'exception : au pire la mesure est ratée, la session continue.
function recordRewrite(deliveredCommand) {
  try {
    const fs = require('fs');
    try { fs.mkdirSync(stateDir(), { recursive: true }); } catch (_) { /* fail-open */ }
    const cur = snapshot();
    const bytes = Buffer.byteLength(String(deliveredCommand || ''), 'utf8');
    const next = {
      commands: cur.commands + 1,
      delivered_tokens: cur.delivered_tokens + estTokens({ bytes }),
    };
    writeAtomic(metricsFile(), next);
    return next;
  } catch (_) {
    return null;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Calcule le gain d'un lot à partir de son snapshot de démarrage et de l'état courant (ou de
// `end` fourni). `rtkStats` (optionnel) = delta déjà calculé côté RTK { raw_tokens, delivered_tokens }
// → niveau `measured`. Renvoie l'objet à figer sur le lot, ou null si AUCUNE preuve (→ rien à
// afficher, aucun champ écrit — jamais de valeur inventée).
function computeLotGain(opts) {
  const o = opts || {};
  const start = o.start || null;
  const end = o.end || snapshot();

  // Niveau MEASURED : uniquement si un delta RTK crédible est fourni (couture dormante).
  const rs = o.rtkStats;
  if (rs && Number.isFinite(rs.raw_tokens) && rs.raw_tokens > 0 && Number.isFinite(rs.delivered_tokens) && rs.delivered_tokens >= 0) {
    const raw = Math.round(rs.raw_tokens);
    const delivered = Math.round(rs.delivered_tokens);
    const saved = Math.max(0, raw - delivered);
    return {
      provider: 'rtk',
      evidence: 'measured',
      raw_tokens_estimated: raw,
      delivered_tokens_estimated: delivered,
      tokens_saved_estimated: saved,
      saving_ratio: raw > 0 ? round2(saved / raw) : 0,
    };
  }

  // Niveau LOCAL : delta du compteur monotone entre démarrage et clôture. Sans snapshot de
  // démarrage (lot legacy, jamais passé par startLot après ce lot), on NE FABRIQUE PAS de delta.
  if (!start || !Number.isFinite(start.commands)) return null;
  const commands = Math.max(0, end.commands - start.commands);
  if (commands <= 0) return null; // aucune réécriture pendant le lot → rien
  const delivered = Math.max(0, end.delivered_tokens - (Number.isFinite(start.delivered_tokens) ? start.delivered_tokens : 0));
  return {
    provider: 'rtk',
    evidence: 'local',
    commands,
    delivered_tokens_estimated: delivered,
  };
}

// Lignes de bilan lisibles pour /close-batch (et réutilisables). Renvoie [] si co absent/vide
// (→ « rien si aucune donnée »). `fmtK` injecté (lib/messages) pour rester sans dépendance croisée.
function gainLines(co, fmtK) {
  if (!co || typeof co !== 'object' || !co.evidence) return [];
  const k = typeof fmtK === 'function' ? fmtK : (n) => String(Math.round(n || 0));
  if (co.evidence === 'measured') {
    const pct = Math.round((co.saving_ratio || 0) * 100);
    return [
      'Gain RTK (preuve : mesuré) :',
      `- sorties brutes estimées : ${k(co.raw_tokens_estimated)}`,
      `- sorties transmises : ${k(co.delivered_tokens_estimated)}`,
      `- économie : ${k(co.tokens_saved_estimated)} — ${pct} %`,
    ];
  }
  if (co.evidence === 'local') {
    const n = co.commands || 0;
    return [
      'Gain RTK (preuve : compteur local — économie de sortie non mesurable ici) :',
      `- commandes réécrites via RTK : ${n}`,
      `- volume de commande livré : ≈ ${k(co.delivered_tokens_estimated)} tokens`,
    ];
  }
  return [];
}

module.exports = { metricsFile, snapshot, recordRewrite, computeLotGain, gainLines };
