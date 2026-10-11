'use strict';
// État LIVE d'une session maître (lot #136) — .vibe-agent/epicmaster-live.json.
// Alimenté par : `backlog.js start|done|note` quand l'owner est « master/lot-* » (CLI), et par les
// hooks SubagentStart/SubagentStop (hooks/subagent-live.js). Lu par `backlog.js epicmaster --live`
// (rendu compact/détaillé) et par la statusline (segment de repli).
//
// Fail-open ABSOLU : aucune fonction publique ne lève ; toute erreur d'E/S ou de JSON -> no-op /
// valeur vide. Écriture atomique (fsjson). Course possible entre deux sous-agents qui écrivent au
// même instant : on relit juste avant d'écrire, au pire une mise à jour est perdue (état indicatif,
// jamais source de vérité — celle-ci reste backlog.json).
const path = require('path');
const { readJson, writeAtomic } = require('./fsjson');

const LIVE_FILE = 'epicmaster-live.json';
const OWNER_RE = /^master\/lot-/;
const STALE_MS = 6 * 3600 * 1000;       // un « en cours » plus vieux que ça est présumé mort
const KEEP_DONE_MS = 24 * 3600 * 1000;  // un lot fait disparaît de l'état au bout de 24 h
const MAX_LOTS = 200;
const MAX_AGENTS = 100;
const MAX_STR = 200;
const MAX_NOTE = 300;

