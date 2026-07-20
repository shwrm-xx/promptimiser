'use strict';
// Plan de lots persistant du projet : .vibe-agent/backlog.json.
// Un lot = une unité de livraison (1 commit), trans-session — à ne pas confondre avec
// les todos de Claude Code (étapes d'exécution volatiles, capturées à part).
// Le fichier doit rester lisible d'un coup d'œil : caps stricts, pas de champs Jira.
// Fail-silent partout (même philosophie que lot.js) : au pire, backlog vide valide.
const path = require('path');
const { vibeDir, ensureLedger, git } = require('./project');
const { writeAtomic, readJson } = require('./fsjson');
const { getLotCounter, incrementLot } = require('./lot');
const perimeterLib = require('./perimeter');

const MAX_LOTS_OPEN = 20; // lots todo+in_progress ; au-delà c'est un Jira, refus doux
const MAX_TITLE = 80;
const MAX_SCOPE = 400;
const MAX_MODEL_HINT = 40; // préconisation de modèle par lot (ex. « sonnet », « opus »)
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh']; // effort de raisonnement par lot, cf. --effort
const MAX_EPIC = 60; // label d'epic optionnel du lot, cf. .vibe-agent/epic (lib/lot.js)
const MAX_VERIFY = 150; // commande shell de preuve de clôture, exécutée par /close-batch avant done
const MAX_OWNER = 80; // id de session propriétaire d'un lot en cours (mode fleet, cf. D3)
const MAX_DEPENDS = 20; // ids de lots dont ce lot dépend (ordre de réintégration, cf. D3)
const MAX_NOTE = 200;
const MAX_TODOS = 30;
const MAX_TODO_CHARS = 120;
const STATUSES = ['todo', 'in_progress', 'done', 'dropped'];
// Budget de coût par lot (tokens de SORTIE cumulés, cf. addCost/cost_tokens). Aligné sur la
// règle de découpe (scope.md : « 1 lot sous ~300k tokens ») : au-delà, un lot a grossi et
// gagne à être redécoupé plutôt qu'étiré. COST_WARN = seuil « à l'approche » (nudge en cours
// de lot) ; COST_BUDGET = seuil de dépassement (message durci). Coût = sortie uniquement :
// métrique monotone, agrégeable trans-session et robuste à la compaction (contrairement à
// l'occupation, qui est un instantané remis à zéro en session fraîche).
const COST_BUDGET_TOKENS = 300000;
const COST_WARN_TOKENS = 250000;

function backlogFile(root) {
  return path.join(vibeDir(root), 'backlog.json');
}

function todoSnapshotFile(root) {
  return path.join(vibeDir(root), 'todo-snapshot.json');
}

