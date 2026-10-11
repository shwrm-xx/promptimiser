'use strict';
// Vigie de dette git non commitée (lot #73). Contrairement au rappel de clôture (#68),
// qui est un signal ONE-SHOT émis au moment où le tree devient sale, cette vigie est un
// signal de TENDANCE : elle nudge quand un diff significatif GROSSIT sur plusieurs tours
// SANS jamais être commité — le lot traîne, la dette s'accumule, et ce travail non
// versionné est exposé à la perte (compaction, /clear, incident) et finira en commit
// monstre illisible. Le rappel de clôture couvre le tout 1er tour sale (turns=1) ; cette
// vigie prend le relais aux tours suivants si la dette continue de croître.
//
// Mesure indépendante des ledgers projet mais LIÉE au repo (la dette git n'a de sens que
// dans un repo) : elle vit donc dans la branche `if (root)` de stop.js. Niveau de dette
// scalaire = lignes du `git diff HEAD` (hors .vibe-agent) + un forfait par fichier touché
// (les fichiers UNTRACKED sont invisibles à numstat mais bien réels — le forfait les
// capture). Fail-open total : toute erreur git/état -> null, jamais d'exception au hook.
const { stateFileFor } = require('./occupancy');
const { writeAtomic, readJson } = require('./fsjson');
const { git, gitStatusMeaningful } = require('./project');

const DEBT_WINDOW_TURNS = 3;   // au moins 3 tours consécutifs de dette avant de nudger
const DEBT_FILE_WEIGHT = 40;   // chaque fichier meaningful ~ 40 lignes de dette équivalente
const DEBT_LEVEL_MIN = 200;    // seuil de « diff significatif » (≈ 200 lignes, ou 5 fichiers, ou mix)
const DEBT_GROWTH_RATIO = 1.5; // anti-spam : ne renudge que si la dette a encore grossi de 50 %

function gitdebtFile(sid) { return stateFileFor(sid, 'gitdebt.json'); }

function headSha(root) {
  return git(['rev-parse', 'HEAD'], root) || null; // null si aucun commit / hors repo
}

// Somme des lignes ajoutées+supprimées du diff vs HEAD, en excluant .vibe-agent (churn de
// ledgers/handoff, jamais de la « vraie » dette) et les fichiers binaires (numstat: « - - »).
// Les fichiers untracked ne sont PAS dans `git diff HEAD` -> non comptés ici (le forfait par
// fichier du niveau de dette les prend en charge). 0 si pas de HEAD ou diff illisible.
function measureChurn(root) {
  const out = git(['diff', 'HEAD', '--numstat'], root);
  if (!out) return 0;
  let sum = 0;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const add = cols[0];
    const del = cols[1];
    const p = cols[2];
    if (add === '-' || del === '-') continue; // binaire
    if (p.replace(/^"/, '').startsWith('.vibe-agent')) continue;
    sum += (parseInt(add, 10) || 0) + (parseInt(del, 10) || 0);
  }
  return sum;
}

// Évalue la dette du tour. `dirtyFiles` (optionnel) = résultat de gitStatusMeaningful déjà
// calculé par stop.js (évite un 2e `git status`) ; sinon recalculé ici. Renvoie
// { churn, files, turns, level } au franchissement (dette significative, en croissance,
// >= DEBT_WINDOW_TURNS tours sans commit, nouveau palier vs dernier nudge), sinon null.
// L'état persiste par session (fichier <sha1>-gitdebt.json) : le compteur de tours et le
// niveau de dette sont remis à zéro quand un commit intervient (HEAD change) ou que le tree
// (meaningful) redevient propre. Fail-open : toute exception -> null.
function evaluate(root, sessionId, dirtyFiles) {
  try {
    if (!root) return null;
    const head = headSha(root);
    const files = (Array.isArray(dirtyFiles) ? dirtyFiles : gitStatusMeaningful(root)).length;
    const st = readJson(gitdebtFile(sessionId), null) || {};

    let turns = typeof st.turns === 'number' ? st.turns : 0;
    let nudgedLevel = typeof st.nudgedLevel === 'number' ? st.nudgedLevel : 0;
    // Commit intervenu depuis le dernier tour (HEAD a bougé) -> la dette est repartie de zéro.
    if (st.head && head && st.head !== head) { turns = 0; nudgedLevel = 0; }

    // Tree propre (hors .vibe-agent) : aucune dette, on réarme et on se tait.
    if (files === 0) {
      writeAtomic(gitdebtFile(sessionId), { head, turns: 0, lastLevel: 0, nudgedLevel: 0 });
      return null;
    }

    const churn = measureChurn(root);
    const level = churn + files * DEBT_FILE_WEIGHT;
    turns += 1;
    const grew = level > (typeof st.lastLevel === 'number' ? st.lastLevel : 0);
    const significant = level >= DEBT_LEVEL_MIN;
    const newEpisode = level >= nudgedLevel * DEBT_GROWTH_RATIO; // anti-spam : palier franchi
    const shouldNudge = turns >= DEBT_WINDOW_TURNS && significant && grew && newEpisode;

    if (shouldNudge) nudgedLevel = level;
    writeAtomic(gitdebtFile(sessionId), { head, turns, lastLevel: level, nudgedLevel });

    return shouldNudge ? { churn, files, turns, level } : null;
  } catch (_) {
    return null; // fail-open : jamais d'exception vers le hook
  }
}

module.exports = {
  evaluate, measureChurn, headSha,
  DEBT_WINDOW_TURNS, DEBT_FILE_WEIGHT, DEBT_LEVEL_MIN, DEBT_GROWTH_RATIO,
};