function clipStr(s, n) { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function nowIso(now) { return new Date(now == null ? Date.now() : now).toISOString(); }
function ts(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; }

function isMasterOwner(owner) { return typeof owner === 'string' && OWNER_RE.test(owner); }
function livePath(root) { return path.join(root, '.vibe-agent', LIVE_FILE); }

function emptyState() { return { v: 1, updated_at: null, lots: {}, agents: {} }; }

function load(root) {
  try {
    const raw = readJson(livePath(root), null);
    if (!raw || typeof raw !== 'object') return emptyState();
    return {
      v: 1,
      updated_at: raw.updated_at || null,
      lots: raw.lots && typeof raw.lots === 'object' && !Array.isArray(raw.lots) ? raw.lots : {},
      agents: raw.agents && typeof raw.agents === 'object' && !Array.isArray(raw.agents) ? raw.agents : {},
    };
  } catch (_) { return emptyState(); }
}

function prune(st, now) {
  const t = now == null ? Date.now() : now;
  for (const [id, l] of Object.entries(st.lots)) {
    if (!l || typeof l !== 'object') { delete st.lots[id]; continue; }
    if (l.status === 'done') {
      const d = ts(l.done_at || l.updated_at);
      if (d != null && t - d > KEEP_DONE_MS) delete st.lots[id];
    }
  }
  const ids = Object.keys(st.lots);
  if (ids.length > MAX_LOTS) {
    ids.sort((a, b) => (ts(st.lots[a].updated_at) || 0) - (ts(st.lots[b].updated_at) || 0))
      .slice(0, ids.length - MAX_LOTS).forEach((id) => { delete st.lots[id]; });
  }
  const aIds = Object.keys(st.agents);
  if (aIds.length > MAX_AGENTS) {
    // on écarte d'abord les agents arrêtés, les plus anciens en tête
    aIds.sort((a, b) => {
      const A = st.agents[a] || {}, B = st.agents[b] || {};
      const sa = A.stopped_at ? 0 : 1, sb = B.stopped_at ? 0 : 1;
      return sa - sb || (ts(A.started_at) || 0) - (ts(B.started_at) || 0);
    }).slice(0, aIds.length - MAX_AGENTS).forEach((id) => { delete st.agents[id]; });
  }
  return st;
}

function save(root, st, now) {
  try {
    st.updated_at = nowIso(now);
    prune(st, now);
    return writeAtomic(livePath(root), st);
  } catch (_) { return false; }
}

// ── Alimentation par la CLI (start / done / note) ─────────────────────────────────────────
// `lot` = lot du backlog (id, title, note) ; `owner` = session_owner du lot AVANT clôture (doneLot
// le vide). N'écrit RIEN si l'owner n'est pas « master/lot-* » : un `start` hors session maître ne
// doit jamais créer de fichier live.
function recordLot(root, kind, lot, owner, now) {
  try {
    if (!root || !lot || lot.id == null || !isMasterOwner(owner)) return false;
    const st = load(root);
    const key = String(lot.id);
    const t = nowIso(now);
    const prev = st.lots[key] && typeof st.lots[key] === 'object' ? st.lots[key] : {};
    const cur = Object.assign({}, prev, {
      id: lot.id, title: clipStr(lot.title, MAX_STR), owner: clipStr(owner, MAX_STR), updated_at: t,
    });
    if (kind === 'start') {
      Object.assign(cur, { status: 'running', started_at: t, done_at: null });
    } else if (kind === 'done') {
      Object.assign(cur, { status: 'done', done_at: t });
      if (!cur.started_at) cur.started_at = lot.started_at || t;
    } else if (kind === 'note') {
      if (!cur.status) Object.assign(cur, { status: 'running', started_at: lot.started_at || t });
      cur.note = clipStr(lot.note, MAX_NOTE);
    } else return false;
    st.lots[key] = cur;
    return save(root, st, now);
  } catch (_) { return false; }
}
const recordStart = (root, lot, owner, now) => recordLot(root, 'start', lot, owner, now);
const recordDone = (root, lot, owner, now) => recordLot(root, 'done', lot, owner, now);
const recordNote = (root, lot, owner, now) => recordLot(root, 'note', lot, owner, now);

// ── Alimentation par les hooks SubagentStart / SubagentStop ───────────────────────────────
// N'écrit que si une session maître est en cours (fichier présent avec au moins un lot « running ») :
// les sous-agents d'une session ordinaire ne doivent pas faire apparaître le fichier. Rattachement
// au lot : seulement s'il n'y a qu'UN lot running sans agent actif — sinon l'agent reste non lié
// (le hook ne reçoit ni prompt ni id de lot : jamais de rattachement inventé).
function recordSubagent(root, event, input, now) {
  try {
    if (!root || !input || !input.agent_id) return false;
    const id = clipStr(input.agent_id, MAX_STR);
    const st = load(root);
    const running = Object.keys(st.lots).filter((k) => st.lots[k] && st.lots[k].status === 'running');
    if (!running.length) return false;
    const t = nowIso(now);
    if (event === 'start') {
      let lotId = null;
      const free = running.filter((k) => !Object.values(st.agents).some((a) => a && !a.stopped_at && a.lot === Number(k)));
      if (free.length === 1) lotId = Number(free[0]);
      st.agents[id] = { id, type: clipStr(input.agent_type || '', 60) || null, started_at: t, stopped_at: null, lot: lotId };
    } else if (event === 'stop') {
      const a = st.agents[id];
      if (!a || typeof a !== 'object') return false; // arrêt d'un agent jamais vu : on n'invente rien
      a.stopped_at = t;
    } else return false;
    return save(root, st, now);
  } catch (_) { return false; }
}

// ── Lecture / résumé ──────────────────────────────────────────────────────────────────────
function summarize(st, now) {
  const t = now == null ? Date.now() : now;
  const s = { running: [], stale: [], done: [], agents_active: [], agents_stopped: 0, updated_at: (st && st.updated_at) || null };
  if (!st) return s;
  for (const l of Object.values(st.lots || {})) {
    if (!l || typeof l !== 'object') continue;
    if (l.status === 'done') s.done.push(l);
    else if (l.status === 'running') {
      const u = ts(l.updated_at);
      (u != null && t - u > STALE_MS ? s.stale : s.running).push(l);
    }
  }
  const byId = (a, b) => a.id - b.id;
  s.running.sort(byId); s.stale.sort(byId); s.done.sort(byId);
  for (const a of Object.values(st.agents || {})) {
    if (!a || typeof a !== 'object') continue;
    if (a.stopped_at) s.agents_stopped++;
    else {
      const u = ts(a.started_at);
      if (u == null || t - u <= STALE_MS) s.agents_active.push(a);
    }
  }
  return s;
}
function isActive(sum) { return !!sum && (sum.running.length > 0 || sum.agents_active.length > 0); }

function ago(iso, now) {
  const u = ts(iso);
  if (u == null) return '?';
  const m = Math.max(0, Math.round(((now == null ? Date.now() : now) - u) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

const NO_STATE = 'Aucun état live (session maître non démarrée) — .vibe-agent/epicmaster-live.json est alimenté par '
  + '`backlog.js start|done|note` avec `--owner master/lot-<id>` et par les hooks SubagentStart/SubagentStop.';

function renderCompact(sum) {
  if (!sum || (!sum.running.length && !sum.stale.length && !sum.done.length && !sum.agents_active.length)) return NO_STATE;
  const bits = [];
  bits.push(sum.running.length ? `${sum.running.length} en cours (${sum.running.map((l) => '#' + l.id).join(', ')})` : '0 en cours');
  if (sum.done.length) bits.push(`${sum.done.length} fait${sum.done.length > 1 ? 's' : ''}`);
  if (sum.stale.length) bits.push(`${sum.stale.length} périmé${sum.stale.length > 1 ? 's' : ''} (${sum.stale.map((l) => '#' + l.id).join(', ')})`);
  bits.push(`${sum.agents_active.length} sous-agent${sum.agents_active.length > 1 ? 's' : ''} actif${sum.agents_active.length > 1 ? 's' : ''}`);
  return 'Epicmaster live : ' + bits.join(' · ');
}

function renderDetailed(sum, now) {
  if (!sum || (!sum.running.length && !sum.stale.length && !sum.done.length && !sum.agents_active.length)) return NO_STATE;
  const L = [renderCompact(sum)];
  const lotLine = (mark, l, extra) => {
    const ag = Object.values(extra.agents).filter((a) => a && a.lot === l.id && !a.stopped_at).length;
    let s = `  ${mark} #${l.id} ${l.title || ''}${l.owner ? ` — ${l.owner}` : ''}`;
    if (l.status === 'done') s += ` · fait il y a ${ago(l.done_at || l.updated_at, now)}`;
    else s += ` · depuis ${ago(l.started_at, now)}${ag ? ` · ${ag} sous-agent${ag > 1 ? 's' : ''}` : ''}`;
    if (l.note) s += `\n      note : ${l.note}`;
    return s;
  };
  const ctx = { agents: sum._agents || {} };
  if (sum.running.length) { L.push('En cours :'); sum.running.forEach((l) => L.push(lotLine('▶', l, ctx))); }
  if (sum.stale.length) { L.push(`Périmés (aucune mise à jour depuis plus de ${STALE_MS / 3600000} h — session morte ?) :`); sum.stale.forEach((l) => L.push(lotLine('⚠', l, ctx))); }
  if (sum.done.length) { L.push('Faits :'); sum.done.forEach((l) => L.push(lotLine('✔', l, ctx))); }
  if (sum.agents_active.length) {
    L.push('Sous-agents actifs :');
    for (const a of sum.agents_active) {
      L.push(`  ⚙ ${a.type || 'agent'} ${String(a.id).slice(0, 12)} · depuis ${ago(a.started_at, now)}${a.lot != null ? ` · lot #${a.lot}` : ' · lot non rattaché'}`);
    }
  }
  return L.join('\n');
}

// Point d'entrée CLI : { text, summary } — jamais d'exception.
function renderLive(root, opts) {
  try {
    const o = opts || {};
    const st = load(root);
    const sum = summarize(st, o.now);
    sum._agents = st.agents;
    const text = o.detailed ? renderDetailed(sum, o.now) : renderCompact(sum);
    const { _agents, ...json } = sum;
    return { text, summary: json };
  } catch (_) { return { text: NO_STATE, summary: null }; }
}

// Segment statusline (« EM ▶2 ✔1 ⚙3 »). '' si rien d'actif : un maître terminé / un projet sans
// session maître ne laisse aucun bruit dans la barre. Lecture d'un seul petit fichier.
function statusSegment(root, now) {
  try {
    const sum = summarize(load(root), now);
    if (!isActive(sum)) return '';
    const parts = ['EM'];
    if (sum.running.length) parts.push(`▶${sum.running.length}`);
    if (sum.done.length) parts.push(`✔${sum.done.length}`);
    if (sum.agents_active.length) parts.push(`⚙${sum.agents_active.length}`);
    return parts.join(' ');
  } catch (_) { return ''; }
}

module.exports = {
  LIVE_FILE, OWNER_RE, STALE_MS, NO_STATE, isMasterOwner, livePath, load, summarize, isActive,
  recordStart, recordDone, recordNote, recordSubagent, renderCompact, renderDetailed, renderLive, statusSegment,
};