function trunc(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function now() {
  return new Date().toISOString();
}

// Normalise la liste des dépendances d'un lot (ids d'autres lots — ordre de réintégration,
// cf. D3) : entiers finis, self exclu, dédoublonnés, capé. Entrée non-array → [].
function normalizeDepends(deps, selfId) {
  if (!Array.isArray(deps)) return [];
  const seen = new Set();
  const out = [];
  for (const d of deps) {
    const n = Number(d);
    if (!Number.isFinite(n) || n === selfId || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_DEPENDS) break;
  }
  return out;
}

// Normalisation défensive : fichier absent/corrompu/champ invalide → backlog vide valide.
function loadBacklog(root) {
  const empty = { version: 1, next_id: 1, created_at: null, updated_at: null, lots: [] };
  if (!root) return empty;
  const raw = readJson(backlogFile(root), null);
  if (!raw) return empty;
  const lots = (Array.isArray(raw.lots) ? raw.lots : [])
    .filter((l) => l && typeof l === 'object' && Number.isFinite(l.id) && l.title)
    .map((l) => ({
      id: l.id,
      title: trunc(l.title, MAX_TITLE),
      scope: l.scope ? trunc(l.scope, MAX_SCOPE) : null,
      status: STATUSES.includes(l.status) ? l.status : 'todo',
      model_hint: l.model_hint ? trunc(l.model_hint, MAX_MODEL_HINT) : null,
      effort_hint: EFFORT_LEVELS.includes(l.effort_hint) ? l.effort_hint : null,
      epic: l.epic ? trunc(l.epic, MAX_EPIC) : null,
      verify: l.verify ? trunc(l.verify, MAX_VERIFY) : null,
      closed_commit: l.closed_commit || null,
      closed_at: l.closed_at || null,
      closed_session_id: l.closed_session_id || null,
      closed_occupancy: Number.isFinite(l.closed_occupancy) ? l.closed_occupancy : null,
      // Coût réel cumulé du lot = tokens de sortie sommés sur tous les tours où il était
      // en cours (cf. addCost, appelé par stop.js). Agrégé trans-session (porté par le lot,
      // pas par l'état de session), figé de fait à la clôture. Négatif/NaN -> 0.
      cost_tokens: Number.isFinite(l.cost_tokens) && l.cost_tokens > 0 ? l.cost_tokens : 0,
      started_at: l.started_at || null,
      lot_number: Number.isFinite(l.lot_number) ? l.lot_number : null,
      note: l.note ? trunc(l.note, MAX_NOTE) : null,
      // Nombre de sessions distinctes ayant travaillé ce lot pendant qu'il restait en cours
      // (incrémenté par touchLot, cf. lib/lot.js:suggestedTitle) — alimente le suffixe
      // « (partie N) » du titre de session quand un lot dépasse une session.
      session_touches: Number.isFinite(l.session_touches) ? l.session_touches : 0,
      // --- Parallélisation gouvernée (décision D3, palier 2) — inertes sans fleet actif ---
      // perimeter : globs de chemins que ce lot a le droit de modifier (périmètre exclusif).
      // depends_on : ids de lots dont il dépend (ordre de réintégration / calcul de vagues).
      // session_owner : id de la session qui « tient » ce lot pendant qu'il est en cours ;
      //   posé par startLot en mode fleet, autorise plusieurs lots in_progress à coexister.
      perimeter: perimeterLib.normalize(l.perimeter),
      depends_on: normalizeDepends(l.depends_on, l.id),
      session_owner: l.session_owner ? trunc(l.session_owner, MAX_OWNER) : null,
    }));
  const maxId = lots.reduce((m, l) => Math.max(m, l.id), 0);
  return {
    version: 1,
    next_id: Math.max(Number.isFinite(raw.next_id) ? raw.next_id : 1, maxId + 1),
    created_at: raw.created_at || null,
    updated_at: raw.updated_at || null,
    lots,
  };
}

// Sécurise le plan de lots : le stage (best-effort) dès qu'il change. Un fichier
// STAGÉ survit à un `git clean -fd` et part avec le prochain commit, ce qui ferme la
// fenêtre où un backlog fraîchement créé, encore non suivi, pouvait disparaître entre
// deux sessions. Le .vibe-agent/.gitignore (bootstrap) le whiteliste ; dans un projet
// sans ce .gitignore, `git add` marche aussi (fichier non ignoré). git() = fail-open.
function stageBacklog(root) {
  try { git(['add', '--', path.relative(root, backlogFile(root))], root); } catch (_) { /* fail-open */ }
}

function saveBacklog(root, b) {
  if (!root) return false;
  ensureLedger(root); // plomberie interne, comme les ledgers
  b.updated_at = now();
  if (!b.created_at) b.created_at = b.updated_at;
  const okw = writeAtomic(backlogFile(root), b);
  if (okw) stageBacklog(root);
  return okw;
}

// Tag d'affichage combiné réutilisé partout (CLI + summaryLines) : « [modèle : X · effort Y] »,
// ou « [modèle : X] » seul si aucun effort posé. Vide si pas de model_hint (lot legacy).
function modelEffortTag(l) {
  if (!l || !l.model_hint) return '';
  return ` [modèle : ${l.model_hint}${l.effort_hint ? ` · effort ${l.effort_hint}` : ''}]`;
}

function findLot(b, id) {
  return b.lots.find((l) => l.id === Number(id)) || null;
}

function openCount(b) {
  return b.lots.filter((l) => l.status === 'todo' || l.status === 'in_progress').length;
}

// null si titre vide, plan déjà au cap, ou effort fourni mais hors énum (refus doux,
// c'est au CLI de l'expliquer). perimeter/dependsOn (optionnels, trailing) : parallélisation
// gouvernée (D3) — vides par défaut, donc lot séquentiel classique.
function addLot(root, title, scope, modelHint, epic, verify, effortHint, perimeter, dependsOn) {
  const t = trunc(title, MAX_TITLE);
  if (!t) return null;
  if (effortHint && !EFFORT_LEVELS.includes(effortHint)) return null;
  const b = loadBacklog(root);
  if (openCount(b) >= MAX_LOTS_OPEN) return null;
  const lot = {
    id: b.next_id,
    title: t,
    scope: scope ? trunc(scope, MAX_SCOPE) : null,
    status: 'todo',
    model_hint: modelHint ? trunc(modelHint, MAX_MODEL_HINT) : null,
    effort_hint: effortHint && EFFORT_LEVELS.includes(effortHint) ? effortHint : null,
    epic: epic ? trunc(epic, MAX_EPIC) : null,
    verify: verify ? trunc(verify, MAX_VERIFY) : null,
    closed_commit: null,
    closed_at: null,
    closed_session_id: null,
    closed_occupancy: null,
    cost_tokens: 0,
    started_at: null,
    lot_number: null,
    note: null,
    session_touches: 0,
    perimeter: perimeterLib.normalize(perimeter),
    depends_on: normalizeDepends(dependsOn, b.next_id),
    session_owner: null,
  };
  b.lots.push(lot);
  b.next_id += 1;
  return saveBacklog(root, b) ? lot : null;
}

// Édite le périmètre (globs) d'un lot existant — posé après coup par pmz:parallelize (lot #79)
// ou à la main. Remplace intégralement (pas d'ajout incrémental). null si lot introuvable/clos.
function setPerimeter(root, id, globs) {
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot || lot.status === 'done' || lot.status === 'dropped') return null;
  lot.perimeter = perimeterLib.normalize(globs);
  return saveBacklog(root, b) ? lot : null;
}

// Édite les dépendances (ids de lots) d'un lot existant. Remplace intégralement.
// null si lot introuvable/clos.
function setDepends(root, id, deps) {
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot || lot.status === 'done' || lot.status === 'dropped') return null;
  lot.depends_on = normalizeDepends(deps, lot.id);
  return saveBacklog(root, b) ? lot : null;
}

// Édite la commande de preuve de clôture d'un lot existant (ex. posée après coup, une
// fois le lot déjà créé sans --verify). null si lot introuvable/clos ou commande vide.
function setVerify(root, id, verify) {
  const v = trunc(verify, MAX_VERIFY);
  if (!v) return null;
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot) return null;
  lot.verify = v;
  return saveBacklog(root, b) ? lot : null;
}

// Deux lots en cours peuvent-ils coexister (mode fleet, D3) ? Oui ssi ils appartiennent à des
// sessions DISTINCTES (owner non nul de part et d'autre, différents) ET ont des périmètres
// DISJOINTS. Sinon ils se marcheraient dessus — un seul doit rester en cours.
function canCoexist(a, b) {
  if (!a.session_owner || !b.session_owner || a.session_owner === b.session_owner) return false;
  return perimeterLib.disjoint(a.perimeter, b.perimeter);
}

// Démarre un lot. Deux régimes :
//  - Classique (sessionOwner absent, OU lot sans périmètre) : au plus un in_progress — les
//    autres rétrogradent en todo. C'est le comportement historique, strictement préservé.
//  - Fleet (sessionOwner fourni ET lot avec périmètre, cf. D3) : les autres lots en cours qui
//    PEUVENT coexister (autre session + périmètre disjoint) restent en cours ; seuls ceux qui
//    entreraient en conflit rétrogradent. Permet N lots in_progress d'une même vague.
function startLot(root, id, sessionOwner) {
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot || lot.status === 'done' || lot.status === 'dropped') return null;
  const owner = sessionOwner ? trunc(sessionOwner, MAX_OWNER) : null;
  lot.session_owner = owner;
  const fleet = !!owner && lot.perimeter.length > 0;
  for (const l of b.lots) {
    if (l.status !== 'in_progress' || l.id === lot.id) continue;
    if (fleet && canCoexist(l, lot)) continue; // vague en cours : on laisse le pair vivre
    l.status = 'todo';
    l.started_at = null;
    l.session_owner = null;
  }
  lot.status = 'in_progress';
  lot.started_at = now();
  lot.session_touches = 0; // (re)départ = repart de « partie 1 » (pas de suffixe)
  return saveBacklog(root, b) ? lot : null;
}

// Incrémente le compteur de sessions ayant travaillé ce lot pendant qu'il restait en cours
// (appelé une fois par démarrage réel de session, cf. lib/lot.js:suggestedTitle). Approximatif
// par construction (avance même si la session n'a en fait pas touché ce lot) — même logique
// assumée que lot-counter.json (cf. commentaire de doneLot). Retourne le compteur à jour, ou
// null si le lot est introuvable/pas en cours.
function touchLot(root, id) {
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot || lot.status !== 'in_progress') return null;
  lot.session_touches = (lot.session_touches || 0) + 1;
  return saveBacklog(root, b) ? lot.session_touches : null;
}

// Agrège le coût réel (tokens de sortie du tour écoulé) sur le lot EN COURS. Appelé une
// fois par tour par stop.js avec turn.out. N'accumule QUE sur un lot in_progress (un lot
// clos/à faire ne « consomme » pas). tokens <= 0 -> no-op silencieux (renvoie le lot tel
// quel sans réécriture inutile). Renvoie le lot à jour, ou null si introuvable/pas en cours.
// Persistance sur le lot (pas l'état de session) => l'agrégat survit aux sessions fraîches.
function addCost(root, id, tokens) {
  const n = Number(tokens);
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot || lot.status !== 'in_progress') return null;
  if (!Number.isFinite(n) || n <= 0) return lot;
  lot.cost_tokens = (Number.isFinite(lot.cost_tokens) ? lot.cost_tokens : 0) + Math.round(n);
  return saveBacklog(root, b) ? lot : null;
}

// Idempotent : un lot déjà done est rendu tel quel, sans réécriture.
// lot_number par défaut = incrementLot(root) (avance ET persiste le compteur global) ;
// stop.js passe la valeur qu'il a déjà fait avancer lui-même pour éviter un double
// increment. Sans ce fallback qui persiste, une clôture manuelle (CLI `done`, cf.
// /close-batch) lisait juste compteur+1 SANS l'écrire : la session suivante relisait le
// même compteur figé et réattribuait le même numéro à un autre lot — d'où un « Lot N »
// qui se répète session après session au lieu d'avancer.
// sessionId (optionnel) : id de la session qui clôt le lot — permet à suggestedTitle de
// vérifier que le lot décrit bien LA session précédente et pas une clôture plus ancienne
// (cf. lib/state.js: previousSessionId). Absent pour une clôture manuelle via le CLI.
// occupancy (optionnel) : occupation contexte du tour de clôture (turnstats.computeTurn().occ),
// figée dans closed_occupancy — métrologie de coût par lot. Posée par stop.js à l'auto-clôture ;
// absente sur une clôture manuelle via le CLI (pas de transcript à ce niveau).
function doneLot(root, id, commitSha, lotNumber, sessionId, occupancy) {
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot) return null;
  if (lot.status === 'done') return lot;
  lot.status = 'done';
  lot.closed_commit = commitSha || git(['log', '-1', '--format=%h'], root) || null;
  lot.closed_at = now();
  lot.closed_session_id = sessionId || null;
  lot.closed_occupancy = Number.isFinite(occupancy) ? occupancy : null;
  lot.lot_number = Number.isFinite(lotNumber) ? lotNumber : incrementLot(root);
  return saveBacklog(root, b) ? lot : null;
}

// Bilan chiffré d'une epic (lot #58) : appelé juste après doneLot sur le lot qui vient de
// clore. Renvoie null tant qu'il reste un lot de la MÊME epic en todo/in_progress (l'epic
// n'est pas terminée) ou si le lot n'a pas d'epic. Coût = somme des cost_tokens déjà
// persistés par lot (#43, aucun recalcul depuis le transcript). Durée = écart entre le plus
// ancien started_at et le plus récent closed_at parmi les lots de l'epic — best-effort, null
// si l'une des deux dates manque (anciens lots créés avant l'ajout de started_at).
function epicBilan(b, lot) {
  if (!lot || !lot.epic) return null;
  const peers = b.lots.filter((l) => l.epic === lot.epic && l.status !== 'dropped');
  const pending = peers.filter((l) => l.status === 'todo' || l.status === 'in_progress');
  if (pending.length) return null;
  const totalCost = peers.reduce((s, l) => s + (Number.isFinite(l.cost_tokens) ? l.cost_tokens : 0), 0);
  const count = peers.length;
  const starts = peers.map((l) => l.started_at).filter(Boolean).sort();
  const ends = peers.map((l) => l.closed_at).filter(Boolean).sort();
  let durationMs = null;
  if (starts.length && ends.length) {
    const d = new Date(ends[ends.length - 1]).getTime() - new Date(starts[0]).getTime();
    if (Number.isFinite(d) && d >= 0) durationMs = d;
  }
  return {
    epic: lot.epic, count, totalCost,
    avgCost: count ? Math.round(totalCost / count) : 0,
    durationMs,
  };
}

// Estimation prédictive du coût d'un lot (lot #63) : moyenne des cost_tokens des lots CLOS
// comparables, affichée au /scope (add) et au démarrage (start) — avant que le lot n'ait
// consommé le moindre token. « Comparable » par ordre de priorité décroissant (la famille la
// plus fine d'abord) : (1) même model_hint + effort_hint ; (2) même model_hint seul ;
// (3) même epic. null dès qu'aucune famille n'a de lot clos avec cost_tokens > 0 — pas de
// chiffre fabriqué à partir de zéro échantillon.
function estimateCost(b, lot) {
  if (!lot) return null;
  const done = b.lots.filter((l) => l.status === 'done' && l.id !== lot.id &&
    Number.isFinite(l.cost_tokens) && l.cost_tokens > 0);
  if (!done.length) return null;
  let peers = [];
  let basis = null;
  if (lot.model_hint && lot.effort_hint) {
    peers = done.filter((l) => l.model_hint === lot.model_hint && l.effort_hint === lot.effort_hint);
    if (peers.length) basis = 'modèle+effort';
  }
  if (!peers.length && lot.model_hint) {
    peers = done.filter((l) => l.model_hint === lot.model_hint);
    if (peers.length) basis = 'modèle';
  }
  if (!peers.length && lot.epic) {
    peers = done.filter((l) => l.epic === lot.epic);
    if (peers.length) basis = 'epic';
  }
  if (!peers.length) return null;
  const avg = Math.round(peers.reduce((s, l) => s + l.cost_tokens, 0) / peers.length);
  return { avg, count: peers.length, basis };
}

function dropLot(root, id, note) {
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot || lot.status === 'done') return null;
  lot.status = 'dropped';
  if (note) lot.note = trunc(note, MAX_NOTE);
  return saveBacklog(root, b) ? lot : null;
}

function noteLot(root, id, note) {
  const b = loadBacklog(root);
  const lot = findLot(b, id);
  if (!lot || !note) return null;
  lot.note = trunc(note, MAX_NOTE);
  return saveBacklog(root, b) ? lot : null;
}

function currentLot(b) {
  return b.lots.find((l) => l.status === 'in_progress') || null;
}

// Premier « à faire » dans l'ordre du tableau (l'ordre est indicatif, pas contractuel).
function nextLot(b) {
  return b.lots.find((l) => l.status === 'todo') || null;
}

// Dernier lot clos = plus grand **id** (repli quand aucune attribution par session n'est
// possible, cf. lotClosedBySession + lib/lot.js). Décrit ce qui vient d'être FAIT, utile pour
// nommer une session qui a clos un lot sans qu'aucun autre ne soit in_progress/todo.
// Historique des tris essayés, tous abandonnés sur données réelles (japlan-app) :
//   - lot_number : compteur global recyclé/null sur clôtures legacy → figeait un vieux lot.
//   - closed_at  : horodatage NON fiable — mix de dates à la journée (« 2026-07-11 »), de
//     valeurs à la seconde ronde saisies à la main, et de clôtures dans le désordre ; un lot
//     ancien (#34, closed_at 23:06 édité) « battait » le vrai dernier (#40, 23:03) → même
//     titre figé session après session.
// L'id backlog est monotone, jamais recyclé, jamais null (cf. addLot) et c'est le référentiel
// affiché (#N) : le trier rend le nommage stable et immunisé aux horodatages sales. Compromis
// assumé : une clôture RÉTROACTIVE d'un vieux lot ne sera pas « le dernier » — mais ce cas est
// couvert par l'attribution par session (le chemin primaire), le repli restant un pis-aller.
function lastDoneLot(b) {
  const done = b.lots.filter((l) => l.status === 'done');
  if (!done.length) return null;
  done.sort((a, c) => (c.id || 0) - (a.id || 0));
  return done[0];
}

// Rang (1-based) d'un lot DANS SON PLAN (epic) : position par id croissant parmi les lots du
// même epic, tous statuts confondus (stable, indépendant des drops/ordre de clôture). C'est le
// « Lot #X » du titre de session — l'utilisateur pense « lot 1..5 de CE plan », pas en id global
// (#34, #40) qui ne remet jamais à zéro entre plans (retour utilisateur 2026-07-13). null si le
// lot n'a pas d'epic (pas de plan où le ranger → « Session Libre » sans « Lot #X »).
function lotRankInEpic(b, l) {
  if (!l || !l.epic) return null;
  const peers = b.lots.filter((x) => x.epic === l.epic).sort((a, c) => (a.id || 0) - (c.id || 0));
  const idx = peers.findIndex((x) => x.id === l.id);
  return idx >= 0 ? idx + 1 : null;
}

// Lot clos par UNE session donnée (closed_session_id === sid) — signal d'attribution fiable
// posé par stop.js à l'auto-clôture. Renvoie le plus grand id parmi les correspondances (la
// dernière chose que cette session a faite si elle en a clos plusieurs), ou null. C'est le
// chemin PRIMAIRE de suggestedTitle : il décrit exactement ce que la session précédente a
// clos, indépendamment des horodatages sales et sans jamais figer le même lot d'une session
// à l'autre (chaque session clôt son propre lot → titre distinct).
function lotClosedBySession(b, sid) {
  if (!sid) return null;
  const mine = b.lots.filter((l) => l.status === 'done' && l.closed_session_id === sid);
  if (!mine.length) return null;
  mine.sort((a, c) => (c.id || 0) - (a.id || 0));
  return mine[0];
}

function progress(b) {
  const active = b.lots.filter((l) => l.status !== 'dropped');
  return { done: active.filter((l) => l.status === 'done').length, total: active.length };
}

// Bloc texte compact réutilisé par le handoff auto et les messages SessionStart.
// [] si backlog absent/vide. Jamais plus de quelques lignes (anti-bloat : injecté).
function summaryLines(root) {
  try {
    const b = loadBacklog(root);
    if (!b.lots.length) return [];
    const p = progress(b);
    const cur = currentLot(b);
    const lines = [];
    let head = `Plan de lots : ${p.done}/${p.total} faits.`;
    if (cur) {
      head += ` Lot en cours : #${cur.id} « ${trunc(cur.title, 60)} »`;
      head += modelEffortTag(cur);
      if (cur.scope) head += ` — ${trunc(cur.scope, 120)}`;
    }
    lines.push(head);
    const upcoming = b.lots.filter((l) => l.status === 'todo').slice(0, 3)
      .map((l) => `#${l.id} « ${trunc(l.title, 60)} »${modelEffortTag(l)}`);
    if (upcoming.length) lines.push(`Suivants : ${upcoming.join(', ')}.`);
    return lines;
  } catch (_) {
    return [];
  }
}

// Capture passive de la todo-list Claude Code : TodoWrite transmet la liste COMPLÈTE à
// chaque appel → un seul fichier écrasé intégralement (dernier état connu). Jamais
// effacé en début de session (précieux après un crash) : remplacé au premier TodoWrite
// de la session suivante. `activeForm` est jeté (redondant avec content).
function writeTodoSnapshot(root, todos, sessionId) {
  try {
    if (!root || !Array.isArray(todos)) return false;
    const clean = todos
      .filter((t) => t && typeof t === 'object' && t.content)
      .slice(0, MAX_TODOS)
      .map((t) => ({ content: trunc(t.content, MAX_TODO_CHARS), status: String(t.status || 'pending') }));
    ensureLedger(root);
    return writeAtomic(todoSnapshotFile(root), {
      session_id: sessionId || null,
      updated_at: now(),
      todos: clean,
    });
  } catch (_) {
    return false;
  }
}

function readTodoSnapshot(root) {
  const raw = readJson(todoSnapshotFile(root), null);
  if (!raw || !Array.isArray(raw.todos)) return null;
  return raw;
}

// Tous les lots d'un ensemble coexistent-ils 2 à 2 (vague fleet valide) ? cf. canCoexist.
function pairwiseCoexist(lots) {
  for (let i = 0; i < lots.length; i++) {
    for (let j = i + 1; j < lots.length; j++) {
      if (!canCoexist(lots[i], lots[j])) return false;
    }
  }
  return true;
}

// Nom de branche suggéré pour un lot en vol (préfixe `pmz/lot-<id>-<slug>`). Slug ASCII borné,
// dérivé du titre (accents dépliés, non-alphanum → tiret). Purement présentatif — réutilisé par
// pmz:parallelize (plan) et, à terme, pmz:reintegrate (#80). Ne lit/écrit rien.
function waveBranch(lot) {
  const slug = String((lot && lot.title) || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // déplie les accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '') || 'lot';
  return `pmz/lot-${lot && lot.id}-${slug}`;
}

// Calcule un PLAN DE VAGUES parallèles à partir des lots « à faire » (D3). Une vague est un
// groupe de lots dont les périmètres sont disjoints DEUX À DEUX (le conflit git y devient
// structurellement impossible) et dont toutes les dépendances `depends_on` sont satisfaites par
// une vague antérieure ou par un lot déjà fait. Fonction PURE : ne lit/écrit rien, ne lance
// rien — elle PROPOSE seulement. Deux règles cardinales, fail-safe :
//   - REFUS des intersections : deux lots aux périmètres qui se chevauchent ne partagent JAMAIS
//     une vague ; l'un est repoussé à une vague ultérieure (jamais co-planifiés).
//   - Au moindre doute → hors vague : un lot sans périmètre est « non parallélisable » ; un lot
//     dont une dépendance ne pourra jamais être satisfaite (cycle, dépend d'un non parallélisable)
//     est « bloqué ». Ni l'un ni l'autre n'entre dans une vague.
// Retour : { waves: [[lot, …], …], unplannable: [{ lot, reason }], blocked: [{ lot, reason }] }.
// L'ordre des vagues respecte `depends_on` ; l'ordre intra-vague suit l'id (stable).
function planWaves(b) {
  const lots = (b && Array.isArray(b.lots)) ? b.lots : [];
  const doneIds = new Set(lots.filter((l) => l.status === 'done').map((l) => l.id));
  const todo = lots.filter((l) => l.status === 'todo');
  const withPerim = todo.filter((l) => Array.isArray(l.perimeter) && l.perimeter.length > 0);
  const unplannable = todo
    .filter((l) => !(Array.isArray(l.perimeter) && l.perimeter.length > 0))
    .map((l) => ({ lot: l, reason: 'aucun périmètre défini' }));
  const unplannableIds = new Set(unplannable.map((u) => u.lot.id));
  const plannableIds = new Set(withPerim.map((l) => l.id));

  const blocked = [];
  // Un lot qui dépend d'un lot « à faire » SANS périmètre ne sera jamais plaçable (sa dépendance
  // n'entrera dans aucune vague) → bloqué d'emblée.
  let remaining = withPerim.filter((l) => {
    const deps = Array.isArray(l.depends_on) ? l.depends_on : [];
    if (deps.some((d) => unplannableIds.has(d))) {
      blocked.push({ lot: l, reason: 'dépend d’un lot non parallélisable' });
      return false;
    }
    return true;
  });

  // Une dépendance est satisfaite si : c'est un lot plaçable déjà posé dans une vague antérieure,
  // OU un lot déjà fait, OU une référence hors-plan (abandonné / id inconnu) — tolérée, jamais bloquante.
  const placed = new Set(doneIds);
  function depsSatisfied(l) {
    const deps = Array.isArray(l.depends_on) ? l.depends_on : [];
    return deps.every((d) => (plannableIds.has(d) ? placed.has(d) : true));
  }

  const waves = [];
  while (remaining.length) {
    const ready = remaining.filter(depsSatisfied).sort((a, c) => a.id - c.id);
    if (!ready.length) {
      // Plus aucun lot prêt alors qu'il en reste : cycle ou dépendance impossible → tous bloqués.
      for (const l of remaining) blocked.push({ lot: l, reason: 'dépendance circulaire ou impossible' });
      break;
    }
    // Remplissage glouton : un lot rejoint la vague seulement si son périmètre est disjoint de
    // TOUS ceux déjà retenus ; sinon il attend une vague ultérieure. La vague vide accepte
    // toujours le premier prêt → progrès garanti à chaque tour (terminaison).
    const wave = [];
    for (const l of ready) {
      if (wave.every((w) => perimeterLib.disjoint(w.perimeter, l.perimeter))) wave.push(l);
    }
    const waveIds = new Set(wave.map((l) => l.id));
    wave.forEach((l) => placed.add(l.id));
    waves.push(wave);
    remaining = remaining.filter((l) => !waveIds.has(l.id));
  }

  return { waves, unplannable, blocked };
}

// Réparation volontairement bête — jamais bloquante, jamais de matching sémantique.
function reconcile(root) {
  const fixed = [];
  const warnings = [];
  const b = loadBacklog(root);
  // 1. Plusieurs in_progress. Une VAGUE valide (tous coexistent 2 à 2 : sessions distinctes +
  //    périmètres disjoints, cf. D3) est légitime → on n'y touche pas. Sinon, retour à
  //    l'invariant historique : garde le plus récemment démarré (fallback : id le plus haut).
  const inProg = b.lots.filter((l) => l.status === 'in_progress');
  if (inProg.length > 1 && !pairwiseCoexist(inProg)) {
    inProg.sort((a, c) => String(c.started_at || '').localeCompare(String(a.started_at || '')) || c.id - a.id);
    for (const l of inProg.slice(1)) {
      l.status = 'todo';
      l.started_at = null;
      l.session_owner = null;
      fixed.push(`#${l.id} rétrogradé en « à faire » (un seul lot en cours à la fois)`);
    }
  }
  // 2. done sans commit → attache le dernier commit connu.
  for (const l of b.lots) {
    if (l.status === 'done' && !l.closed_commit) {
      l.closed_commit = git(['log', '-1', '--format=%h'], root) || null;
      if (l.closed_commit) fixed.push(`#${l.id} : commit de clôture attaché (${l.closed_commit})`);
    }
  }
  // 3. Lots faits en désordre → informatif seulement, l'ordre du tableau est indicatif.
  const doneAfterTodo = b.lots.some((l, i) => l.status === 'done' &&
    b.lots.slice(0, i).some((m) => m.status === 'todo'));
  if (doneAfterTodo) warnings.push('Des lots ont été faits dans le désordre — rien à réparer, ordre indicatif.');
  if (fixed.length) saveBacklog(root, b);
  return { fixed, warnings };
}

const EXPORT_COLUMNS = ['id', 'title', 'status', 'epic', 'model_hint', 'effort_hint', 'verify', 'cost_tokens', 'closed_commit', 'closed_at'];

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Export brut du plan de lots en CSV (une ligne par lot, colonnes EXPORT_COLUMNS) — pour
// tableur externe (reporting, coût par livrable). Toujours tous les lots, y compris abandonnés.
function exportCsv(b) {
  const lines = [EXPORT_COLUMNS.join(',')];
  for (const l of b.lots) lines.push(EXPORT_COLUMNS.map((c) => csvField(l[c])).join(','));
  return lines.join('\n');
}

// Même contenu que exportCsv, en table Markdown (coller dans un compte-rendu/doc).
function exportMarkdown(b) {
  const header = `| ${EXPORT_COLUMNS.join(' | ')} |`;
  const sep = `| ${EXPORT_COLUMNS.map(() => '---').join(' | ')} |`;
  const rows = b.lots.map((l) => `| ${EXPORT_COLUMNS.map((c) => String(l[c] == null ? '' : l[c]).replace(/\|/g, '\\|')).join(' | ')} |`);
  return [header, sep, ...rows].join('\n');
}

module.exports = {
  backlogFile, loadBacklog, saveBacklog, addLot, setVerify, setPerimeter, setDepends, startLot, doneLot, dropLot, noteLot,
  touchLot, addCost, currentLot, nextLot, lastDoneLot, lotClosedBySession, lotRankInEpic, progress, summaryLines, reconcile,
  epicBilan, estimateCost, canCoexist, pairwiseCoexist, planWaves, waveBranch,
  todoSnapshotFile, writeTodoSnapshot, readTodoSnapshot, modelEffortTag,
  exportCsv, exportMarkdown,
  MAX_LOTS_OPEN, MAX_TITLE, MAX_SCOPE, MAX_MODEL_HINT, MAX_EPIC, MAX_VERIFY, MAX_OWNER, MAX_DEPENDS, MAX_NOTE, MAX_TODOS, EFFORT_LEVELS,
  COST_BUDGET_TOKENS, COST_WARN_TOKENS,
};
